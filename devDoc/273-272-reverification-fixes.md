# 272 复验问题修复记录（268 进展四）

2026-11-12。按 [271 第 4 节复验](271-model-settings-and-dialogue-independent-review.md#4-272-修复独立复验) 修复 MR-03 的两项剩余缺口与 MR-04 的首图回退。MR-01、MR-02、MR-05 已通过独立复验，不再改动。[271 第 5 节复验](271-model-settings-and-dialogue-independent-review.md#5-273-补修独立复验) 追加的在途旧候选写回问题见 [274](274-273-reverification-fixes.md)。

## 1. 修复范围与结论

| 编号 | 复验指出的问题 | 修复结论 |
| --- | --- | --- |
| MR-03a | 新建/编辑保存时清空探测状态，刚读取到的草稿候选丢失，保存后角色页下拉为空 | 保存前捕获与本提交配置一致的草稿候选，保存成功后写入该资源的共享缓存；过期请求仍按代际丢弃 |
| MR-03b | 同地址换密钥后共享缓存仍提供旧候选（凭据状态都显示 stored） | 成功换密钥/清除密钥时先清理该供应商的缓存并通知共享页，再写入本次可得候选；共享页收到空缓存会清空旧候选 |
| MR-04 | 首张立绘加载失败时双缓冲跳过解码检查，活动图片停在坏图 | 渲染的活动/缓冲图片都挂 `onError`，失败地址进入同一回退判定，继续切到下一层 |

## 2. 草稿候选转存与换密钥清理

- 新建：保存前记录当前探测的候选（列表已成功加载才转存）；创建成功后以新资源的共享缓存键写入，再清理组件内探测状态。
- 编辑：保存前捕获候选；保存成功后先按结果资源计算缓存键，`replace`／`clear` 时先 `clearModelCache` 清掉旧凭据下的候选，再写入本次候选。未改配置（走资源接口）的读取仍由探测逻辑直接写缓存并刷新资源摘要。
- `useModelProbe` 的共享订阅在缓存被清理（读取为 null）时清空候选与「已加载」状态，避免角色页继续显示旧列表。
- 过期保护不变：探测请求带代际与配置键，保存时复位；迟到响应不会写回缓存或覆盖当前列表。

## 3. 首张立绘失败回退

- `CrossfadeLayer` 的两个图片槽都增加 `onError`，把实际失败的地址交给舞台；舞台只在当前候选链（差分 → 句段快照 → 当前服饰 → 主题图）内记录失败并继续下一张。
- 首张图即使因 `src === current` 跳过了预解码，也会由图片错误事件进入回退；双缓冲切换逻辑保持不变。

## 4. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 渲染端类型检查 | `desktop/desk-preview/renderer && npm run typecheck` | 通过 |
| 渲染端构建 | `npm run build` | 通过（`dist` 已重建） |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 108／108（新增缓存清理与订阅用例） |
| 后端 | 本轮未改后端；沿用 [270](270-268-progress-dialogue-model-picker.md) 的 355 项与 21 步离线验收 | 不变 |
| Electron 复验 | 需由复核方用桌面环境重跑 271 第 4 节场景 | 待复验 |

## 5. 变更清单

| 文件 | 变更 |
| --- | --- |
| `desktop/.../components/model/model-cache.js`、`model-cache.d.ts` | 新增 `clearModelCache()` |
| `desktop/.../components/model/use-model-probe.ts` | 共享订阅在缓存清理后清空候选 |
| `desktop/.../pages/Settings.tsx` | 新建/编辑保存转存草稿候选；换密钥先清缓存 |
| `desktop/.../conversation/ConversationStage.tsx` | 图片槽 `onError` 进入同一回退链 |
| `desktop/desk-preview/tests/model-cache.test.cjs` | 缓存清理与订阅用例 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/272`、项目工作记忆 |

## 6. 交接边界

- 本轮为实施方自验，MR-03a／MR-03b／MR-04 首图回退待复核方复验；MR-01／MR-02／MR-05 维持已通过结论。
- [271 第 3 节](271-model-settings-and-dialogue-independent-review.md#3-待验证与待实施) 仍未实施：Agent 首次穿搭与标注前置条件、生图草稿探测与草稿测试参数、MCP／Skill 探测、真实语音与生图服务、发布包预置角色初始化。
- 共享候选只在本次运行的内存中维护；换密钥后的候选需重新读取（或由保存前的草稿探测转存）。
