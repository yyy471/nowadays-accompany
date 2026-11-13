# 288 283 第 7 节复验问题修复

2026-11-12。按 [283 第 7 节复验](283-278-workflow-simplification-independent-review.md#7-287-补修独立复验) 修复两处扩展场景缺口。第 6 节的两个原场景在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。283 第 8 节复验后的补修见 [289](289-283-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| R01 停用或改绑后的旧在途调用 | 维护等待名单改为直接查询目标服务的实际在途调用，不再与当前影响范围取交集。记忆运行时按目标服务提供在途角色；对话执行也登记本轮固定的模型服务。即使服务已全局停用或角色已改绑到其他服务，旧调用仍留在等待名单中，结算后才写入地址。暂停与恢复名单仍按当前角色状态和操作归属计算，未发起停止的角色不进入恢复名单。 |
| R02 切窗口后的同文本重发 | 读取窗口快照时对照原提交记录：快照中已存在同一 `submissionId` 的消息即认为原提交已确认，结束对应的重试记录。切到其他窗口期间生成回复、再切回来发送相同文本时会使用新的提交标识；尚未确认的提交仍保留原标识用于去重。新增纯函数 `isSubmissionConfirmed` 与回归用例。 |

## 2. 变更文件

- 后端：`conversation-service.ts`（登记执行固定的模型服务并暴露在途角色）、`resource-service.ts`（等待名单直接取目标服务在途调用）、`app.ts`（合并记忆与对话的在途角色）。
- 桌面：`use-window-session.ts`（读取快照时收敛重试记录）、`window-model.js`／`.d.ts`（`isSubmissionConfirmed`）、`conversation-window-model.test.cjs`（快照收敛用例）。
- 测试：`backend/tests/p18-278-review-fixes.test.ts` 新增「服务停用后等待旧在途调用」「改绑到其他服务后等待旧服务在途调用」两项。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p18-278-review-fixes.test.ts` | 12／12 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 371／371 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 114／114 |

验收报告：`backend/test-results/p5-2026-11-12T10-28-04-307Z-dfef43e4/summary.json`。

新增用例覆盖：

1. 已停止角色在目标服务上的记忆调用挂起时全局停用该服务，影响范围不再包含角色；修改地址仍等待旧调用结算，结算后返回 200 且暂停名单为空。
2. 同一在途调用期间把角色改绑到其他服务，当前影响范围为空；修改旧服务地址仍等待原调用结算。

## 4. 交接边界

- 本文为实现方自验；R02 的切窗口重发仍需按 Electron 场景复验。
- [283 第 3 节](283-278-workflow-simplification-independent-review.md#3-待实施与待验收) 所列的句段标注与过场图规划维护期拦截、角色删除同页流程、草稿生图、未保存录音试听、设置导航收敛仍未实施。
