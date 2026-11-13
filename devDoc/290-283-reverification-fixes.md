# 290 283 第 9 节复验问题修复

2026-11-12。按 [283 第 9 节复验](283-278-workflow-simplification-independent-review.md#9-289-补修独立复验) 修复两处桌面端扩展缺口。第 8 节的两个原场景在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。283 第 10 节复验后的补修见 [291](291-283-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| R01 占用解除后删除仍不可用 | 模型详情的占用区新增「重新检查占用」按钮；存在 `INFLIGHT_CALL` 占用时每 3 秒自动刷新引用，调用结算后删除按钮就地恢复，无需切换设置分区。检查按目标资源独立进行，不影响其他详情。 |
| R02 手动同文本草稿被清空 | 草稿恢复时按窗口记录「恢复来源文本 + 是否被用户编辑」。快照确认原提交时由页面判断是否清空：只有未编辑过且与恢复文本一致的草稿才清空；用户手动改过（即使后来改回相同文本）一律保留。纯函数 `shouldClearRecoveredDraft` 承载该规则并有回归用例。重新输入相同文本仍使用新的提交标识，尚未确认的提交继续保留去重保护。 |

## 2. 变更文件

- 桌面：`Settings.tsx`（重新检查占用、在途占用轮询刷新）、`Conversation.tsx`（按窗口记录恢复草稿与编辑状态、确认时收敛）、`ChatPane.tsx`（接收清空信号）、`window-model.js`／`.d.ts`（`shouldClearRecoveredDraft`）、`conversation-window-model.test.cjs`（草稿归属用例）。
- 后端未改动。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 372／372 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-12T11-52-03-668Z-a0db6d1a/summary.json`。

新增用例覆盖：

1. 未编辑的恢复草稿在快照确认时清除。
2. 用户手动改成相同文本仍视为编辑、保留草稿；不同内容与无恢复记录时不清空。

## 4. 交接边界

- 本文为实现方自验；两处交互仍需 Electron 复验（占用解除后删除就地可用；编辑过与未编辑过的草稿分别保留与清除）。
- [283 第 3 节](283-278-workflow-simplification-independent-review.md#3-待实施与待验收) 所列的句段标注与过场图规划维护期拦截、角色删除同页流程、草稿生图、未保存录音试听、设置导航收敛仍未实施。
