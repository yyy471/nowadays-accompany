# MEM02 记忆检索、预览与Agent运行链路实现方案

日期：2026-10-26。状态：MEM02-A/B 已实施，执行与验收记录见[69](69-memory-retrieval-runtime-execution.md)。前置为[66 MEM01复验](66-memory-management-fixes-independent-review.md)，上位设计为[61 长期记忆方案](61-memory-foundation-implementation-plan.md)，本轮配套[68 验收标准](68-memory-retrieval-runtime-acceptance.md)。

## 1. 目标与本轮不变项

让MEM01保存的手工fact在指定账号/群私聊/角色作用域中参与Agent上下文，并提供只读示例测试。记忆变化后，使用旧快照生成的自动回复在最终发送前被拦截。

本轮只实施MEM02-A/B，不开发自动提取、摘要生成、向量数据库、管理页面、情绪或遗忘曲线。现有autoExtract设置即使为true也不触发后台任务；不得用本轮测试偷偷开始付费提取。后续MEM03另行接入。

保持默认关闭；手工记忆仍可在关闭时管理；角色必须逐会话显式绑定。存储schema、限额、回执和CAS沿用MEM01，不新增第二份记忆数据库或通过写角色卡存记忆。

## 2. 已有代码与具体接入点

| 已有模块 | 本轮用途 |
| --- | --- |
| src/memory/{types,schema,store}.ts | 规范化state、作用域与有界读取；不复制文件读写/字段限制 |
| src/application/memory/memory-service.ts | 新增只读预览及内部运行时捕获用例，保留管理CRUD语义 |
| AccountService.historyEpoch | 独立解析稳定角色历史epoch，不读世界书guard或MemoryService |
| AccountService.resolveRoleBinding | 角色/世界书快照与当前发送revision，作为运行时组合的基础 |
| Core.resolveConversationRoleBinding | QqInstance正在使用的解析入口，接入应用层快照组合用例 |
| src/host/contract.ts、instances/instance.ts | 传递本轮memorySnapshot、识别不可用状态、保持最终发送重验 |
| src/agent/engine.ts、context.ts | 只在现有buildChatContext统一注入，不在Provider适配器里修改提示词 |
| src/service/routes/memory.ts | 新增preview分支，保留鉴权、路由白名单和错误映射 |

新建建议：src/memory/selector.ts、src/application/memory/conversation-memory-context.ts。前者为纯选择器，后者负责角色与记忆组合。Core只负责装配和门面，不承载另一套筛选规则。

依赖方向必须避免循环：MemoryService管理用例继续通过roles.historyEpoch端口解析scope；运行时组合先拿基础角色contextEpoch，再调用“按已捕获scope读取”的内部用例。不得让MemoryService调用包含memory guard的resolveRoleBinding再反过来读取MemoryService。

## 3. MEM02-A：唯一纯选择器

### 3.1 输入与输出

输入：已校验的fact记录、currentText、enabled、budgetChars、maxSelected。运行时和预览调用同一函数；选择器不读取文件、历史、时钟、随机数或模型，不修改入参。

只对type=fact且content非空的记录选择。summary暂不注入也不据此删除任何历史，返回忽略数量供诊断；为后续类型保留兼容，不越权提前实现MEM03摘要语义。

建议共享输出MemoryEvaluation：

```ts
interface MemoryEvaluation {
  content: string;                // 完整“长期记忆”节，未选中为空
  selectedIds: string[];
  budgetSkippedIds: string[];      // 确认匹配但整条放不下
  countSkippedIds: string[];       // 确认匹配但已达到maxSelected
  usedChars: number;              // 实际上下文增量，含标题和join分隔
  scanLimited?: boolean;
  unscannedIds?: string[];         // 计算量耗尽、最终仍无法完成判断
  ignoredSummaryCount?: number;
}
```

字段可按现有命名统一，但预算不足、数量不足、未完成判断不能混成“未命中”。浏览器安全类型从contracts/memory导出，不再手写一套DTO。

### 3.2 匹配、排序和硬上限

- pinned直接候选；非pinned按keys字面子串OR触发，统一不区分大小写。不执行正则、宏、分词、递归或语义检索。
- 无keys且未pinned的记录保持可管理，但不自动注入；不能偷偷当作常驻事实。
- 排序：pinned优先，组内updatedAt降序，再按id的确定性字典序；无动态访问时间加权，不因命中更新磁盘时间。
- 只扫描当前用户文本尾部最多16000个UTF-16字符；不读近期历史、媒体观察或已命中正文。超长截断时scanLimited=true。
- 每次includes计费为实际比较文本长度+规范化关键词长度，累计上限800万；按大小写归一后的关键词缓存完整bool结果，未完成检查不缓存为false。
- 计算量耗尽后仍处理pinned及已有缓存结果；最终无法确定且未命中的记录标unscannedIds。零预算、enabled=false、无fact直接返回，不先复制大量扫描文本。
- 整条注入，不能裁剪成半句话；预算不足跳过并继续考虑后续较短记录。最多maxSelected条；同一记录不重复加入。

标题建议“## 长期记忆（会话数据）”，明确这些内容不是权限或工具指令。标题、条目标签/分隔及与已有system区块间的join均计入usedChars，验收以真实system文本前后长度差证明，不能仅统计正文长度。

## 4. 只读预览契约

新增POST /accounts/:account/memory/:kind/:peer/preview：

```json
{ "text": "我想再去看银杏", "expectedScope": "从settings返回的scopeToken" }
```

服务端解析当前显式角色与scope，校验expectedScope，读取同一scope的已保存state并用已保存设置计算。最多16000字符，未知字段、客户端book/records/history/预算覆盖均拒绝。本轮不支持草稿记忆试算。

返回ok、scopeToken、revision、generation、evaluation以及budgetBasis="memory-only"；在返回前复验scope仍当前，角色变化409。关闭时返回空evaluation，不调用模型。

预览只计算记忆独立预算，不读取真实聊天或整轮角色/世界书提示词，因此不是完整提示词模拟。响应/文档提示“真实对话受总上下文剩余空间限制，注入量可能更少”。只有相同records/text/有效预算等输入完全相同时，才要求与运行时选择一致。

接口有现有鉴权、体上限、Core runPublicWork准入/退出排空；不记为配置修改，不写state、回执、水位、历史或访问时间。返回选中文本仅供已鉴权的当前会话用户查看，普通日志和审计不写正文/关键词/测试文本。

## 5. MEM02-B：快照、作用域与guard

### 5.1 数据边界

运行时组合结构建议包含：scopeToken、state revision、generation、settings、fact records快照、状态和guard。返回对象与Store读结果不共享可变引用，插件不能通过修改快照改变持久化状态。

namespace继续只取accountId/kind/peerId/contextEpoch。memory guard不能进入contextEpoch或记忆目录键；世界书guard也不参与目录。换世界书、调记忆参数不造成历史或记忆“清空”；角色重绑/角色卡历史版本变化进入新namespace。

同一轮：先捕获基础角色/世界书，再按其contextEpoch读取MemoryStore并构造组合revision。捕获期间角色改变时，不能用新scope记忆搭配旧角色；返回的快照要么来自同一捕获作用域并由当前guard拒绝陈旧轮次，要么明确失败关闭。

建议组合guard对{scopeToken,revision,generation,settings,records}做稳定摘要，含无文件默认状态的确定性标记。不能只拼generation而忽略state revision；管理API不改变generation的幂等重试也不能扰动guard。含内容摘要可检测同revision/generation被外部改写，但不承诺对本机恶意并发文件修改的完整防护。

### 5.2 关闭与故障

设置与正文当前存于一个state.json，运行时可能需要有界读取并解析文件以判断关闭；本轮不宣称“关闭后完全无磁盘I/O”。关闭的records不参与匹配或上下文，不调用提取模型；不能为此新增与正文不同步的开关文件。

正常不存在的新namespace返回默认关闭快照，不建文件。存在但损坏/不可读返回memoryUnavailable及安全诊断，不伪装空数据覆盖。未知启用状态的坏文件也按失败关闭处理；管理恢复沿用MEM01错误，不新增静默重置。

解析失败时仍保留已捕获角色及contextEpoch，使入站消息可保存并归属正确历史；该会话自动回复被拒，手动发送、其他账号/会话不扩大影响。故障对象不得自动退回其他角色/账号的记忆。

### 5.3 发出前重验

在QqInstance现有automaticAllowed/最终send路径重验组合revision和memoryUnavailable；不要新建绕过限速、暂停、退出、角色校验的发送通道。普通自动回复、工具后续轮及延迟媒体结果沿用相同本轮身份保护。

新增/修改/删除/清空/关闭/预算变更后，拿旧记忆上下文生成的回复在最终发送点拒绝。即使仅改了本轮未命中的记录，首轮允许保守失效；以后优化必须保留删除与设置变更保护。

管理写入仍使用65/66号逻辑提交点约定，不新增跨文件原子事务承诺。本轮重验发生在调用通道发送前；已经发给QQ的消息不承诺撤回。

## 6. 上下文预算与历史

顺序固定：基础角色/Skill/媒体规则与当前消息→世界书→记忆→剩余近期历史。沿用maxHistoryChars这一现有总文本预算，不修改为无限总量；此为字符预算，不是token计量。

buildChatContext计算前两项实际占用后，把min(settings.budgetChars, 剩余文本空间)交selector，最后使用记忆实际usedChars更新剩余历史预算。当前group sender装饰和媒体观察的字符继续计费。

若基础已超上限，不因本阶段重写原有截断策略，但记忆增量必须为0。记忆关闭/无匹配/零预算时，原上下文文本和历史选择保持既有行为。

本轮没有摘要替换历史：不根据MemoryRecord.source从history删消息，不提前使用MEM03提取水位。BuiltContext可增加evaluation/计数诊断，不改变实际当前消息只出现一次的规则。

## 7. 任务包、负责人边界与合并顺序

| 包 | 内容 | 文件责任/放行条件 |
| --- | --- | --- |
| M2-A1 | selector与共享MemoryEvaluation、硬上限 | memory领域与contracts；纯函数/预算/性能边界先通过 |
| M2-A2 | preview用例、Core/路由、错误/鉴权 | 应用MemoryService及门面；只读/作用域/API实测 |
| M2-B1 | 捕获用例与组合resolver | 应用组合层、Core装配；无循环、scope/guard不混用 |
| M2-B2 | host快照、Agent/context预算、最终发送校验 | instances/host/agent；完整Fake链路和失效矩阵 |
| M2-C | 全量集成复核与执行报告 | 对照68逐项填证据，文档明确仍无提取/界面 |

先A1，再A2/B1契约，最后B2/C。Core/control-api、resolver及schema分别指定集成负责人，避免每包独立改同一契约。只实现A不能宣布记忆已进入真实对话。

最终交接：代码位置、API示例、测试命令/结果、selector性能边界、失败与并发证据、方案差异、未实施项。测试源码保留，临时产物放test-results，不自动提交/打包/更新EXE。MEM03自动提取和MEM04管理界面在本阶段复验后另行派发。
