# 299 298 补修独立复验问题修复

2026-11-13。按 [283 第 18 节](283-278-workflow-simplification-independent-review.md#18-298-补修独立复验) 修复删除期间确认结束的任务丢失记忆整理的问题。298 的原问题在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。283 第 19 节复验后的补修见 [300](300-299-reverification-fixes.md)。

## 1. 修复内容

- 记忆运行时在删除保护期间收到任务结束通知时，不再直接丢弃，而是按角色记住任务编号；任务结束请求本身仍返回成功，任务状态正常落库。
- 删除失败、删除保护解除后，补发的 `wakePendingWork` 会调用记忆运行时的 `kick`：先重放删除期间记住的任务结束通知，再检查待处理触发。任务证据随后按正常流程形成一次 `task_end` 整理并只调用一次模型。
- 删除成功时角色已移除，`disposeRole` 清空这些暂存通知；关闭运行时也一并清空。删除期间被拒绝的其他新工作仍按原守卫处理。

## 2. 变更文件

- 后端：`memory-runtime.ts`（删除期暂存任务结束通知、`kick` 补发、清理）。
- 测试：`tests/p18-278-review-fixes.test.ts` 新增「删除期间确认结束的任务在删除失败后补发整理」。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 390／390 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-13T03-40-55-734Z-48e9b087/summary.json`。

新增用例覆盖：删除被在途调用挂起期间结束一个含工具结果的任务，接口返回 200；删除超时后补发唤醒，原任务的 `task_end` 整理执行一次，角色保留。

## 4. 交接边界

- 本文为实现方自验；删除成功路径不补发、真实记忆模型与 Electron 场景仍需按 283 第 18 节复验。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
