# nowadays

目录与Git约定见[仓库规范](devDoc/23-repository-layout-and-version-control.md)：测试源码保留，测试截图/报告、运行数据、构建输出和`release/`发行包不进入Git。

当前桌面版采用引导式外部 SnowLuma 接入：用户从官方页面自行下载、解压、初始化并启动，nowadays 记住目录和加密管理密码、检测 QQ 并在点击后注入/监听。应用不自动部署或启动 SnowLuma。详见 [首次配置与验收](devDoc/20-guided-external-snowluma.md)。

QQ 进程注入编排与交互核心。目标是把「注入一个 QQ、连上它、收发消息」做成**可多实例、彼此隔离、无单例**的底座；私聊/群聊策略、插件、角色卡、Skill 都属于功能层，通过 `AgentHost` 契约接入。

当前版本实现：SnowLuma attach 探测与 1.14.x 手动注入/监听管理、OneBot 通道、实例状态机、声明式收敛、多实例监督、QQ 维度账号档案、公用/私有制品分发、账号级插件运行 Worker、按账号滚动热部署、账号命名空间存储、分层配置、本地控制 API、指标/诊断，以及 Windows 桌面端（Electron + React）与安装包。第一阶段增加了四项模型能力路由、账号策略与硬授权、凭据库、内置最小 Agent、账号媒体制品与有限异步任务；第二轮补齐执行计划/凭据版本一致性与全宿主暂停，并加入手动注入操作状态机、进程身份校验和桌面操作界面。

## 分层与职责

| 层 | 目录 | 职责 |
|---|---|---|
| 注入后端 | `src/injection/` | runtime 作用域的探测/附着；SnowLuma 按账号 attach/detach |
| 通道 | `src/channels/` | OneBot 事件规范化、动作调用、心跳、暂停/恢复、重连带代际号 |
| 实例会话 | `src/instances/instance.ts` | 一个 QQ 号的生命周期、身份校验、回环、入站/出站队列、限流、宿主回调 |
| 运行时资源 | `src/instances/runtime-registry.ts` | runtime 共享、引用计数、按账号熔断、释放 |
| 编排 | `src/instances/supervisor.ts` | desired/observed 收敛、每实例操作串行、退避重启、预算与并发上限 |
| 存储 | `src/storage/` | 账号键路径、分段 JSONL、seq、messageId 幂等、desired 状态、槽位规格 |
| 配置 | `src/config/` | global → account → kind → account:kind → conversation 合并与原子写 |
| 账号档案 | `src/profiles/` | `profile.json`、角色卡必填、插件启用集、revision 快照 |
| 制品分发 | `src/artifacts/` | 公用/私有 manifest、catalog、滚动部署与回滚 |
| 插件运行时 | `src/extensions/runtime/` | 每账号每插件一个 Worker、声明与 handler 握手、作用域化插件状态、超时终止代际；`src/host/` 只保留内部注入宿主端口 |
| 控制面 | `src/service/` | 本地 HTTP + SSE，指标、诊断、审计、事件续传、档案/制品/slot API，桌面 UI 静态托管 |
| 桌面端 | `desktop/` | Electron 主进程内嵌 Core、preload 注入本地 token、托盘、React 控制台与打包脚本 |

## 资源与隔离

一个 `AccountSession` = 一个 QQ 号 × 一条通道 × 一份账号命名空间。实例是「runtime + 策略」的运行槽：启动后按通道回报的 QQ 绑定账号，停止时释放绑定，因此同一个槽可以在下次启动时注入另一个号。

- **没有模块级单例**：`createCore()` 每次返回独立容器；同进程可以创建多个 Core。
- **一个 dataRoot 一个写者**：`DataRootLock` 阻止两个进程同时写同一数据根。
- **账号租约**：同一 Core 内一个 QQ 号只能由一个实例持有。显式 `accountId` 在创建时预占；动态账号在启动绑定后获取，停止/故障拆除时释放。跨进程账号租约尚未实现。
- **runtime 共享**：SnowLuma 按 `runtimeDir` 共享 backend，引用计数归零后释放；熔断按账号隔离，一个号掉线不拖累同 runtime 的其他号。
- **数据不共用**：`<dataRoot>/accounts/<accountId>/` 下保存该 QQ 的 `profile.json`、`messages/`、私有制品和 `plugin-state/`；旧 `<dataRoot>/messages/` 目录不会被自动迁移。
- **槽位可恢复**：桌面端把槽位规格写入 `<dataRoot>/slots.json`；重启后按文件恢复。desired 状态另行持久化，二者互不覆盖。
- **角色卡必填**：账号没有可解析的角色卡时停在 `awaiting_profile`，不进入 `online`，也不启动回复宿主。
- **唯一回复者**：内置 Agent 是账号唯一的自动回复者；插件不再接管回复，只能提供工具、钩子补充数据和插件自己的状态。插件拿不到 bus/store/backend/token，也拿不到发送端口。
- **身份不串**：实例只允许以自己绑定的账号发送；`spec.accountId` 与通道回报的 selfId 不一致直接失败。
- **失败不扩散**：`startAll` 使用 allSettled 语义；重启只重启失败实例，并受全局并发和抖动限制。
- **事件不串**：每个 Core 有自己的 `TypedEventBus` / `EventLog`，事件带 `instanceId`。

## 回环语义

本核心按**实例归属**判定回环，而不是 `senderId === selfId`：

- 事件里的 `self_id` 不属于本实例 → `misattributed`，丢弃并报错；
- 本实例自己发出的回声（`message_sent` 或 `senderId = 本实例 selfId`）→ `self`，丢弃；
- 其余一律 `accept`，包括另一个号发来的消息。

## 状态与消息语义

- 每个实例有 `desiredState`（running/stopped）和 observed 状态；手工 stop 会持久化到 `<dataRoot>/state/desired.json`，进程重启后不会自动拉起。
- 实例状态：`stopped → provisioning → starting → awaiting_login → awaiting_profile → online`；`awaiting_profile` 表示账号档案不完整。
- 每实例一条操作链，start/stop/restart 串行执行；上线前的 stop 会立即取消在途 start/connect。
- 优雅停止会暂停通道、排空 ingress/egress（`drainTimeoutMs` 有界），再停宿主、断开通道与后端；超时丢弃会发 `drain_timeout` 事件。
- 宿主热切换：新 profile 的宿主就绪后才原子替换；在途 turn 继续使用旧宿主，旧宿主排空后停止。
- 失败按 `retryable` 分类：不可重试错误进入 failed 并发出 `restart_suppressed`，不会盲目重启。
- 入站：有界队列 + 每会话串行 + `messageId` 去重；先落盘再发事件，落盘失败会报 `persist_failed` 但仍把消息交给宿主。
- 出站：每会话 FIFO + 每账号令牌桶；`idempotencyKey` 去重；消息发出后落盘失败不会让调用方重试造成重复发送。
- 背压：入站队列高水位暂停通道，硬上限丢弃并报 `ingress_overflow`；出站队列满返回 `backpressure`（HTTP 429）。
- 未实现持久化 outbox：当前是 best-effort + 本地幂等，不保证跨进程重启的 at-least-once。

## 账号档案与制品

公用层默认是 `<dataRoot>/public`，私有制品属于账号目录：

```
<dataRoot>/
  public/
    catalog.json                    # { "role-card:default": "r1", "plugin:echo": "r1" }
    artifacts/
      role-card/default/r1/manifest.json
      plugin/echo/r1/manifest.json
      plugin/echo/r1/echo.mjs
  accounts/10001/
    profile.json
    catalog.json                    # 私有制品当前 revision
    artifacts/                      # 私有角色卡/插件
    messages/                       # 会话 JSONL
    plugin-state/                   # 每个插件一个命名空间
```

`profile.json` 示例：

```json
{
  "version": 1,
  "roleCard": { "source": "public", "id": "default" },
  "plugins": [
    { "source": "public", "id": "echo", "config": {} },
    { "source": "private", "id": "local", "enabled": false }
  ]
}
```

- `roleCard` 必填；没有档案、角色卡解析失败或 profile 结构非法时，实例停在 `awaiting_profile`。
- 不写 `revision` 时跟随 catalog 的当前 revision；显式写 revision 可固定。
- 公开引用随公用层更新；私有制品只在该账号目录内解析。

制品 manifest：

```json
{ "id": "default", "kind": "role-card", "revision": "r1", "content": "你的角色设定" }
{ "id": "echo", "kind": "plugin", "revision": "r1", "entry": "echo.mjs", "apiVersion": 1 }
```

插件 manifest 用 `tools` / `hooks` / `skills` / `state` 声明可执行项，模块入口只提供与声明对应的 handler：`beforeContext` 返回带来源标记的补充数据，`afterTurn` 收到本轮真实结果摘要，工具 handler 接收校验后的参数与宿主生成的只读上下文并返回结构化结果。插件没有 `send`、没有回复出口，未声明的导出不能成为工具。

热部署是**按账号滚动**的：`POST /artifacts/:kind/:id/deploy` 先更新 catalog，再逐个账号校验新档案、为新 revision 建立运行代际、原子切换、排空旧代际。单个账号失败时保留旧 revision 与旧宿主，继续处理其他账号；`GET /deployments` 查看部分成功结果。`POST /artifacts/rollback` 恢复 `catalog.previous.json` 后再次滚动。系统不做长期版本并行，但会保留历史 revision 目录用于回滚。

内置 Agent 是唯一的自动回复宿主；需要自定义隔离或接入方式时，只能通过 `CoreOptions.hostFactory` 注入内部端口，不再提供第二套面向用户的插件标准。插件工具与内置工具走同一条执行通道：每账号一个执行器共享一份全局并发额度，可执行清单来自该账号 Worker 的握手结果，握手未就绪或授权被撤销时既不会进入模型请求，也不会在动作前通过复核。同一插件的钩子与工具在该插件 Worker 内串行，避免多个会话同时改写同一份插件状态；其他插件及账号的工具按共享限额运行，每轮钩子另按累计预算调度。

换代际后，旧代际的在途 turn 仍会结束，但它的结果与插件状态写入会被丢弃，不会覆盖新 revision 的状态。Worker 提供生命周期与故障隔离，但不是安全沙箱：插件代码按受信任代码对待。

## 第一阶段：模型能力、策略与任务

第一阶段在原有实例/通道/存储之上增加以下纵向能力，仍然由同一个 Core 装配，不引入第二套调度器：

| 模块 | 目录 | 职责 |
|---|---|---|
| 服务配置 | `src/providers/` | schemaVersion=2 配置、原子写与备份、Provider/模型/能力声明、端点限流、能力路由与重试 |
| 凭据 | `src/secrets/` | 只按 `credentialRef` 读写；系统保护不可用时拒绝保存，不退回明文 |
| 能力策略 | `src/policy/` | 账号硬授权 + 账号→私聊/群聊→指定会话的普通开关与绑定覆盖 |
| 内置 Agent | `src/agent/` | 角色卡 + 受限历史 + Skill + 观察数据的单轮对话；显式生图与异步视频 |
| 媒体 | `src/media/` | 账号媒体制品、受控下载、MIME/大小/校验、保留与清理 |
| 任务 | `src/jobs/` | 每账号串行、全局受限的有限任务；排队/运行/等待远端/终态与投递状态 |
| 扩展 | `src/extensions/` | Tool 注册、Hook 分发、Skill 可用性解析 |

### 服务配置

模型服务配置在 `<dataRoot>/config.v2.json`，与旧的 `config.json` 分开；旧文件只备份、不改写。示例见 [nowadays.config.v2.example.json](nowadays.config.v2.example.json)。四个能力 id 固定为 `chat`、`image.understand`、`video.understand`、`image.generate`；模型是否支持某项能力完全以配置声明为准，不由适配器猜测。

- `openai-compatible-v1`：`/chat/completions`（文本、图片输入、工具调用）与 `/images/generations`（`b64_json` 或 URL）。
- `video-polling-v1`：`POST/GET/DELETE /video/understand[/{id}]`，支持轮询、进度与尽力而为的远端取消。
- `fake-v1`：本地可脚本化适配器，用于 A/I 级测试与桌面演示。
- 云端服务必须使用 https；密钥只能通过 `credentialRef` 引用，不能写进配置、模型参数或错误信息。
- 同一 `baseUrl` 的并发限制按端点共享；请求超时、轮询上限和重试次数都在服务配置中显式声明。

可用 `credentials` API 写入/删除密钥；读取接口只返回是否已配置。桌面端使用 Electron `safeStorage`（Windows 为 DPAPI）保存密文到 `userData/credentials.json`，不可用时明确拒绝保存。

### 账号策略与回复归属

账号策略保存在 `config.v2.json` 的 `accountPolicies.<QQ>`：

- `allowedProviders`、`media.allowCloudUpload`、`crossProviderFallback` 是账号硬授权，作用域覆盖不能绕过。
- `bindings` 把四项能力绑定到 provider/model；`fallback` 只在账号允许跨服务回退且目标能力兼容时才有效。
- `agentEnabled`、`capabilities`、`visionMode` 可在 `byKind`、`byConversation` 中逐层覆盖。
- `skills.enabled` / `skills.disabled` 按账号选择公用 Skill；`skills.definitions` 可用同 id 覆盖为私有版本。未显式配置时保持公用定义默认继承，私有定义只进入该账号的上下文。
- 暂停 Agent 只停止自动回复，QQ 连接、人工发送和媒体任务仍可用。
- 撤销能力开关、服务授权或云端上传许可后，排队任务会被取消；每次提交、重试与 fallback 前都会按当前策略复核，旧授权快照不能继续发起请求。

`GET /accounts/:accountId/effective?kind=&peerId=` 返回每项能力的可用性、不可用原因、开关来源、绑定来源、取消模式与 Skill 可用性，UI 直接展示结果而不是只展示已保存配置。

### 内置 Agent、媒体与任务

- 上下文包含角色卡、启用的世界书与事实记忆、有效Skill、有界历史、当前消息及带来源的观察/插件数据；当前输入只出现一次，跨账号/跨会话历史不混用。
- 插件 `beforeContext` 只补充非system数据，`afterTurn` 收到实际发送结果；单钩子500ms、每轮before/after共用2s，模型等待不计入。相关作用域、插件配置或代际失效时，旧结果不能交付；带插件补充数据或工具协议的轮次不作为MEM03事实候选。独立验收见[90号记录](devDoc/90-ext-d-independent-review.md)。
- 图片默认先交给授权的外部识图服务，再以带来源标记的观察数据进入对话；`visionMode=direct` 时直接交给支持图片输入的对话模型。关闭图片理解时两条路径都不会偷偷执行。
- 视频走独立媒体任务，成功后回到原会话追加一轮对话；没有视频能力时明确说明，不假装看过视频，也不静默抽帧外发。
- 显式 `/draw`、`!draw`、`/img`、`!img` 命令和模型工具 `generate_image` 都走同一生图任务与统一发送出口。
- 模型工具调用按预算循环：最多 3 个工具回合、4 次工具调用、4 次模型续答；被拒绝的调用同样计入预算，最后一次模型请求不再提供工具。assistant 的 `tool_calls` 与配对的 `tool` 结果只活在本轮续答里，不写入历史、不提前发出中间文本，一轮对话只有一条最终回复。
- 生图与语音工具经统一执行器提交原有媒体任务，返回 `submitted` 与 jobId；同一宿主调用在账本与媒体任务两层去重。Provider的callId只用于协议配对，不同消息或模型回合是独立宿主调用，不能仅因复用call_1而合并。
- 媒体按账号保存，下载大小/类型/重定向/私网地址都受限；生成结果支持 base64 与 URL，不接受远端文件系统路径或无法获取的 assetId。
- 任务状态：`queued`、`running`、`waiting_remote`、`succeeded`、`failed`、`cancelled`、`interrupted`；投递状态单独记录。重启后遗留非终态任务标记 `interrupted`，不会自动重新提交付费请求。
- 取消模式按适配器声明区分 `remote` / `localOnly` / `none`；本地取消不会被说成远端已取消。

### 代际与隔离

账号绑定时递增 `sessionEpoch`；每次宿主创建递增 `hostEpoch`；配置/策略变化会改变 `profileFingerprint`。旧宿主晚到的发送、状态写入和会话回包会因代际不匹配被拒绝。公用与私有插件同 id 时，状态命名空间分别为 `<id>` 与 `<private>~plugin~<id>`，不会串用。

### 第一阶段桌面页面

侧边栏新增：

- **模型与能力**：服务 CRUD、模型能力声明、密钥写入/删除、能力探测（生图探测需要显式确认费用）。
- **账号策略**：账号硬授权、作用域切换、Agent 暂停/恢复、能力开关与绑定、生效结果与 Skill 不可用原因。
- **任务与媒体**：任务筛选、取消、失败/远端未知说明、账号媒体缩略图、删除与过期清理。
- **运行槽位**：只读展示 SnowLuma 进程（PID、路径、QQ 身份、注入/连接状态），按用户点击执行“注入并监听 / 开始监听 / 刷新 / 请求卸载”；槽位卡片区分“暂停自动处理”“停止监听”和“请求卸载”三种语义。

设置页提供 SnowLuma runtime 目录、管理地址、管理密码（只写凭据库）与版本/鉴权/hookAutoLoad 状态，并明确列出记忆管理页面、情绪/遗忘曲线与受管 launch 为后续阶段，**不提供保存后实际不生效的入口**。

### 独立世界书

- 资源库可新建或导入世界书 JSON（原生/酒馆数组/酒馆对象），列表只读取版本摘要；选择版本后才读取正文。
- 编辑器支持条目增删复制、关键词/正文/常驻/大小写/优先级/位置与搜索筛选；保存使用稳定 requestId、`baseRef` 与基础指纹创建不可变新版本，原版本和已有会话都不会被覆盖或自动切换。复制为新书会生成独立 id（长 id 也保留后缀），可直接保存。
- `POST /worldbooks/preview` 只对调用方给出的草稿和文本执行与运行时相同的匹配器；不读真实历史、不调用模型、不写资源或记忆，扫描/预算受限会明确标出。
- 每个私聊/群聊二选一：角色卡内置书，或公共独立书的固定 revision；来源与参数一次 CAS 保存，旧客户端省略 `source` 时保留已存来源。有效状态、版本、条目数与“建议参数”在会话设置中展示，建议参数只改草稿且不自动启用；版本超过一页时可“加载更多版本”。
- 关闭快照继续携带角色与历史 epoch；换书/切版本/参数变化进入发送前 guard，旧上下文生成的回复会被拒绝。换角色不读取旧角色来源，保留旧数据供明确管理。


### 迁移与备份

- 首次创建 v2 配置时，如果存在旧 `config.json`，备份为 `config.json.backup.json`，旧文件内容保持原样。
- v2 每次写入前保留 `config.v2.json.bak`；无效 JSON 会明确报错并保留原文件，不自动清空。
- 账号 `profile.json`、消息、插件状态和媒体都在原有账号目录下继续使用，桌面端升级不会迁移或删除旧数据。

> 第一阶段验收中的 A/I 项由自动化测试覆盖；涉及至少两个真实 QQ 与真实模型服务的 M 项，在没有实际证据时必须标记为未验收。当前仓库不包含真实 QQ 登录或付费模型调用证据。

## 桌面端

桌面端把 Core 直接跑在 Electron 主进程里，控制面只监听 `127.0.0.1` 的随机端口，UI 与 API 同源；每次启动生成随机 token，通过 preload 注入渲染进程，渲染进程开启 `contextIsolation`/`sandbox`，拿不到 Node 能力。

```bash
npm run desktop:start    # 构建并启动开发版
npm run desktop:pack     # 只打 portable exe
npm run dist             # NSIS 安装包 + portable exe
```

产物在 `release/`：

- `nowadays-0.2.4-setup.exe`：可选择安装目录的 NSIS 安装包，带卸载器与桌面快捷方式。
- `nowadays-0.2.4-portable.exe`：单文件便携版，直接运行；SnowLuma由用户另行准备。

行为约定：

- 关闭窗口只隐藏到托盘，QQ 注入、通道与插件继续工作；托盘菜单提供「打开主窗口 / 打开数据目录 / 退出」。退出会先停止 Core，再结束进程。
- 单实例锁：重复启动会把已有窗口唤回。
- 新安装默认数据根是 `%APPDATA%/nowadays/data`，日志在 `%APPDATA%/nowadays/logs/desktop.log`。检测到旧 `%APPDATA%/Accompany` 时继续使用旧目录（包括加密凭据和单实例锁），无需手动迁移。
- 桌面总览直接展示可连接的QQ进程，注入并识别账号后动态创建内部实例，无需手动创建槽位；Fake仍作为开发和测试后端保留。
- 桌面端默认 `manualStartOnly:true`、`autoStartSnowLuma:false`：SnowLuma管理服务和QQ均由用户自行启动，进程列表只读，只有点击按钮才调用 SnowLuma `load`。
- “停止监听”只停止本应用的连接、队列、宿主并释放账号租约，不卸载注入、不关闭 QQ；“请求卸载”先停止监听，再显式调用 SnowLuma `unload`，并提示会影响共享该进程的其他应用。
- 可用环境变量覆盖：`NOWADAYS_DATA_ROOT`（数据根）、`NOWADAYS_UI_DIR`（UI 目录）、`NOWADAYS_LOG_LEVEL`。旧 `ACCOMPANY_*` 名称保留兼容，新名称优先。
- 打包脚本从 `node_modules/electron/dist` 组装 `win-unpacked`，再交给 electron-builder 的 prepackaged 模式；这样不会重复下载/解压 Electron，也避开了部分机器上解压目录被扫描占用的重命名问题。

> 安装包尚未做代码签名，Windows SmartScreen 可能提示未知发布者。需要签名时在 `CSC_LINK`/`CSC_KEY_PASSWORD` 下接入证书即可。

## 快速开始

```bash
npm install
npm test                 # 状态机 / 队列 / 存储 / 配置 / 监督 / 隔离 / 档案 / 制品 / 桌面 API / 宿主 / 模型路由 / 手动注入
npm run typecheck        # 核心、测试与渲染进程类型检查
npm run build

# 桌面端（构建 React UI、主进程与 preload 后启动 Electron）
npm run desktop:start

# 只读探测已有的 SnowLuma 运行时
npx tsx src/bin/nowadays.ts probe --runtime-dir "D:/app/QQAgent/QQ Agent/resources/app/snowluma"

# 以无 UI 的命令行方式启动核心（示例配置见 nowadays.config.example.json）
npx tsx src/bin/nowadays.ts start --config nowadays.config.example.json
```

控制面默认监听 `127.0.0.1`，非回环绑定必须提供 Bearer token。所有路由同时支持 `/v1` 前缀。

首次启动前需要先准备 `<dataRoot>/accounts/<qq>/profile.json` 和角色卡制品；缺失时实例会停在 `awaiting_profile`，这是有意的阻断。桌面端默认把槽位规格持久化到 `<dataRoot>/slots.json`；CLI 仍以配置文件的 `instances` 为准，除非显式开启 `persistSlots`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 免鉴权存活检查 |
| GET | `/health/ready` | 免鉴权就绪检查（是否有在线实例） |
| GET | `/instances` | 实例状态（desired/observed、档案、队列、最近错误） |
| GET | `/slots` | 槽位状态 + 持久化的槽位规格 |
| POST | `/slots` | 动态添加槽位，body 同 `InstanceSpec` |
| DELETE | `/slots/:id` | 停止并移除槽位（同时清理 desired 状态、释放租约） |
| POST | `/slots/:id/start`、`/slots/:id/stop` | 与 `/instances/:id/*` 等价；支持 `Prefer: respond-async` |
| GET | `/accounts` | 已知 QQ 账号、档案状态、角色卡/插件摘要与占用槽位 |
| GET | `/conversations?accountId=` | 账号下已知会话 |
| GET | `/accounts/:accountId/conversations/:kind/:peerId/messages` | 消息历史；支持 `limit`、`afterSeq`、`beforeSeq` |
| POST | `/instances/:id/send`、`/slots/:id/send` | `{ kind, peerId, text \| segments }`，支持 `Idempotency-Key` |
| GET | `/accounts/:accountId/profile` | 读取账号档案 |
| PUT | `/accounts/:accountId/profile` | 保存档案并尝试热重载绑定的实例 |
| POST | `/accounts/:accountId/reload` | 重新解析并应用档案 |
| GET/POST | `/providers` | 列出服务（脱敏）/ 新增服务，可同时写入密钥 |
| PUT/DELETE | `/providers/:id` | 更新 / 删除服务；删除会清理账号绑定 |
| PUT/DELETE | `/providers/:id/credential` | 写入 / 删除系统凭据库中的密钥 |
| POST | `/providers/:id/test` | `{ capability, modelId?, confirmCost? }`，生图探测必须显式确认费用 |
| GET/PUT | `/accounts/:accountId/policy` | 读取 / 写入账号策略 |
| GET | `/accounts/:accountId/effective?kind=&peerId=` | 生效能力、来源、不可用原因与 Skill 状态 |
| POST | `/accounts/:accountId/agent` | `{ enabled, kind?, peerId? }`，按作用域暂停/恢复自动回复 |
| POST | `/accounts/:accountId/capabilities/:capability` | `{ enabled, kind?, peerId? }`，切换普通能力开关 |
| GET | `/injection/runtime` | SnowLuma 管理连接、版本、鉴权、hookAutoLoad 与外部所有权状态 |
| POST | `/injection/connection/test` | 验证已保存连接：真实鉴权并只读进程列表，不启动服务或注入 |
| GET | `/injection/processes` | 归一化进程列表；只读，不触发 load |
| GET/PUT | `/injection/settings` | 读取 / 写入 runtime 目录与管理地址；`password` 只写凭据库 |
| DELETE | `/injection/password` | 清除 SnowLuma 管理密码 |
| POST | `/injection/processes/:pid/inject-and-listen` | 用户显式注入并监听；body 带 `slotId`、`identity`、可选 `expectedAccountId` |
| POST | `/injection/processes/:pid/listen` | 对已注入目标只开始监听，不重复 load |
| POST | `/injection/processes/:pid/refresh` | 显式刷新注入状态 |
| POST | `/injection/processes/:pid/unload` | 先停止本应用监听，再请求 SnowLuma 卸载；body 可选 `slotId` |
| GET | `/injection/operations/:id` | 查询手动注入操作状态与结果 |
| GET | `/jobs?accountId=&state=` | 媒体任务列表，按账号与状态过滤 |
| GET | `/jobs/:jobId?accountId=` | 单个任务；必须带账号以避免跨账号读取 |
| POST | `/jobs/:jobId/cancel` | `{ accountId }`，本地取消并单独记录远端状态 |
| GET | `/accounts/:accountId/media` | 账号媒体索引 |
| GET/DELETE | `/accounts/:accountId/media/:mediaId` | 读取媒体字节 / 删除 |
| POST | `/media/cleanup` | 按保留策略清理，跳过任务仍在引用的媒体 |
| GET | `/artifacts` | 公用层制品清单 + 当前 catalog revision |
| GET | `/worldbooks` | 有界世界书版本摘要（`id`/`offset`/`limit`，不含正文） |
| GET | `/worldbooks/:id/revisions/:revision` | 指定固定版本的完整正文与指纹 |
| POST | `/worldbooks/revisions` | 不可变新版本/派生（`requestId`、`baseRef`、`expectedBaseFingerprint`） |
| POST | `/worldbooks/preview` | 草稿试算 `{ book, text, scanDepth?, budgetChars? }`，只读匹配 |
| PUT | `/accounts/:accountId/role-bindings/:kind/:peerId/worldbook` | 来源 + 参数 CAS 保存（`expectedRevision`） |
| POST | `/accounts/:accountId/role-bindings/:kind/:peerId/worldbook/preview` | 使用已保存来源与会话参数做只读关键词测试 |
| POST | `/accounts/:accountId/memory/:kind/:peerId/preview` | 只读检索预览 `{ text, expectedScope }`，按已保存设置计算，标注 `budgetBasis: memory-only` |
| GET/PUT | `/accounts/:accountId/memory/:kind/:peerId/settings` | 记忆开关、预算与最多选用条数；PUT 携带 `expectedScope` 与 `expectedRevision` |
| GET/POST | `/accounts/:accountId/memory/:kind/:peerId/records` | 有界摘要列表（不含正文）/ 手工 fact 新增（`requestId` + 双 expected） |
| GET/PUT/DELETE | `/accounts/:accountId/memory/:kind/:peerId/records/:id` | 指定正文 / 编辑 / 删除（记录版本 + 双 expected） |
| POST | `/accounts/:accountId/memory/:kind/:peerId/clear` | 清空记录并关闭自动提取，保留设置与状态文件 |
| GET | `/accounts/:accountId/memory/:kind/:peerId/extraction` | 提取状态、水位、冷却、本地配额与运行时状态；不含聊天或模型输出 |
| POST | `/accounts/:accountId/memory/:kind/:peerId/extraction/activate` | 显式付费授权：`startFrom:"now"`、`confirmModelUse:true` + 双 expected；只处理此后的新消息 |
| POST | `/accounts/:accountId/memory/:kind/:peerId/extraction/pause` | 双 expected 暂停自动提取并失效旧任务 |
| POST | `/artifacts/:kind/:id/deploy` | `{ revision }`，更新 catalog 并滚动部署 |
| POST | `/artifacts/rollback` | 回滚到上一份 catalog 并滚动 |
| GET | `/deployments` | 最近的部署记录（含逐账号结果） |
| GET | `/metrics` | JSON 指标快照 |
| GET | `/diagnostics` | 状态、limits、runtime、账号租约、desired、审计、部署 |
| GET | `/events` | SSE：`instance:*` / `channel:*`，支持 `Last-Event-ID` 续传 |

错误响应包含 `{ ok: false, error, code, retryable? }`，并通过 `x-request-id` 回传请求 id。

长期记忆（MEM03）已在MEM02上下文之上完成可选自动fact提取：默认关闭，必须先开启记忆并显式确认`startFrom:"now"`的付费模型使用；旧`autoExtract=true`不会静默授权。只在内置Agent纯文本回复成功发送并持久化后触发，按当前账号/群私聊/角色epoch有界读取新消息；准入按合格文本计数，长消息不会阻塞后续，扫描达到上限时有界续扫而不重读旧前缀。至少6条且距上次尝试5分钟才调用，每次提取只向Provider发出一次尝试、不自动重试或fallback，失败冷却至少10分钟；每scope最多1个运行+1个合并任务、全局并发2、每账号12次/小时且全局30次/小时（本地成本闸）。模型输出必须是无tools调用的单个严格JSON对象；服务端生成model fact与证据范围，提交在原始会话队列内重验scope/generation/水位，删除、清空、关闭或编辑模型事实会原子暂停并拒绝在途旧结果。相同sourceKey幂等，容量不足整批拒绝并暂停。自动提取无QQ消息输出、无摘要生成、无管理页面；真实付费服务尚未验收。详见`devDoc/75-memory-extraction-execution.md`，独立复核修复见`devDoc/77-memory-extraction-review-fixes.md`，方案与验收为`devDoc/73`、`devDoc/74`。

## 容量上限

`limits` 可覆盖：`maxInstances`、`maxIngressQueue`、`maxConversationQueue`、`maxMessageBytes`、`maxSseClients`、`maxConcurrentActions`、`sendRatePerSecond`、`sendBurst`、`startConcurrency`、`restartConcurrency`、`healthCheckIntervalMs`、`unhealthyThreshold`、`shutdownTimeoutMs`、`drainTimeoutMs`、`hostDrainTimeoutMs`、`hostTimeoutMs`、`maxHostHistory`、`maxChatConcurrency`、`maxAccountChatConcurrency`、`maxChatPending`、`maxMediaConcurrentJobs`、`maxAccountMediaConcurrentJobs`、`maxMediaJobPending`、`maxPerAccountMediaJobPending`、`mediaJobTimeoutMs`、`maxImageBytes`、`maxVideoBytes`、`mediaDownloadTimeoutMs`、`mediaRetentionDays`。

## 关键不变量（给未来的修改者）

1. 不要在模块顶层放可变状态。共享资源用显式 registry/lease，不用单例。
2. 通道发送前必须校验账号归属；不要绕过 `QqInstance.send()` 直接调通道。
3. 入站先落盘再发事件；落盘失败也要让宿主看到消息，并单独报错。
4. 配置和 desired 状态写入必须走各自串行队列；不能直接写文件。
5. 新后端实现 `InjectionBackend`，按 runtime 作用域设计 start/stop/status；会话差异通过 spec 传入。
6. 新宿主实现 `AgentHost`，只能通过 `AgentMessageContext` 的 `send`/`resolveConfig`/`history`/`state`/`profile` 工作，不要接触 bus、store、backend 或 token。
7. 角色卡是账号上线的前置条件；不要在缺少档案时静默兜底。热部署必须先校验新档案、再切换宿主，失败账号保留旧 revision。
8. 队列、SSE、消息大小、发送速率都要有显式上限；不要给无限增长的 Promise 链或内存缓冲。

## 未实现（下一阶段）

- 长期记忆摘要生成、摘要替换历史与 MEM04 管理页面，以及人格关系与情绪/遗忘曲线（需另写隔离、预算与删除方案）。
- 插件/Skill 体验完善、多模态真实服务矩阵与桌面发行收尾（见 `devDoc/53`、`devDoc/54`）。
- `launch`：拉起 QQ、生成/改写每号端口、runtime 进程级所有权；`PortAllocator` 目前只服务未来的 launch。
- 跨进程账号租约与多写者存储。
- 远端制品仓库与签名校验；当前公用层是本地目录。
- 公开制品 fork 到私有的显式操作（当前可直接在账号目录维护私有 manifest）。
- 已接受远端任务的执行服务身份持久化与重启后查询/取消（当前配置变化会安全中断，不迁移远端任务 ID）。
- 持久化 outbox、消息撤回与群管理动作的完整封装；当前媒体任务有持久化队列，但普通聊天仍是 best-effort。
- 桌面端代码签名、自动更新、多平台安装包；当前产物是 Windows x64 的未签名 NSIS/portable。
- 第一阶段验收中的真实 QQ/真实模型服务 M 项；没有实际环境证据前不宣称完成。
