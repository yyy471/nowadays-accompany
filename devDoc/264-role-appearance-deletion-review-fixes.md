# 252 第三包 · 263 复核问题修复记录

2026-11-11。按 [263 独立复核](263-role-appearance-deletion-independent-review.md) 修复 252 第三包的 AD-R01～AD-R04。修复后 [262](262-role-appearance-deletion-history.md) 的接口、数据结构与删除语义保持不变，只补齐复核指出的四个缺口；角色删除现在必须显式选择是否保留历史。

## 1. 修复范围与结论

| 编号 | 复核指出的问题 | 修复结论 |
| --- | --- | --- |
| AD-R01 | 并发删除各自通过「至少保留一个」检查，最终删到零个角色 | 删除请求串行执行，「至少保留一个」在移除索引的同一事务里复验 |
| AD-R02 | 省略 `keepHistory` 时默认清理历史 | 首次删除必须显式传值；缺失返回 400 `KEEP_HISTORY_REQUIRED`，角色与目录保持不变 |
| AD-R03 | 角色已删除，清理记录删除失败却返回 500 | 决策提交后的收尾失败保留待清理记录，按实际删除结果返回成功 |
| AD-R04 | 旧立绘清理失败使替换返回 500，并删除已经生效的新立绘文件 | 素材清理改为提交后的尽力清理，新图、当前指向与成功响应保持一致 |
| AD-R05 | 上传在异步解码期间服饰被删除，仍向已删除服饰写入素材 | 素材写入与「服饰仍有效」在同一事务里复验，拒绝后清理本次写入的文件 |
| AD-R06 | 角色删除与在途素材上传并行，上传把素材写回已删除角色 | 同一角色的配置写入与删除串行执行，删除等在途上传结束后才移除索引与清理目录 |

复核脚本 `backend/test-results/review-262/independent.ts` 的四个场景在修复后全部通过（4／4），输出保存在 `backend/test-results/review-262/independent-fixed.log`；[263 第 264 复验](263-role-appearance-deletion-independent-review.md#264-修复独立复验) 追加的 AD-R05 由 `backend/test-results/review-262/appearance-races.ts` 覆盖（3／3，含既有的晚到标注用例），输出保存在 `backend/test-results/review-262/appearance-races-fixed.log`；[263 第 6 节补修复验](263-role-appearance-deletion-independent-review.md#264-第-6-节补修独立复验) 追加的 AD-R06 由 `backend/test-results/review-262/role-upload-race.ts` 覆盖（2／2），输出保存在 `backend/test-results/review-262/role-upload-race-fixed.log`。

## 2. AD-R01 · 并发删除保留至少一个角色

**成因。** `remove()` 在等待运行时收尾（`await runtime.dispose`）之前检查角色数量，之后写事务直接删除索引。两个并发 DELETE 分别在收尾等待期间通过检查，最终把两个角色都删除。

**修法。**

- `RoleDeletionService.remove()` 用内部队列串行化删除请求：后一个请求在前一个完成后再进入，避免交错检查。
- 保留收尾前的快速检查，用于在不触碰运行时的前提下直接拒绝；权威检查移到「移除角色」的同一事务里，事务内重新统计角色数量，少于两个时抛 409 `LAST_ROLE_REQUIRED`，事务整体回滚。
- 串行化只覆盖本进程；事务内复验仍防止其他进程在检查与写入之间插入删除。

**边界。** 并发删除同一角色时，后一个请求看到角色已不存在并进入既有清理重试路径（需显式 `keepHistory`）；保留路径仍只保留文件、不提供读取接口。

## 3. AD-R02 · 删除必须显式选择历史处理

**成因。** 路由把缺失的 `keepHistory` 当成 `false`，与 DL-148「由用户选择是否保留记忆与对话数据」不一致。

**修法。** 首次删除必须携带 `keepHistory`，只接受 `0`／`1`／`false`／`true`；缺失返回 400 `KEEP_HISTORY_REQUIRED`，非法值返回 400 `INVALID_QUERY`。校验在活动守卫之后、任何数据改动之前完成，角色索引、目录与历史保持不变。

**边界。** 已接受清理删除的重试同样要求显式传值；待清理记录存在时按清理路径继续，不会因再次声明「保留」而恢复已删除的角色。

## 4. AD-R03 · 清理记录删除失败不改变已接受的删除

**成因。** `finishCleanup()` 在角色索引与目录都已删除后调用 `clearRoleDeletion()`，该语句失败时异常冒泡为 500；故障期间重试也在同一处失败，与实际可见状态不一致。

**修法。** 目录删除成功后清除待清理记录改为容错：失败时保留记录，仍按实际结果返回 200 与 `filesRemoved`；重试与启动恢复继续清除记录。与第二包 RP-R06 的收尾语义一致。

**边界。** 决策提交前的失败仍完整回滚并返回错误；本修复只覆盖「删除已接受」之后的记录清除。

## 5. AD-R04 · 旧立绘清理失败不影响新立绘

**成因。** `replaceHome()` 在替换事务提交后调用清理旧素材；旧素材行删除失败时异常进入外层 `catch`，把刚写入的新立绘文件删除，但数据库已经指向新素材，导致列表可见而读图 404。

**修法。**

- 新增的素材清理统一改为「提交后尽力清理」：`releaseUnreferencedAsset()` 捕获清理失败并保留素材行与文件，不推翻已提交的替换或删除。
- 差分删除在硬删除失败时回退为软删除，响应按 `retained=true` 返回；软删除也失败时错误向上冒泡，此时素材仍在衣柜中可见，未见状态与响应一致。

**边界。** 未引用的素材可能因清理失败暂时留在磁盘与数据库（行已按删除状态过滤），后续删除重试或人工清理可回收；本轮不新增常驻清理任务。

## 6. AD-R05 · 上传与服饰删除交错

**成因。** 主页立绘补传与差分上传只在异步图片解码之前校验服饰存在；解码期间同一服饰可被 HTTP 删除并提交，入库时不再复验删除状态，于是在已删除服饰下写入一条未标记删除的素材，文件也留在受管目录。

**修法。**

- `AppearanceStore.addAsset()`／`replaceHome()` 把「服饰仍有效」的校验与素材插入放进同一事务（`assertActiveOutfit`）：服饰已删除时抛 404 `OUTFIT_NOT_FOUND`，事务不写入任何行。
- 服务层既有的失败处理随之清理本次写入的受管文件，响应与可见状态一致。
- 晚到差分标注继续按素材标识读取，复核用例确认已物理删除的素材不会写回句段。

**边界。** 上传与删除交错时语义为「先删除生效」：删除先提交则上传收到 404，需要时由前端提示重试或改选服饰；反过来上传先提交时，素材随服饰一起按删除状态过滤。不引入额外的锁或跨进程协调。

## 7. AD-R06 · 角色删除与在途上传串行

**成因。** 角色配置写入租约只阻止恢复活动，不互斥其他写入。差分上传在异步图片解码期间持有删除前打开的业务库；角色删除请求并发通过检查并移除索引、开始清理目录。解码结束后上传仍向原目录与业务库写入素材：保留路径留下新素材与文件，清理路径在清理开始后重建目录并保留待清理记录。

**修法。**

- `RoleActivityService.guardRole()` 增加按角色的写入链：同一角色的配置写入（五个外观写接口、角色删除等）按到达顺序串行执行；租约仍在入口同步持有，恢复与停止仍被拒绝。
- 角色删除与上传共用这条守卫，因此删除会排在在途上传之后：上传先提交则删除随后执行（保留路径保留该素材，清理路径连同目录删除）；删除先获得锁则上传排队，随后因角色不存在返回 404。
- `RoleDeletionService` 的内部删除队列与事务内复验保持不变（AD-R01、AD-R02）。

**边界。** 串行化只覆盖本进程；多进程（如 CLI）并发仍依赖事务内复验与 HTTP 层守卫。排队不设独立超时，等待时长受在途上传自身的解码与写入时间约束；前端在删除时若正有上传，删除响应会相应延后。

## 8. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p6-appearance.test.ts`、`tests/p16-role-deletion.test.ts` | 17／17 |
| 复核脚本原样重跑 | `npx -y node@24 --import tsx --test test-results/review-262/independent.ts` | 4／4；证据见 `test-results/review-262/independent-fixed.log` |
| 上传交错原样重跑 | `npx -y node@24 --import tsx --test test-results/review-262/appearance-races.ts` | 3／3（含晚到标注回归）；证据见 `test-results/review-262/appearance-races-fixed.log` |
| 角色删除与上传交错原样重跑 | `npx -y node@24 --import tsx --test test-results/review-262/role-upload-race.ts` | 2／2；证据见 `test-results/review-262/role-upload-race-fixed.log` |
| 全量测试 | `--test-concurrency=8 tests/*.test.ts` | 355／355 |
| 离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0`、`sourceUnchanged=true` |

验收报告：`backend/test-results/p5-2026-11-11T13-14-11-223Z-5fc16524/summary.json`。

新增定向用例：

1. `tests/p16-role-deletion.test.ts`：`并发删除不会删到零个角色`（AD-R01）。
2. `tests/p16-role-deletion.test.ts`：`清理记录写入失败不阻断已接受的删除`（AD-R03）。
3. `tests/p6-appearance.test.ts`：`旧立绘清理失败不影响新的主页立绘`（AD-R04）。
4. `tests/p6-appearance.test.ts`：`上传与服饰删除交错时不写入已删除服饰`（AD-R05，覆盖差分上传与立绘补传两类交错）。
5. `tests/p16-role-deletion.test.ts`：`角色删除等待在途配置写入结束后才执行`（AD-R06）。
6. `tests/p16-role-deletion.test.ts`：`至少保留一个角色` 补充省略与非法 `keepHistory` 的 400 断言（AD-R02）。

既有用例未放宽断言：p6 的改名、立绘替换、删除服饰／差分与旧库回填，p16 的保留／清理／中断恢复均保持原样。

## 9. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/application/role-deletion-service.ts` | 删除请求串行化；事务内复验最后角色；收尾清除记录容错（AD-R01、AD-R03） |
| `backend/src/http/routes.ts` | `keepHistory` 必填与值校验（AD-R02） |
| `backend/src/application/role-activity-service.ts` | 配置写入按角色串行，删除等待在途写入（AD-R06） |
| `backend/src/application/appearance-service.ts` | 素材清理改为提交后尽力清理；差分硬删除失败回退软删除（AD-R04） |
| `backend/src/storage/appearance-store.ts` | 素材写入与服饰有效性在同一事务里复验（AD-R05） |
| `backend/tests/p16-role-deletion.test.ts` | 新增并发删除、清理记录失败用例；补充必填校验断言 |
| `backend/tests/p6-appearance.test.ts` | 新增旧立绘清理失败、上传与删除交错用例 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/262-role-appearance-deletion-history.md`、`devDoc/252-role-config-settings-development-plan.md`、项目工作记忆 |

## 10. 交接边界

- 本文记录实施方自验。AD-R01～AD-R06 在已验离线范围已关闭，第三包通过 [263 第 7 节补修独立复验](263-role-appearance-deletion-independent-review.md#264-第-7-节补修独立复验)。
- 前端接入（253／261）：角色删除必须让用户显式选择「保留记忆与对话数据」或「一并删除」，两个选项分别发送 `keepHistory=1`／`0`；未选择时不发请求，后端缺失该参数会返回 400。上传与删除并发时以先提交的删除为准，上传方收到 404 后提示重试或改选服饰；若删除时有在途上传，删除响应会等该上传结束后返回。
- 已接受清理删除的重试仍要求携带 `keepHistory`；已删除角色没有读取接口（用户确认只保留文件）。
- 素材物理清理失败属于可延后的清理事项，不影响新立绘、衣柜列表或历史读取。
