# 296 295 补修独立复验问题修复

2026-11-13。按 [283 第 15 节](283-278-workflow-simplification-independent-review.md#15-295-补修独立复验) 修复角色删除链路的两项缺口。295 的原修复场景在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。283 第 16 节复验后的补修见 [297](297-296-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| 292-R03 取消后提前移除角色 | 删除流程在取消过场图任务后，改为等待该角色已领取的后台调用真正释放（规划／标注的在途登记），而不只等外层任务结束。模型收到取消仍收尾时会继续等待；在现有等待期限内无法收尾时返回 409 `ROLE_BUSY` 并保留角色，可稍后重试。结算完成后才移除索引并按所选方式处理历史。 |
| 292-R03 删除期手动整理 | `POST /v1/roles/:roleId/memory/batches` 在角色处于删除收尾时返回 409 `ROLE_DELETING`，不再启动新的记忆模型调用；已有任务照常收尾，其他角色的整理入口不受影响，删除失败后同一角色恢复可用。 |

## 2. 变更文件

- 后端：`resource-service.ts`（按角色等待已领取调用释放）、`bootstrap/app.ts`（删除收尾等待与失败返回）、`routes.ts`（手动整理入口检查）。
- 测试：`tests/p11-scene-image-planning.test.ts` 新增「删除等待规划真正结算」；扩展删除期场景覆盖同角色整理被拒绝、其他角色照常、删除失败后整理恢复。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 387／387 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-13T01-09-51-326Z-d9b14c21/summary.json`。

新增用例覆盖：

1. 规划模型收到取消后仍在收尾：删除保持等待，`INFLIGHT_CALL` 仍在；模型结算后删除返回 200 并移除角色。
2. 删除收尾期间同角色手动整理返回 409 `ROLE_DELETING`，其他角色返回 202；删除失败后同角色恢复可整理。

## 4. 交接边界

- 本文为实现方自验；保留与清理两条历史路径、超时后保留角色的完整场景仍需按 283 第 15 节复验。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
