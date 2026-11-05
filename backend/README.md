# Nowadays 后端原型

这是新主线的 TypeScript／LangGraph 源码原型，使用单独的 backend 依赖、CLI 和本机 HTTP／SSE API。P5 实施与证据见 [193 开发文档](../devDoc/193-p5-prototype-delivery-guide.md)、[194 交付记录](../devDoc/194-p5-prototype-delivery-record.md)。

P5 已通过 [195 整体独立复核](../devDoc/195-p5-independent-review.md)，在首轮本机后端源码原型范围收口；远程 MCP、干净安装、其他真实协议和桌面交付范围仍按记录单列。

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

角色创建即获得默认窗口。设定修订使用 `role update --role <id> --definition @文件 --expected-revision <当前版本>`，身份和已有记录保留。

从 examples/model-anthropic.json、model-openai-chat.json 或 model-openai-responses.json 复制一份到 `.nowadays/model.json`，按实际服务修改 baseUrl；样例地址故意不可用。baseUrl 填服务的 API 根路径，适配层拼接 messages、chat/completions 或 responses。credentialRef 可为 `env:NOWADAYS_MODEL_API_KEY` 或 `file:<密钥文件绝对路径>`。环境引用应在启动后端前设置，后端进程才能读到；密钥不要放入样例或提交。

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

用角色绑定指定对话模型和后台记忆模型；`binding put` 替换整个绑定列表，修改时保留已有 MCP／Skill 条目：

```powershell
@{ bindings = @(
  @{ capability='chat_model'; resourceId=$model.resourceId; modelName=$modelId; enabled=$true },
  @{ capability='memory_model'; resourceId=$model.resourceId; modelName=$modelId; enabled=$true }
) } | ConvertTo-Json -Depth 10 | Set-Content .nowadays/bindings.json -Encoding utf8NoBOM
node --import tsx src/cli.ts binding put --role $roleId --json '@.nowadays/bindings.json'
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

## 6. 数据布局与验收

```text
<app-root>/data/app.sqlite
<app-root>/data/roles/<roleId>/business.sqlite
<app-root>/data/roles/<roleId>/execution.sqlite
<app-root>/data/roles/<roleId>/workspace/
```

业务库保存正式身份、状态、消息、记忆、任务和调用事实；execution.sqlite 为图检查点，不替代正式业务数据。备份时先停止后端，保留整个 app-root/data；不要只复制其中一个 SQLite 文件。

```powershell
npm run accept:offline
```

统一离线入口运行类型检查、交付回归、168 项当前正式测试、真实进程／CLI 重启冒烟，以及 P2 20、P3 11、P4 28 项定向场景。实际数量以本次报告为准。脚本使用当前 node，在新建 `test-results/p5-.../` 下保存 summary.json、源码哈希、逐步日志和业务报告；不会读取你的运行配置、调用真实模型、覆盖或清理旧验收目录。任何失败、报告缺失或用例数量不完整均返回非零退出码。

本命令会启动本地子进程和本机回环 HTTP 服务。运行输出属于忽略的证据，稳定结论和覆盖限制见 194；独立复核与实现方自验分别记录。
