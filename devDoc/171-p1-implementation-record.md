# P1 实施记录

日期：2026-11-03。

状态：**P1-01～P1-06 完成，R01～R04 全部通过最终独立复验。** 本次类型检查、13 个测试及三组共 13 个复核场景全部通过，最新证据见[172 第 12 节](172-p1-independent-review.md)。历次实现方自验与失败复验按轮次保留；P2 准备见[173](173-p2-memory-agent-development-guide.md)，尚未编码。

需求依据为[持续决策记录](161-digital-life-direction-decisions.md) DL-86 等，阶段范围见[执行清单 164](164-backend-prototype-execution-checklist.md)和[P1 开发文档 169](169-p1-role-storage-development-guide.md)。P1-01 的固定契约见[170](170-p1-01-contract.md)。本文只记录实际完成情况，不新增产品决定。

## 工作包状态

| 工作包 | 状态 | 证据／说明 |
| --- | --- | --- |
| P1-01 契约 | 完成 | [170 P1-01 契约](170-p1-01-contract.md)固定目录、appRoot、schema、API／CLI、初始化、身份关联及错误 |
| P1-02 工程与存储 | 实现方自验完成 | 独立 `backend/`、schema 版本、应用／角色／检查点存储工厂、健康接口、关闭重开测试 |
| P1-03 角色与消息 | 实现方自验完成 | 角色创建／初始化重试、设定修订、状态版本、窗口、消息去重与分页 |
| P1-04 配置与关联 | 实现方自验完成 | 资源定义／开关、角色绑定、任务／执行／调用、模式事件与资源延续仓储 |
| P1-05 API 与 CLI | 实现方自验完成 | 独立后端进程 + 独立 CLI 进程走同一 HTTP 服务，重启后读取一致 |
| P1-06 自验与独立复核 | 完成 | R01～R04 修正后最终独立复验通过，见 172 第 12 节；历史轮次不改写 |

## 运行环境与依赖

- 分支：`codex/p1-role-storage`；用户已要求本地提交，源码版本以包含本记录的 Git 提交为准。独立验证发生在提交前，摘要及确切报告见 172 第 12 节。
- Node.js 24.22.2 / win32-x64；npm 11.19.1；`backend/package-lock.json` 为 lockfileVersion 3。
- 实际安装：better-sqlite3 12.10.0、zod 4.6.7、typescript 5.9.3、tsx 4.23.15、@types/node 24.10.0、@types/better-sqlite3 9.6.0。
- 与 P0 相同，直接使用本机 Node 20 安装会因 better-sqlite3 无对应预编译包且缺少 Visual Studio 失败；本次把 Node 24 目录放到 PATH 最前安装成功。P1 的 `engines` 声明为 `>=24`，未宣称其他 Node 版本通过。

安装命令（在 `backend/` 下）：

```bash
PATH="$PWD/../prototypes/p0/.runtime/node-v24.22.2-win-x64:$PATH" \
  ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe \
  ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node_modules/npm/bin/npm-cli.js install
```

## P1-02 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 配置入口 | `src/bootstrap/config.ts` | `--app-root`／`NOWADAYS_APP_ROOT`、默认端口 3210、回环地址、数据根 `<appRoot>/data`、roleId 路径校验 |
| 应用组装 | `src/bootstrap/app.ts` | 创建数据根、打开 `app.sqlite`、组装 HTTP 服务、幂等关闭 |
| 后端入口 | `src/main.ts` | 解析参数、监听并输出 listening JSON、SIGINT／SIGTERM 关闭 |
| 存储 schema | `src/storage/schema.ts` | app／business／execution 独立 user_version=1；WAL、外键、busy_timeout；必需表校验；版本不符拒绝 |
| 存储工厂 | `src/storage/app-store.ts`、`role-store.ts`、`checkpoint-store.ts`、`role-storage.ts` | 应用库、角色业务库、检查点库打开／关闭；角色目录和 workspace 创建 |
| HTTP 基础 | `src/http/server.ts`、`router.ts`、`errors.ts` | 统一 JSON 响应／错误、健康检查、404；后续路由复用 |
| 测试 | `tests/p1-02-storage.test.ts` | 建库、重开、WAL／外键、schema 版本错误、健康接口 |

P1-02 只建立存储与 HTTP 基础，没有资源绑定或 CLI 业务命令；`execution.sqlite` 在 P1-02 只创建并记录版本，检查点表留给 P2 的检查点驱动。

## P1-03 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 角色存储 | `src/storage/role-store.ts` | 角色记录、设定修订、状态版本、窗口、消息提交去重、按 sequence 分页；事务内分配窗口序号 |
| 应用配置库 | `src/storage/app-store.ts` | 角色索引、初始化状态、初始请求载荷、失败标记与 ready 清理 |
| 应用服务 | `src/application/role-access.ts`、`role-service.ts`、`message-service.ts` | 角色 ready 校验、每次请求打开角色存储、创建／初始化重试、设定／状态／窗口／消息 |
| HTTP 契约 | `src/http/body.ts`、`validation.ts`、`schemas.ts`、`routes.ts` | 1 MiB JSON 请求、zod 校验、统一错误、角色／状态／窗口／消息路由 |
| 测试 | `tests/p1-03-role-message.test.ts` | 创建、重启恢复、修订冲突、状态冲突、消息去重与窗口隔离、初始化失败重试 |

已实现的路由：`POST/GET /v1/roles` 相关操作、`POST /v1/roles/:roleId/initialize`、`PATCH .../definition`、`GET/PUT .../state`、`POST/GET .../windows`、`POST/GET .../messages`。消息接口只保存用户消息，不调用模型。

角色创建先在 `app.sqlite` 写入 `initializing` 和初始请求载荷，再建立角色目录／业务库／检查点库／默认窗口；失败标记 `failed`，`POST .../initialize` 使用同一 roleId 和保存的载荷补齐后标记 `ready`。设定修订与状态版本分开递增；消息以 `(window_id, submission_id)` 去重，同编号不同正文返回冲突。

## P1-04 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 资源契约 | `src/domain/resource.ts` | 按 model／mcp／skill 校验配置结构；模型凭据只允许 `env:`／`file:` 引用 |
| 资源配置 | `src/storage/app-store.ts` | 资源创建、读取、按 kind 列表、更新名称／开关／配置；存于 `app.sqlite.resources` |
| 资源服务 | `src/application/resource-service.ts` | 创建／更新校验、角色绑定全量替换；校验资源存在、kind 与 capability 匹配、模型名必填、每个角色最多一个对话／记忆模型 |
| 绑定与关联仓储 | `src/storage/role-store.ts` | 角色绑定；任务、执行、`execution_tasks`、工具调用五态、模式事件、工具结果、资源延续；跨执行任务关联与版本字段独立保存 |
| HTTP 路由 | `src/http/schemas.ts`、`routes.ts` | `POST/GET/PATCH /v1/resources`、`GET/PUT /v1/roles/:roleId/bindings` |
| 测试 | `tests/p1-04-resource-task.test.ts` | 资源校验与重启、绑定替换与规则冲突、任务跨执行、工具五态与模式、版本语义、资源延续、事务回滚 |

任务、执行和工具调用按契约不提供 HTTP 路由；P1-04 通过存储测试验证约束。工具调用以 `(execution_id, step_key)` 幂等，参数按稳定 JSON 比较；同一执行与任务必须先建立 `execution_tasks` 关联。保存工具结果会推进工具调用终态，但不结束所属任务；任务只能由显式结束操作写入状态和原因。

## P1-05 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| CLI 入口 | `src/cli.ts` | 解析全局 `--base-url`，stdout 输出 JSON，stderr 输出错误 JSON 并以非零退出 |
| HTTP 客户端 | `src/cli/client.ts` | CLI 只持有 baseUrl；统一解析后端错误；后端不可达返回 `BACKEND_UNREACHABLE` |
| 命令 | `src/cli/commands.ts` | health、角色、状态、窗口、消息、资源、绑定命令；`<json|@file>` 支持从文件读取 |
| 测试 | `tests/p1-05-api-cli.test.ts` | 真实后端进程与独立 CLI 进程完成全流程，停止并重启后端后读取一致；后端不可用时失败且不写角色目录 |

正式后端入口 `src/main.ts` 与 CLI `src/cli.ts` 独立运行；CLI 不接收 appRoot、不打开 SQLite。P1-05 测试用 `process.execPath` 启动两个子进程，验证同一 HTTP 服务入口。

## P1-06 首轮复核问题修正

[172 独立复核](172-p1-independent-review.md)首轮未通过，登记 P1-R01～P1-R04；修正内容与证据见该文第 7 节，本文不重复其结论。

| 问题 | 修正 | 自验 |
| --- | --- | --- |
| P1-R01 缺失存储被当作首次创建 | `RoleStorage` 区分初始化与打开；ready 角色打开要求 roleDir、workspace、business／execution 数据库存在，缺失或空库返回 `STORAGE_ERROR`，不重建、不初始化 | 2 个缺失文件场景及空库测试通过 |
| P1-R02 unknown 结果不能补录 | 工具结果保留 previous 状态／诊断／原始结果／适配结果／错误及 reconciledAt；unknown 可受控补录 success／failed（必须携带确定结果），明确结果不可冲突改写 | 重启后补录、幂等与冲突测试通过 |
| P1-R03 步骤幂等忽略任务 | `beginToolCall` 幂等同时比较 taskId、工具名和规范参数 | 同步骤不同任务返回 `TOOL_CALL_CONFLICT` |
| P1-R04 未验证必需索引 | 业务库打开检查索引存在、唯一、部分、列顺序及谓词，并检查工具结果表必需列 | 缺失／错误索引与缺列均被拒绝，正常角色可用 |

修正后实现方复验：`npm run typecheck` 退出码 0；`npm test` 12 个测试通过、0 失败，运行编号 `p1-r01-r04-20261103T171357`；172 补充探针 6/6 `contractPassed`，报告 runId `p1-independent-1793697247418-457c7a7b`。该探针由实现方重跑，不能替代独立复验。

## P1-06 第二轮复核问题修正

[172 第 8 节](172-p1-independent-review.md#L126)的独立复验确认 R01、R03 通过，但 R02、R04 仍有遗漏；按第 9 节要求修正：

| 问题 | 修正 | 自验 |
| --- | --- | --- |
| R02 只传状态即可补录 | 保存任何 success／failed 结果都必须提供显式结果（raw／adapted／error，允许 null）；仅 status 或只给诊断码返回 `TOOL_RESULT_EVIDENCE_REQUIRED`，原结果保持 unknown | 首次保存与补录均拒绝无结果请求；带 raw／adapted 或显式空结果成功 |
| R02 调用 unknown 但无结果 | 允许对 `finishToolCall(...unknown)` 形成的调用中间态补录带证据结果，记录 previous_status 与 reconciledAt | 重启后 previous 状态和补录时间保留 |
| R04 谓词子串匹配 | 提取完整 WHERE 子句并整体比较；附加 AND／OR 或不同谓词返回 `SCHEMA_INDEX_INVALID`；绑定写入另校验单模型约束 | 附加 `AND 0` 的索引被拒绝；删索引后仍拒绝写入两个对话模型 |

第二轮实现方复验：`npm run typecheck` 退出码 0；`npm test` 12 个测试通过、0 失败，运行编号 `p1-r02-r04-round2-20261103T180130`；原 6 场景探针 6/6（`p1-independent-1793700085883-c62888d7`）、补查 3 场景 3/3（`p1-recheck-1793700085373-0bda098f`）。该复验仍不能替代独立复验。

## 首轮实现方自验（P1-R01～R04 修正前）

本次执行者：Codex 实现会话。执行目录：`backend/`。分阶段运行编号：P1-02 `p1-02-20261103T163338`、P1-03 `p1-03-20261103T163700`、P1-04 `p1-04-20261103T164233`、P1-05 `p1-05-20261103T164356`；P1-06 全量自验运行编号 `p1-06-20261103T164606`，证据日志 `test-results/<runId>/run.log` 和 `typecheck.log`（均 Git 忽略）。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 退出码 0 |
| `npm test`（`node --import tsx --test tests/*.test.ts`） | 8 个测试通过，0 失败（P1-02 3 项、P1-03 2 项、P1-04 2 项、P1-05 1 项）；修正后复验见上一节 12 项 |

测试覆盖：

- 应用库与角色业务库／检查点库创建，`journal_mode=wal`、`foreign_keys=1`，关闭后重新打开版本仍为 1。
- 角色业务库包含消息、调用模式事件、资源延续等必需表。
- 健康接口返回 `{status:"ok",version:"0.1.0"}`，未知路径返回 JSON `NOT_FOUND`。
- 已有数据库 schema 版本不是 1 时返回 `SCHEMA_VERSION_UNSUPPORTED`，不自动迁移。
- 必需索引的存在、唯一性、列顺序及完整 WHERE 谓词被校验；引号内字符串常量按原样比较，大小写、尾部空格和括号变体均被拒绝。
- 角色创建后重启读取设定、状态和消息；设定／状态修订冲突返回 409；窗口消息相互隔离。
- 同一提交编号重试返回原消息，同编号不同正文返回 `SUBMISSION_CONFLICT`，新编号相同正文插入新消息；分页按 sequence 稳定前进。
- 初始化失败标记 `failed`，修复目录后用同一 roleId 重试成功并清理初始载荷。
- 资源按 kind 校验配置；`credentialRef` 可读写引用本身；资源开关与名称更新后重启仍保留，未知资源返回 404。
- 角色绑定全量替换；资源不存在、kind 不匹配、模型名缺失或多余、重复能力、多个对话／记忆模型均被拒绝；替换前旧绑定保留，重启后仍可读。
- 同一任务关联两次执行后仍保持 active；工具 success 不结束任务；显式结束后保存原因，重复结束幂等、冲突结束返回 409。
- 工具调用 `step_key` 重试返回原调用，参数不同返回冲突；`pending`／`running`／`success`／`failed`／`unknown` 五态、前后台模式事件和工具结果在重启后保留。
- 执行的加载版本与提交版本分开；提交后更新角色状态不改变旧执行版本，重复提交同版本幂等，不同版本返回 409。
- 绑定全量替换在唯一约束失败时回滚，旧绑定保留，未留下半提交。
- 独立后端进程与独立 CLI 进程完成健康、角色、状态、窗口、消息、资源、绑定和初始化流程；重启后端后读取一致；后端不可用时 CLI 返回 `BACKEND_UNREACHABLE`，角色目录数量不变。
- 后端意外错误响应不返回内部细节；日志只记录错误名称，不输出堆栈、SQL 或请求体。

## 已知限制及未覆盖事项

- 首轮至第三轮的失败证据继续保留；R04 最后修正已通过最终独立复验，见 172 第 12 节。此结论只覆盖当前 P1 范围，不代表后续图调度、模型或扩展已验证。
- `BUSINESS_SCHEMA_VERSION` 仍为 1；`tool_results` 新增的补录字段没有为修正前旧库提供迁移，结构不符的旧库会拒绝打开而非自动改写。
- 任务、执行、工具调用和资源延续按契约只提供存储能力，没有 HTTP 路由、调度器或恢复执行；P2 接入 LangGraph 后复用。
- 资源删除／运行中改绑、角色卡导入格式和额度运行中切换仍未确认，未进入 P1；模型凭据只保存引用，不读取、不验证环境变量或文件是否存在。
- CLI 只有命令式接口，没有交互式补全或配置存储；`role update` 只给 `--payload` 时先 GET 当前角色以补齐设定正文。
- P1-05 的停止方式在 win32 上可能直接终止进程而非走完整 SIGTERM 关闭；重启读取验证了文件恢复，但没有覆盖所有平台信号语义。
- 角色创建允许存储多个角色记录，但当前只按单角色验收；多角色管理不进入 P1。
- 未调用真实模型、MCP 或 Skill，未验证桌面打包或 Electron ABI；`execution.sqlite` 尚无检查点表。
- 测试只覆盖当前 Node 24 / win32-x64 环境；未验证其他 Node 版本或操作系统。

## 独立复核（2026-11-03）

执行者：本次 Codex 独立复核会话，与上述实现方自验分开记录。类型检查退出码 0，原有 8 个测试重新运行全部通过；新增 6 个边界场景中 5 个未满足契约，归并为 4 类问题：已有角色存储缺失被静默创建、unknown 无法补存已确认结果、步骤幂等漏校验任务归属、打开数据库漏查必需索引。

复核结论：**首轮未通过；R01～R04 修正后，第二轮独立复验确认 R01、R03 通过但 R02、R04 仍有遗漏；第三轮独立复验确认 R02 也已通过，R04 仍有字符串常量规范化遗漏（见 172 第 10 节），P1 尚未完成**。实际响应、优先级、修正与复验要求、命令和证据位置见[172 P1 独立开发复核](172-p1-independent-review.md)第 7 节。独立复核轮次未修改实现或依赖，未提交或推送，不以自验重跑通过宣布阶段完成。

修正后的独立复验：类型检查、12 个测试及原 6 个复核场景全部通过；R01、R03 修正通过。补查 3 个边界发现 R02、R04 仍有遗漏：错误索引谓词附加 `AND 0` 仍被接纳；unknown 结果可只凭状态声明升级为 success；只有调用状态 unknown、尚无结果行时又拒绝保存确认结果。完整证据及补修要求见[172 第 8 节](172-p1-independent-review.md)。未满足用户“没有问题后提交”的条件，本轮未提交、推送或推进 P2。

第三轮独立复验：类型检查、12 个测试、原 6 个场景及第二轮 3 个场景全部通过，R01～R03 已通过。新增 SQL 字符串常量探针发现 R04 的规范化仍把 `'CHAT_MODEL'`、`'chat_model '`、`'chat_(model)'` 错当成 `'chat_model'`，错误索引被接纳；P1 仍未通过。最新证据和修正要求见[172 第 10 节](172-p1-independent-review.md)，本轮未修改生产实现、提交或推进 P2。

第三轮修正与实现方复验：按 172 第 10.2 节把 SQL 规范化改为引号内文本及边界原样保留，仅规范化引号外语法；新增字符串常量回归测试。类型检查退出码 0，13 个测试全部通过（运行编号 `p1-r04-literal-round3-20261103T182447`），字符串常量探针 4/4、原 6 场景 6/6、第二轮 3 场景 3/3 均 `contractPassed`（报告 runId `p1-literal-review-1793701478091-7de11acd`、`p1-independent-1793701497017-684be66a`、`p1-recheck-1793701497459-89009a51`）。该结果仍为实现方自验，待独立复验；未提交、推送或推进 P2，详见[172 第 11 节](172-p1-independent-review.md)。

最终独立复验：本轮重新执行类型检查、13 个测试和三组共 13 个场景，全部通过；R04 的引号内字符串值及边界保持不变，正常控制场景与无效常量拒绝均验证通过，R01～R04 全部关闭。具体命令、执行者、时间、报告文件和源码摘要见[172 第 12 节](172-p1-independent-review.md)。P1 完成；本轮按用户要求本地提交并交付[173 P2 开发文档](173-p2-memory-agent-development-guide.md)，P2 尚未编码。

## 数据目录调整（2026-11-03）

用户要求运行数据目录以 `data/` 开头。`src/bootstrap/config.ts` 的 `dataRoot` 由 `<appRoot>/.nowadays` 改为 `<appRoot>/data`，三处测试路径同步；[170 契约](170-p1-01-contract.md)和[174 P2-01 契约](174-p2-01-memory-agent-contract.md)已更新。当前工作区没有既有 `.nowadays` 运行数据，不做自动迁移。类型检查退出码 0，13 个测试通过（运行编号 `p1-data-root-20261103T191443`），原复核探针 6/6 `contractPassed`（runId `p1-independent-1793704493214-b5ed2b2e`）。该调整发生在 P1 最终独立复验之后，属于用户明确要求的路径变更，不改变 P1 数据模型；独立复核尚未覆盖这一路径变更。
