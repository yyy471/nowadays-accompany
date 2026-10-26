# MEM03 可选自动提取实现方案与任务包

日期：2026-10-26。状态：MEM03-A～E 已实施并通过[74号自动验收](74-memory-extraction-acceptance.md)，执行、复核修复与证据见[75](75-memory-extraction-execution.md)。前置：[72 MEM02复验](72-memory-runtime-fixes-independent-review.md)；继承[61 基础设计](61-memory-foundation-implementation-plan.md)。本文件定稿删除抑制与付费触发边界，不构成真实付费服务或管理页面已上线的声明。

## 1. 目标与首轮范围

用户明确开启后，系统从当前账号、当前群聊/私聊、当前角色的**新用户消息**中提取少量fact，校验后持久化，并沿用MEM02上下文及guard机制。普通收发不等待提取模型。

首轮只发布自动fact提取；summary生成、摘要替换历史、模型合并/覆盖既有事实、向量检索、情绪/遗忘曲线均不包含。MemoryRecord现有summary类型继续可读取但不注入，不因为本阶段扩大类型就提前开启历史裁剪。

MEM04管理页面另行实施，本轮提供明确的控制API与状态，测试由HTTP调用完成，不自动增加任务历史/聊天页。若只交付API，在执行报告说明“尚无用户页面入口”。

## 2. 当前代码盘点与接入原则

| 当前模块 | 本轮处理 |
| --- | --- |
| MemorySettings.enabled/autoExtract | 保留字段；增加明确激活流程，不能将旧true配置当新功能付费授权 |
| MemoryState.extraction.throughSeq/lastCompletedSourceKey | 扩展同文件提取元数据，兼容缺字段，不新增游离水位文件 |
| MemoryService管理CRUD与generation | 增加激活、暂停、提取提交和删除联动；复用Store事务、容量限制和scope校验 |
| MemoryRecord.origin/source | 模型结果只能服务端赋origin=model、type=fact、pinned=false，来源范围由快照确定 |
| StoredMessage.seq/contextEpoch | 来源筛选、角色隔离与成功水位，不读取其他epoch或公共资源正文 |
| QqInstance/Agent实际轮次 | 新增“合格文本轮已成功发送并持久化”的内部通知，不以模型开始/返回事件作为成功触发 |
| ProviderRouter与账号文本绑定 | 直接提取调用，无Agent工具执行循环；复用限流、超时、能力检查与凭据 |
| MediaJobService | 结果与能力类型是媒体专用，不把提取伪装成生图/视频job |
| 平台队列/Semaphore/AbortSignal/Core退出 | 复用有界并发与排空原语，新增最小协调器，不复制媒体job后台 |

建议新增src/application/memory/extraction/{coordinator,input,output}.ts；schema/DTO继续集中memory与contracts。Core负责装配，路由只调用用例。提取协调器不直接改角色绑定或调用QQ发送。

## 3. 明确激活及升级兼容

现有autoExtract字段在MEM01/02只是保存配置，升级后不能静默开始调用模型。新增extraction.activationVersion=1才代表本阶段已明确激活；缺少激活元数据时，即使autoExtract=true，effectiveStatus仍为needs-confirmation，不调模型。

建议提取状态扩展（字段名可局部调整，语义不能削弱）：

```ts
interface MemoryExtractionState {
  throughSeq: number;                  // 已处理或明确跳过的来源边界
  activationVersion?: 1;
  activatedAfterSeq?: number;          // 本次激活时的边界，不回填旧聊天
  lastCompletedSourceKey?: string;
  recentResults?: Array<{ sourceKey: string; throughSeq: number; at: number }>;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  pausedReason?: 'user' | 'deleted' | 'cleared' | 'memory-disabled' | 'capacity';
}
```

recentResults最多64项；不保存模型原始全文/聊天正文。现有state version=1可增可选字段，但必须保证旧文件按默认未激活解析。向旧应用降级可能无法识别新字段，发布说明必须列出备份恢复条件，不宣称双向兼容。

有效开启条件同时满足：enabled=true、autoExtract=true、activationVersion=1、当前scope有效、账号文本能力可用、未暂停且未超本阶段限额。无法确认时失败关闭。

### 激活流程

新增POST /accounts/:account/memory/:kind/:peer/extraction/activate，提交expectedScope、expectedRevision、startFrom:"now"、confirmModelUse:true。

服务端读取当前scope消息的最新稳定seq作为激活边界，与原throughSeq取较大值；不扫描整库，给MessageStore增加有界lastSeq/最高序号查询能力或使用等效只读索引。不能从只读“最后N条且按epoch过滤”的空结果错误推断全会话seq=0。

在Store事务内重验scope与revision，原子写autoExtract=true、激活元数据、边界、revision/generation；不自动把enabled=false改true，关闭的记忆须先明确开启。激活本身不调用模型，不追溯旧聊天。

通用PUT settings：enabled=false或autoExtract=false时，同次提交清除激活有效性并增加generation；仅把autoExtract从false改true不激活，返回needs-confirmation提示。已经激活时普通参数修改可保持激活，但旧任务失效；不能因重启、读取或页面刷新重新获取付费授权。

## 4. 删除抑制：明确暂停与新消息边界

### 删除/清空的单次原子语义

deleteRecord成功时同次写入：删除目标、autoExtract=false、清除activationVersion、pausedReason=deleted、增加revision/generation；保留throughSeq、回执等已提交信息。clear沿用原清空语义并补pausedReason=cleared。任一落盘失败，上述修改全部不生效，不能“删除失败但先暂停”或“删除成功但任务仍可提交”。

手工编辑模型事实时改为origin=user并暂停自动提取（pausedReason=user），避免模型随后覆盖用户修正；普通用户事实的编辑只增加generation，仍不允许模型覆盖。删除因防回填而暂停是产品行为变化，API返回effectiveStatus/原因，MEM04页面需明确展示。

协调器在持久成功后取消对应scope的排队/运行任务；取消只是节省资源，真正保证来自提交时generation/激活检查。进程崩溃导致取消通知丢失，也不能让旧结果写回。

### 重新开启

必须再次明确activate，startFrom只允许now。本次最新seq及之前的聊天不用于未来自动提取，原成功水位不倒退；在途旧任务必须因generation或激活身份不同被拒。首轮不提供自动回溯或“重新提取全部历史”。

本方案**不承诺永久语义遗忘**：它阻止在途任务复活和从激活边界之前的旧聊天立即回填。未来的新用户消息再次提供同一信息，仍可能形成新fact；没有同义判别/永久tombstone功能，不以exact hash冒充语义抑制。

## 5. 来源与触发

### 合格轮次

首轮只在内置Agent的一轮纯文本对话已成功发送最终普通文本回复、且出站已成功持久化后发出内部通知。工具调用确认语、生图/语音/视频任务、媒体观察、插件直接发送、手工发送、被guard抑制或发送失败的轮次不触发。

不能在AgentEngine“模型返回”时触发：那时实际发送可能尚未成功。新增专门的内部completion事件/端口，包含account/kind/peer、contextEpoch、turnId、入/出站seq、session身份及本轮guard；不向HTTP暴露“伪造完成”入口。存储失败缺少可靠seq时不提取。

### 有界输入

从(throughSeq, 触发轮的稳定入站seq]读取当前scope用户文本消息，方向仅in，contextEpoch必须相同；当前助手回复、系统提示、角色卡、世界书、旧记忆、模型观察不作为事实来源。群聊保留senderId，不能把甲的自述写成乙的属性。

每批最多50条用户消息、24000 UTF-16字符，按seq升序取连续前缀；正文过长按完整消息跳过并记录明确计数/推进规则，不能无限卡在同一条。纯媒体空文本和非当前epoch消息可跳过，但只有确认其位于稳定边界内才推进游标。

**禁止用最近N条反向读取后把水位直接推进到触发seq**，否则积压时会漏掉中间消息。若现有MessageStore只有最近limit语义，新增正向有界读取或明确分页端口，并以跨页测试证明不丢消息；不要全量加载再slice。

输入sourceKey由scopeToken、激活边界、实际选中的seq/文本摘要、generation、提取提示版本及模型解析身份稳定哈希生成。记录source.fromSeq/throughSeq表示证据范围，服务端分配；不允许模型任意声明其他会话来源。

### 频率与合并

默认累计至少6条新的合格用户文本消息且距上次尝试至少5分钟才可调用；无新完成轮次不靠定时器唤醒。每scope最多1个运行任务和1个合并待处理通知，更新目标上界但不并发执行两次同scope任务。

建议全局并发2、待处理scope最多32，每账号最多12次/小时、全局最多30次/小时；是保守本地执行上限，不是货币预算。配额在Provider调用前占用，失败也计费次数；不能通过新建requestId或立刻重试绕过。限制和计数持久化到有界提取配额状态，复用原子写入；重启仍遵守额度，不自动恢复或重发旧模型任务。

## 6. Provider调用与严格输出

复用账号当前已授权文本绑定和统一ProviderRouter；不新增会话级模型配置。捕获provider/model及配置代际，调用前重验权限、scope/generation/激活和运行状态。参数不支持时明确失败，不悄悄切到未授权服务。

调用为独立无tools的ChatRequest，不经过Agent工具循环。模型返回toolCalls直接拒绝，不执行任何工具。将消息作为引用数据，给出严格事实提取schema；提示词不能代替输出/权限校验。

首轮输出示例：

```json
{
  "facts": [
    { "content": "用户甲喜欢银杏。", "keys": ["银杏"], "evidenceSeqs": [123] }
  ]
}
```

只接受单个严格JSON对象（无Markdown包裹、无未知字段），facts最多8条，正文最多1000字符、keys最多8×64字符、evidenceSeqs为本批真实入站文本seq的非空子集。空facts是合法成功；输出原文最多16000字符且受Provider有界响应读取保护。实际记录仍走MEM01更高一级总量/字节校验。

模型不得设置id/revision/type/origin/pinned/time/目录/权限。服务端赋type=fact、origin=model、pinned=false，source按核验的证据seq最小/最大构造。确定性校验只证明来源引用有效，不能证明每个自然语言事实都正确；管理页面应显示模型来源，允许修正/删除。

## 7. 提交、水位、去重与失败

模型调用期间不持有MemoryStore文件锁，也不阻塞会话收发。返回后通过原会话串行队列提交，避免本次自动写入在另一个活跃文本轮中间增加generation；若角色/会话已结束，放弃。不得用旧context.deliver来确认提取，提取无QQ消息输出。

Store事务里重验：当前角色scope、generation/state revision、enabled/autoExtract/激活身份、来源水位和sourceKey。最后角色校验保持65/66号逻辑提交点约定；不承诺跨文件原子事务。

全部候选先校验再提交。记录、新state revision/generation、成功水位、recentResults同一文件原子写入。相同sourceKey回执先于普通旧revision冲突检查，以支持提交响应丢失；不重复插入、不重复推进。模型调用失败不推进成功水位。

精确去重使用服务端规范化正文摘要与现有记录/本批比较，重复跳过；不执行语义合并，不修改既有手工或模型fact。全部候选为空/重复也是成功，可推进实际处理到的批次边界，不能推进尚未读取的积压部分。

容量不足采用全批拒绝，不先写一部分再报失败；当前成功水位不推进，原子暂停自动提取并给出capacity原因。若连暂停元数据也无法落盘，则进程内熔断该scope并报告持久化失败，重启不应自动反复调用导致费用；配额状态仍约束，恢复需明确操作。

其他错误：超时/鉴权/网络/格式失败记录安全状态并进入至少10分钟冷却，不自动重试本次Provider请求；下一次有新合格完成通知、冷却结束且额度足够时才考虑新的尝试。错误信息不记录聊天、候选、完整密钥或模型原始返回。

## 8. 状态、API与生命周期

建议同一前缀/accounts/:account/memory/:kind/:peer：

| 接口 | 用途/约束 |
| --- | --- |
| GET /extraction | effectiveStatus、scopeToken/state revision、边界、数量/配额/冷却、安全错误；无聊天/原始输出 |
| POST /extraction/activate | 双expected、startFrom=now、confirmModelUse=true；必须enabled，不调用模型 |
| POST /extraction/pause | 双expected；autoExtract=false、失效generation/激活，持久化后取消任务 |

首轮不提供“立即调用模型”“回溯全部历史”按钮/API。现有DELETE/clear返回新增提取状态，明确删除会暂停提取。日志仅含scope/request标识、计数、时长和安全错误；跨账号不能查询其他scope的提取输入或状态。

MemoryExtractionCoordinator复用KeyedSerialExecutor、Semaphore、AbortSignal和现有退出排空。Core.stop先关闭提取准入、取消排队/中断本地等待，再有限等待在途任务；晚返回结果不再提交。不能让一个不响应取消的Provider无限阻止退出；记录“远端是否已取消未知”，不伪称没有费用。

state元数据不存可执行任务正文；重启只读激活/配额/水位，不自动重发崩溃前任务。后续新的合格轮次可以重新触发，但重新校验generation/权限/额度。

## 9. 任务包与合并顺序

| 包 | 交付 | 放行条件 |
| --- | --- | --- |
| M3-A | 激活/暂停schema、兼容迁移、删除/清空联动及状态API | 旧true不静默调用；删除暂停与失效原子；新边界复验 |
| M3-B | 稳定完成通知、正向有界历史读取、批次/sourceKey | 无丢页/跨scope/助手伪事实；触发条件准确 |
| M3-C | 最小协调器、配额/冷却/退出 | 不阻塞会话，有界且重启不重发，无私有失控队列 |
| M3-D | 无工具Provider调用、严格输出与原子提交 | 旧结果拒绝、响应丢失恢复、水位/记录一致、容量不半写 |
| M3-E | 全链路独立复核与执行报告 | 74号关键项全通过，保留Fake调用/水位/文件与发送证据 |

A→B→C/D→E；每包定向测试，最后全量/类型检查/桌面构建/diff检查。共享schema、Core/lifecycle、消息读取端口由明确负责人集成。

本阶段可先完成A并验证无自动调用，再放行B～D。summary与MEM04页面不混入该阶段；后续另写方案和验收。测试产物放test-results，正式源码入Git；是否提交、打包、真实服务验收分别记录，不默认执行。
