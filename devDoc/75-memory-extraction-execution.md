# MEM03 可选自动fact提取执行记录

日期：2026-10-26。状态：MEM03-A/B/C/D/E 已完成并通过74号自动验收；首轮复核与76号R1/R2的P1均已修复并加入回归，76号修复与证据见[77](77-memory-extraction-review-fixes.md)。对应方案[73](73-memory-extraction-implementation-plan.md)、验收[74](74-memory-extraction-acceptance.md)，前置为[72 MEM02复验](72-memory-runtime-fixes-independent-review.md)。本轮不包含summary、MEM04管理页面、向量/情绪/遗忘曲线；没有调用真实付费模型或发送真实QQ消息。

## 1. 包完成情况

| 包 | 结果 | 内容 |
| --- | --- | --- |
| M3-A | 完成 | 显式激活/暂停、旧`autoExtract=true`兼容、删除/清空/编辑原子暂停、重新开启边界、状态API |
| M3-B | 完成 | 纯文本回复已发送并持久化后的内部完成通知、正向有界读取、批次/sourceKey、扫描跳过计数 |
| M3-C | 完成 | 最小协调器、每scope运行+合并待处理、全局并发/scope上限、持久配额、冷却、退出排空 |
| M3-D | 完成 | 无tools Provider调用、严格JSON输出、服务端字段、原子提交/回执/水位、同会话队列提交 |
| M3-E | 完成 | 全链路FakeChannel→Agent→提取→MemoryStore→下一轮提示词，复核修复与全量回归 |

普通收发不等待提取模型；提取失败不推进成功水位，不向QQ发送任何内容。

## 2. 代码位置

| 位置 | 内容 |
| --- | --- |
| `src/memory/types.ts` | 提取状态、暂停原因、结果/失败、提取条目/正文/关键词/输出上限 |
| `src/memory/schema.ts` | 提取状态严格解析、激活/暂停请求校验、正文摘要`memoryContentDigest` |
| `src/memory/store.ts` | 状态文件上限只读暴露 |
| `src/application/memory/memory-service.ts` | 激活、暂停、扫描推进、尝试/失败记录、原子提交、删除/清空/编辑联动 |
| `src/application/memory/extraction/input.ts` | 正向有界读取、50条/24000字符、合格文本准入计数与批次分离、有界续扫、跳过计数、sourceKey |
| `src/application/memory/extraction/quota.ts` | `state/memory-extraction-quota.json`、12/账号/小时、30/全局/小时、失败关闭 |
| `src/application/memory/extraction/coordinator.ts` | 6条/5分钟门槛、扫描续扫缓存、每scope1运行+1合并、全局2并发/32 scope、10分钟冷却、退出 |
| `src/providers/router.ts`、`src/core/core.ts` | 按调用执行策略；提取固定单次尝试、无自动fallback，普通Agent保持原重试/回退 |
| `src/application/memory/extraction/output.ts` | 单个严格JSON对象、facts/正文/keys/evidence限制、未知字段拒绝 |
| `src/application/memory/extraction/runner.ts` | 无tools请求、toolCalls拒绝、实际provider/model sourceKey、提交排队 |
| `src/application/memory/extraction/errors.ts` | 提取尝试错误与benign/fatal标记 |
| `src/core/core.ts` | 配额加载、Provider适配、协调器装配、bus订阅、会话队列提交、生命周期、状态合并 |
| `src/core/extraction-events.ts`、`src/core/events.ts` | 内部完成事件；不向HTTP或插件开放 |
| `src/instances/instance.ts` | 成功发送/持久化后发出完成事件；`enqueueConversationTask` |
| `src/agent/engine.ts` | 仅纯文本最终回复调用`markExtractable` |
| `src/host/contract.ts` | 可选`markExtractable`端口 |
| `src/storage/contract.ts`、`src/storage/jsonl-store.ts` | `lastSeq`、正向`readRange`、并发裁剪时的段快照 |
| `src/contracts/memory.ts`、`src/service/routes/memory.ts`、`src/service/http/errors.ts` | 提取视图/配额/运行时状态、GET/activate/pause、409映射 |
| `src/application/ports/control-api.ts`、`src/core/core.ts` | Core控制端口 |
| `src/index.ts` | 新契约类型导出 |

## 3. 生效语义

- 有效开启必须同时满足：记忆`enabled=true`、`autoExtract=true`、`activationVersion=1`、当前scope有效、账号文本能力可用、未暂停/未冷却/未超限。
- 激活只接受`startFrom:"now"`与`confirmModelUse:true`，边界取`max(throughSeq, 旧激活边界, 最新稳定seq)`；不回溯旧聊天，不调用模型。
- 旧文件中`autoExtract=true`但没有激活元数据时为`needs-confirmation`，重启或读取不会静默授权。
- 删除记录、清空、关闭记忆、关闭自动提取、编辑模型事实均在同一状态写入中暂停提取并增加generation；写入失败全部不生效。重新开启必须再次显式激活，旧任务因scope/generation/水位不匹配被拒。
- 历史输入只读取当前角色epoch、入站、非空文本；每批最多50条/24000字符；纯媒体、空文本、旧epoch、超长单条明确跳过，50条或字符预算截断后水位只推进到实际读取边界，不跳到触发seq。
- 六条准入门槛统计“已扫描到的合格文本”，不受字符预算批次大小影响；长文本导致批次只能装1～5条时仍可累计达门槛。扫描达到记录上限时保留进程内有界续扫前缀，下一次触发从最后检查位置继续，不重读、不跳过、不推进未处理水位；只有完全不含合格文本的已检查前缀才允许原子推进。
- 自动提取的Provider调用固定为单次尝试、禁用自动fallback，仍复用统一路由、权限、凭据、端点限流、配置代际和执行guard；失败后由协调器记录10分钟冷却，冷却内新通知不调用，需冷却结束且出现新的合格完成通知才再次尝试。普通Agent调用不传该策略，重试与回退语义不变。
- 完成事件只在最终纯文本回复成功发送且入站/出站均持久化后产生；工具确认、生图/语音/视频、媒体观察、插件发送、手工发送、guard抑制和发送失败都不触发。
- 提交在原始会话ingress队列执行，不能插入另一文本轮中间；事务内重验角色scope、revision/generation、激活/暂停、成功水位、evidence范围与sourceKey。相同sourceKey在旧revision检查之前返回幂等回执。
- 精确正文重复跳过；模型结果不能更新或覆盖手工/旧模型fact。容量不足整批拒绝、原子暂停且不推进水位。
- 配额在Provider调用前占用，失败也计数；配额文件损坏或不可写时拒绝调用。重启不重发旧任务，额度不重置。
- `GET /extraction`返回配额与运行时状态；状态、错误、审计和普通日志只含scope标识、计数和安全错误码，不含聊天正文、候选或模型原始输出。

## 4. 验收结果

### 4.1 激活、兼容与删除抑制（A）

| ID | 结果 | 证据 |
| --- | --- | --- |
| A01 | 通过 | `memory-extraction`：旧`autoExtract=true`→`needs-confirmation`，无激活字段，模型调用0 |
| A02 | 通过 | `memory-api`：未鉴权401；缺confirm/startFrom非now/过期双expected拒绝且状态不变 |
| A03 | 通过 | `memory-extraction`：已有聊天时边界等于稳定最新seq，激活不调用模型；E2E中断言激活后无提取调用 |
| A04 | 通过 | `memory-extraction` A04/A05b：删除+暂停+失效同次写入；写失败零副作用；运行中删除的旧结果被拒 |
| A05 | 通过 | `memory-extraction`：清空/关闭/编辑模型fact原子暂停；用户fact编辑只增加generation |
| A06 | 通过 | `memory-extraction` A06；E2E删除后重激活边界12，只处理之后消息 |
| A07 | 通过 | `memory-extraction` A07：允许未来新消息形成新fact，记录字段不存正文 |
| A08 | 通过 | `memory-extraction` A08：旧状态读取、lastSeq跨重启/epoch稳定；MEM01幂等/容量/CAS回归通过 |

### 4.2 完成通知与输入批次（I）

| ID | 结果 | 证据 |
| --- | --- | --- |
| I01 | 通过 | `memory-extraction-trigger`：只有已发送且持久化的纯文本回复产生1个候选；模型返回/发送前不算完成 |
| I02 | 通过 | 手工/插件/发送失败/工具确认/媒体/guard抑制均不触发 |
| I03 | 通过 | 跨账号/群私聊/角色epoch隔离；store拒绝跨账号；事件无正文/source；HTTP无伪完成入口 |
| I04 | 通过 | `memory-extraction-input`：50条、24000字符、多分页连续前缀，水位不跳触发seq；6条长文本时批次1条但准入计数6；新增并发裁剪段快照回归 |
| I05 | 通过 | 出站/旧epoch/空文本/纯媒体/超长跳过计数；无文本前缀由协调器原子推进（1000条前缀→水位1000）；单条大消息留待下批；扫描上限下按`[0,2,4]`续读，不重读长前缀；运行时R1的7次调用/批次seq/字符数/水位见77号 |
| I06 | 通过 | 仅当前epoch入站文本；助手/世界书/角色/旧记忆/观察不进入输入；群聊保留senderId |
| I07 | 通过 | sourceKey对证据/模型/提示版本/generation/边界确定；重复完成通知不重复插入；重复入站不产生第二候选 |

### 4.3 并发、费用与生命周期（Q）

| ID | 结果 | 证据 |
| --- | --- | --- |
| Q01 | 通过 | `coordinator`：<6条、间隔<5分钟不调用；无定时器唤醒；空/重复完成可推进已读取前缀 |
| Q02 | 通过 | 每scope最多1运行+1合并；全局并发2；待处理scope上限32；普通收发不被阻塞 |
| Q03 | 通过 | 配额在调用前占用；失败仍计数；单账号12/全局30；不能通过重试绕过；协调器重建仍遵守额度 |
| Q04 | 通过 | `quota`：计数跨重启持久化；无任务正文持久化，重启不自动重发 |
| Q05 | 通过 | 网络/超时/鉴权/输出错误进入10分钟冷却，不推进水位；提取Provider为单次尝试、无fallback（`provider-policy`真实Router链路：primary 1/fallback 0/配额1/水位0；冷却内0调用，到期无新通知0调用）；日志无正文 |
| Q06 | 通过 | 排队前后校验；角色/激活/暂停/cooldown在Provider前丢弃；新增“排队中暂停→释放信号量后调用0”回归 |
| Q07 | 通过 | close中止本地等待，drain有界；Provider不响应abort时晚结果`isAdmitted=false`；E2E停止期间不落盘 |

### 4.4 输出与原子提交（O）

| ID | 结果 | 证据 |
| --- | --- | --- |
| O01 | 通过 | `runner`：请求无tools；toolCalls存在即拒绝且不提交；不执行任何工具 |
| O02 | 通过 | `output`/`runner`：非JSON、围栏、额外文本、未知字段、超限、证据越界确定性拒绝，不部分写入 |
| O03 | 通过 | 仅服务端生成id/revision/type/origin/pinned/time/source；客户端多字段被拒；证据范围取所选seq最小/最大 |
| O04 | 通过 | 空facts、全部重复、批内重复均合法，水位推进一次，无重复记录 |
| O05 | 通过 | 运行中暂停/删除/换角色后提交被拒，记录/回执/水位不变；新增memory guard在Provider前后复验 |
| O06 | 通过 | 新增O06用例：模型同文不覆盖手工fact；手工记录的正文/keys/pinned/origin/更新时间不变，只新增不同事实 |
| O07 | 通过 | 新增O07用例：state写入失败后文件、记录、水位、回执不变，同sourceKey可安全重试；D02覆盖响应丢失/重复回调幂等 |
| O08 | 通过 | D05用4KiB可注入上限验证实际文件字节检查；新增1000条记录上限用例，整批拒绝+原子暂停+水位不变 |
| O09 | 通过 | 实际Agent/FakeChannel验证：提取结果就绪后等待活跃文本轮结束；7次发送无guard破坏，随后才提交记录 |

### 4.5 状态、隐私与范围（S）

| ID | 结果 | 证据 |
| --- | --- | --- |
| S01 | 通过 | 未鉴权401；跨scope双expected 409；错误/状态不含其他scope token或正文；HTTP测试新增断言 |
| S02 | 通过 | disabled/needs-confirmation/active/paused/cooldown/failed在服务层与HTTP设置/删除/提取状态中区分；暂停原因准确 |
| S03 | 通过 | 审计只含动作/scope id；提取输出错误不包含原始输出/聊天；配额文件只存账号计数；事件/状态无候选正文 |
| S04 | 通过 | 全量MEM02/世界书/发送/退出回归通过；无summary注入/历史裁剪/新页面 |

## 5. 端到端与故障证据

### 5.1 完整闭环

`test/memory-extraction-runtime.test.ts`中的E2E：

- 6个真实FakeChannel入站轮次（正常Agent回复）→每轮入站/出站持久化→6个内部完成事件→协调器调用Fake文本Provider 1次→提取1条model fact，`throughSeq=11`。
- 第7轮用户消息包含事实关键词后，实际Agent提示词包含`用户喜欢喝乌龙茶`；通道发送累计7条，提取Provider调用仍为1。
- 提取请求只有system/user两条消息，无tools，不含Agent回复文本；下一轮提示词证明记录已进入MEM02上下文。

### 5.2 队列顺序（O09）

- 第6轮后持有提取Provider响应；第7轮Agent文本轮进入并保持发送前暂停。
- 释放提取响应后100ms内：记录0、`throughSeq`仍0，说明提交没有插入活跃轮次。
- 释放第7轮后：7条回复全部发送，`auto_reply.suppressed=0`；随后`throughSeq=11`、记录1，提取Provider调用1次。

### 5.3 删除/重新激活

- 首轮6条消息→1次调用→记录`FACT_1`、水位11；删除后`paused/deleted`、水位保留11。
- 重新激活边界12；5条新消息仍不调用；第6条新消息触发第2次调用，输入seq严格为`[13,15,17,19,21,23]`，不含旧消息；最终水位23、记录`FACT_13`。

### 5.4 运行中失效

| 场景 | 调用数 | 记录/水位 | 结果 |
| --- | --- | --- | --- |
| 暂停Provider期间 | 1 | 0 / 0 | `paused/user`，配额已计1，旧结果被拒 |
| 删除记录期间 | 1 | 0 / 0 | `paused/deleted`，旧结果被拒 |
| Provider期间换角色 | 1 | 旧scope 0 / 0 | 新scope `disabled`，旧scope未被写 |
| Core停止期间 | 1 | 0 / 0 | 晚结果不落盘，退出有限等待 |

### 5.5 复核发现与修复

独立复核未发现P0；发现两项P1、若干P2，均已处理或记录：

1. **P1：`JsonlStore.readRange`并发裁剪漏读仍存在的段**。等待段读取期间裁剪会`shift()`段数组；原循环读取活数组，可能跳过下一段却返回`exhausted=true`，提取水位会越过未读消息。已改为迭代段快照，并新增回归：读取首个段时批量追加触发一次裁剪删除两个整段，修复前首读漏掉仍存在的seq 4，修复后返回`[4,5,6]`；未修复版本该用例失败。
2. **P1：大量非文本积压导致扫描永久停滞**。原协调器在`messages.length<6`时直接返回，已检查的纯出站/媒体前缀不推进，下一次重复扫描同一窗口。新增`advanceExtraction`：仅推进到已检查且不含未处理合格文本的前缀，不调用模型、不占配额，并通过原会话队列提交。回归用1000条出站+6条文本验证先推进到1000、下一次正常选中全部文本。后续76号R1进一步要求“上限前已有1～5条文本”也必须有界续扫，原“推进到首条之前”的做法已由77号的进程内续扫取代。
3. **P2：role切换窗口的提取元数据串scope**。状态读取后再次校验epoch；进程内熔断键改为`scopeToken+generation`，避免新角色generation碰撞被误熔断。
4. **P2：完成事件memory guard未被实际复验**。Runner在Provider调用前后读取当前epoch的memory guard，与完成时guard不一致即中止；补充guard变化用例。
5. **P2：跳过计数不可见**。协调器新增debug日志，只输出inspected/selected/processedThroughSeq/reachedTrigger/skipped计数，不含正文。
6. **P2：测试缺口**。新增O06（不覆盖手工记录）、O07（写入失败+安全重试）、O08（1000条上限）、Q06b（排队中暂停）、S01错误体无范围泄漏、memory guard变化、并发裁剪回归。
7. **76号R1/P1：字符预算与六条门槛冲突，长文本永久堵在最早前缀**。批次大小与准入计数分离；新增有界进程内续扫，长前缀只读一次，达标后仍按原前缀调用。运行时R1记录7次调用、各批seq/字符数/水位，17条文本各处理一次。
8. **76号R2/P1：提取继承Provider自动重试/回退**。`ProviderRouter`新增按调用策略，提取固定单次尝试、无fallback；真实Core/Router回归验证primary 1次、fallback 0、配额1、水位0、冷却内/到期无通知均不调用；普通Agent重试/回退对照通过。

76号R1/R2的根因、修复代码、完整调用记录与边界见[77号](77-memory-extraction-review-fixes.md)。

未修复但已记录的P2：

- 暂停/删除未主动abort同scope已在途Provider；硬保证来自返回后的generation/scope/水位复验，取消通知丢失也安全。`close()`会中止本地等待并在有界时间后退出。
- 配额文件损坏时`snapshot`仍显示0使用量，实际`acquire`失败关闭；需通过一次失败记录或后续日志观察。
- 8MiB实际文件上限通过可注入4KiB上限验证同一代码路径，未生成8MiB真实满额文件。
- 扫描续扫进度不持久化；重启后从水位重新进行有界扫描，可能重复读取但不跳过合格文本。
- Provider请求已到达服务方后失败仍可能产生一次计费；本地只保证每次配额准入最多一次HTTP请求，不承诺退款。

## 6. 命令与结果

在`D:\app\nowadays\accompany`执行：

```powershell
npm test
npm run typecheck
npm run desktop:build
git diff --check
```

| 命令 | 结果 |
| --- | --- |
| `npm test` | 退出码0；102个测试文件，916通过、1既有跳过（共917）；MEM02基线833通过/1跳过，本轮及复核修复累计新增83项通过，未新增skip |
| `npm run typecheck` | 退出码0（测试tsconfig + renderer tsconfig） |
| `npm run desktop:build` | 退出码0（服务端tsc、renderer Vite、Electron main/preload） |
| `git diff --check` | 退出码0，无空白错误 |

新增测试源码：

- `test/memory-extraction.test.ts`
- `test/memory-extraction-input.test.ts`
- `test/memory-extraction-trigger.test.ts`
- `test/memory-extraction-quota.test.ts`
- `test/memory-extraction-coordinator.test.ts`
- `test/memory-extraction-output.test.ts`
- `test/memory-extraction-runner.test.ts`
- `test/memory-extraction-runtime.test.ts`
- `test/memory-extraction-provider-policy.test.ts`

并在`test/memory-api.test.ts`增加提取状态/激活/暂停/配额/隔离HTTP用例。

## 7. 迁移与恢复条件

- 旧state version=1可直接读取；缺少`activationVersion`时即使`autoExtract=true`也只显示`needs-confirmation`，不调用模型。
- 提取水位、激活边界、成功回执与记录在同一`state.json`写入；删除/清空/编辑不会回退`throughSeq`。重新激活取当前稳定seq，不回溯。
- 新增`<dataRoot>/state/memory-extraction-quota.json`。删除它会重置本地小时额度；损坏/超限/不可写会失败关闭，不应通过删除来绕过异常。
- 崩溃后只恢复激活/水位/回执/配额，不恢复进行中的请求；需要新的合格完成通知才会再次尝试。
- 降级前应备份`accounts/<accountId>/memory/`与`state/memory-extraction-quota.json`。旧版本可能忽略新字段，不能承诺双向兼容。

## 8. 未实施与发布状态

- **未实施**：summary生成/摘要替换历史、MEM04管理页面、语义合并/tombstone、向量检索、情绪/遗忘曲线、真实Provider兼容矩阵。
- **未验收**：真实QQ消息、真实付费模型、真实配额账单、Electron原生视觉/缩放。无用户页面入口；HTTP与FakeProvider结果不代表所有服务商协议兼容。
- **未承诺**：跨文件物理原子事务；已发送到QQ的消息撤回；暂停时必然取消已发出的Provider请求或退款。
- **Git/发行**：未提交、未打包、未更新发行包或EXE。工作区保留此前未提交改动；测试使用系统临时目录并清理。

可以声明：**自动fact提取闭环（激活/暂停/删除保护、完成触发、有界输入与续扫、协调/配额/单次Provider调用与冷却/退出、严格输出、原子提交、同会话队列顺序）已实现并通过MEM03自动验收；76号R1/R2已由77号关闭。** 不能声明摘要、永久语义遗忘、记忆管理页面或真实付费服务兼容已完成。
