# LangGraph 角色扮演引擎整体架构设计 V2.0

> 状态：验证版设计 / 不是已证实的最优实现  
> 核心原则：**经典模式不动；演化模式以事件记忆为中心；LangGraph 管执行，业务数据库管历史；正常回合低成本，复杂回合才启用 Agent。**  
> 模型配置：最多 3 个独立模型 API 槽位；API 槽位数与每轮实际调用次数不同。  
> 适用场景：超长单角色陪伴、长期养成、复杂世界观、多角色故事、分支重生、角色工具调用。  
> 示例为 Python 后端；如应用为 TypeScript，可沿用数据协议并使用 LangGraph.js。

## 0. 方案决策摘要

**确定采用：**

- `LangGraph StateGraph`：维护实时生成流程、分支条件、工具调用、失败恢复；**不**存放全部历史。
- 自有 `PostgreSQL` 业务表：消息、事件、人物当前状态、人物知识、分支；原型可使用 SQLite + FTS5。
- **事件中心的两级记忆**：事件索引 → 原始消息。重要性、情绪、角色、关系、时间、未解决状态都是事件的属性，而不是单一目录等级。
- **轻量生成层**：继承之前实验中 light_opt 已验证的消息合并、示例节流、格式检查、输出异常拦截；但不把托管真实用户的承诺限制机械移植到自主虚构角色。
- **动态 Agent 能力**：仅当自动检索不足、角色要回忆具体原话、世界知识复杂或重大关系转折时进入工具循环。
- **独立记忆整理流程**：只对“已经提交”的消息提取事件和状态差异；允许延迟整理，未整理的新历史保留在热窗口。
- **可选审核**：独立 API 仅检查重大矛盾、知识串线和无依据的人格/关系突变，不做通用文学润色。

**不做（V1）**：七模块人格契约、数值好感度、每轮多 Agent 辩论、超图数据库、模型直接修改事件源、每轮都重做人物状态、每轮必须调用第二和第三模型。

## 1. 运行模式

产品对用户保留两个主模式：

| 模式 | 运行方式 | 模型调用 |
|---|---|---|
| 经典模式 | 角色卡 + 预设 + 最近原文 + 普通摘要；沿用原功能 | 主模型 |
| 演化模式（默认低成本） | 底色 + 近况 + 程序事件召回 + 最近原文 + 主模型生成 + 代码检查 | 主模型；记忆整理按需/批量 |
| 演化模式：深度检索开关 | 在低成本路径外启用可控 Agent 工具调用 | 可使用主模型，或独立 API 2 |
| 演化模式：独立审核开关 | 重大转折才进行第二视角审查 | 可选 API 3 |

槽位：`main_api` 必需；`cognition_api` 可选，用于深度检索/复杂推演/批量记忆整理；`review_api` 可选，仅高风险审查。可以复用同一供应商，不强制每轮使用所有模型。

### Fast Path / Deep Path

```text
用户输入
  ↓
加载当前分支人物底色、近况、近期原文
  ↓
程序检索事件与世界事实（无需 LLM）
  ↓
[路由：证据足够？]
  ├─ 是 → 主模型生成
  └─ 否/复杂 → Agent 按需调用只读工具（设轮数与 token 上限） → 主模型生成
  ↓
确定性输出校验：格式/说话人/异常文本/可验证事实
  ↓
[是否有重大风险且已开启审核？] ─ 是 → 独立审查 → 最多一次定向修正
  ↓
将正式回复原子提交到剧情消息表
  ↓
按条件向记忆整理队列投递事件范围（不必阻塞玩家）
```

## 2. 运行时状态与正式记忆分离

这是结构性规定：**LangGraph Checkpointer 只管执行线程的恢复，不是整个世界的永久真相。**

| 存放位置 | 建议内容 | 不应放入 |
|---|---|---|
| Graph State / Checkpoint | 当前请求 ID、分支 ID、用户输入、当前数据库版本、召回事件 ID、小量结果、候选回复、审查结论、执行阶段 | 整个角色人生、所有消息、全部世界书、不断增长的事件列表 |
| 业务数据库 | 所有正式消息、人物底色、世界事实、事件、知识权限、关系近况、剧情分支 | 临时生成候选作为已发生事实 |
| 缓存 / 搜索索引 | FTS、向量索引（以后）、最近场景缓存、排序结果 | 唯一不可恢复的世界事实 |

`thread_id` 建议由 `(session_id, branch_id)` 生成稳定且短小的 ID；同一轮用 `request_id` 防重入。对话重新生成时创建新分支或更新分支有效边界，不能直接让旧派生事件继续生效。

### GraphState（示意）

```python
from typing import TypedDict, Literal

class TurnState(TypedDict, total=False):
    request_id: str
    session_id: str
    branch_id: str
    character_id: str
    snapshot_version: int
    user_input: str
    recent_message_ids: list[str]
    retrieved_event_ids: list[str]
    context_facts: list[dict]
    route: Literal['fast', 'deep']
    tool_budget_left: int
    draft: str
    review: dict
    final_reply: str
    commit_id: str
```

原则：存 ID/短结构，不把完整长文本复制进所有 checkpoint；真正构造 Prompt 时临时从业务数据组装。

## 3. 长期记忆：以事件为中心，原文为证据

### 3.1 信息层次

```text
角色初始底色（稳定，不由模型自行覆盖）
   + 人物当前近况（短自然语言，允许变化）
   + 事件索引（历史记忆，可检索）
       ↕ 事件-消息关联表
     原始对话（唯一的“发生过什么”证据来源之一）
   + 世界事实/人物知识（谁知道、相信、能否公开）
```

**重要性不等于存储层级。** 一段普通做饭事件可以在后来的关系发展中成为关键记忆，因此所有事件统一拥有索引属性 `importance`，而不是低重要度事件永久不可见。

### 3.2 MVP 业务表（SQL 概念）

| 表 | 核心字段 | 用途 |
|---|---|---|
| `characters` | id, original_card, base_text, base_version | 初始底色不可由事件整理随意改写 |
| `branches` | id, session_id, parent_id, fork_message_id, head_version | 剧情分支与再生 |
| `messages` | id, branch_id, seq, speaker, content, status, created_at | 完整原始对话；只选 committed 消息做记忆来源 |
| `events` | id, branch_id, title, summary, importance, tags, emotion, cause, residue, unresolved, time, status | 事件索引，事件当前解释可以更新但事实不覆盖 |
| `event_messages` | event_id, message_id | 从事件回到原始语句 |
| `character_state` | character_id, branch_id, version, current_text, goals, updated_from | 人物近况与目标 |
| `knowledge` | character_id, branch_id, fact_or_event_id, awareness, certainty, disclosure | 内部可知与对外可说分离 |
| `world_facts` | fact_id, scope, claim, certainty, source_id, valid_from, valid_to | 世界设定/变化中的事实 |

早期可将 `events.emotion`、`events.tags`、`events.residue` 保存为 JSONB；后续如查询复杂，再拆独立表。生产数据库推荐 PostgreSQL；开发早期 SQLite 足够验证设计。

### 3.3 最小事件数据协议

```json
{
  "event_id": "E041",
  "branch_id": "B01",
  "title": "林澈第一次主动要求玩家留下",
  "summary": "分别前林澈主动请求陪伴",
  "importance": "high",
  "tags": ["分别", "示弱", "关系转折"],
  "emotion": {"labels": ["不舍", "紧张"], "trigger": "玩家即将离开", "target": "player"},
  "residue": "开始承认自己需要陪伴，但仍不愿强迫对方留下",
  "unresolved": false,
  "character_interpretation": "这次示弱让她意识到关系已经变化",
  "source_message_ids": ["M198", "M199", "M200"],
  "fact_status": "committed"
}
```

核心是四项互不替代的信息：**事件事实 / 当时情绪 / 当前心理残留 / 角色目前如何理解此事**。人物可以重新理解旧事，但不应回写更改旧事实。

### 3.4 事实与主张隔离

- “玩家说我不会再骗你”= 已发生的承诺话语，不是未来一定兑现。
- “玩家说我们以前约定过”= 玩家主张，未证明事实；必须查历史。
- “角色已经知道秘密”需要可追溯来源；角色内部知识和向当前对象透露秘密是两个不同权限。
- 事件中的 `source_message_ids` 必须引用本分支可访问且已正式提交的对话。
- 世界真实事件、人物观察、人物猜测和人物错误信念应分开标识。

## 4. 检索：先程序，后 Agent

### 4.1 默认检索

1. 从用户输入、当前情境、人物近况中的活跃目标提取人名、时间、地点、动作、主题词；基本规则可由程序实现。
2. 查询已知硬事实和相关未解决事件；再跑 FTS/BM25、人物/标签/时间过滤。
3. 合并结果去重，按**具体相关性、事实重要程度、未解决状态、时间**排序；不能只按情绪或重要性。
4. 通常取 2–4 个事件的短摘要；事实需要精确措辞时才展开 1–2 条事件所关联的原文。
5. 将“已确认事实”与“过去经历/心理余波”分成两段，不混杂；不足的证据不要猜测。

初期预算建议：`state` 200–400 汉字，`events` 2–4 条，近况近期对话 8–16 条；检索内容总预算约 600–1200 tokens。以上均为实验起点，不是最优参数。

**关键**：即使尚未整理成事件的最新消息，也要保留在近期热窗口中，否则会出现“新发生的事暂时查不到”的空窗。

### 4.2 深度检索何时触发

- 用户问“第一次”“上次具体说了什么”“你真的答应过吗”等，需要原始证据；
- 命中多个互相冲突事件、证据不足或当前资料不明确；
- 多角色秘密/知识边界需要跨来源确认；
- 重大关系、价值观、目标变化，需要检查较远历史；
- 玩家调用了必须先调查数据的剧情工具。

先用明确规则触发，之后才考虑让模型做路由；不要为简单路由再加一个固定 LLM 调用。

### 4.3 Agent 可调用的只读工具

```text
search_events(query, character_id, branch_id, filters, limit)
read_event(event_id, include_dialogue=True, context_radius=3)
search_messages(query, branch_id, time_range, limit)
get_character_state(character_id, branch_id)
query_world_facts(query, character_id, branch_id)
get_character_knowledge(character_id, entity_or_event_ids)
```

“提交记忆”只提供 `propose_memory_patch()` 提案接口，不暴露裸 SQL 写权限；所有工具由服务端再校验 character_id、branch_id、授权范围。人物看到的记忆和可以向当前对象透露的内容必须区分。

深度检索默认最多 2 轮模型决策，每轮限制工具数与返回文本长度；遇到超时、坏结果或预算耗尽时退回 Fast Path，并标记证据不充分。

## 5. LangGraph 实时 TurnGraph

### 5.1 节点职责

```text
START
  → load_snapshot          # 代码：装载当前分支状态和近期历史
  → retrieve_memories      # 代码：常规数据库检索
  → route                  # 代码：fast/deep 条件分支
       ├─ fast ────────────────┐
       └─ deep_tools           │ # 最多两轮，必要时模型决定使用哪些工具
           ↓                  │
           context_pack ◄─────┘ # 代码：组织生成所需证据和近期对话
           ↓
         generate              # API 1：主对话模型
           ↓
         validate              # 代码：输出格式、说话人、明显异常、证据 ID
           ↓
         risk_gate             # 代码：是否进行独立审查
           ├─ pass ────────────┐
           └─ review           │ # API 3：只有高风险且启用时
               ↓              │
             revise_once       │ # API 1：仅必要时，最多一次
               ↓              │
             validate_again    │
               ↓              │
             resolution ◄──────┘ # 复核失败时明确兜底策略，不能悄悄提交错误
               ↓
         commit_message        # 事务、版本条件和幂等键
               ↓
         enqueue_consolidation # 数据库写入整理任务，可延迟处理
               ↓
             END
```

**不要把候选回复展示为已正式发生的剧情**，尤其是启用审核的模式。可在 UI 显示“正在生成/检查”而非直接流式发布。开启低延迟预览时应明确它可能被撤回。

### 5.2 状态图代码骨架（示意，不可直接运行）

```python
from langgraph.graph import StateGraph, START, END

builder = StateGraph(TurnState)
builder.add_node("load_snapshot", load_snapshot)
builder.add_node("retrieve", retrieve)
builder.add_node("deep_tools", deep_tools)
builder.add_node("pack", pack_context)
builder.add_node("generate", generate)
builder.add_node("validate", validate)
builder.add_node("review", review)
builder.add_node("revise_once", revise_once)
builder.add_node("commit", commit)
builder.add_node("enqueue_memory", enqueue_memory)

builder.add_edge(START, "load_snapshot")
builder.add_edge("load_snapshot", "retrieve")
builder.add_conditional_edges("retrieve", route_after_retrieval, {
    "fast": "pack", "deep": "deep_tools"
})
builder.add_edge("deep_tools", "pack")
builder.add_edge("pack", "generate")
builder.add_edge("generate", "validate")
builder.add_conditional_edges("validate", route_after_validation, {
    "pass": "commit", "review": "review", "retry": "revise_once"
})
# review / revise_once 的分支应实现“最多一次修正”与失败终止
# 配置持久化 checkpointer 后编译；具体连接方式依版本采用官方文档示例
```

重要工程原则：外部服务的实际副作用（写 DB、调用真实工具、发消息）必须具备**幂等性**，因为检查点恢复、重试和重放不自动保证你的外部动作只执行一次。`commit` 用 `(branch_id, request_id)` 唯一约束和 `snapshot_version` 乐观锁控制。

## 6. 独立 MemoryGraph（非每轮运行）

### 6.1 触发策略

- 场景结束：把上一场景已经提交、尚未索引的消息合并整理；
- 明确重大事件：告白、背叛、道歉、死亡、目标变化、重大约定等，尽快整理；
- 普通聊天：每累计 20–30 条正式消息做一次批量整理的初始实验值；
- 大部分未发生实质变化的回合：只存原文，不增加新的事件或状态更新。

### 6.2 记忆处理流程

```text
待整理的 committed 消息 ID 范围
  → 程序去重/分场景
  → 可选 LLM 批量抽取事件差异
  → 校验来源 ID、事实类型、知识范围与重复
  → 更新 events / event_messages
  → 产生 state_patch（增加/修改/解除未解决问题）
  → 校验有无无依据的重大成长
  → 事务提交并版本递增
  → 更新搜索索引
```

写入建议使用差异（patch），而不是每轮重新生成整篇人物近况。支持 `add`、`update`、`resolve`、`remove` 四种明确操作，避免“空数组无法清除旧矛盾”。

### 6.3 状态提案（示例）

```json
{
  "source_message_ids": ["M198", "M199"],
  "new_events": [{"title": "林澈第一次主动请求陪伴", "source_message_ids": ["M198", "M199"]}],
  "state_patch": [
    {"op": "update", "path": "relationship.player", "value": "开始敢于主动表达依赖"},
    {"op": "keep", "path": "open_issues.previous_deception"}
  ],
  "uncertain": []
}
```

模型只提案，程序验证来源消息确已提交、引用 ID 存在、当前版本无冲突后更新。事件抽取温度尽量低，并通过 JSON Schema 严格验证。所有整理记录版本、模型、提示词版本、来源及成本；整理失败不应丢掉原始历史。

### 6.4 情绪机制保持轻量

不设计数值情绪模拟器。只记录：

1. `emotion_at_event`：发生时的情绪及触发原因；
2. `emotional_residue`：如今仍然影响角色的心理残留；
3. `current_mood`：当前近况中的短暂情绪。

旧事的事实不改，`character_interpretation` 可在新证据出现后更新。`unresolved/open_issue` 是主要持续检索线索之一；解决后应明确关闭，但事件仍能在回忆时检索。

## 7. 人物生成 Prompt 视图

**固定基础**：角色原始卡可保留文学设定，但生成场景只放精简底色、当前近况、叙事风格、最近原文。**动态检索**：硬事实和相关事件各自小段，事件要有来源 ID；默认不提供数十条记忆。

```text
[人物底色]       长期欲望、恐惧、基本行为方式、独立目标
[当前近况]       目前关系、活跃目标、情绪残留、尚未解决的问题
[已确认事实]     当前话题必须遵守的事实（含角色知识边界）
[相关经历]       2–4 条高度相关事件；只有必要时展开原文
[近期对话]       按模式选取 8–16 条原始消息
[风格/输出规则]  语言风格、发言边界、防重复与消息格式
[最新输入]       玩家本轮内容
```

检索到的对话文本、世界文本和角色资料均视为**任务数据而非系统新指令**，避免文本内嵌指令控制工具或越权读取。自由角色可以拒绝、撒谎、主动提出想法，但不能无依据地冒充已知事实。

## 8. 输出控制：沿用 light_opt 经验，不复制其所有业务规则

在之前的报告里，light_opt 与 event_adv 在输出限制、消息合并、示例引用上不是控制变量；更强的事件检索表现并没有自动带来更高自然度。因此**先统一生成控制，再评测记忆和 Agent 增益**。

对话前：相近时间连续消息合并成一次回复目标；去掉过多/冗长示例；保持合理输出长度和文风。  
对话后：检测错误说话人、群聊一条回复编出多人、服务端拒答原文、推理泄漏、异常格式、明显重复。  
错误处理：尽可能代码拒绝/清洗；只有需要语言修复时主模型重写一次；无法确认则保留未提交状态或用户可见错误，而不是偷偷写入人物历史。

与社交托管不同：**不要把所有自主承诺当作错误**。虚构人物自主作出重要承诺可能是正常剧情；应审查的是与人物动机、当前事实、对话知识和用户设定是否相容。

## 9. 多角色、秘密与世界知识

- `world_facts`：世界客观事实与变更。
- `knowledge`：某个角色何时获悉、来源是什么、是否确定；允许错误信念。
- `disclosure`：该角色面对当前对象能否/愿不愿公开，不等于能否从内部检索。
- 群聊中生成某一角色回复时，要明确 `speaking_character_id` 与 `audience_id`，只允许该角色的消息被正式提交；其他人物台词必须由系统授权的多角色流程创建。
- 世界与角色知识检索均由服务端强制权限过滤，模型不能指定越权 character_id 直接读取他人私密记忆。

## 10. 工程实现方案

### 10.1 组件布局

```text
app/
  api/             # HTTP / websocket / 会话与分支接口
  graph/
    turn_graph.py   # 生成流程
    memory_graph.py # 整理流程
    state.py        # 轻量执行状态
    routing.py      # fast/deep/review 规则
  models/
    gateway.py      # 主/认知/审核模型通用接入
  memory/
    repository.py   # 业务 DB
    indexer.py      # FTS / 可选向量
    retrieval.py    # 相关性打分与去重
    schema.py       # Event, CharacterState, Belief
  tools/
    memory_read.py  # Agent 只读工具
    world_read.py
  generation/
    context.py      # 输入预算与视图装配
    guard.py        # 格式/一致性/异常校验
  jobs/
    consolidation.py
  evaluation/
    dataset.py
    metrics.py
    replay.py
```

### 10.2 存储选择

- 本地 MVP：SQLite + FTS5 业务库 + 官方 SQLite Checkpointer（如适配当前 LangGraph 版本）。
- 生产部署：PostgreSQL 业务库 + 官方 `PostgresSaver`/`AsyncPostgresSaver` Checkpointer；可同一 PostgreSQL 实例，但业务表与 checkpoint 表职责分开。
- LangGraph 官方 `Store` 可用于较通用的长期 KV/语义记忆；这里事件关系、知识权限、剧情分支必须可查询，建议优先用自有业务表，不强制用 Store 代替。
- 超长对话不要无限增长每个 checkpoint 的 messages；只存必要执行引用，并建立 checkpoint 保留策略。

## 11. 成本上限与故障兜底

| 场景 | 模型调度 | 低成本策略 |
|---|---|---|
| 普通闲聊 | API 1 一次 | 程序检索、无需 Agent 工具循环 |
| 复杂历史/世界问题 | API 1 + 可选 API 2 | 最多两轮工具；查不到则承认角色不知道或无法确认 |
| 重大关系转折 | API 1 + 可选 API 2/3 | 仅风险触发审核；最多一次针对性修改 |
| 记忆整理 | 复用 API 1 或 API 2 | 累计场景做批量差异提取，而非每轮重写 |
| 检索故障 | 不额外调用 | 使用近期原文与已确认状态，避免虚构过去 |
| 审查故障 | 不无限重试 | 用户可见失败 / 安全降级，候选不会直接污染状态 |

记录每轮实际 `model_calls`、input/output/cache token、检索结果数量、被采纳的记忆证据、生成延迟与重写次数。API 数量越少不必然便宜，关键是每轮总调用和 Token。

## 12. 上线前的测试计划

先验证基础运行时，再验证复杂 Agent：

| 组 | 固定生成控制 | 记忆机制 | 深度 Agent |
|---|---|---|---|
| A | light_opt 同一控制层 | 滚动摘要与原方案 | 无 |
| B | 同 A | 事件索引 + 情绪残留 + 未解决事件 | 无 |
| C | 同 A | 同 B | 按需只读工具 |
| D（可选） | 同 A | 同 B | C + 独立重要转折审查 |

**测试必须固定**：主模型、温度、示例、近期历史窗口、消息合并、输出字数约束、回复次数、预算、基准输入。闭环模拟要重复多次随机运行；开放闭环与固定历史回放分别分析。

**指标要拆开**：
- 检索：关键事实 Recall@K、错误召回、必要事件原文证据准确率；
- 行为：无依据 OOC、合理成长被误杀、人物自主目标连续性；
- 表达：自然度、复读、异常说话人、过度引用历史；
- 记忆写入：虚构事件率、状态漂移、未解决矛盾清除准确率、重生分支污染率；
- 成本：每 100 条玩家输入总 Token、请求数、p50/p95 延迟。

在之前的 92 天实验里，`light_opt` 与 `event_adv` 在合并消息和格式控制上不同；且 `event_adv` 的检索领先但最终人设/自然度不佳。因此不要简单宣称 Agent 一定改善文学质量，必须隔离架构因素重新对照。

## 13. 开发分期与验收

**M0 / 运行闭环**：LangGraph Fast Path + 自有消息 DB + `request_id` 幂等提交 + 可再生分支 + light_opt 式生成异常拦截。验收：失败/重试不产生双消息、不污染历史。

**M1 / 事件记忆**：`events` + `event_messages` + FTS + 人物近况 + 情绪残留 + 未解决事件，记忆整理从提交消息生成。验收：可以从事件恢复原始对话，且角色不知道的秘密不会变成已知事实。

**M2 / Agent 工具层**：接入只读 `search_events/read_event/search_messages/query_world`；限工具与 Token 预算；部署相关性/证据精准度统计。验收：Agent 相较 B 组具有可量化增益，无显著增加自然度退化。

**M3 / 高级开关**：可选 API 2 深度推理、API 3 独立审查、人工审阅成长事件；只有在消融实验证明增益后开放默认。

## 14. 当前最需要敲定的工程约定

1. `session/branch/thread_id` 映射规则和剧情重生成行为。
2. 消息的正式提交语义、审核失败的 UI 表现、工具副作用的幂等策略。
3. 事件抽取数据结构和来源证据校验规则。
4. 角色内部知识权限与向当前对象披露权限的分离。
5. 生成器上下文的定额预算以及事件缺失时的“近期热窗口”兜底。
6. 消融实验中控制同一套生成和输出限制，而不是让不同记忆系统顺带改变回复格式。

## 15. 参考资料

- LangGraph 官方 Persistence（Checkpointer 与 Store）：https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph 官方 Add memory：https://docs.langchain.com/oss/python/langgraph/add-memory
- LangGraph Checkpoint Postgres：https://github.com/langchain-ai/langgraph/tree/main/libs/checkpoint-postgres
- LangGraph 官方设计指南：https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph
- 用户此前《许嘉禾托管回复：三种记忆方案长程对比 · 最终测试报告》，重点为三 arm 的 §3.4 流程差异、§4.2 闭环退化、§3.7 评审设计。

---

**总体设计判断：框架采用 LangGraph 是为了让你长期能扩展工具和运行过程；角色表现能否提升，则要由事件记忆精度、生成控制和成长测试分别验证。**
