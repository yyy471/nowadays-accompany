# 273 补修复验问题修复记录（268 进展五）

2026-11-12。按 [271 第 5 节复验](271-model-settings-and-dialogue-independent-review.md#5-273-补修独立复验) 修复换密钥后旧候选仍可在途写回的问题。272／273 已通过的场景不再改动。[271 第 6 节复验](271-model-settings-and-dialogue-independent-review.md#6-274-补修独立复验) 追加的旧列表失败与旧测试结果晚到问题见 [275](275-274-reverification-fixes.md)。

## 1. 修复范围与结论

| 编号 | 复验指出的问题 | 修复结论 |
| --- | --- | --- |
| MR-03c | 换密钥清理只删除当前缓存值；旧密钥的在途列表在清理后返回时仍会写回旧候选 | 为每个供应商增加缓存代次：清理时推进代次；探测请求在发出时记录代次，晚到结果代次不一致就整段丢弃（不更新候选、不写缓存） |

## 2. 缓存代次与在途失效

- `model-cache.js` 新增 `getModelCacheEpoch(key)`；`clearModelCache(key)` 无论缓存是否存在都推进该供应商代次并通知订阅者。
- `useModelProbe` 的已保存服务列表请求在发出前记录 `cacheKey` 的当前代次；响应返回并通过配置键／请求代际检查后，再核对缓存代次：不一致说明期间换过密钥，直接丢弃本次结果，不写共享缓存、不覆盖角色页候选。
- 该判定不依赖旧请求与新请求的先后：旧请求晚于保存返回、或晚于新密钥列表返回，都会因代次不一致被丢弃；新密钥列表按新代次正常写入。
- 忙碌状态仍由各自的请求代际结算：丢弃结果时 `finally` 照常清除「正在读取…」。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 渲染端类型检查 | `desktop/desk-preview/renderer && npm run typecheck` | 通过 |
| 渲染端构建 | `npm run build` | 通过（`dist` 已重建） |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 109／109（新增缓存代次用例） |
| 后端 | 本轮未改后端；沿用 [270](270-268-progress-dialogue-model-picker.md) 的 355 项与 21 步离线验收 | 不变 |
| Electron 复验 | 需由复核方重跑「旧请求晚于保存返回／晚于新密钥列表返回」两种顺序 | 待复验 |

## 4. 变更清单

| 文件 | 变更 |
| --- | --- |
| `desktop/.../components/model/model-cache.js`、`model-cache.d.ts` | 新增缓存代次；清理无条件推进代次并通知 |
| `desktop/.../components/model/use-model-probe.ts` | 已保存列表记录并核对代次，晚到旧候选整段丢弃 |
| `desktop/desk-preview/tests/model-cache.test.cjs` | 代次推进与通知用例；更新重复清理断言 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/273`、项目工作记忆 |

## 5. 交接边界

- 本轮为实施方自验，MR-03c 待复核方复验；272／273 已通过项维持原结论。
- [271 第 3 节](271-model-settings-and-dialogue-independent-review.md#3-待验证与待实施) 仍未实施：Agent 首次穿搭与标注前置条件、生图草稿探测与草稿测试参数、MCP／Skill 探测、真实语音与生图服务、发布包预置角色初始化。
- 代次只在本次运行的内存中维护；重启后按供应商重新读取候选。
