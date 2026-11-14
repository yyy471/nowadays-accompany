# 298 297 补修独立复验问题修复

2026-11-13。按 [283 第 17 节](283-278-workflow-simplification-independent-review.md#17-297-补修独立复验) 修复删除超时后遗漏的已排队整理自动唤醒。297 的原问题在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。283 第 18 节复验后的补修见 [299](299-298-reverification-fixes.md)。

## 1. 修复内容

- 删除收尾失败时，先清除删除保护，再补发一次唤醒：`conversation.wakePendingWork(roleId)` 会重新检查该角色的待处理记忆触发并交给统一调度。删除期间被拒绝的维护结束唤醒（记忆服务恢复可用）因此不会丢失，已接收的整理会自动继续。
- 补发只影响该角色；删除保护仍在期间继续拒绝新工作领取；删除成功时角色已移除，不需要补发。
- 补发本身失败或再次遇到维护时不阻断删除结果，后续维护结束或消息会重新触发。

## 2. 变更文件

- 后端：`role-deletion-service.ts`（失败回调）、`bootstrap/app.ts`（删除失败后补发唤醒）。
- 测试：`tests/p18-278-review-fixes.test.ts` 新增「删除超时后补发删除期间被拒绝的维护唤醒」。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 389／389 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-13T01-41-06-782Z-d8e99570/summary.json`。

新增用例覆盖：记忆服务维护中排队的整理、已领取调用让删除超时、删除保护期间维护结束的唤醒被拒绝；删除返回 409 后保护释放，补发唤醒使原整理自动调用模型，角色保留可继续使用。

## 4. 交接边界

- 本文为实现方自验；真实记忆模型与 Electron 删除重试场景仍需按 283 第 17 节复验。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
