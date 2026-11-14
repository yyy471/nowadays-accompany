# 252 第一包 · 255 复核问题修复记录

2026-11-11。按 [255 独立复核](255-role-activity-independent-review.md) 修复 252 第一包的 RA-R01～RA-R04，并把恢复语义写入 [161](../../161-digital-life-direction-decisions.md)。修复后 [254](254-role-activity-config-guard.md) 的接口与状态机保持不变，只补齐复核指出的四个缺口。

## 1. 修复范围与结论

| 编号 | 复核指出的问题 | 修复结论 |
| --- | --- | --- |
| RA-R01 | 前台执行已退出、只剩后台工具时，停止一直停在 `stopping` | 最后一个后台工具结算后由对话服务确认停止；仍有后台工具在途时前台收尾不再提前确认 |
| RA-R02 | 恢复返回 200，但原任务仍是 `paused`，没有再调度 | 恢复后把因停止而暂停的任务链改回 `active` 并排队续行，同时重挂唤醒定时器 |
| RA-R03 | 全局写入读请求体期间新增角色，提交时仍返回 200 | 受保护写入读完请求体、落库之前重验一次停止条件 |
| RA-R04 | `PUT /v1/roles/:roleId/autonomy/budget` 不受保护 | 纳入角色配置写入清单；运行中与正在停止都拒绝，后端确认停止后允许 |

复核脚本 `backend/test-results/review-254/independent.ts` 的四个场景在修复后全部通过（4／4）。

## 2. RA-R01 · 后台工具结算后收敛停止

**成因。** 停止确认只有两个触发点：图节点入口命中 `ROLE_STOP_REQUESTED`，以及前台执行收尾时的兜底确认。慢工具转后台后前台执行以 `superseded` 退出，之后才请求停止时两个触发点都不会再发生；最后一个后台工具结算只把 `backgroundToolsByRole` 计数减到 0。

**修法。**

- `registerBackgroundTool` 的结算回调在计数归零时调用新增的 `confirmStopIfIdle()`：仍有执行在跑就跳过，否则用原执行的编号确认停止。
- 确认发生在结算写库之后（`onBackgroundToolSettled` 的 `.then` 先于计数递减注册），原 `tool_calls` 记录、原始响应和真实状态都保留，不改成失败、不补写 unknown。
- 同步确认之后再延后一个宏任务兜底一次，覆盖「前台执行恰好还在收尾」的竞争；重复确认由 `WHERE state='stopping'` 幂等处理。
- `runExecution` 收尾的兜底确认增加条件：仍有后台工具在途时不确认，交给最后一个工具结算后的收敛路径，避免提前放行配置写入。

**边界。** 只改活动状态，不改执行与工具调用记录。后台工具的真实结果仍按原调用结算，任务仍活跃时排队续行；恢复后由统一调度接手。

## 3. RA-R02 · 恢复后重新调度原任务

**成因。** `resume()` 只把 `role_activity` 从 `stopped` 改回 `active`，没有接通对话调度。停止时任务链与执行都记为 `paused`，用户消息保持领取，但没有任何入口再启动续行。

**修法。**

- `ActivityRuntime` 增加可选的 `resumeWork(roleId)`，由 bootstrap 注入 `conversation.rescheduleAfterStop()`；`RoleActivityService.resume()` 在状态改回 `active` 之后调用，失败不回滚状态。
- `ConversationStore.listStoppedTaskContinuations(reason)` 找出 `tasks.status='paused'`、`tasks.end_reason='ROLE_STOP_REQUESTED'` 且存在 `paused` 执行的任务与窗口。
- `rescheduleAfterStop()` 把这些任务改回 `active`、排队续行，再调用统一调度；统一调度同时重挂唤醒定时器，让停止期间到期的待办继续推进。
- `beginTaskContinuation()` 接手未处理消息时，除了 `superseded`／`failed`，也接受 `paused` 执行领取的消息。否则恢复续行提交后，原消息仍挂在已暂停的执行上，永远无法标记处理。
- 待办、任务链与自主额度一律不动：不新建任务、不清空排队、不重置额度。

**恢复语义。** 按用户此前确认的选项「原样保留，继续推进」实现，并写入 [161](../../161-digital-life-direction-decisions.md) 的 DL-148 记录：恢复后按原计划继续，停止前已排队的唤醒、未结束的任务链与剩余自主额度都不清理。

## 4. RA-R03 · 全局写入提交前重验

**成因。** 全局守卫在请求进入时校验一次，随后 `readJsonBody` 还要等请求体读完。这期间新建的角色默认 `active`，但校验已经通过，写入照常提交。

**修法。**

- `http/body.ts` 增加请求级的一次性校验钩子：`readJsonBody` 与 `readMultipartForm` 读完全部请求体后、解析与落库之前触发。
- `roleWrite` 在租约内挂 `assertStopped(roleId)`，`globalWrite` 挂 `assertAllStopped()`。钩子只在受保护写入上存在，其他接口不受影响。
- 新增角色出现在 `GET /v1/activities`（`roles` 左连接 `role_activity`，没有记录视为 `active`），因此重验能看见它并返回 409 `ROLES_NOT_STOPPED`。
- 全局租约在入口即持有，期间恢复仍返回 409 `ROLE_ACTIVITY_CONFLICT`（`CONFIG_WRITE_IN_PROGRESS`），与复核脚本的探测一致。

**边界。** 没有请求体的全局写入（如 `DELETE /v1/resources/:resourceId`）在入口校验与写入之间没有等待点，不需要额外重验。

## 5. RA-R04 · 自主额度纳入写入保护

`PUT /v1/roles/:roleId/autonomy/budget` 加入 `ROLE_CONFIG_WRITES`。运行中返回 409 `ROLE_NOT_STOPPED`（`reason=ACTIVE`），正在停止返回同一错误码（`reason=STOPPING`），后端确认停止后允许修改。

**写入清单清查。** 逐个核对全部写路由后的结论：

| 接口 | 处理 | 理由 |
| --- | --- | --- |
| `PATCH /v1/roles/:roleId/definition` | 已保护 | 角色设定 |
| `PUT /v1/roles/:roleId/bindings` | 已保护 | 模型／扩展绑定 |
| `PUT /v1/roles/:roleId/voice`、`voice/enabled`、`voice/reference`、`DELETE voice/references/:assetId` | 已保护 | 声音配置与参考音频 |
| `PUT /v1/roles/:roleId/scene-image` | 已保护 | 角色生图配置 |
| `POST /v1/roles/:roleId/appearance/outfits`、`.../sprites` | 已保护 | 外观素材 |
| `PUT /v1/roles/:roleId/autonomy/budget` | 本次新增 | 角色自主额度属于配置 |
| `PATCH`／`DELETE /v1/resources/:resourceId`、`PATCH /v1/image-services/:serviceId` | 已保护 | 全局模型与生图服务 |
| `PUT /v1/roles/:roleId/state`、`POST .../messages`、`input-state`、`tasks/:taskId/finish` | 不保护 | 运行时状态与对话操作，不是配置 |
| `POST`／`DELETE /v1/roles/:roleId/autonomy/wakes`、`memory/*`、`diaries` | 不保护 | 待办与记忆数据，不是配置；恢复时按原样保留 |
| `POST /v1/roles`、`POST /v1/resources`、`POST /v1/image-services` | 不保护 | 新建不改变既有角色正在使用的配置；全局写入期间新建角色由 RA-R03 的提交前重验拦截 |

## 6. 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 复核脚本 | `npx -y node@24 --import tsx --test test-results/review-254/independent.ts` | 4／4 通过 |
| 全量测试 | `npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts` | 325／325 通过（新增 4 项定向用例） |
| 离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，真实服务调用 0 |

验收报告：`backend/test-results/p5-2026-11-11T05-39-16-633Z-23773ece/summary.json`

新增定向用例在 `backend/tests/p14-role-activity.test.ts`：

1. `恢复后重新调度暂停的原任务，不需要再发用户消息`（RA-R02）
2. `后台工具结算后停止能收敛，且保留原调用记录`（RA-R01）
3. `自主额度写入纳入角色配置保护`（RA-R04，覆盖 active／stopping／stopped）
4. `全局写入读完请求体后重验停止条件`（RA-R03）

既有测试按「统一强制 + 同步改造」调整：`tests/p3-03-autonomy-scheduling.test.ts` 的额度写入改经 `configFetch`，CLI `autonomy budget set` 用 `activity stop → 写入 → activity resume` 包裹；`tests/p14-role-activity.test.ts` 的额度准备改为先停止再写、写完恢复。均未绕过路由守卫，也未直接改产品状态。

## 7. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/domain/role-activity.ts` | 新增 `ROLE_STOP_TASK_END_REASON`；`ActivityRuntime` 增加 `resumeWork` |
| `backend/src/application/role-activity-service.ts` | `resume()` 在恢复后调用 `resumeWork` |
| `backend/src/application/conversation-service.ts` | `confirmStopIfIdle()`；后台结算计数归零确认停止；收尾兜底确认避开在途后台工具；`rescheduleAfterStop()` |
| `backend/src/storage/conversation-store.ts` | `listStoppedTaskContinuations()`；续行接手 `paused` 执行领取的消息 |
| `backend/src/http/body.ts` | 请求体读完后的提交前校验钩子 |
| `backend/src/http/write-guard.ts` | 角色级与全局写入在读完体后重验 |
| `backend/src/http/config-writes.ts` | 额度写入加入 `ROLE_CONFIG_WRITES` |
| `backend/src/bootstrap/app.ts` | 注入 `resumeWork` |
| `backend/tests/p14-role-activity.test.ts` | 新增 4 项定向用例；额度准备改为停止后写入 |
| `backend/tests/p3-03-autonomy-scheduling.test.ts` | 额度写入改经 `configFetch` 与 CLI 活动作用域 |

## 8. 交接边界

- 本轮是实施方自验，RA-R01～RA-R04 的独立复验仍由复核方执行；独立复验通过前不宣告第一包收口。
- 252 第二包（模型与扩展资源管理）在本次修复后启动，第三包（外观、删除与历史数据）与 [253](253-role-config-settings-frontend-plan.md) 前端接入仍未开始。
- 恢复语义已按用户确认写入 161；若后续调整该规则，需同时改 `resume()` 的调度行为与本节结论。
