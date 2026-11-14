# 294 293 补修独立复验问题修复

2026-11-12。按 [283 第 13 节](283-278-workflow-simplification-independent-review.md#13-293-补修独立复验) 修复 293 之后仍存在的三项问题。本文为实现方自验记录，复验仍由独立复核确认。283 第 14 节复验后的补修见 [295](295-294-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| 292-R01／R02 检查与登记空档 | 资源服务新增 `claimModelCall`：维护检查与在途登记在同一个同步调用里完成，不再有检查通过后被新维护窗口插入的空档。标注与规划统一改用 `resolveClaimedModelBinding`：解析绑定、等待维护、改绑后复查新目标、领取调用在同一条路径内完成；领取成功后在模型请求结束或取消时释放。应用层的在途汇总改为「资源服务领取记录 + 记忆 + 对话执行」。 |
| 292-R03 未发出标注阻塞删除 | 标注的维护等待使用独立的 `waitSignal`，删除角色前先 `cancelQueuedAnnotations` 取消尚未领取的等待，再执行静默检查；已经发出的标注继续等待其结算。队列清理后删除不再等待 15 秒超时。 |
| 292-R04 停用记忆绑定阻塞恢复 | 恢复活动的维护检查改用实际的 `usageTargets`：独立记忆绑定停用后回退到对话模型，不会因为它指向维护中的服务而阻止恢复；旧任务仍由调度按目标暂缓。 |

## 2. 变更文件

- 后端：`resource-service.ts`（原子领取、在途合并、恢复目标判断）、`model-maintenance.ts`（领取式解析）、`segment-annotation-service.ts`（领取与等待信号）、`scene/model-planner.ts`（领取式解析）、`conversation-service.ts`（标注等待取消、关闭清理）、`bootstrap/app.ts`（装配与删除前取消）。
- 测试：`tests/p19-model-maintenance.test.ts`（检查后插入维护、改绑复查、连续维护、取消）、`p18-278-review-fixes.test.ts`（未领取标注不阻塞删除、停用记忆绑定可恢复）、`p11-scene-image-planning.test.ts`（原有在途占用用例继续通过）。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 384／384 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-12T15-53-01-328Z-69ad9041/summary.json`。

新增用例覆盖：

1. 最后一次维护检查后、领取前被新维护窗口插入时，领取被拒绝并继续等待；等待期间取消不领取调用。
2. 等待后改绑到也在维护的服务继续等待，同一服务连续维护持续等待。
3. 标注在维护窗口排队、尚未领取时删除角色，取消等待后立即完成删除。
4. 停用的独立记忆绑定回退到对话服务后，维护旧记忆服务不阻止角色恢复。

## 4. 交接边界

- 本文为实现方自验；Electron 的删除与恢复入口仍按 283 第 13 节场景复验。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
