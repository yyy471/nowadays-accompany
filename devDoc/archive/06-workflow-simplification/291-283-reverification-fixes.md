# 291 283 第 10 节复验问题修复

2026-11-12。按 [283 第 10 节复验](283-278-workflow-simplification-independent-review.md#10-290-补修独立复验) 修复两处桌面端缺口。第 9 节的两个原场景在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| R01 慢响应轮询丢弃 | 模型详情的引用查询改为「资源令牌 + 请求序号」：轮询发起的新请求不再让上一请求失效，慢于 3 秒周期的响应仍可应用；同一资源内只有较新的响应能覆盖较旧的。切换资源、关闭详情或卸载时令牌变化，旧响应一律丢弃。存在在途占用时继续轮询，直到占用解除后按钮就地恢复。 |
| R02 清空信号重放 | 输入区消费清空信号后立即回调父页面丢弃该信号；切到其他窗口再切回来时不再重放。清空仍只在快照确认原提交、且恢复草稿未被编辑时产生一次。清理完成后新写草稿并多次切窗不会被清空。 |

## 2. 变更文件

- 桌面：`Settings.tsx`（引用查询令牌与序号）、`ChatPane.tsx`（清空信号消费回调）、`Conversation.tsx`（消费后清除信号）。
- 后端未改动。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 372／372 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-12T13-10-16-057Z-a2a0fd58/summary.json`。

## 4. 交接边界

- 本文为实现方自验；两处交互仍需 Electron 复验（慢于轮询周期的引用响应、清空信号只执行一次）。
- [283 第 3 节](283-278-workflow-simplification-independent-review.md#3-待实施与待验收) 所列的句段标注与过场图规划维护期拦截、角色删除同页流程、草稿生图、未保存录音试听、设置导航收敛仍未实施。
