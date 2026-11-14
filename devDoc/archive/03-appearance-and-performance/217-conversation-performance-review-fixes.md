# 对话演出第一包复核修复记录

2026-11-09，`dev-front` 工作树，基线 `8d6dd08`。按 [216 独立复核](216-conversation-performance-independent-review.md) 修复 R01～R04，并复跑定向用例、全量测试与统一离线验收。未修改 216 的复核结论，未提交或推送，未调用真实模型。

## 1. R01 快照与 SSE 之间漏掉终态

- 消息列表改为窗口快照：不传 `after`／`before` 时返回最近一页消息（按 `sequence` 升序），`nextBefore` 指向更早一页的起点；传 `after` 保持原向前翻页，传 `before` 向历史翻页；两者同时出现返回 400 `INVALID_QUERY`。
- 响应新增 `cursor`，为读取同一快照时窗口的最新 SSE 事件编号。消息、句段、未完成回复文字和游标在同一个 SQLite 读事务内取得，消除快照与 SSE 建连之间写入终态或表情结果时的遗漏。
- 客户端进入窗口后使用 `after=cursor` 建立 SSE；快照已包含的增量不会重放，快照之后写入的 `message_delta`、`message_segments`、`segment_annotations`、`message_completed`／`message_interrupted` 都能续接。
- 生成期间句段仍不提前发布：桌面先用 `activeReply`（消息编号、执行编号、已产生文字）和后续 `message_delta` 显示一个进行中的气泡，收到 `message_segments` 后再按段展示。若要生成中逐句出气泡，需要另立工作包改变句段发布时机。
- [快照读取](../../../backend/src/application/message-service.ts#L34) · [向前翻页](../../../backend/src/storage/role-store.ts#L662) · [消息路由](../../../backend/src/http/routes.ts#L207)

复验覆盖：生成中断言快照文字与游标，放行模型让终态在快照之后、SSE 建连之前写入，再用 `after=cursor` 读取；新增量与快照文字拼成完整回复，未重放连接起点之前的增量。另用 5 条消息覆盖最近一页、`before` 两页翻页、`after` 向前翻页、游标为 0 和 `after`／`before` 冲突。

## 2. R02 省略差分时回放不到原服饰

- 句段在回复落库时就写入当时的服饰 `outfitId`，差分保持可空；正常提交使用本轮提交后的状态，打断、主动分享和进程中断收尾使用当时已提交的角色状态。
- 表情标注优先使用句段已保存的服饰，不再按标注时的当前状态回退；写回差分时用 `COALESCE(outfit_id, ?)`，只补空值，不覆盖历史服饰。
- 标注模型省略、返回空数组、服饰没有差分或标注失败时，句段仍有明确服饰归属，差分保持空，桌面可按该服饰回退。
- [句段落库](../../../backend/src/storage/conversation-store.ts#L666) · [当前服饰](../../../backend/src/storage/conversation-store.ts#L701) · [标注服饰选择](../../../backend/src/application/segment-annotation-service.ts#L226)

复验覆盖：黑裙标注微笑 → 白裙有差分但标注返回空 → 换回黑裙；白裙句段保存 `outfitId`、差分为空、标注时间为空，换回后再次读取仍为白裙；另保留无差分服饰只保存句段不调用标注模型的用例。

## 3. R03 附加模型调用绕过计量与额度

- 标注调用接入既有 `model_calls`／`call_metering`：用户对话按 `user_chat` 记录且 `counted=0`，不扣自主点数；自主任务按 `autonomous` 记录，调用前经 `AutonomyService.consumePoint`，额度耗尽时直接跳过标注、不发出模型请求。
- 记录用途、成功／失败状态、错误码、用量和上游原始响应；解析器没有有效选择但模型正常完成时仍记录成功调用。正文、句段和消息状态不因标注失败改变。
- 启动恢复新增收尾：执行已经终结但模型调用仍为 `running` 的记录归为 `PROCESS_INTERRUPTED`，避免标注中途退出留下永久在途记录。
- [标注计量与额度](../../../backend/src/application/segment-annotation-service.ts#L82) · [用途判定](../../../backend/src/storage/conversation-store.ts#L1780) · [启动收尾](../../../backend/src/storage/conversation-store.ts#L1693)

复验覆盖：三轮用户对话实际 9 次模型请求对应 9 条 `model_calls` 和 9 条 `call_metering`，全部 `user_chat`、`counted=0`，自主额度未变化；自主额度 1 点用完后主动分享的后置标注不再请求模型，`model_calls` 无记录；提高额度后标注请求 1 次，记录 `autonomous`、成功、`counted=1`、用量 JSON，预算已用 2 点；标注模型抛错时回复和句段保留，调用记录为失败。

## 4. R04 旁白范围未先确定

- 切分改为先确定范围再断句：整行 `*…*` 动作、`旁白：`／`【旁白】` 显式旁白先标记为旁白，再在范围内按句末标点切分。
- 显式旁白内的引号台词 `“…”`／`「…」`／`『…』` 和 `台词：`／`对白：` 标记另起为台词；标记本身不进入句段文字，起止位置仍指向原文。
- 行内 `*动作*` 单独标为旁白，其余文字正常断句；句段合并只在同一范围和同一类型内进行，不再把旁白和台词合并。
- 原文范围保持 `content.slice(startOffset, endOffset) === text`。
- [范围分类](../../../backend/src/domain/message-segments.ts#L104) · [显式旁白](../../../backend/src/domain/message-segments.ts#L138) · [范围断句](../../../backend/src/domain/message-segments.ts#L229)

复验覆盖：`旁白：她低下头。窗外开始下雨。` 全部为旁白；`*她低下头。窗外开始下雨。*` 全部为旁白且不含星号；`旁白：她低下头。台词：走吧。` 为旁白加台词；`旁白：她低下头。她说：“走吧。”` 为旁白加引号台词；行内 `她笑了*转身离开。*` 分成台词与旁白；所有句段逐一核对原文范围。

## 5. 验证与限制

- 新增和调整 13 项定向测试（`p7-performance.test.ts`）；全量正式测试 226 项通过；类型检查通过。
- 统一离线验收 21／21 步、交付回归 2／2 通过，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T01-18-35-130Z-6fc34418/`。
- 216 已独立验证的 v7→v8 迁移与旧事件保留未改动；本轮继续使用 v8，没有新增迁移。
- 未开始音色、试听、TTS、生成过场图和桌面对话演出；未验证真实模型标注质量与时延、真实自主调度中的标注开销、桌面逐段展示。
- 桌面对生成中回复的契约见第 1 节；逐句实时气泡不在本轮范围。
- 本轮为实现方修复与自验，需由独立复核重新验证 R01～R04；独立复核通过前不提交。

## 6. 216 第 4 节补充复验修复

[216 第 4 节](216-conversation-performance-independent-review.md#4-217-修复独立复验)确认 R02 在已验范围关闭，R01、R03、R04 的原复现路径已通过，但扩展路径仍有三处缺口。本轮只补这三处，不改变已通过的行为。

### 6.1 R01 补充：自动重连仍读取初始游标

- SSE 游标解析改为同时校验 URL `after` 与 `Last-Event-ID`，取两者中较新的值继续。EventSource 自动重连保留原 URL（例如 `?after=2`）并补上 `Last-Event-ID: 5` 时，从 5 之后补齐，不再重放 3～5。
- 只有请求头、只有查询参数和两者都没有的行为保持不变；任一值非法仍返回游标错误。
- [游标解析](../../../backend/src/http/routes.ts#L755)

复验覆盖：第一轮回复中途断开，记录最后收到的完成事件；提交第二轮后按自动重连方式用原 `?after=0` 加 `Last-Event-ID` 重连，只收到第二轮的事件，编号全部大于已见游标，增量拼回第二轮正文且只有一个完成事件。

### 6.2 R03 补充：自主扣点先于调用登记提交

- 标注的额度扣减与 `model_calls`／`call_metering` 登记放进同一个 SQLite 事务。登记写库失败时扣点一起回滚；额度耗尽时不留下调用记录，也不派发模型。
- 未接入自主服务的组合仍在派发前跳过自主标注；用户对话分支只登记、不扣点，行为不变。
- 事务提交后模型请求失败时仍保留已扣点与失败调用记录，与既有自主任务“调用尝试计入额度”的规则一致。
- [标注扣点与登记](../../../backend/src/application/segment-annotation-service.ts#L97)

复验覆盖：注入 `call_metering` 写入失败后发起主动分享，正文和句段保留，模型请求数、`model_calls`、`call_metering` 与已用点数均未增加；移除故障后同一入口可正常标注，请求、调用记录、计量记录和已用点数各增加 1。

### 6.3 R04 补充：两段行内动作之间的台词被吞进旁白

- 整行星号旁白要求开星号后的第一次闭合就在行尾；存在多段星号动作时交给行内动作匹配，星号之间的文字按台词、星号内按旁白分别切分。
- `*她微笑* 你好！ *她挥手*` 现在得到旁白、台词、旁白三个范围，原文范围仍逐段一致。
- [整行星号判定](../../../backend/src/domain/message-segments.ts#L368)

复验覆盖：上述同行混排输出 `["她微笑", "你好！", "她挥手"]` 并核对类型与偏移；原有整行星号旁白、显式多句旁白和带标点旁白用例保持通过。

### 6.4 验证

- `p7-performance.test.ts` 新增 2 项正式测试并扩充切分断言，共 15 项定向测试通过。
- 全量正式测试 228 项通过，类型检查通过。
- 统一离线验收 21／21 步、交付回归 2／2 通过，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T01-52-13-614Z-314def00/`。
- 本轮未运行真实模型、媒体服务或桌面演出；R01～R04 的三处补充缺口待独立复验，独立复核通过前不提交。

## 7. 216 第 5 节补修：凭据初始化失败仍扣自主点数

[216 第 5 节](216-conversation-performance-independent-review.md#5-217-第-6-节补修独立复验)确认第 6 节三处补充用例通过，R01、R02、R04 在已验范围关闭；R03 还剩一处：默认模型适配器的凭据在扣点之后才读取，`file:` 凭据缺失时没有发出请求，却已经扣点并留下 `MODEL_CREDENTIAL_UNAVAILABLE`、`counted=1` 的调用记录。

- 把模型适配器初始化（含 `file:`／`env:` 凭据读取）前移到额度扣减与调用登记之前。初始化失败直接跳过标注，不扣点、不写 `model_calls`／`call_metering`，已保存的主动分享不受影响。
- 适配器初始化成功、请求实际派发后再失败时，行为不变：调用记录为失败、自主点数仍按一次调用扣减、计量保持 `counted=1`。
- 用户对话的标注同样在适配器初始化失败时不留调用记录；已保存的正文和句段保持可读。
- [适配器初始化与扣点顺序](../../../backend/src/application/segment-annotation-service.ts#L97) · [扣点与登记同事务](../../../backend/src/application/segment-annotation-service.ts#L104)

复验覆盖：绑定不存在的 `file:` 凭据后发起主动分享，正文、句段和服饰归属保留，模型请求、`model_calls`、`call_metering` 与已用点数全部不变；另用离线模型在派发后抛错，确认自主点数增加 1、调用记录为 `failed`／`MODEL_REQUEST_FAILED`／`autonomous`、计量为 `counted=1`。

验证：`p7-performance.test.ts` 17 项通过；全量正式测试 230 项、交付回归 2 项通过；统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0，运行目录为 `backend/test-results/p5-2026-11-09T02-06-24-044Z-1907b573/`。本轮仍未调用真实模型或媒体服务，R03 凭据补充待独立复验，独立复核通过前不提交。
