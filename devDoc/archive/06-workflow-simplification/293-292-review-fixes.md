# 293 292 独立复核问题修复

2026-11-12。按 [283 第 12 节](283-278-workflow-simplification-independent-review.md#12-292-独立复核) 修复 [292](292-278-remaining-deletion-maintenance.md) 的四项阻塞。本文为实现方自验记录，复验仍由独立复核确认。283 第 13 节复验后的补修见 [294](294-293-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| 292-R01 在途占用缺失 | 标注与过场图规划从模型调用登记成功起，到结果结算完成为止，把角色与实际使用的服务登记到后台在途表。应用层的在途汇总现在合并记忆、对话执行和后台调用；引用报告会列出 `INFLIGHT_CALL`，模型维护等待与删除检查都会等这些调用收尾。 |
| 292-R02 等待后改绑绕过维护 | 抽出共享的 `resolveOutsideMaintenance`：维护中等待，结束后重新解析；重新解析出的目标如果也在维护就继续等待，等待期间被取消则停止领取。标注与规划都改用同一实现，覆盖 A→B 改绑、同一服务连续维护与取消。 |
| 292-R03 搁置续行阻止删除 | 角色已停止时不会再启动新续行，删除前的静默检查不再把队列里搁置的续行算作在途；目录清理与索引移除照常执行，已发出的调用仍按原规则收尾。 |
| 292-R04 旧任务阻止恢复 | 恢复活动的维护检查只看角色当前启用的绑定：当前对话与记忆都在其他服务时可以恢复；仍指向维护服务的旧任务继续由调度在任务领取入口暂缓，维护结束后自动继续，不需要再次切换活动状态。 |

## 2. 变更文件

- 后端：`application/model-maintenance.ts`（新增共享解析）、`segment-annotation-service.ts` 与 `scene/model-planner.ts`（等待、重新解析、在途登记）、`conversation-service.ts`（标注登记注入、静默检查）、`resource-service.ts`（恢复检查只看启用绑定）、`bootstrap/app.ts`（后台在途汇总与装配）。
- 测试：`tests/p19-model-maintenance.test.ts`（A→B、连续维护、取消、无需等待）、`p18-278-review-fixes.test.ts`（旧任务依赖可恢复、搁置续行可删除）、`p11-scene-image-planning.test.ts`（规划与标注在途占用并阻挡服务修改）。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 381／381 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-12T15-17-08-245Z-cba47249/summary.json`。

新增用例覆盖：

1. 规划模型调用挂起时引用报告含 `INFLIGHT_CALL`、删除受限，模型地址修改等待结算后才写入。
2. 标注在途时同样计入占用并阻挡地址修改。
3. 维护等待中改绑到另一个也在维护的服务会继续等待；同一服务连续维护与取消分别返回正确结果。
4. 只剩搁置续行的已停止角色可以直接删除，不再等待静默超时。
5. 当前对话与记忆都改到新服务时，只有旧任务依赖维护服务的角色仍可恢复活动。

## 4. 交接边界

- 本文为实现方自验；Electron 的删除与恢复入口仍按 283 第 12 节场景复验。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
