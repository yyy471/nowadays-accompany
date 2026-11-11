# 角色活动与配置写入保护独立复核

2026-11-11。复核 `dev-front` 上 [254](254-role-activity-config-guard.md) 对 [252 第一包](252-role-config-settings-development-plan.md#第一包--角色活动与配置写入保护) 的实现。常规活动状态、空闲停止、前台节点暂停、角色写入拦截和现有角色恢复与写入互斥均通过正式回归。四个补充场景失败，第一包未通过独立复核。

## RA-R01 · P2 · 后台工具结算后仍卡在正在停止

让本机模拟工具转入后台，等前台执行退出，再请求停止。工具返回成功后，原调用记录已结算，活动接口却持续返回 `state=stopping`、`running=false`，修改人设仍返回 409。停止确认目前由前台执行收尾触发，最后一个后台工具结算时只更新计数。应为这个场景明确停止确认和晚到结果处理，使停止状态能收敛，并保留原调用记录。 [后台结算计数](../backend/src/application/conversation-service.ts#L1715)

## RA-R02 · P2 · 恢复接口成功后原任务未重新调度

在模型与工具节点之间暂停一条已有对话任务。调用恢复返回 200，角色状态变为 `active`，原任务仍为 `paused`，模型调用数保持 2。整个过程没有再次发送用户消息。恢复目前仅写活动状态，未接通已有调度。应按确认后的恢复语义处理原任务与到期待办。 [恢复入口](../backend/src/application/role-activity-service.ts#L109)

## RA-R03 · P2 · 全局写入等待期间新增角色会绕开停止条件

停止唯一角色，发起修改全局模型的请求，让请求体尚未读完。此时恢复原角色按预期被拒，说明全局写入保护已生效。随后另一个请求成功创建了默认 `active` 的角色。继续完成原请求后，修改返回 200，模型名称已更新。全局校验只在开始时执行，期间仍可新增活动角色。应使角色创建与全局写入协调，或在提交时重验。 [全局写入校验](../backend/src/application/role-activity-service.ts#L175) · [创建角色入口](../backend/src/http/routes.ts#L113)

## RA-R04 · P2 · 自主额度修改未纳入角色写入保护

角色处于 `active` 时调用 `PUT /v1/roles/:roleId/autonomy/budget` 返回 200，重新读取确认每日上限已经改为 7。该操作属于角色配置，当前没有纳入配置写入清单。应验证运行和正在停止时拒绝修改，后端确认停止后允许修改。 [额度写入](../backend/src/http/routes.ts#L424) · [写入清单](../backend/src/http/config-writes.ts#L10)

## 验证及交接范围

定向复核使用隔离数据、离线模型和本机模拟 MCP，证据位于 `backend/test-results/review-254/independent.log`。后端 321 项正式测试与 21 步离线验收通过，报告位于 `backend/test-results/p5-2026-11-11T03-55-57-065Z-a7945c06/summary.json`。

254 采用「待办与额度原样保留、继续推进」作为实现方案。252 仍将恢复时的待办和额度处理列为待确认项，正式接口应以用户确认并写入 161 的规则为准。模型与扩展资源管理、外观及删除为 252 后续工作包。前端开发和整体验收的最新排期见 [253](253-role-config-settings-frontend-plan.md)。

## 256 修复独立复验

2026-11-11。RA-R01～RA-R04 的原始复现全部通过，已在原场景关闭。合并重跑 P14、P15 与四个独立用例，共 19 项通过。

| 编号 | 独立复验结果 |
| --- | --- |
| RA-R01 | 后台工具成功结算后，角色进入 `stopped`、`running=false`，人设保存返回 200。 |
| RA-R02 | 恢复接口重新调度原任务，未新增用户消息。原任务进入 `completed`，模型调用数由 2 变为 3。 |
| RA-R03 | 全局模型修改读取请求体期间新增活动角色，提交前重验返回 409，模型名称保持原值。 |
| RA-R04 | 活动中的额度写入返回 409，读取仍是原额度。确认停止后写入返回 200。 |

恢复时保留待办、原任务链和剩余额度的用户确认已记录在 [161 变更记录](161-digital-life-direction-decisions.md)，对应实现见 [256](256-role-activity-review-fixes.md)。

### RA-R05 · P2 · 重启后空闲角色仍卡在正在停止

在临时库写入已请求停止的状态，模拟进程在写入 `stopping` 后、确认停止前退出。重新创建后端并查询活动，角色返回 `state=stopping`、`running=false`。保存人设返回 409 `ROLE_NOT_STOPPED`，再次请求停止才进入 `stopped`。启动恢复处理了执行记录，但没有收敛已无工作可等待的停止请求。应在恢复执行记录后核对持久化的停止状态，确认没有在途执行或待结算结果后自动收敛，并保留已存任务和调用证据。第一包仍有此项待修。复现输出见 `backend/test-results/review-257/independent.log`。 [后端启动恢复](../backend/src/bootstrap/app.ts#L160)

## 259 修复独立复验

2026-11-11。按 [259](259-role-activity-resource-review-fixes.md) 重跑 RA-R05 原始脚本与正式回归。用临时库模拟进程在确认停止前退出，重启后首次查询即返回 `stopped`、`running=false`，人设写入返回 200，无需再次停止。正式用例同时核对了确认时间和显式恢复活动。RA-R01～RA-R04 原始场景重跑仍通过，第一包在已验离线范围通过独立复验。

本轮合并运行 P14、P15 和两组原始独立脚本，共 27 项全部通过。输出见 `backend/test-results/review-259/independent-recheck.log`。第二包的扩展验证见 [258](258-resource-management-independent-review.md#259-修复独立复验)。
