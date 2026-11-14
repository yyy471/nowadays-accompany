# Nowadays 后端服务与原型说明

这是新主线的 TypeScript／LangGraph 后端源码，使用独立的 `backend` 依赖、CLI 和本机 HTTP／SSE API。最新功能进展与待办见 [当前状态看板](../devDoc/STATUS.md)，首轮后端原型阶段收口记录见 [193 开发文档](../devDoc/archive/01-backend-prototype/193-p5-prototype-delivery-guide.md)、[194 交付记录](../devDoc/archive/01-backend-prototype/194-p5-prototype-delivery-record.md) 与 [195 整体独立复核](../devDoc/archive/01-backend-prototype/195-p5-independent-review.md)。

在首轮 P5 原型之后，后端已补充角色活动状态控制（新建默认 `stopped`、同页停用与恢复）、模型／MCP／Skill 影响扫描与维护窗口协调、角色外观衣柜、对话自然句段与表情标注、语音统一协议及启停（`DL-149`）、ComfyUI 生图适配（`DL-150`）、消息接收与等待原因等能力；远程 MCP（`DL-115`）、真实外部模型／语音／生图服务联调与干净安装验证仍按记录单列。

## 1. 环境与安装

在 backend 目录操作。package.json 要求 Node.js >=24；当前实际验证为 Windows x64、Node 24.22.2，依赖版本固定在 package-lock.json。不要使用旧项目根目录的 node_modules。

```powershell
Set-Location D:\app\nowadays\accompany\backend
node --version
npm ci
npm run typecheck
```

`better-sqlite3` 为原生依赖，需与当前 Node ABI 匹配；本次使用已安装且实际运行通过的独立依赖，未宣称上述安装已在干净机器验证。源码通过 tsx 运行，无需 dist。不要带 `--omit=dev` 安装：当前运行入口需要 tsx。

本工作区可临时使用 P0 下载的独立 Node；这不是交付时必须依赖的目录：

```powershell
$nodeDir = (Resolve-Path '..\prototypes\p0\.runtime\node-v24.22.2-win-x64').Path
$env:PATH = "$nodeDir;$env:PATH"
node --version
```

## 2. 启动、检查与停止

选择 Nowadays 目录下的专用运行文件夹，下面的 `.nowadays` 被 Git 忽略。app-root 是运行根目录，实际数据在其 data/ 下；也可通过 NOWADAYS_APP_ROOT 设置。示例显式指定 app-root，防止操作其他数据。

```powershell
npm run dev -- --app-root .\.nowadays --port 3210
```

后端打印 `listening` JSON，固定监听 127.0.0.1。`--port 0` 由系统分配端口，取日志中的实际值。另开终端，在同一 backend 目录执行：

```powershell
npm run cli -- health
node --import tsx src/cli.ts --base-url http://127.0.0.1:3210 health
```

需要解析 CLI JSON 时使用第二种 node 直接调用形式，避免 npm 的命令提示文字。前台 Ctrl+C 请求停止；关闭后用同一个 app-root 启动以恢复原数据。客户端断开时后端仍运行，已有任务继续；显式退出后没有另设常驻服务。不要同时启动两个后端共用一个运行目录，完整多后端并发尚未验证。

## 3. 创建角色并配置模型

```powershell
$role = node --import tsx src/cli.ts role create --name 小今 --definition '@examples/role.md' | ConvertFrom-Json
$roleId = $role.roleId
$windowId = $role.defaultWindowId
node --import tsx src/cli.ts role get --role $roleId
```

角色创建即获得默认窗口，初始活动状态为 `stopped`（`GET /v1/roles/:roleId/activity` 可查）。修改角色设定、绑定、语音、生图、外观与额度等角色级配置前，目标角色须处于 `stopped`（可用 `activity stop --role $roleId` / `activity resume --role $roleId` 启停）；设定修订使用 `role update --role <id> --definition @文件 --expected-revision <当前版本>`，身份和已有记录保留。

从 examples/model-anthropic.json、model-openai-chat.json 或 model-openai-responses.json 复制一份到 `.nowadays/model.json`，按实际服务修改 baseUrl；样例地址故意不可用。baseUrl 只接受 http/https，不能内嵌账号、查询串或片段，末尾斜杠会统一去掉；适配层拼接 messages、chat/completions 或 responses。credentialRef 可为 `env:NOWADAYS_MODEL_API_KEY` 或 `file:<密钥文件绝对路径>`。环境引用应在启动后端前设置，后端进程才能读到；密钥不要放入样例或提交。

也可以在 `POST /v1/resources` 或 `PATCH /v1/resources/:id` 时直接提交 `secret`（只写）。创建时资源与密钥在同一事务落库；更新时省略 `secret` 保留、`null` 清除、字符串替换。直填密钥与 `credentialRef` 二选一，同时提供返回 `RESOURCE_CREDENTIAL_CONFLICT`。已存密钥只在同一服务内沿用：协议或 origin 变化时，省略 `secret` 会返回 `RESOURCE_CREDENTIAL_STALE`，需要重新填写密钥或显式清除；同站点换路径仍可保留。读接口只返回 `credential.status`（`stored` 已保存、`reference` 引用、`missing` 未配置、`unavailable` 不可解密）和 `resolvable`，不回明文。密钥用应用目录下的主密钥加密后存于 app 库；这是原型阶段的本地静态加密，同账户进程仍可读取主密钥，桌面打包与跨重启验证后再决定是否改用系统密钥链。

已保存服务可直接按资源探测：`POST /v1/resources/:resourceId/models` 列模型，`POST /v1/resources/:resourceId/model-test`（body `{ "model": "..." }`）测试连接。测试记录带资源归属和配置指纹；密钥替换后旧结果在资源视图中标为 `lastTest.stale=true`，地址或协议变化会清空该资源的旧测试。新建服务仍可用 `POST /v1/model-services/models` 与 `/test` 临时探测，候选 `secret` 只用于本次请求、不落库。列模型请求 20 秒超时、连接测试 60 秒超时，均拒绝跟随重定向；列表响应不是 `{ "data": [...] }` 时返回 `MODEL_LIST_INCOMPATIBLE`，与空列表区分。

```powershell
Copy-Item examples/model-anthropic.json .nowadays/model.json
# 编辑 .nowadays/model.json 后继续。
$model = node --import tsx src/cli.ts resource create --kind model --json '@.nowadays/model.json' | ConvertFrom-Json
$modelId = '填写服务实际模型ID'
$service = (Get-Content .nowadays/model.json -Raw | ConvertFrom-Json).config
$service | ConvertTo-Json -Depth 10 | Set-Content .nowadays/model-service.json -Encoding utf8NoBOM
node --import tsx src/cli.ts model models --json '@.nowadays/model-service.json'
node --import tsx src/cli.ts model test --json '@.nowadays/model-service.json' --model $modelId
```

以上获取列表、测试连接会实际请求所配服务，测试连接会调用模型；不属于离线验收。列表端点不受服务支持时，可手动填写模型 ID。历史真实证据只覆盖 DeepSeek Anthropic Messages，其他协议只有离线／本地模拟证据。

用角色绑定指定对话模型和后台记忆模型；`binding put` 替换整个绑定列表（支持 `expectedRevision` 并发保护），修改时保留已有 MCP／Skill 条目；开始对话与自主活动前别忘了调用 `activity resume --role $roleId` 恢复角色活动：

```powershell
@{ bindings = @(
  @{ capability='chat_model'; resourceId=$model.resourceId; modelName=$modelId; enabled=$true },
  @{ capability='memory_model'; resourceId=$model.resourceId; modelName=$modelId; enabled=$true }
) } | ConvertTo-Json -Depth 10 | Set-Content .nowadays/bindings.json -Encoding utf8NoBOM
node --import tsx src/cli.ts binding put --role $roleId --json '@.nowadays/bindings.json'
node --import tsx src/cli.ts activity resume --role $roleId
```

上述写文件命令使用 PowerShell 7 的 utf8NoBOM，避免 JSON 文首 BOM；也可使用编辑器保存为无 BOM UTF-8。

## 4. 本地 MCP 和通用 Skill

复制 examples/mcp-local.json，替换绝对路径占位符。command 是实际 node.exe 路径；tsx loader 使用绝对 file URL，使工具在角色 workspace 工作目录中也能加载后端依赖。角色 workspace 为 `.nowadays/data/roles/<roleId>/workspace`，由创建角色自动建立。

```powershell
$mcp = Get-Content examples/mcp-local.json -Raw | ConvertFrom-Json
$mcp.config.command = (Get-Command node).Source
$mcp.config.args = @('--import', ([Uri](Join-Path $PWD 'node_modules/tsx/dist/loader.mjs')).AbsoluteUri, (Join-Path $PWD 'src/mcp/local-server.ts'))
$mcp.config.env.NOWADAYS_WORKSPACE = (Resolve-Path ".nowadays/data/roles/$roleId/workspace").Path
$mcp | ConvertTo-Json -Depth 10 | Set-Content .nowadays/mcp.json -Encoding utf8NoBOM
$mcpResource = node --import tsx src/cli.ts resource create --kind mcp --json '@.nowadays/mcp.json' | ConvertFrom-Json
$skill = Get-Content examples/skill.json -Raw | ConvertFrom-Json
$skill.config.sourcePath = (Resolve-Path examples/skills).Path
$skill | ConvertTo-Json -Depth 10 | Set-Content .nowadays/skill.json -Encoding utf8NoBOM
$skillResource = node --import tsx src/cli.ts resource create --kind skill --json '@.nowadays/skill.json' | ConvertFrom-Json
$bindings = Get-Content .nowadays/bindings.json -Raw | ConvertFrom-Json
$bindings.bindings += @{ capability='mcp'; resourceId=$mcpResource.resourceId; enabled=$true }
$bindings.bindings += @{ capability='skill'; resourceId=$skillResource.resourceId; enabled=$true }
$bindings | ConvertTo-Json -Depth 10 | Set-Content .nowadays/bindings.json -Encoding utf8NoBOM
node --import tsx src/cli.ts binding put --role $roleId --json '@.nowadays/bindings.json'
```

本地工具包含文件读写、目录检索、命令／脚本执行。Skill 目录使用通用 `目录名/SKILL.md`，正文按需加载。资源及角色绑定只提供 enabled 开关；关闭阻止新链使用，已执行原链保持资源至链结束。

## 5. 对话与查询

```powershell
$submissionId = [guid]::NewGuid().ToString()
node --import tsx src/cli.ts message send --role $roleId --window $windowId --content '你好，请记住我们今天开始共同生活。' --submission-id $submissionId
node --import tsx src/cli.ts message list --role $roleId --window $windowId
node --import tsx src/cli.ts task list --role $roleId
node --import tsx src/cli.ts memory status --role $roleId
node --import tsx src/cli.ts autonomy status --role $roleId
```

send 只登记输入并返回执行关联，不等待完整答复；稍后查询历史或订阅 SSE。重试同一发送使用同一 submissionId；新的消息使用新编号。HTTP 路由及请求体分别见 [routes.ts](src/http/routes.ts)、[schemas.ts](src/http/schemas.ts)，CLI 参数见 [commands.ts](src/cli/commands.ts)。事件流使用 `events --role <id> --window <id> --after <游标>`，首次订阅可省略 after；正常聊天、输入状态和新消息中断仍按已有契约执行。

- 消息列表默认返回窗口最近一页，`before` 向历史翻页，`after` 保持向前续读；响应同时返回本页句段、未完成回复快照和与读取同一快照边界的 `cursor`，进入窗口后用 `after=cursor` 建立 SSE 即可续接终态与晚到媒体。断线重连同时带 `after` 与 `Last-Event-ID` 时从较新的游标继续，不重放已收到的事件。
- `segments` 为 `message_segments` 表中的自然段（含稳定 `segmentId`、原文范围、台词／旁白类型、回复时服饰及已标注差分），`activeReply` 在回复生成中给出 `messageId`、`executionId` 与已产生的文字；生成期间句段不提前发布，桌面先显示一个进行中的气泡。单条消息及句段可用 `GET /v1/roles/:roleId/windows/:windowId/messages/:messageId` 读取；流事件新增 `message_segments`（正文句段确定）与 `segment_annotations`（表情差分晚到），两者均按游标重放。
- 角色当前服饰有差分时，回复提交后会异步调用同一对话模型为句段选择差分；调用计入 `model_calls`／`call_metering`，用户对话不扣自主点数，自主任务先过额度，适配器与凭据初始化在扣点之前，初始化失败不计调用；扣点与调用登记在同一事务内完成，登记失败不消耗额度。没有服饰、没有差分、额度不足或标注失败时只保留文字和句段。[213 方案](../devDoc/archive/03-appearance-and-performance/213-conversation-performance-backend-plan.md) · [217 复核修复](../devDoc/archive/03-appearance-and-performance/217-conversation-performance-review-fixes.md)

### 音色与语音合成

- **配置与开关**：音色服务支持旧 IndexTTS 路径协议和 `nowadays-tts-v1` 统一协议。`GET/PUT /v1/roles/:roleId/voice` 读取或保存 `enabled`、`baseUrl`、`protocol`、`voiceSource`（`reference` 参考音频或 `preset` 预置音色）、`capabilities`、`language`、`speed`、`emoAlpha`；`PUT /v1/roles/:roleId/voice/enabled` 单独切换角色语音启停（停用保留现有配置，`DL-149`）；旧请求的 `referenceAssetId` 保持原含义。`POST /v1/roles/:roleId/voice/probe` 读取 `{baseUrl}/health` 的能力与就绪状态，就绪且声明预置音色时返回 `{baseUrl}/voices` 列表。
- **参考音频与试听／合成**：`POST /v1/roles/:roleId/voice/reference` 用 `multipart/form-data` 的 `file` 字段导入 WAV／MP3／FLAC／OGG 参考音频（≤32 MiB），返回受管 `assetId`；`GET /v1/roles/:roleId/voice/references` 列出已导入音频并标记当前引用，`DELETE /v1/roles/:roleId/voice/references/:assetId` 删除未使用的音频（正在使用时返回 409 `VOICE_REFERENCE_IN_USE`，文件清理失败返回 `fileRemoved=false` 供重试）。`POST /voice/preview` 用 `text` 和可选候选 `config`（或兼容平铺字段）试听且不落库；`POST /windows/:windowId/segments/:segmentId/speech` 为台词句段返回音频，旁白返回 400 `VOICE_SEGMENT_NOT_SPEAKABLE`（语音已停用时返回 `VOICE_DISABLED`）。
- **统一协议与旧协议边界**：统一协议调用 multipart `/tts`（克隆上传受管参考音频与可选原文，预置传 `voice_id`），语言按服务声明传递，语速在 0.1–10 内按声明收敛且声明须包含 1.0；统一协议请求不跟随重定向，3xx 返回 502。上游返回 404 且带 `code: VOICE_NOT_FOUND`／`PRESET_VOICE_NOT_FOUND` 时映射为 409 `TTS_VOICE_UNAVAILABLE`，单纯 404 按通用失败处理；切服务后参考模式未确认前试听和合成返回 `VOICE_REFERENCE_MODE_REQUIRED`。旧协议调用 `POST {baseUrl}/tts` JSON（`lang` 限 `zh`／`en`／`ja`／`es`／`ar`，语速 `duration_factor` 限 0.5–2）。
- **校验与错误映射**：`baseUrl` 允许路径前缀，拒绝查询串、片段和账号信息。响应须为完整 PCM WAV（校验 RIFF 块边界、格式字段与数据帧对齐），单次响应上限 16 MiB，拒绝非 WAV 时关闭上游连接；服务错误映射 502，连不上 503，超时 504，调用取消 499。[218 记录](../devDoc/archive/03-appearance-and-performance/218-tts-implementation-record.md) · [221 统一接入记录](../devDoc/archive/03-appearance-and-performance/221-tts-unified-implementation.md) · [246 语音启停](../devDoc/archive/04-role-settings-and-media/246-role-voice-toggle.md)

### 生成过场图

- **服务与任务接口**：生图服务配置与角色生图参数分别由 `/v1/image-services`（列表/创建/修改/`probe`）与 `/v1/roles/:roleId/scene-image`（读取/保存/`probe`/`preview`）管理，首版支持 ComfyUI 适配（[248 适配记录](../devDoc/archive/04-role-settings-and-media/248-comfyui-adaptation.md)）。过场图任务从已保存回复发起，`POST /v1/roles/:roleId/windows/:windowId/messages/:messageId/scene-images` 接受 `idempotencyKey` 与可选 `layerMode`（`background`／`full_scene`），同幂等键复用返回 200、新建返回 201。状态流为 `queued → planning → generating → succeeded`（失败为 `failed`），`GET .../scene-images/:taskId` 与 `GET .../scene-images/assets/:assetId` 校验角色/窗口/文件归属；消息分页与详情返回 `sceneImages`，状态变化通过 `scene_image_task` 流事件按游标重放，重启会把未完成任务结算为 `SCENE_IMAGE_INTERRUPTED`。
- **规划、锚点与安全落盘**：规划默认用角色对话模型（无绑定或初始化失败回退固定规划器，非法句段区间或冲突图层直接拒绝 `SCENE_IMAGE_PLAN_INVALID`）。接收任务时锁定服务快照、超时与锚点，站点变更时以 `SCENE_IMAGE_SERVICE_CHANGED` 失败；`full_scene` 拼接服饰 `home` 参考图与基础/服饰锚点，`background` 不传参考图。生成上限取服务 `timeoutMs`（默认 180 秒，超时记 `SCENE_IMAGE_GENERATION_TIMEOUT`），写盘排他创建、失败清理并复查取消；未配生图服务走本地假生成器，配置 ComfyUI 时走真实适配器，真实联调与自动触发规则仍待验证。

## 6. 数据布局与验收

```text
<app-root>/data/app.sqlite
<app-root>/secrets/master.key
<app-root>/data/roles/<roleId>/business.sqlite
<app-root>/data/roles/<roleId>/execution.sqlite
<app-root>/data/roles/<roleId>/workspace/
<app-root>/data/roles/<roleId>/voice/
<app-root>/data/roles/<roleId>/scene-images/
```

业务库保存正式身份、状态、消息、记忆、任务和调用事实；execution.sqlite 为图检查点，不替代正式业务数据。`secrets/master.key` 是模型服务直填密钥的本地加密主密钥，首次保存密钥时生成；备份时应保留整个 app-root（至少 `data/` 与 `secrets/`），丢失主密钥后已保存密钥会显示为不可解密，需要重新填写。备份时先停止后端，不要只复制其中一个 SQLite 文件。

```powershell
npx -y node@24 scripts/accept-offline.mjs
```

统一离线入口需在 Node 24 下运行（或确保当前 `node` 为 v24 后执行 `npm run accept:offline`），依次运行类型检查、交付回归、当前正式测试（最近实测 402 项；实际数量以当次报告为准）、真实进程／CLI 重启冒烟，以及 P2 20、P3 11、P4 28 项定向场景。脚本在新建 `test-results/p5-.../` 下保存 summary.json、源码哈希、逐步日志和业务报告；不会读取你的运行配置、调用真实模型、覆盖或清理旧验收目录。任何失败、报告缺失或用例数量不完整均返回非零退出码。

本命令会启动本地子进程和本机回环 HTTP 服务。运行输出属于忽略的证据，最新总体结论与待办见 [当前状态看板](../devDoc/STATUS.md)，首轮 P5 交付详情见 [194](../devDoc/archive/01-backend-prototype/194-p5-prototype-delivery-record.md)，最近一次离线验收基线见 [283 第 26 节](../devDoc/archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验)；独立复核与实现方自验分别记录。
