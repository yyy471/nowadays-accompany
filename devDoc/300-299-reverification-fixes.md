# 300 299 补修独立复验问题修复

2026-11-13。按 [283 第 19 节](283-278-workflow-simplification-independent-review.md#19-299-补修独立复验) 修复记忆服务晚于删除超时恢复时丢失任务整理的问题。299 的原场景在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。283 第 20 节复验后的补修见 [301](301-300-reverification-fixes.md)。

## 1. 修复内容

- 删除失败后补发的 `kick` 只负责安排一次调度，不再提前把暂存的任务结束通知搬进运行队列。通知保留在暂存区，直到出现真正可运行的记忆批次。
- 记忆运行时在处理批次时、确认服务不在维护后，才把暂存的任务编号并入本批任务列表；`onTaskFinished` 据此写入持久化 `task_end` 触发并继续整理。
- 维护中提前返回的批次不会消费暂存通知；维护结束后再次唤醒时，原任务仍会形成一次整理。删除成功时 `disposeRole` 仍会清空暂存。

## 2. 变更文件

- 后端：`memory-runtime.ts`（暂存任务通知的保留与批次内吸收、`kick` 调度）。
- 测试：`tests/p18-278-review-fixes.test.ts` 新增「记忆服务晚于删除超时恢复时仍补发任务整理」。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 391／391 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-13T04-00-44-492Z-2b2516d6/summary.json`。

新增用例覆盖：任务在删除期结束并缓存通知，记忆服务在删除超时后才结束维护；超时期间没有模型调用，维护结束后原任务自动形成一次 `task_end` 整理，角色保留。

## 4. 交接边界

- 本文为实现方自验；真实记忆模型、保留与清理两条删除路径及 Electron 场景仍需按 283 第 19 节复验。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
