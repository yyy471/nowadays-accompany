# MEM00 长期记忆基础设计与分阶段开发方案

日期：2026-10-26。状态：MEM01-A/B已实施并通过S01～S12（见[63 执行记录](63-memory-foundation-execution.md)）；MEM02～MEM04待实施。依据：[53 总体计划](53-remaining-development-implementation-plan.md)、[54 总体验收](54-remaining-development-acceptance.md)；本阶段详细验收见[62 标准](62-memory-foundation-acceptance.md)。

## 1. 目标与首轮边界

目标：每个明确绑定角色的群聊/私聊拥有可查看、添加、修改、删除、关闭的长期记忆；启用后以受限内容参与真实Agent上下文，随后可选自动提取和摘要。

首轮先完成手工事实记忆，再接检索/上下文，最后才做自动提取。不要一次开发向量检索、情绪、遗忘曲线、跨会话共享、独立记忆模型管理或浏览器采集。

明确默认：

- 默认enabled=false、autoExtract=false；关闭时不检索、不自动写入、不调用提取模型，但用户仍可通过明确管理操作维护手工记忆。
- 模型配置仍按账号，提取复用账号文本能力及现有凭据；本阶段不新增会话模型设置。
- 世界书是设定资源，记忆是会话运行数据；记忆不进入public资源库，不随角色卡分发。
- 关闭与删除分开：关闭保留数据；删除立即移出检索。删除记忆不等于删除原聊天、不撤回已发送QQ消息。
- 角色改变进入新的历史作用域；不自动迁移旧角色记忆。换世界书不改变记忆作用域。

## 2. 代码盘点与复用边界

| 已有位置 | 可复用内容 | 不应误用 |
| --- | --- | --- |
| src/storage/contract.ts | 消息seq、contextEpoch、有界历史读取 | 聊天历史不是可编辑记忆Store |
| src/profiles/role-bindings.ts | 显式角色、稳定contextRevision | 不能把每次变化的binding.revision当记忆目录键 |
| AccountService.resolveRoleBinding | 当前角色历史contextEpoch、发送校验revision | 世界书guard不得进入记忆namespace |
| src/agent/context.ts | 唯一上下文装配及字符预算入口 | 不在Provider适配器里再塞一份记忆 |
| src/instances/instance.ts | 捕获快照、入站保存、最终发送校验 | 不另建绕过现有发送准入的记忆回复通道 |
| 平台异步与原子写入模块 | KeyedSerialExecutor、Semaphore、AbortSignal、writeJsonAtomic | 不复制Promise链和文件提交算法 |
| src/jobs/service.ts/types.ts | 已有媒体任务生命周期经验 | 当前是MediaJobService及媒体结果/能力类型，不能直接把记忆伪装成图片/语音任务 |
| 资料与角色、公共Modal/草稿注册 | 会话绑定管理入口与交互保护 | 不恢复聊天会话页或任务历史页 |

当前未发现独立MemoryStore/MemoryService实现。以下新增文件为建议职责位置，可按仓库规范调整，不得由多个包各写一套隔离或检索逻辑。

## 3. 数据与隔离

### 3.1 唯一作用域

MemoryScope为{accountId,kind,peerId,contextEpoch}。contextEpoch来自服务端当前解析角色的稳定历史epoch，而非客户端任意输入，也不是含世界书guard的resolved revision。

namespace=SHA-256(JSON.stringify([accountId,kind,peerId,contextEpoch]))。目录建议accounts/<accountId>/memory/<namespace>/state.json；文件内保存完整scope并复核，不能仅相信路径。所有标识经现有identity/schema校验，不能直接拼接contextEpoch为目录。

前端GET返回opaque scopeToken（namespace即可）及state revision；所有写入携带expectedScope和expectedRevision。服务端重新解析当前显式角色并比较，角色切换后旧页面写入返回409，不会写到新角色。旧记忆暂不提供跨epoch查看/迁移入口，后续另行设计。

### 3.2 状态文件

```ts
interface MemoryState {
  version: 1;
  scope: MemoryScope;
  revision: string;          // 每次持久化修改的新版本
  generation: number;        // 每次内容/设置/重置修改递增，用于旧结果失效
  settings: { enabled: boolean; autoExtract: boolean; budgetChars: number; maxSelected: number };
  records: MemoryRecord[];
  extraction?: { throughSeq: number; lastCompletedSourceKey?: string };
}
interface MemoryRecord {
  id: string;
  revision: string;
  type: 'fact' | 'summary';
  content: string;
  keys: string[];
  pinned: boolean;
  origin: 'user' | 'model';
  createdAt: number;
  updatedAt: number;
  source?: { fromSeq: number; throughSeq: number };
}
```

首轮限制：每scope最多1000条、单条正文4000 UTF-16字符、总正文最多1048576字符；keys最多16个、每个128字符；budgetChars默认1500、范围0～8000，maxSelected默认8、范围1～20。文件有界读取上限8MiB，API沿用现有请求体上限，批量导入不在首轮。

ID、时间、revision、generation和模型origin由服务端分配；客户端不能把手工记录标成模型摘要或伪造已处理水位。MEM01只开放fact手工CRUD；summary由MEM03用例内部创建。不存在的全新scope返回默认关闭视图，首次明确写入才落盘；已存在但损坏/无权限的文件不能当空数据覆盖。外部手工删除整个记忆目录不属于“删除记忆”API，不承诺自动恢复，使用备份处理。

### 3.3 提交语义

每scope状态文件一个串行域，比较state revision后整文件原子替换。设置、内容和提取水位在同一文件提交；成功落盘后才替换内存快照/返回成功，失败不推进revision、generation或水位。

手工创建带稳定requestId，失败重试避免重复；对已处理请求使用有界回执，建议最近128个，明确过期重试可能需先查询，不声称永久幂等。回执与记录同次原子提交。相同requestId不同内容409。

不物理删除state文件：清空写入空records并增加generation，设置保留且autoExtract关闭。不得因删除后没有文件而使旧提取任务重新认为自己有效。磁盘坏数据不做静默重建；管理端提供明确错误和备份恢复说明。

## 4. API与应用结构

建议模块：src/memory/{types,schema,selector}.ts、src/memory/store.ts、src/application/memory/memory-service.ts。selector纯函数，不读账号目录或调用模型；Store不依赖HTTP/React；Core只做门面与退出准入。

以下为目标接口，实施时同步共享contracts与测试：

| 路径（统一前缀/accounts/:account/memory/:kind/:peer） | 输入/返回 | 约束 |
| --- | --- | --- |
| GET /settings | settings、scopeToken、revision、generation、数量 | 未绑定角色时明确错误，不创建文件 |
| PUT /settings | settings、expectedScope、expectedRevision | 不改角色绑定，不隐式调用模型 |
| GET /records | offset/limit（默认50、最多100） | 当前scope有界摘要；不返回其他epoch数据 |
| GET /records/:id | 指定正文与来源摘要 | 复核scope归属 |
| POST /records | 手工fact字段、requestId及双expected | 分配服务端身份与时间 |
| PUT /records/:id | 可编辑字段、双expected、record revision | state/record冲突409，不静默覆盖 |
| DELETE /records/:id | 双expected及record revision | 更新generation，立即不参与检索 |
| POST /clear | 双expected | 明确二次确认后清空、关闭自动提取，保留状态文件 |
| POST /preview | text、expectedScope | 只用已保存记忆/设置与示例文本，不读真实聊天或写入 |

scope不存在与未绑定角色要区分：新scope有默认设置，但没有角色不能生成一个“账号默认记忆”。管理CRUD须鉴权、审计标识和数量，日志不写正文/测试文本/密钥。400校验、404指定记录或绑定缺失、409作用域/版本变化、413体超限、I/O错误按现有安全错误映射。

已关闭的MEM01阶段管理操作可工作，运行时不取记忆；不要把MEM01 CRUD通过写成上下文已生效。

## 5. MEM02：检索、预算与真实运行链路

选择器输入规范化记录、当前文本和参数；首轮只按字面关键词OR、pinned和近期顺序：pinned优先，其次命中记录，组内updatedAt降序、id稳定打破平局。无关键词且未pinned的fact仅保存不自动注入，页面明确说明。最多选maxSelected条，整条加入，预算不足跳过不截断。

扫描当前文本最多16000字符，并设置与世界书同量级的比较工作上限和完整结果缓存；没有开启、预算0或无记录直接返回。检索不访问其他scope，不递归扫描命中正文，不执行正则/宏。

buildChatContext分配顺序：基础角色/Skill/媒体规则和当前消息→现有世界书→记忆→剩余近期历史。现有maxHistoryChars实际为本轮文本空间上限，暂不改名扩大范围；记忆区块标题/分隔全部计费。基础已满不追加记忆。BuiltContext返回选中ID/字符/受限标记，日志仅记计数。

运行时在每轮捕获memorySnapshot与generation，加入现有发送guard；namespace只由contextEpoch计算，绝不能由带memory guard的revision反推，避免循环或每次编辑创建新目录。记忆编辑/删除/关闭/清空后旧上下文回复被最终发送处拒绝；同角色聊天历史epoch保持。

关闭后不读记忆正文装配上下文，但仍要能发现设置变化以拒绝旧轮。启用状态I/O/解析失败时该会话自动回复失败关闭并给出安全诊断，不影响手动发送和其他会话；不能把损坏当成正常空书。内存缓存若引入，必须有明确失效机制，不能先返回成功后异步落盘。

## 6. MEM03：可选提取与摘要

只有enabled和autoExtract都明确开启才运行。捕获当前scope、generation、来源范围、角色guard及模型配置；每scope最多1个活跃提取，建议全局最多2个、待处理最多32个，输入最多50条/24000字符，超限明确截取范围或延后，不阻塞普通收发。

现有MediaJobService不能直接承载记忆结果。本包先确定最小MemoryExtractionCoordinator，复用平台有界串行/信号量/取消/超时/退出drain，不复制媒体任务状态机或新增通用任务后台。首轮提取任务可仅驻内存，重启不自动重发付费请求，持久成功水位保存在MemoryState。

只提取服务端已保存的当前scope消息，不包括其他角色历史；来源范围在提交前复核。输出用严格JSON schema和总量限制，只允许有限fact/summary候选；当外部数据处理，不能执行其中工具、目录或权限要求。

任务落盘前在scope串行域内重验generation/角色/设置及来源水位，任一变化就放弃陈旧结果，失败不推进成功水位。重叠来源、重复回调和重试不得重复写记忆。用户改过的fact不由模型静默覆盖；冲突候选另行提示或跳过。

只有选入上下文且验证来源范围的summary，才允许从近期历史省略其覆盖的原消息。summary未命中/超预算/被删除时保留原历史，不能因“存在摘要”就全局丢掉聊天上下文。首轮可先只做fact提取，summary另一步启用并独立验收。

删除/清空/关闭会使在途提取失效；可能仍存于原聊天的信息不应被描述为彻底物理遗忘。对用户明确删除的记录，至少禁止已经在途的来源重新写回；是否禁止未来重新提取同一事实需持久抑制规则，MEM03必须在实现前单独定稿并展示，不承诺只靠generation解决永久抑制。

## 7. MEM04：管理界面

入口放在现有资料与角色的会话绑定详情，不增加聊天页。显示账号/群私聊/角色作用域、记忆开关、自动提取开关、预算、事实列表/详情、来源标识、新增编辑删除清空及只读示例测试。

复用公共控件、暖浅色token、Modal和草稿保护；账号/角色变化不复用旧草稿写入新scope。保存以服务端规范化返回建立基线，409保留草稿；列表刷新失败与写入结果分开。删除/清空说明原聊天保留，自动提取可能付费须明确开启。

## 8. 可派发任务与放行条件

| 包 | 交付 | 必须证据 |
| --- | --- | --- |
| MEM01-A | 共享schema/MemoryScope/Store/默认值 | 隔离、限制、CAS、写失败、回执/清空、重启 |
| MEM01-B | MemoryService、Core/API/审计 | 鉴权、expectedScope、旧角色写入拒绝、不调用模型 |
| MEM02-A | 纯选择器与预算预览 | 稳定顺序、整条预算、扫描上限、只读 |
| MEM02-B | 快照/guard/实际Agent | 删除与关闭拦截旧回复、历史保持、错误隔离 |
| MEM03-A | 提取协调与严格输出 | 有界队列、超时、撤销/旧任务失效、成功水位 |
| MEM03-B | 可选summary及去重 | 来源范围、未选摘要不删历史、重复提取/手改冲突 |
| MEM04 | 页面与集成验收 | 真实浏览器管理闭环、dirty/旧请求/退出/scope切换 |

**下一次直接派发MEM01-A/B**，不要求同时做自动提取与完整界面。其通过后再派发MEM02，不能只做Store单测就称长期记忆可用。MEM03删除后未来再提取策略应先记录设计，再开发自动写入。

本文件完成MEM00现状盘点和基础设计。各任务允许调整局部命名，但作用域、guard/历史分离、删除、付费与失败语义若改变，必须同步方案与验收。当前没有实施记忆功能、提交Git或更新EXE。
