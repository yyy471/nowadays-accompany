# 后端插件、Skill 接入与手动测试实现方案

日期：2026-10-28。

状态：**待实施方案**。本次仅新增方案和文档导航，没有修改业务代码，没有交付测试页面。

代码核对基线：`6e6f015e1612712d7f78371826de333aedf05f04`。当前实现以源码为准，既有设计与实施背景见[79 扩展执行方案](79-agent-extension-execution-plan.md)、[101 EXT-G 复验](101-ext-g-fixes-independent-recheck.md)和[102 总体架构](102-overall-architecture-and-features.md)。本文收敛后续接入与测试工作，不推翻已经实现的统一工具执行底座。

## 1. 本轮决定

用户明确要求：

- 先确定修改方向，再实施；本次请求交付实现方案。
- 本轮只改造后端，前端页面后置。为将来的“扩展详情 → 测试”次级页面提供接口。
- 导入只做满足调用契约所需的基础校验，不分析实际调用代码，不通过试运行判断插件或 Skill 是否可以导入。
- 插件业务代码、第三方服务、用户配置是否真正有效，由用户主动测试；调用失败就返回错误。
- 个人可以放入插件、Skill 使用；插件与 Skill 的配置应有简单明确的使用方式。
- 保留统一工具模型：内置工具和插件工具是同一类 Tool；插件是扩展包，Skill 是任务说明。

本轮不增加插件代码分析、导入时动态加载、网络连通探测、自动安装依赖、配置 schema 表单平台、Skill 模板表达式引擎、MCP、插件市场或新的通用任务调度平台。也不为这次接入重建版本发布系统。

沿用项目已有的账号隔离、工具授权、路径处理、原子写、调用预算、Worker 超时和凭据约定；这些直接复用，不围绕导入再加一套检查链。基础文件复制和摘要计算不属于业务代码分析，可以复用现有导入实现。

## 2. 统一概念与现状

| 概念 | 目标定义 | 当前依据与处理 |
| --- | --- | --- |
| Tool | 模型可以调用的函数；来源为 builtin 或 plugin | [身份与声明](../src/extensions/contracts.ts)、[执行器](../src/extensions/execution/executor.ts)已存在，继续复用 |
| Plugin | 提供 tools、hooks、skills 的代码资源包 | 保留 manifest、JS 入口和每账号每插件 Worker，不增加第二种插件协议 |
| Skill | 任务说明，可引用工具；本身不是函数或脚本运行器 | [SkillConfig](../src/extensions/types.ts)已存在，补文件导入与账号配置 |
| Hook | 宿主在固定阶段调用的插件函数 | 保留 beforeContext、afterTurn，不放进模型可调用工具清单 |
| Provider | 模型能力服务 | 保留对话、图像/视频理解、图像/语音生成路由；Provider 不等于 Tool |

模型输入仍是“上下文 + 可用工具清单”。Skill、角色卡、世界书、事实记忆、历史和 Hook 数据进入上下文；模型可调用清单由内置工具与插件工具组成。

当前值得补齐的地方：

1. [ArtifactImportService](../src/application/artifacts/artifact-import-service.ts)已有目录插件导入，但主要由桌面内部用例消费，缺少本轮需要的统一后端接入入口。
2. [LocalArtifactStore](../src/artifacts/local.ts)已能读取公用和账号私有插件目录，不需要另建插件存储系统。
3. 插件配置已在 `profile.plugins[].config` 保存，[档案解析](../src/profiles/profile.ts)将其交给 Worker；缺少独立、方便使用的配置读写接口。
4. 独立 Skill 当前在 `config.v2.json` 的公用 `skills[]` 和账号 `skills.definitions[]` 保存，没有 SKILL.md 导入和独立的账号参数配置。
5. [ExtensionToolService](../src/application/extensions/extension-tool-service.ts)已有统一工具执行与扩展快照；[AgentEngine](../src/agent/engine.ts)已有模型工具循环，测试应复用这些逻辑。
6. 现有 Skill 有效预览只说明配置和标准选择结果，不等同于实际调用模型、执行插件。

## 3. 接入契约

### 3.1 插件文件

继续采用已有目录格式：

```text
weather/
  manifest.json
  index.mjs
  config.example.json       # 可选，仅供用户参考
  README.md                 # 可选
  ...                       # 作者自己的模块和资源
```

一个最小可调用插件示例：

```json
{
  "id": "weather",
  "kind": "plugin",
  "revision": "r1",
  "entry": "index.mjs",
  "apiVersion": 1,
  "tools": [{
    "id": "query",
    "description": "查询指定城市的天气",
    "inputSchema": {
      "type": "object",
      "properties": { "city": { "type": "string" } },
      "required": [],
      "additionalProperties": false
    },
    "effect": "read"
  }]
}
```

```javascript
export const tools = {
  async query(args, ctx) {
    const city = args.city || ctx.config.city;
    if (!city) throw new Error('请在配置或调用参数中填写城市');
    return { status: 'ok', text: `测试查询城市：${city}` };
  }
};
```

导入只检查 manifest 可解析、必要身份字段、支持的 apiVersion、入口普通文件存在，以及工具/Hook/Skill 声明的基本结构。工具参数继续使用现有受支持的 JSON Schema 子集。

**导入不 import 插件，不执行 init，不检查函数内部实现，不测试网络、依赖包或配置的业务含义。** JS 语法错误、依赖不存在、声明的 handler 不存在、外部服务失败等在正常加载或用户主动测试时报告。已有运行时握手保留在运行阶段，不迁入导入流程。

### 3.2 独立 Skill 文件

第一版采用普通 Markdown 加可选 JSON 元数据，避免为接入引入自定义模板或复杂 YAML 解析规则：

```text
travel-planning/
  SKILL.md
  skill.json                # 可选
  config.example.json       # 可选，仅供用户参考
```

`SKILL.md` 正文即 instructions。可选 `skill.json` 示例：

```json
{
  "id": "travel-planning",
  "name": "旅行规划",
  "description": "结合天气整理旅行建议",
  "tools": ["public/plugin/weather/query"]
}
```

无 `skill.json` 时，id 取父目录名，name 取首个 Markdown 一级标题，没有标题则取目录名，tools 默认空数组。派生 id 必须满足现有标识格式；不符合时提示补充 skill.json。元数据沿用当前 Skill 定义中的 description、tools、requires、kinds、peers，instructions 始终取 SKILL.md。

JSON Skill 定义继续复用现有 CRUD 接口，不要求已有数据转换成 Markdown。SKILL.md 是新增作者入口，导入后统一转成已有 Skill 定义保存，不建立另一套运行协议。本版不承诺兼容其他产品的任意 YAML frontmatter、scripts 或 references 运行规范；随包脚本不自动执行，附属文档不自动检索，作者需要模型阅读的内容先放入正文。

基础校验仅涉及必要文本、字段类型、工具引用格式及已有内容上限。引用工具尚未安装、未授权或服务不可用，**不阻止导入**；实际预览/运行继续使用现有有效状态规则报告原因，不隐式安装、授权或修改开关。

### 3.3 手动放入与目录选择

约定本地待导入目录：

```text
<dataRoot>/imports/
  plugins/<package>/manifest.json
  skills/<package>/SKILL.md
```

用户可以复制目录后主动扫描，也可以通过后端传入一个具体源目录进行预览和导入。扫描只枚举该层候选并做上述基础校验，逐项返回结果；一个坏包不影响列出其他包。不增加文件监听、后台自动加载或自动修复。

插件导入到既有公用或账号私有 artifacts 结构，公用 catalog/部署沿用现有用例；账号选择继续走 profile.plugins。导入结果提供固定 revision 的 ref，用户可直接按固定 ref 选择，不要求导入后立即启动或部署。

Skill 导入到既有公用或账号私有 definitions。默认关闭，后续启停复用现有策略接口。重名覆盖沿用现有 Skill 保存的 expectedRevision；插件同 id/revision 不覆盖，沿用现有导入提示。导入过程不写入用户工具授权。

## 4. 简单配置契约

### 4.1 四类数据分开

| 数据 | 保存/传入方式 | 职责 |
| --- | --- | --- |
| 插件或 Skill 定义 | 导入的文件或现有定义接口 | 作者定义功能与说明 |
| 账号配置 | 合法 JSON 对象 | 用户长期偏好，默认 `{}` |
| 工具调用参数 | 每次调用的 arguments | 这次操作输入，由工具参数 schema 校验 |
| 插件运行状态 | 原有 state 接口 | 插件进度或缓存，不当作配置编辑 |

本轮配置只按账号保存，不增加群、私聊、单会话配置覆盖。已有群/私聊/会话**启停策略**继续保留，与配置作用域分开。作者自行决定工具参数是否覆盖 ctx.config 中的默认值。

宿主只校验配置是合法 JSON 对象并沿用已有大小上限；没有必填字段表、自动补默认值、配置 schema 平台或配置正确性探测。config.example.json 仅是说明文件，不会被宿主自动合并或写入账号。

凭据继续遵循现有 credentialRef 约定，不在本包新增插件凭据代理、完整凭据库访问端口或明文密码配置。普通 JSON 配置接口不承担通用第三方鉴权集成。

### 4.2 插件配置

- 唯一持久化位置仍为 `accounts/<accountId>/profile.json` 中对应插件条目的 config；不要再复制到 config.v2.json。
- 使用 `public/plugin/weather` 或 `private/plugin/weather` 定位安装条目，避免只按 weather 匹配。
- Worker 的 init、工具和 Hook 读取同一账号配置；沿用运行时已有 configDigest 换代检测。
- 保存配置不丢失其他插件、revision、enabled 或旧 roleCard 字段。
- 保存后沿用现有重载/同步用例更新受影响账号。加载失败时返回“保存成功，重载失败”，不把保存结果说成调用成功。
- 新的配置更新与已有整档案保存共用账号级写入串行链；复用 atomic-write 底层。仅补这条真实读改写链，不引入新的事务框架。

现有 ResolvedProfile.revision 只计算制品引用，不能直接拿来判断插件配置是否被修改。独立配置接口的 revision 应由目标插件条目内容计算，读取、比较和提交在上述串行域完成。

### 4.3 Skill 配置

在 `AccountSkillPolicy` 增加可选 configs，不新增配置文件：

```json
{
  "skills": {
    "definitions": [],
    "configs": {
      "travel-planning": { "city": "杭州", "language": "中文" },
      "public/plugin/weather/skill/forecast": { "days": 3 }
    }
  }
}
```

- key 使用实际解析后的 Skill id；插件 Skill 保留现有完整命名空间。
- 公用与私有同 id 沿用当前私有覆盖规则，对应一份账号配置；不再增加来源级配置继承。
- 正文编辑、复制、删除及其他账号策略更新都应保留未操作的 configs；删除定义不会自动清空配置，用户可明确清空为 `{}`。
- ConfigStore 的解析、序列化、账号策略更新与 SkillService 的 definitions 更新都必须保留新字段。缺失 configs 时按空对象读取，旧配置无需迁移。
- 配置接口清空某项时删除该 key；其他 Skill 配置保持原样。

上下文统一渲染为：

```text
### 旅行规划
<SKILL.md 正文>

用户配置（JSON）：
{"city":"杭州","language":"中文"}
```

采用固定标题与 JSON 序列化，不做 `{{表达式}}` 替换。正文和配置一起计算 Skill 注入预算；有效预览、测试和正式 Agent 共用同一个渲染函数。预览可同时返回原文和实际渲染文本，但不能将渲染结果反写成用户定义正文。

配置不主动授权工具；当前 Skill 未启用或引用工具不可用时，继续由既有有效状态逻辑处理。配置发生变化应进入现有扩展快照摘要，使后续轮次使用新配置。

## 5. 后端接口

以下均为目标接口，尚未实现。保持当前认证、错误响应和可选 `/v1` 前缀约定。新 DTO 放入 contracts，用例放入 application；Core 只装配和委托。

### 5.1 导入与配置

| 方法与路径 | 请求/行为 |
| --- | --- |
| `POST /extensions/imports/scan` | 枚举固定 imports 目录，返回候选目录、kind 和基础校验结果 |
| `POST /extensions/imports/preview` | `{ kind: "plugin" | "skill", sourceDirectory }`，只做文件与格式预览 |
| `POST /extensions/imports` | `{ kind, sourceDirectory, target: { source: "public" | "private", accountId? }, expectedRevision? }`，正式导入；私有目标必填 accountId |
| `GET /accounts/:accountId/extensions/config?kind=plugin&id=public%2Fplugin%2Fweather` | 返回目标插件配置和 revision；kind=skill 时 id 为实际 Skill id |
| `PUT /accounts/:accountId/extensions/config?kind=plugin&id=...` | `{ config: {}, expectedRevision }`，整项替换；kind=skill 同理 |

配置查询中的 id 放在 query，避免插件完整身份中的斜杠与路由分段冲突。GET 返回 `{ ok:true, config, revision }`；PUT 额外返回可选 reload 结果。业务配置字段不作类型推断或自动转换。

插件 preview/import 包装并复用现有 ArtifactImportService，已有指纹检查可以继续内部使用，不另加新的确认票据系统。公用目标复用既有路径，私有目标将同一导入逻辑的基目录映射到指定账号。Skill import 复用现有 savePublic/savePrivate 的 revision 检查；已有 id 冲突时使用现有冲突提示，让用户明确覆盖。

这些导入接口消费本机目录，用于当前本地控制面；不增加远程下载、自动解压、包管理器安装或云端导入服务。

### 5.2 手动测试

使用三个明确入口，不建立持久化调试会话服务：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /accounts/:accountId/extensions/tests/tool` | 实际加载并调用一个内置或插件工具，不调用对话模型来选择工具 |
| `POST /accounts/:accountId/extensions/tests/skill-preview` | 组装指定 Skill、账号配置和测试输入，列出工具及不可用原因，不执行插件或模型 |
| `POST /accounts/:accountId/extensions/tests/skill` | 实际调用对话模型，允许模型调用当前可用工具，返回最终回答与调用记录 |

工具请求示例：

```json
{
  "toolId": "public/plugin/weather/query",
  "arguments": { "city": "杭州" },
  "scope": { "kind": "group", "peerId": "123456" }
}
```

Skill 请求示例（preview 和实际调用共用）：

```json
{
  "skillId": "travel-planning",
  "input": "帮我安排明天的杭州一日游",
  "scope": { "kind": "group", "peerId": "123456" },
  "roleText": "你是一位旅行规划助手。"
}
```

scope 可省略，省略时以固定测试会话解析账号默认/私聊策略；传入时只用于选择相应启停策略和能力配置，不读取该真实会话历史或状态。roleText 仅作用于测试，默认使用简短扩展测试助手说明，不创建真实角色绑定。

测试使用**已导入、已由该账号选择的资源和保存的配置**，需要的工具授权、运行开关沿用当前策略；关闭的 Skill 或未授权工具直接报告原因。测试不会自动安装、启用、授权，不接受临时源码、任意函数名或配置覆盖。用户需要调整配置时先调用配置接口保存，再测试，减少临时态。

### 5.3 测试结果

```json
{
  "ok": true,
  "test": {
    "status": "ok",
    "durationMs": 120,
    "reply": "建议明天上午……",
    "calls": [{
      "toolId": "public/plugin/weather/query",
      "arguments": { "city": "杭州" },
      "result": { "status": "ok", "text": "多云" }
    }]
  }
}
```

- `test.status` 使用已有语义 `ok / error / submitted / unknown`；工具结果复用 ToolInvocationResult，不再发明第二套返回协议。
- 失败包含 `stage: load | init | invoke | model`、code、message；沿用现有错误脱敏和结果大小限制，不做自动归因分析。
- HTTP 请求格式、身份、资源不存在等仍走现有 4xx/5xx 错误约定。测试已执行但目标调用失败时，可用 HTTP 200 + `test.status:error` 表达，避免与后端无法接受请求混淆。
- Skill preview 返回渲染后的说明、测试输入、可用工具描述、未启用/依赖不可用原因，不返回调用成功标志。
- preview 依据文件声明和已保存策略展示工具候选；未启动测试 Worker 时，handler 标为“未验证”，不能因为正式 QQ Worker 没有运行就判定离线测试不可用。实际测试启动自己的运行时后，使用本次握手结果确定可调用工具。
- 实际 Skill 测试返回最终回答、实际提供的工具身份和 calls。模型未选择调用工具时 calls 为空，不能由此宣称某插件调用通过。
- 不输出模型内部推理、凭据或完整 Worker 内存，只返回本轮对话输出与必要调用记录。

## 6. 测试如何复用正式运行逻辑

### 6.1 工具测试

```text
用户 POST tool
  → 读取账号配置、安装项和现有授权
  → 创建短生命周期测试 Worker/状态目录
  → 正常加载和初始化
  → 统一 ToolExecutor 执行指定工具
  → 返回结果，释放测试资源
```

Worker 必须加载入口代码才能实际执行，这是**用户主动运行**，不是导入检查。缺 handler、缺依赖、init 异常或超时均在这里正常返回。

测试运行时复用 AccountPluginRuntime、PluginWorkerManager、ToolExecutor 与现有限流器；增加必要的运行上下文/状态目录注入点，不复制一个“简化执行器”。scope 供策略解析，测试存储使用独立临时根目录，不与同账号正式插件 Worker 共用可写状态。配置仍取该账号保存值，插件 ctx.accountId 保持所选账号。

安装项、开关和授权先从保存配置读取，handler 就绪状态则在本次测试 Worker 正常启动后解析，不能复用正式 QQ 实例的就绪快照作为启动测试的前置条件。Skill 实际测试也遵循这一顺序。

### 6.2 Skill 测试

```text
用户 POST skill
  → 解析指定 Skill、配置、当前工具与策略
  → 共用 Skill 渲染与上下文预算
  → ProviderRouter 调用模型
  → 有工具调用则进入原统一执行器和工具续答循环
  → 将最终回答返回 HTTP，不发 QQ
```

从 AgentEngine 中抽出已有对话轮次所需的最小可复用调用入口，使正式 Agent 和测试用例共用上下文、工具协议、内置工具 handler 和预算；不复制整个 Agent，也不把私有字段强行开放给路由。

测试只注入指定 Skill，以及原链路会运行的有效 Hook 数据；工具清单仍来自现有可用工具集合，不限制为 Skill 引用的工具，引用代表依赖而非专属授权。其他独立 Skill 不自动混入本次目标测试。Hook 和插件工具使用本次独立测试状态。

该入口不要求 QQ 在线，也不要求真实会话角色卡。它是显式测试用例，使用 roleText 和测试输入构建上下文；不经过 QqInstance.onMessage，不放宽正式 QQ 会话“显式绑定角色后才自动回复”的规则。QQ 自动回复暂停不禁止用户主动测试；模型能力、资源启停和工具授权仍照常检查。

测试 history 为空，不读取真实消息、世界书或事实记忆，也不产生自动记忆提取。最终文字、媒体结果回到测试响应或现有任务查询；测试消息上下文中的 send/deliver 是测试结果收集端口，不接真实通道。afterTurn 不能把仅返回测试结果伪称为 sent；测试模式应跳过该 QQ 发送结果钩子，并在输出中说明。

### 6.3 异步结果与释放

内置生图/语音仍复用当前 MediaJobService 和 MediaService，完成后只保存媒体/任务结果，不发送 QQ。返回 submitted + jobId 后，继续通过现有 `GET /jobs/:id?accountId=...`、取消与媒体读取接口查看结果。任务 delivery 标为 skipped，并记录“手动测试，不投递 QQ”，不标为发送成功。

测试请求返回 submitted 时，不能立即中止任务捕获的 signal 或撤销执行上下文；将必要上下文生命周期交给已有任务终态清理，终态后释放临时资源。用户取消和 Core 关闭沿用当前任务语义，未知结果不自动重提。

本包只承接现有宿主管理的媒体任务。普通插件工具返回自建 jobId，不自动成为系统 jobs；如要查看其外部任务，插件提供后续查询工具即可，不在本轮新增插件通用长任务 RPC。

同步测试使用已有调用超时和并发上限；补足测试服务关闭时释放资源即可，不建设测试记录数据库、长连接日志平台或无限测试队列。

### 6.4 测试的实际含义

用户主动测试会真实执行插件代码，可能访问外部服务、产生外部动作或调用收费模型。后续页面入口应直说“实际调用测试”，不称为无副作用沙箱。本包不增加重复确认链，也不因未测试或测试失败而禁止用户导入、安装和配置资源。

独立状态只约束宿主管理的插件 state、调用账本和消息历史；无法保证插件自行写文件或访问外部服务没有副作用。测试成功仅说明本次输入得到对应结果，不能作为资源的长期健康认证。

## 7. 模块与兼容处理

| 位置 | 预计改动 |
| --- | --- |
| `src/contracts/` | 新增导入、配置和测试 DTO，补充 Skill 配置/渲染预览字段 |
| `src/application/artifacts/` | 复用目录导入；补扫描与 Skill 文件到现有定义的转换 |
| `src/application/extensions/` | 增加轻量配置与手动测试用例，复用现有策略/运行时服务 |
| `src/extensions/` | 共用 Skill 正文+配置渲染函数；补必要的测试存储/调用上下文注入点 |
| `src/providers/types.ts`、`config-store.ts` | 增量支持 skills.configs，保留其他策略和配置字段 |
| `src/profiles/`、`application/accounts/` | 为插件 config 更新提供同账号串行读改写与当前重载结果 |
| `src/agent/` | 提取可复用对话轮次入口，保持正式 Agent 行为；媒体交付使用注入端口 |
| `src/bootstrap/`、`core/`、`application/ports/control-api.ts` | 装配与委托新增用例，接入现有关闭流程 |
| `src/service/routes/` | 增加导入、配置与测试路由；复用认证、错误与审计 |
| `test/` | 补离线接入、配置贯通、测试结果与正式链路回归证据 |
| `desktop/renderer/` | 本轮不改动 |

兼容原则：

- 不迁移插件 artifact 目录，不删除现有 profile.plugins[].config，不改变工具完整身份或 apiVersion。
- 不要求现有 Skill 新增必填字段；configs 缺省时为 `{}`，原 JSON 定义继续工作。
- 新增 HTTP 能力，保留原 Core/HTTP 接口和错误约定；整账号策略与 Skill CRUD 的往返必须保留新增配置。
- 配置保存沿用串行提交与 atomic-write。配置版本、运行时 configDigest、扩展快照只补必要字段，不新建多级版本平台。
- 文档示例中新增的文件入口不等于兼容第三方任意插件/Skill 标准。当前插件仍使用本项目声明/handler 契约。

## 8. 实施任务与顺序

| 包 | 工作 | 可验收产物 |
| --- | --- | --- |
| BE-1 | 固定导入、配置、测试 DTO；整理最小插件和 Skill 文件样例 | 契约、解析样例；明确哪些检查在导入、哪些发生于运行 |
| BE-2 | 后端目录扫描/预览/导入，公用与账号私有目标，SKILL.md 转换 | 个人文件可由 Core/HTTP 导入；坏实现也能按格式导入 |
| BE-3 | 插件 config 独立接口、Skill configs、共用渲染与预算 | 配置重启后保留，正式上下文和预览读到同一值 |
| BE-4 | 独立测试上下文与统一工具手动调用 | 不连 QQ 可执行插件工具，正确返回加载/初始化/调用错误 |
| BE-5 | Skill preview、模型实际调用、内置媒体异步结果 | 真实 Core+FakeProvider 工具续答、job 查询与无 QQ 投递闭环 |
| BE-6 | 集成回归、简明作者/用户说明、执行记录和独立复核 | 后端可交给后续次级页面接入；明确自动化与真实环境边界 |

按 BE-1 → BE-2 → BE-3 → BE-4 → BE-5 → BE-6 推进；不在本轮安排 UI 重写或改造架构图。每包完成后记录实现方证据；整体实现交付后按项目约定另留独立复核文档，不能用本方案代替执行或复核结论。

## 9. 验收标准

### 9.1 文件接入

| 编号 | 输入 | 预期 |
| --- | --- | --- |
| I01 | 最小 manifest + 正常入口文件 | 可扫描、预览、导入、按账号选择 |
| I02 | JS 语法错误、缺依赖、缺 handler 的插件 | 只要声明和文件结构合规即可导入；主动测试时返回实际失败 |
| I03 | 模块顶层含可观察动作的测试 fixture | scan/preview/import 不执行该动作；只在主动加载/测试发生 |
| I04 | 无 manifest、缺入口、不支持的 apiVersion、错误声明结构 | 基础错误明确返回；其他候选仍可列出 |
| I05 | 裸 SKILL.md；带 skill.json 的 Skill | 正确转换成现有定义；已有 JSON Skill 入口不受影响 |
| I06 | 引用不存在工具的 Skill | 导入成功，预览/运行报告不可用原因，不自动授权或安装 |
| I07 | 公用/私有插件或 Skill；重复 id/revision | 目标路径和账号正确，沿用现有覆盖/冲突规则 |

### 9.2 配置与调用

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| C01 | 同一公用插件被账号 A/B 配置不同城市 | 工具分别读到各账号 ctx.config，重启后保持 |
| C02 | 配置是合法对象，但业务字段错误 | 宿主允许保存；作者实现返回结果或错误，宿主不预判服务正确性 |
| C03 | 修改单个插件配置 | 其他插件和档案字段不丢失；重载结果如实返回 |
| C04 | Skill 参数配置、私有覆盖、公用/插件 Skill | 配置按有效 id 读取，正文+配置以相同函数进入预览和实际模型请求 |
| C05 | 更新 Skill 定义或其他账号策略后再读配置 | configs 保留；旧数据不需要迁移；正文不会被渲染文本覆盖 |
| C06 | 配置很长，正文+配置超过预算 | 使用现有上限与排除/裁剪语义，不突破实际请求预算 |
| C07 | 配置并发编辑或与整档案保存交错 | 按既有保存语义串行，独立接口 revision 冲突可见，不丢无关条目 |

### 9.3 手动测试

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| T01 | 没有 QQ/SnowLuma 在线 | 可测试已选择插件与 Skill，不注入或启动 QQ |
| T02 | 插件加载/初始化/调用分别失败 | stage、code、message 对应实际阶段，不伪称为导入失败 |
| T03 | 直接工具测试与 Skill 模型测试 | 前者不额外调用对话模型；后者实际使用模型工具协议和续答 |
| T04 | Skill preview | 无模型调用、无 Worker 启动、无插件执行、无配置写入 |
| T05 | 未授权工具或关闭的资源 | 使用现有原因返回，不因测试自动开放权限 |
| T06 | 与正式账号运行同时测试 | 宿主插件 state、账本、聊天历史不混用，不污染事实记忆 |
| T07 | 内置生图/语音 submitted | 返回现有 jobId，可查询终态/媒体；测试 HTTP 返回后任务可继续，无 QQ 发送 |
| T08 | 模型没有选择工具或工具部分失败 | 返回实际 calls 和最终结果，不强制模型调用、不自动反复测试 |
| T09 | 测试结束、超时、Core 关闭 | 测试 Worker/临时存储有正常释放；异步任务按终态清理 |
| T10 | 正式 QQ 消息回归 | 仍需显式角色绑定，发送、授权、账号隔离和原 Agent 预算保持原语义 |

自动化按现有约定使用临时 dataRoot、FakeChannel、fake-v1 和确定性本地插件，不用真实 QQ 或付费模型。关键证据以真实 Core/HTTP 往返和实际传给 FakeProvider 的 messages/tools 为准，不只测试 DTO 或复制实现的断言。

完成实现后执行 `npm run typecheck`、`npm test`、`npm run desktop:build`，并记录实际结果。构建仅验证旧桌面消费者兼容，不意味着测试页面已实现。真实第三方插件、网络和付费服务由用户手动测试，其成败不作为格式导入的门槛，也不由本地 fake 结果代为认证。

## 10. 交付口径

实现完成后应交付：后端契约与接口、个人插件/Skill 导入路径、账号 JSON 配置、工具直接测试、Skill 预览及实际对话测试、一个无需外网的插件/Skill 示例，以及实现方与独立复核记录。

“后端完成”只覆盖上述范围。前端扩展管理、次级测试页面、第三方插件长期可用性和真实 QQ/模型兼容性分别记录，不写成已经完成。本文件当前仅为方案，所有新增字段、文件入口与 API 均待实施。
