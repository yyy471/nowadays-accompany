# 286 283 第 5 节复验问题修复

2026-11-12。按 [283 第 5 节复验](283-278-workflow-simplification-independent-review.md#5-285-补修独立复验) 修复仍失败的四项问题。R03、R07 在该轮复验中通过，本轮未改动。本文为实现方自验记录，复验仍由独立复核确认。283 第 6 节复验后的补修见 [287](287-283-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| R01 对话与记忆同时在途 | 对话执行新增外部工作判定：后台记忆整理仍在途时，图的停止边界不再直接确认停止，执行收尾的兜底确认也跳过；只有记忆队列整批收尾后的空闲通知，或对话收尾时外部工作已结束，才确认停止。模型维护因此会等前台对话与后台记忆都到达安全边界后再提交。 |
| R02 响应晚于 SSE | 发送响应到达时先检查缓冲事件里是否已有原消息对应的 `execution_started`。有则以流事件为准，按顺序回放缓冲的增量、分段与完成事件，不再落入旧的 `MODEL_MISSING` 等待提示并丢弃已到达的回复；两种先后顺序都保留原回复与等待状态清除。 |
| R05 用户先行停止 | 暂停协调区分「本次操作发起」与「用户先前已发起」。已停止或已处于 `stopping` 的角色不再进入 `maintenance.pausedRoleIds`；超时错误名单也只包含本次发起且已确认停止的角色。 |
| R09 刷新失败后的重试 | 额外按本轮已确认的上传结果标记已导入套，预览计划把它们当作重名跳过。服饰列表刷新失败、拿不到新名称时，再次确认导入仍只提交失败套，不会重复上传成功套。新增纯函数 `markImportedPlans` 与对应回归用例。 |

## 2. 变更文件

- 后端：`conversation-service.ts`（外部工作判定接入节点暂停、收尾确认与空闲收敛）、`app.ts`（向对话服务注入记忆忙碌判定；暂停名单只记录本次发起的停止）。
- 桌面：`use-window-session.ts`（缓冲事件优先与等待释放判定）、`AppearancePanel.tsx`（已导入集合与重试范围）、`appearance-import.js`／`.d.ts`（`markImportedPlans`）、`appearance-import.test.cjs`（重试用例）。
- 测试：`backend/tests/p18-278-review-fixes.test.ts` 新增「对话与记忆同时在途」「用户先前发起停止」两项。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p18-278-review-fixes.test.ts` | 10／10 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 368／368 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 113／113 |

验收报告：`backend/test-results/p5-2026-11-12T09-11-41-272Z-57d94c1c/summary.json`。

新增用例覆盖：

1. 第一轮对话完成后挂起后台记忆，再让第二轮对话停在模型调用；模型维护等待期间只放行对话，角色保持 `stopping`，地址未变；记忆结算后才写入并确认停止。
2. 用户先发起停止使角色进入 `stopping`，随后开始模型维护；维护成功但不把该角色列入本次暂停名单。
3. 已导入套在预览中被标为跳过，刷新失败时重试集合只包含失败套。

## 4. 交接边界

- 本文为实现方自验；R02、R09 的 Electron 交互仍需独立复验。
- [283 第 3 节](283-278-workflow-simplification-independent-review.md#3-待实施与待验收) 所列的句段标注与过场图规划维护期拦截、角色删除同页流程、草稿生图、未保存录音试听、设置导航收敛仍未实施。
