# 271 复核问题修复记录（268 进展三）

2026-11-12。按 [271 独立复核](271-model-settings-and-dialogue-independent-review.md) 修复 268 进展中的五个缺口。修复后 [270](270-268-progress-dialogue-model-picker.md) 的接口与交互保持，只补齐并发的忙碌结算、候选重开与共享、立绘回退与等待提示。[271 第 4 节复验](271-model-settings-and-dialogue-independent-review.md#4-272-修复独立复验) 追加的 MR-03 草稿转存／换密钥清理与 MR-04 首图回退见 [273](273-272-reverification-fixes.md)。

## 1. 修复范围与结论

| 编号 | 复核指出的问题 | 修复结论 |
| --- | --- | --- |
| MR-01 | 列表与测试并发共享一个代际，先发操作无法清理忙碌状态 | 列表与测试各自持有代际；配置键变化时各自失效并复位，不再出现「正在读取…」常驻 |
| MR-02 | 已选模型值同时充当搜索词，重新聚焦无法重开完整候选；方向键不能选中 | 已选值与搜索词分离；点击/聚焦重开完整候选；方向键移动、Enter 选中、Esc 关闭 |
| MR-03 | 设置页探测结果不共享给角色页或资源摘要；未改动配置仍走匿名草稿 | 已保存供应商的候选按服务共享；未改动配置走按资源接口并刷新资源最近测试；草稿结果只显示在原配置与模型上 |
| MR-04 | 角色句段缺少立绘快照时直接传空；立绘自身解码失败无法继续回退 | 页面分别传句段快照、当前服饰、主题图；舞台按「差分 → 快照 → 服饰 → 主题」逐层回退，任一层解码失败继续下一层 |
| MR-05 | 首句之后、模型仍在生成时没有等待提示 | 等待提示覆盖「首句未到」与「已到最后一段仍在生成」两种状态 |

## 2. 探测并发与候选控件

- `useModelProbe` 拆成列表代际与测试代际；任一操作只结算自己的忙碌状态。配置键变化时两类请求同时失效并复位。测试结果记录测试时的模型名，调用方按当前模型名过滤显示。
- `ModelNamePicker` 分开已选值与搜索词：聚焦/点击字段打开完整候选，输入时按搜索词筛选；支持 ArrowUp/ArrowDown 移动、Enter 选中、Esc 关闭，并维护 `aria-activedescendant`。选中仍不覆盖手填。

## 3. 候选共享与已保存探测

- 新增 `components/model/model-cache.js`：按 `resourceId + protocol + baseUrl + credential 状态` 生成缓存键；写入时通知订阅者，读取返回副本。
- 设置编辑：配置未改动（协议、地址一致且保留密钥）时走 `POST /v1/resources/:id/models|model-test`，成功后刷新资源摘要并写入共享缓存；改动或换密钥走草稿探测（保留密钥时按资源解析，后端核对协议与 origin）。
- 角色对话/记忆：以已保存供应商的缓存键订阅共享候选；选择供应商即显示已有候选，无需再次读取；测试结果随模型名变更失效。

## 4. 立绘回退与等待反馈

- `StageSources` 拆为 `segmentHomeUrl`、`outfitUrl`、`themeUrl`；舞台候选链为「差分 → 句段快照 → 当前服饰 → 主题图」，按真实图片地址记录解码失败并继续下一层。历史仍优先使用当轮快照。
- `ChatPane` 的等待文案：首句未到时「正在组织回复…」，展示到最后一段仍在生成时「下一句还在准备…」；可推进时不显示。

## 5. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 渲染端类型检查 | `desktop/desk-preview/renderer && npm run typecheck` | 通过 |
| 渲染端构建 | `npm run build` | 通过（`dist` 已重建） |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 107／107（新增共享缓存与隔离用例） |
| 后端 | 本轮未改后端；沿用 [270](270-268-progress-dialogue-model-picker.md) 的 355 项与 21 步离线验收 | 不变 |
| Electron 设置联调 | `tests/settings-workspace-check.cjs` | 本工作区缺少 `pngjs` 依赖未执行；脚本已按新控件更新 |

## 6. 变更清单

| 文件 | 变更 |
| --- | --- |
| `desktop/.../components/model/use-model-probe.ts` | 列表／测试独立代际；已保存探测写缓存并刷新摘要；测试结果绑定模型名 |
| `desktop/.../components/model/ModelNamePicker.tsx` | 已选值与搜索词分离；点击重开；方向键与 Enter 选中 |
| `desktop/.../components/model/model-cache.js`、`model-cache.d.ts` | 已保存供应商候选共享缓存 |
| `desktop/.../pages/Settings.tsx` | 设置编辑未改动走资源接口；角色页共享候选；测试结果按模型过滤 |
| `desktop/.../pages/Conversation.tsx`、`conversation/ConversationStage.tsx` | 立绘来源拆分与逐层回退 |
| `desktop/.../conversation/ChatPane.tsx` | 最后一段仍在生成时的等待提示 |
| `desktop/desk-preview/tests/model-cache.test.cjs` | 缓存隔离与订阅用例 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/270`、项目工作记忆 |

## 7. 交接边界

- 本轮为实施方自验；MR-01～MR-05 待复核方复验。Electron 桌面联调脚本需在具备 `pngjs` 的桌面环境执行。
- 271 第 3 节仍未实施：Agent 首次穿搭路径、生图草稿探测与草稿测试参数、MCP／Skill 探测、真实语音与生图服务；不提供伪造入口。
- 共享候选仅在本次运行的内存中维护；重启后按供应商重新读取，手填与已保存绑定不受影响。
