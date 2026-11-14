# 227 过场图后端独立复核

2026-11-09，`dev-front` 工作树，基线 `c9ffa4e`。本轮复核 [224 CG-01](224-scene-image-cg-01-record.md)、[226 CG-02](226-scene-image-cg-02-record.md)，同时重跑流式句段和统一 TTS 情绪增量。业务源码与正式测试以被验工作树为准。

## 1. 结论

过场图后端本轮独立复核未通过。现有回归通过，新增边界探针复现两项 P1 和两项 P2。CG-01 的正常任务读取、幂等重放、素材、v13 迁移及 SSE 重连通过既有离线覆盖。CG-02 的规划输入、参考图、失败重试及超时仍有第 2 节缺口。流式句段和统一 TTS 情绪增量在已验离线范围通过。真实 TTS 听感、真实生图服务、CG-03 自动触发和桌面交互属于后续验收。

## 2. 复核发现

| 编号 | 优先级 | 复现与影响 | 复验条件 |
| --- | --- | --- | --- |
| R01 | P1 | 生成等待只依赖生成器配合 `AbortSignal`。使用忽略信号的生成器，设置 30 ms 超时，125 ms 后信号已中止但任务仍为 `generating`。再调用 `close()`，70 ms 后仍未返回，直到手动释放生成器才结束。服务关闭和任务结算都可能被挂起。 [生成等待](../../../backend/src/application/scene-image-service.ts#L396) · [关闭路径](../../../backend/src/application/scene-image-service.ts#L237) | 由服务侧设定超时和关闭结算，生成器不返回也能进入相应终态；忽略已结算任务的晚到结果。 |
| R02 | P1 | 在角色库对 `model_calls` 注入 `BEFORE INSERT` 失败。手动任务仍调用规划模型一次并成功出图，模型调用登记新增 0 条。正常用户手动任务无需扣自主额度，实际调用仍应留痕。 [规划调用登记](../../../backend/src/scene/model-planner.ts#L89) · [工作包约定](223-conversation-performance-development-guide.md#32-接口和状态建议) | 规划调用在登记成功后才发出。登记失败时任务可追溯地结算，模型实际调用次数为 0。 |
| R03 | P2 | 手动选择 `background`，离线规划模型看不到请求图层并返回 `full_scene` 与「夏澄站在窗边向镜头挥手」的提示。生成器收到 `background` 字段和要求人物入画的原提示，任务成功。假生成器按模式画渐变，掩盖了真实生图适配器可能收到的矛盾输入。 [规划提示](../../../backend/src/scene/model-planner.ts#L220) · [图层覆盖](../../../backend/src/application/scene-image-service.ts#L545) | 指定图层在规划模型调用前进入输入和约束，冲突方案在发送给生成器前得到处理。纯背景和整幅图各验证最终生成请求。 |
| R04 | P2 | 先生成一轮 `outfitId=null` 的历史回复，再导入并穿上新外套。从旧回复发起整幅图，规划器收到新外套名称，生成器收到一张新服饰参考图。这会把后来换装回填进旧场景，偏离 223 使用目标回复已存服饰的契约。 [服饰回退](../../../backend/src/storage/scene-image-store.ts#L147) · [任务归属](223-conversation-performance-development-guide.md#31-任务和画面归属) | 有历史服饰时使用历史服饰。无历史服饰时按未知服饰和无服饰参考生成，或先单独确认明确的产品回退规则。 |

## 3. 验收证据与范围

- 用项目 Node.js 24.22.2 独立重跑 `npm run accept:offline`。21／21 步通过，正式测试 276／276，交付回归 2／2，`sourceUnchanged=true`，`realServiceCalls=0`。 [本轮报告](../../../backend/test-results/p5-2026-11-09T09-01-00-707Z-1c081125/summary.json)
- 第 2 节额外探针使用独立临时角色库和离线模型。四项均通过实际任务服务发起，验证数据库、传给模型或生成器的输入，以及最终任务状态。超时用例结束时释放了挂起的假生成器。
- 本轮新增的是复核记录和文档状态。建议先关闭 R01、R02，再完成图层与历史服饰复验，以修复后的契约作为自动触发和桌面正式联调的基线。

## 4. 228 修复独立复验

2026-11-09。R02、R04 关闭。R01 的生成器等待与 R03 的显式图层冲突路径已修复，追加边界仍待处理，过场图后端暂缓收口。

| 编号 | 复验结论 | 复现实测 |
| --- | --- | --- |
| R01 | 原复现通过，关闭边界仍待修复 | 挂起生成器分别遇到 30 ms 超时和服务关闭，任务得到对应失败码。之后释放生成器，素材仍为 0。生成器已返回、图片完整解码尚未结束时调用 `close()`，等待 60 ms 仍未返回。释放解码后任务变为 `succeeded`，写入 1 张图片。服务关闭需覆盖解码等待并在写盘前复查取消。 [解码和写盘](../../../backend/src/application/scene-image-service.ts#L427) |
| R02 | 关闭 | 再次注入 `model_calls` 登记失败，任务结算为 `SCENE_IMAGE_PLAN_UNAVAILABLE`，额外规划调用和生成调用均为 0。 [登记失败路径](../../../backend/src/scene/model-planner.ts#L89) |
| R03 | 显式冲突通过，缺字段和回退仍待修复 | 手动纯背景指定已进入提示，模型显式返回 `full_scene` 时拒绝。省略 `layerMode` 或返回 `portrait` 时，任务仍以 `background` 成功，生成器收到「夏澄站在窗边，向镜头挥手」。解绑对话模型走固定回退时，生成器同样收到包含旧服饰与挥手动作的背景提示。需拒绝缺失或非法的图层值，并为纯背景回退提供只描述环境的提示。 [解析](../../../backend/src/scene/model-planner.ts#L305) · [固定回退](../../../backend/src/scene/fixed-planner.ts#L24) |
| R04 | 关闭 | 回复时无服饰、后来换装，补画仍是未知服饰且参考图 0 张。回复保存旧外套、后来换新外套，补画仍取旧外套及其 1 张参考图。 [历史服饰查询](../../../backend/src/storage/scene-image-store.ts#L151) |

Node.js 24.22.2 下独立重跑 `npm run accept:offline`，21／21 步、280 项正式测试、2 项交付回归全部通过，`sourceUnchanged=true`，真实服务调用 0。追加探针使用离线模型、假生成器及独立临时角色库。 [本轮报告](../../../backend/test-results/p5-2026-11-09T09-14-57-749Z-865d440f/summary.json)

## 5. 228 第 8 节补修独立复验

2026-11-09。R01、R03 通过复验并关闭，R02、R04 维持关闭。另在素材落盘失败路径复现 R05，过场图后端收口待该项修复与复验。

| 编号 | 复验结论 | 独立探针 |
| --- | --- | --- |
| R01 | 关闭 | 使用默认图片检查器，在 Sharp 像素解码阶段挂起。服务关闭和生成期限到达时分别结算为 `SCENE_IMAGE_INTERRUPTED`、`SCENE_IMAGE_GENERATION_TIMEOUT`。释放解码后，两例的素材记录和磁盘文件均为 0，终态保持。 [解码等待及写盘前检查](../../../backend/src/application/scene-image-service.ts#L434) |
| R03 | 关闭 | 手动选纯背景时，规划模型省略图层、返回 `portrait` 或返回 `full_scene`，三个任务均以 `SCENE_IMAGE_PLAN_INVALID` 失败，生成器调用 0 次。移除模型绑定后，固定回退成功，生成器仅收到中性环境提示且没有人物参考图。 [图层校验](../../../backend/src/scene/model-planner.ts#L181) · [固定回退](../../../backend/src/scene/fixed-planner.ts#L26) |
| R05 | P2，待修复 | 注入排他写入先落盘 12 字节、再抛 `ENOSPC`。任务进入 `failed`，素材表新增 0 条，但目录残留一张 12 字节图片。代码在完整写入返回后才设置清理路径。应在成功取得新文件的所有权后登记清理目标，并在写入异常时移除已创建的文件。复验同时覆盖目标已存在的场景，避免误删已有素材。 [写盘与清理](../../../backend/src/application/scene-image-service.ts#L443) |

Node.js 24.22.2 下独立重跑 `npm run accept:offline`，21／21 步、283 项正式测试、2 项交付回归全部通过，`sourceUnchanged=true`，真实服务调用 0。追加探针在临时角色库使用本地图片、离线模型和写入故障注入。 [本轮报告](../../../backend/test-results/p5-2026-11-09T09-31-44-609Z-f11c7bf4/summary.json)

## 6. 228 第 9 节 R05 独立复验

2026-11-09。R05 通过原复现和文件名冲突复验，R01～R05 关闭。故障清理被拒绝时的任务结算新增 R06。

| 场景 | 实测结果 |
| --- | --- |
| 新文件半写入后抛出 `ENOSPC` | 文件描述符已关闭，任务为 `failed`，目录和素材表均为 0。同一幂等键复用原失败记录。 |
| 目标已存在 | 在排他打开前放入完整 PNG，由系统返回真实 `EEXIST`，原图字节完全一致。换新幂等键重试成功并登记素材。 |
| R06（P2）清理残留文件失败 | 半写入故障后，对该文件的删除返回 `EPERM`。`waitForIdle()` 返回，但任务仍是 `generating`、错误码为空，12 字节残留仍在。删除异常发生在结算之前，外层等待结束时吞掉拒绝，窗口得不到终态。复验条件为即使清理被拒绝也要保留原失败原因、持久化并发布终态，另行记录未清理文件。 [删除与失败结算](../../../backend/src/application/scene-image-service.ts#L470) · [后台等待](../../../backend/src/application/scene-image-service.ts#L260) |

Node.js 24.22.2 下独立重跑 `npm run accept:offline`，21／21 步、285 项正式测试、2 项交付回归全部通过，`sourceUnchanged=true`，真实服务调用 0。表中的三项探针均使用独立临时角色库、本地图片和离线模型。 [本轮报告](../../../backend/test-results/p5-2026-11-09T09-48-22-964Z-f0910a6a/summary.json)

## 7. 228 第 10 节 R06 独立复验

2026-11-09。R06 通过，R01～R06 在已验离线范围关闭。CG-01 任务与读取契约、CG-02 规划与手动生成的离线范围通过独立复验。

- 在临时角色库注入「写入 12 字节后 `ENOSPC`，删除返回 `EPERM`」。从消息快照游标订阅本机 SSE，再通过正式 HTTP 接口发起任务。任务查询和实时 SSE 均返回 `failed`、`SCENE_IMAGE_GENERATION_FAILED`，摘要保留原始写入错误并标记清理失败。日志保留残留文件路径，客户端摘要省略路径。 [清理与结算](../../../backend/src/application/scene-image-service.ts#L480)
- 残留文件未登记为素材。同一幂等键重放返回原失败任务，生成调用次数保持 1。解除故障后换新键，重试成功并保存结果。
- 残留文件自动清扫、CG-03 自动触发、真实生图和桌面联调按后续工作包推进。

Node.js 24.22.2 下独立重跑 `npm run accept:offline`，21／21 步、286 项正式测试、2 项交付回归全部通过，`sourceUnchanged=true`，真实服务调用 0。 [本轮报告](../../../backend/test-results/p5-2026-11-09T09-57-47-870Z-5fda94e2/summary.json)
