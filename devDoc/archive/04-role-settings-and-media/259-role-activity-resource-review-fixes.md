# 255／258 复核问题修复记录

2026-11-11。按 [255 独立复验](255-role-activity-independent-review.md) 的 RA-R05 与 [258 独立复核](258-resource-management-independent-review.md) 的 RP-R01～RP-R03 修复 252 第一、二包。修复后 [254](254-role-activity-config-guard.md) 的活动状态机、[257](257-resource-management.md) 的资源接口与绑定整表约定保持不变，只补齐复核指出的四个缺口。资源写入按类型分流时依据 [161](../../161-digital-life-direction-decisions.md#dl-148-配置修改直接删除与运行限制) 的 DL-148：模型服务要求全角色停止，MCP／Skill 按占用判断。258 在 259 复验中追加的 RP-R04（预检通过后删除写入失败仍丢失绑定）见第 6 节；258 在第 6 节补修复验中追加的 RP-R05（逐库提交中断后资源仍在、绑定已丢失）见第 7 节；258 第 7 节补修复验追加的 RP-R06／RP-R07（删除收尾与重试）见第 8 节。

## 1. 修复范围与结论

| 编号 | 复核指出的问题 | 修复结论 |
| --- | --- | --- |
| RA-R05 | 进程在请求停止与确认之间退出，重启后一直停在 `stopping` | 执行记录恢复后核对持久化停止状态，无在途执行或后台工具的角色自动确认停止 |
| RP-R01 | 共用路由把所有资源的 PATCH／DELETE 交给全角色停止守卫 | 资源写入按 `kind` 分流：模型走全角色停止，MCP／Skill 交给服务层占用检查 |
| RP-R02 | 角色库不可读时引用扫描吞错，把实际占用当成空 | 引用扫描无法完成时抛出 `STORAGE_ERROR`，依赖该报告的写入一并失败 |
| RP-R03 | 删除逐库清理，后续角色库失败时前序绑定已被移除 | 删除前先完成引用检查并打开全部角色业务库，失败时原绑定保持可读，重试收敛 |
| RP-R04 | 预检通过后，清理写入或最终资源删除失败，仍丢失已提交的绑定 | 绑定清理与资源删除放进跨连接的一组事务，任一步失败全部回滚，失败时资源与绑定都保持原样 |
| RP-R05 | 跨连接依次提交：后续 COMMIT 失败或进程中断后，资源与绑定的可见状态不一致 | 资源删除与待清理记录在全局库同事务先提交；残留绑定由读侧过滤、启动恢复与重试继续清理 |
| RP-R06 | 清除待清理记录失败会误报删除失败并阻断启动 | 决策提交后的收尾失败保留记录并返回成功；启动清理逐条容错，单条失败不阻断启动 |
| RP-R07 | 重试同一 DELETE 在资源不存在处提前结束，不继续清理 | 删除入口先识别待清理记录，重试同一 DELETE 继续清理并幂等成功 |

复核脚本 `backend/test-results/review-257/independent.ts` 的四个场景在修复后全部通过（4／4），输出保存在 `backend/test-results/review-259/independent.log`。

## 2. RA-R05 · 重启后收敛无在途执行的停止请求

**成因。** 停止确认只发生在运行中的执行命中图节点边界、前台执行收尾、最后一个后台工具结算这几条路径。进程在写入 `stopping` 之后、确认之前退出时，重启后的恢复流程只处理执行记录，没有任何路径再确认这条停止请求，角色会一直停在 `stopping`，配置写入持续返回 409。

**修法。**

- `RoleActivityService.reconcileStartup()` 遍历持久化活动记录，只处理 `stopping`：运行时报告仍有执行或后台工具在跑时跳过，其余直接调用 `RoleActivityStore.confirmStop` 收敛为 `stopped`。
- `bootstrap` 在 `conversation.recoverOnStartup()` 之后调用。执行恢复过程中重新接回的执行会同步登记为运行中，因此不会被这次收敛误停，仍等下一个可保存节点确认。
- 收敛只改活动状态，不删除任务、任务链或工具调用记录；`confirmStop` 的 `WHERE state='stopping'` 保证幂等，也不会覆盖之后发生的恢复。

**边界。** 重启前仍在跑的执行由既有恢复流程接回；本次收敛只处理「已无工作可等待」的停止请求，相当于把空闲停止的正常确认路径补到启动阶段。

## 3. RP-R01 · 资源写入按类型分流

**成因。** `config-writes.ts` 把 `PATCH`／`DELETE /v1/resources/:resourceId` 与生图服务一起列为全局写入，路由守卫在进入时统一要求所有角色已停止。MCP／Skill 的占用规则本应是「目标资源被角色开启或未结束任务链保留」，与无关角色是否活动无关，共用守卫导致未绑定扩展也被 409 `ROLES_NOT_STOPPED` 拦截。

**修法。**

- `config-writes.ts` 新增 `RESOURCE_CONFIG_WRITES`，把两个资源写入从 `GLOBAL_CONFIG_WRITES` 拆出；`ConfigWriteScope` 增加 `resource` 类型与 `resourceId`。`GLOBAL_CONFIG_WRITES` 只保留生图服务。
- `write-guard.ts` 新增 `resourceWrite`：请求进入时按 `resourceId` 读取资源类型。模型资源复用原有全角色停止守卫（含读完请求体后的提交前重验）；MCP／Skill 直接交给处理器，由 `ResourceService.references`／`assertNotInUse` 返回 `RESOURCE_IN_USE` 与占用原因。资源不存在或暂不可读时交给处理器给出正式错误响应。
- 测试客户端 `tests/config-write.ts` 同步清单：资源写入先读取 `kind`，只有模型资源才执行「停止全部角色 → 写入 → 恢复」作用域。

**边界。** 模型服务的修改、删除仍要求所有角色停止；MCP／Skill 的修改、全局关闭与删除按 DL-148 的占用判断，关闭的绑定不单独阻止操作。资源**创建**仍不属于受保护的修改／删除范围。

## 4. RP-R02 · 引用扫描失败不吞错

**成因。** `references()` 逐个角色库读取绑定与未结束任务链时捕获并忽略存储错误，把读不到的角色当成「没有引用」。后续修改与删除依据不完整的报告放行，实际占用仍保留。

**修法。** 去掉吞错分支，`RoleAccess.withStore` 的 `STORAGE_ERROR` 直接向上抛出。`GET /v1/resources/:id/references` 返回 500 `STORAGE_ERROR`；`update()`／`remove()` 依赖同一报告，在校验阶段失败，资源、绑定与开关都不被改动。角色库恢复后读取与写入自动恢复。

## 5. RP-R03 · 删除前预检保持绑定

**成因。** `remove()` 按角色逐个打开业务库清理绑定，后一个角色库不可读时前一个角色的绑定已经被删除，失败无法撤销；资源仍在但部分绑定丢失。

**修法。**

- `RoleAccess.openReadyStores()` 一次性打开全部 ready 角色的业务库，任一库打不开就关闭已打开句柄并报错。
- `remove()` 的顺序改为：生成引用报告 → 校验 `canDelete` → 预检并打开全部角色库 → 逐库清理绑定 → 在 app 库事务里清除密钥并删除资源。前两步或预检失败时尚未改动任何绑定，原绑定保持可读。
- 清理本身按 `resource_id` 删除，是幂等的；存储恢复后重试会接着清理剩余角色并完成资源删除。

**边界。** 角色业务库各自独立，跨库事务不可用。若在所有库都成功打开后仍出现清理写失败，可能留下部分已清理的绑定与未删除的资源，但不会留下指向已删资源的悬空绑定；再次删除会收敛。启动恢复、配置写入与资源删除之外没有新增后台清理任务。

## 6. RP-R04 · 删除写入失败时回滚全部绑定

**成因。** 第二章的预检只保证引用扫描和角色库都能打开，之后的清理逐库提交，最后才删全局资源。第二个角色的绑定删除或最终资源删除在语句层失败时，先前角色的绑定已经提交，接口返回 500 但资源仍可读、部分绑定已丢失。

**修法。**

- 新增 `storage/transaction-group.ts` 的 `runAtomicallyAcross()`：对参与操作的每个连接依次 `BEGIN IMMEDIATE`，全部语句成功后才逐个 `COMMIT`；任一步抛错则回滚所有已开启的事务。
- `ResourceService.remove()` 把「逐库清理绑定 + 清除密钥 + 删除资源」整体放进这一组事务。第二步的删除语句失败时，先前角色的绑定删除一并回滚，失败响应与可见状态一致：资源仍在、原绑定全部保留。
- 故障注入验证覆盖两处：第二个角色库的绑定删除失败、全局库的资源删除失败。移除注入后重试都成功删除资源，确认可重试收敛。

**边界。** 角色业务库与 app 库是独立文件，SQLite 不支持跨库事务；本实现保证语句级失败（约束、触发器、写入错误）全部回滚。`COMMIT` 阶段的进程级 I/O 故障无法跨库原子回滚，不在可保证范围内，也未做持久化删除进度。读侧不缓存绑定，回滚后的状态与失败前一致。

## 7. RP-R05 · 逐库提交中断后的一致可见状态

**成因。** 第 6 节的 `runAtomicallyAcross()` 在各连接上依次提交：后续连接 `COMMIT` 失败时，先前已提交的角色库无法由 `ROLLBACK` 恢复；进程在第一次 `COMMIT` 后退出时，也没有删除记录可供启动恢复。两种情况下资源仍可读，但部分原绑定已经消失，失败响应与可见状态不一致。

**修法。**

- app 库 V5→V6 新增 `resource_deletions` 表（待清理的已删除资源），老库升级直接建表。
- `storage/transaction-group.ts` 改为 `runWithDecisionCommit()`：先对全部连接 `BEGIN IMMEDIATE`，语句全部成功后才提交；**决策库（app 库）先提交**，其余连接随后逐个提交。决策库提交前的任何语句或提交失败都会回滚全部连接，原配置完整保留；决策库提交成功后才接受删除，后续连接提交失败只影响清理进度。
- `ResourceService.remove()` 把「角色库绑定清理 + 资源删除 + 清除密钥 + 待清理记录」放进这一组事务，其中资源删除与待清理记录属于 app 库的同一事务。决策提交成功且角色库全部提交后清除待清理记录；角色库提交失败时保留记录，删除仍算已接受。
- `ResourceService.reconcilePendingDeletions()` 在 `bootstrap` 启动恢复阶段继续清理残留绑定，角色库暂不可读时保留记录等下一次；`listBindings()` 过滤待清理资源的绑定，`ModelBindingResolver.tryResolve()` 对已删资源按「未绑定」处理，避免残留绑定进入页面或对话。

**边界。** 决策库提交前失败仍返回 500 并完整回滚（RP-R04 的两个故障注入场景不变）。决策库提交后的进程中断或 `COMMIT` 故障属于「删除已接受」：读侧立即按删除状态呈现，物理清理由待清理记录在本次请求、启动恢复或后续重试中完成，不新增常驻后台任务。`COMMIT` 阶段的多库原子性仍不在保证范围内，改用持久化记录换取一致的可见状态。

## 8. RP-R06／RP-R07 · 删除收尾与重试

**成因。** 第 7 节的 `remove()` 在角色库全部提交后直接清除待清理记录：该删除失败时异常冒泡为 500，而资源与绑定其实已经删除。启动恢复的 `reconcilePendingDeletions()` 也没有隔离单条失败，清除记录失败会中断 `bootstrap`。另外，决策提交后残留绑定的清理若未完成，重试同一 `DELETE` 会先走引用查询，资源已不存在直接返回 404，永远到不了清理路径。

**修法。**

- `remove()` 在决策提交且角色库全部提交后清除待清理记录时捕获失败：记录保留，已接受的删除仍返回成功（RP-R06）。
- 启动清理改为逐条调用 `cleanupPendingDeletion()`：单条的角色库打开、绑定清理或记录清除失败都只保留该条记录，不向上抛出；待清理列表读取失败也返回 0，不阻断 `bootstrap`（RP-R06）。
- `remove()` 入口先检查 `isResourceDeletionPending(resourceId)`：命中时直接继续清理并幂等返回成功，使公开的 `DELETE` 成为重试入口，而不是在 `RESOURCE_NOT_FOUND` 处提前结束（RP-R07）。

**边界。** 决策提交前的失败仍返回 500 并完整回滚。重试只处理已接受删除的收尾，不重新校验引用；残留绑定已按删除状态从读取视图过滤。待清理记录清除失败时会一直保留到下次启动或删除重试，读取视图在此期间仍按删除状态呈现。

## 9. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `npx -y node@24 --import tsx --test tests/p14-role-activity.test.ts tests/p15-resource-management.test.ts` | 26／26 |
| 复核脚本原样重跑 | `npx -y node@24 --import tsx --test test-results/review-257/independent.ts` | 4／4；证据见 `test-results/review-259/independent.log` |
| RP-R04 故障注入原样重跑 | `npx -y node@24 --import tsx --test test-results/review-259/delete-write-failure.ts` | 2／2 |
| RP-R05 提交失败与中断原样重跑 | `npx -y node@24 --import tsx --test test-results/review-259/delete-commit-failure.ts` | 2／2；证据见 `test-results/review-259/delete-commit-failure-fixed.log` |
| RP-R06／RP-R07 收尾与重试原样重跑 | `npx -y node@24 --import tsx --test test-results/review-259/delete-cleanup-edges.ts` | 2／2；证据见 `test-results/review-259/delete-cleanup-edges-fixed.log` |
| 全量测试 | `--test-concurrency=8 tests/*.test.ts` | 343／343 |
| 离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0`、`sourceUnchanged=true` |

验收报告：`backend/test-results/p5-2026-11-11T09-10-53-060Z-5db1d81d/summary.json`。

新增定向用例：

1. `tests/p14-role-activity.test.ts`：`重启后收敛已无在途执行的停止请求`（RA-R05）。
2. `tests/p15-resource-management.test.ts`：`角色活动期间仍可维护未占用的扩展资源`（RP-R01，覆盖无关角色活动、未绑定资源三项写入放行，以及被绑定资源的 `RESOURCE_IN_USE` 拒绝与占用原因）。
3. `tests/p15-resource-management.test.ts`：`角色库不可读时引用检查失败并拒绝写入`（RP-R02）。
4. `tests/p15-resource-management.test.ts`：`删除失败不会移除已处理的角色绑定`（RP-R03，覆盖失败保持绑定与恢复后重试收敛）。
5. `tests/p15-resource-management.test.ts`：`删除写入失败时回滚全部绑定（second-role-binding／final-resource-delete）`（RP-R04，用 SQLite 触发器分别注入绑定删除与资源删除失败）。
6. `tests/p15-resource-management.test.ts`：`删除决策提交失败时保留原配置`（RP-R05，用延迟外键让资源删除的 `COMMIT` 失败）。
7. `tests/p15-resource-management.test.ts`：`删除决策提交后中断，重启继续清理残留绑定`（RP-R05）。
8. `tests/p15-resource-management.test.ts`：`待清理状态下列表过滤残留绑定并可重试清理`（RP-R05 的读侧过滤与恢复清理）。
9. `tests/p15-resource-management.test.ts`：`清理记录写入失败不阻断已接受的删除`（RP-R06，覆盖删除请求返回成功与保留故障启动）。
10. `tests/p15-resource-management.test.ts`：`重试同一 DELETE 继续清理残留绑定`（RP-R07，覆盖公开入口重试清理）。

既有用例未放宽断言：`tests/p14` 的全局模型写入拒绝与提交前重验仍按 `ROLES_NOT_STOPPED` 验证；`tests/p15` 既有的 MCP 占用检查、关闭绑定清理与脱敏用例保持原样。

## 10. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/application/role-activity-service.ts` | 新增 `reconcileStartup()` |
| `backend/src/bootstrap/app.ts` | 执行恢复后调用活动收敛（RA-R05）；启动时继续清理已删除资源的残留绑定（RP-R05） |
| `backend/src/http/config-writes.ts` | 新增 `RESOURCE_CONFIG_WRITES`；作用域增加 `resource` 与 `resourceId` |
| `backend/src/http/write-guard.ts` | 新增 `resourceWrite()`，按资源类型分流 |
| `backend/src/http/routes.ts` | 资源写入注册按类型守卫 |
| `backend/src/application/role-access.ts` | 新增 `openReadyStores()` 预检打开 |
| `backend/src/application/resource-service.ts` | 引用扫描不再吞错；删除先预检，决策库先提交并保留待清理记录；收尾清除失败保留记录并返回成功；新增 `reconcilePendingDeletions()`、`cleanupPendingDeletion()` 与读侧过滤（RP-R03～RP-R07） |
| `backend/src/application/model-binding-resolver.ts` | 已删资源的残留绑定按未绑定处理（RP-R05） |
| `backend/src/storage/schema.ts` | app 库 V5→V6：新增 `resource_deletions` 待清理记录表 |
| `backend/src/storage/app-store.ts` | 新增 `recordResourceDeletion()`／`listResourceDeletions()`／`isResourceDeletionPending()`／`clearResourceDeletion()` |
| `backend/src/storage/transaction-group.ts` | 新增 `runWithDecisionCommit()`：决策库先提交，提交前失败全部回滚（RP-R05） |
| `backend/tests/config-write.ts` | 资源作用域先读取类型，仅模型资源停止全部角色 |
| `backend/tests/p14-role-activity.test.ts` | 新增 RA-R05 用例 |
| `backend/tests/p15-resource-management.test.ts` | 新增 RP-R01～RP-R07 十个用例（RP-R04～RP-R07 覆盖故障注入、提交失败、中断恢复与重试收尾） |
| `backend/tests/p1-02-storage.test.ts`、`p12-role-settings.test.ts` | app 库版本与表清单更新为 V6 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/252-role-config-settings-development-plan.md`、`devDoc/254-role-activity-config-guard.md`、`devDoc/257-resource-management.md`、项目工作记忆 |

## 11. 交接边界

- 本文记录实施方自验。RA-R05 和 RP-R01～RP-R07 均已通过原场景独立复验，第一、二包在已验离线范围通过。见 [255 复验](255-role-activity-independent-review.md#259-修复独立复验) 和 [258 第 8 节补修复验](258-resource-management-independent-review.md#259-第-8-节补修独立复验)。
- [253](253-role-config-settings-frontend-plan.md) 前端与后端并行开发。252 第三包（外观、删除与历史数据）仍待实施，接口交付后接入。
- 资源写入保护仍在 HTTP 路由层；`ResourceService` 直接调用属于测试夹具或脚本路径，不经过活动守卫。
- 删除资源的清理没有跨库原子提交，改用「决策库先提交 + 待清理记录」：决策提交前的失败仍完整回滚；提交后的进程中断、收尾失败或后续清理失败由启动恢复、公开删除重试与读侧过滤收敛，取舍见第 5～8 节。
