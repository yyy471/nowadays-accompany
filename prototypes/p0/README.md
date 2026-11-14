# P0 技术小样

本目录是[后端开发文档 165](../../devDoc/archive/01-backend-prototype/165-backend-development-guide.md) 对应的 P0 可运行小样，验证“离线模型 → 工具调用 → 结果先保存 → 暂停/重启恢复 → 正式提交”的最小链路。

它只覆盖 P0，不是 P1 的正式角色管理、P2 的完整记忆/Agent 回复或正式 HTTP API。

## 运行环境

- Node.js 22 或 24；本次证据使用 **Node 24.22.2 / win32-x64**。
- 不要使用 Node 20：`better-sqlite3@12.10.0` 没有 Node 20（ABI 115）的 Windows 预编译包，安装会回退到本地编译并因缺少 Visual Studio 失败。
- 依赖版本见 `package.json` 和 `package-lock.json`。

## 安装与运行

在 `prototypes/p0` 目录下：

```bash
npm install
npm run typecheck
npm run p0:all
```

`p0:all` 会依次运行 P0-01 和 P0-C01～C10，每个用例在独立进程中执行；每次运行生成 `runId` 并写入各用例报告，汇总会校验报告归属。全部通过时退出码为 0，汇总写入 `data/p0-summary.json`。同一时刻只运行一个 `p0:all`；并发运行会互相清理固定用例目录，报告归属不符会判失败，但不会得到假通过。

单独运行某个用例：

```bash
npm run p0-01
npx tsx src/cases/c01.ts
npx tsx src/cases/c02.ts
# ...
```

如果 PATH 中的 `node` 不是 22/24，请显式使用对应版本的 Node 执行上述命令，或把该版本的目录放到 PATH 最前面。

本次证据使用工作区内的临时 Node 24：

```bash
PATH="$PWD/.runtime/node-v24.22.2-win-x64:$PATH" \
  ./.runtime/node-v24.22.2-win-x64/node.exe \
  ./.runtime/node-v24.22.2-win-x64/node_modules/npm/bin/npm-cli.js install
```

`.runtime/` 不提交。

## 数据与证据位置

运行数据全部在 `data/` 下，按用例分开，已被 `.gitignore` 忽略：

```text
data/<case>/
  role.sqlite          # 业务库：角色、消息、执行、任务、调用、结果、决策
  execution.sqlite     # LangGraph 检查点库
  workspace/           # MCP 样例工具的实际文件效果
  report.json          # 该用例的检查项、事件、runId 与数据库快照
data/p0-summary.json   # 整套用例汇总（runId、各报告归属与结论）
```

不要提交数据库、日志或运行数据。`report.json` 中的数据库快照用于复核，不是正式 P1 数据模型；报告的 `runId` 必须与本次 `p0-summary.json` 一致。

## 用例

| 用例 | 验证点 | 报告 |
| --- | --- | --- |
| P0-01 | 业务 SQLite、LangGraph 检查点、stdio MCP 三组件基本调用；MCP 结果适配接受 JSON 文本、普通文本、structuredContent 和原始内容 | `data/p0-01/report.json` |
| P0-C01 | 正常执行：工具调用、结果保存、回复与状态提交 | `data/c01/report.json` |
| P0-C02 | 工具结果保存后暂停，同次执行恢复，工具不重跑 | `data/c02/report.json` |
| P0-C03 | 暂停进程被强杀后，新进程用原执行编号恢复，工具不重跑 | `data/c03/report.json` |
| P0-C04 | 新消息切换：旧部分回复保留为 interrupted，迟到输出隔离，已发工具不重发 | `data/c04/report.json` |
| P0-C05 | 暂停期间修改角色设定/状态，恢复后的判断读取最新值，旧快照不回退 | `data/c05/report.json` |
| P0-C06 | 工具效果已发生但响应丢失：可核查则补成功，不可核查则保留 unknown，不重做 | `data/c06-verify/report.json`、`data/c06-unverifiable/report.json` |
| P0-C07 | 正式回复与状态提交失败：事务回滚，不报告完成，已有工具结果保留 | `data/c07/report.json` |
| P0-C08（补充） | 越界路径触发 MCP 明确错误，记录为 failed 并区别于 unknown | `data/c08/report.json` |
| P0-C09（复核补充） | 调用已登记为 running 但没有已保存结果：恢复按 unknown 核查，不重发，工具效果为 0 | `data/c09/report.json` |
| P0-C10（复核补充） | 工具已登记但检查点未落：重入按 `step_key` 复用同一调用，工具只执行一次 | `data/c10/report.json` |

## 小样结构

```text
src/
  config.ts              # 数据目录
  domain/                # 状态、事件、错误类型
  storage/business.ts    # 业务 SQLite 与事务提交
  graph/build.ts         # LangGraph 节点与路由
  model/scripts.ts       # 可控离线模型脚本
  mcp/server.ts          # 本地 stdio MCP 样例工具
  mcp/client.ts          # MCP 客户端
  mcp/executor.ts        # 超时、未知结果与重试边界
  cases/                 # 用例控制器、子进程 runner、报告归属校验、汇总
  smoke/p0-01.ts         # 三组件冒烟与 MCP 结果适配验证
  smoke/probe-interrupt.ts # interrupt()/Command(resume) 独立探针
reviews/                 # 复核探针（原 5 场景、强杀恢复、L01 报告归属）
```

### 关键约束

- 工具调用先登记，真实 MCP 执行后结果先写入业务库，再回到图。
- 正式回复、角色局部状态和本轮完成标记在同一个业务库事务中提交；提交成功后才发出 `completed` 事件。
- 业务库与检查点库分文件；检查点只保存图进度，不作为角色长期历史。
- 执行编号就是 LangGraph 的 `thread_id`；同次恢复沿用，新决策新建。
- 工具调用按 `(execution_id, step_key)` 幂等登记；重入复用同一调用，不重复登记或执行。
- 模型节点每次决策前从业务库重新读取最新角色资料、状态与工具结果，恢复时不沿用旧上下文。
- 执行已不是 running（如被新消息替代）时，旧决策不得再登记或派发新工具。
- 暂停点使用 `interrupt()`；恢复使用 `Command({ resume })`，前置节点不会重跑。
- 离线模型是脚本化的 `ChatModelPort`，不调用付费模型；真实模型适配留到 P2。
- MCP 样例只操作本用例 `workspace/` 下的文件，路径越界会被拒绝。
- MCP 明确错误归 failed；响应超时或调用发出后的连接中断归 unknown，先核查再决定是否补记。
- 已应答且 `isError=false` 时，JSON 文本解析后作为结果；普通文本、`structuredContent` 或原始内容也按成功应答保存，不因缺少 JSON 文本判为工具失败。
- `executions.state_version_loaded` 记录最近一次上下文加载看到的角色版本；`state_version_committed` 记录正式提交产生的版本，completed 重入返回后者。

## 已知限制

- 没有 HTTP/API/SSE 层；P0 只验证执行基础，CLI/API 契约留到 P1/P2。
- 没有正式的角色管理、多角色、记忆、Skill、预算或调度器；这些属于后续阶段。
- 离线模型是确定性脚本，不代表真实模型的流式、工具调用格式或服务兼容性。
- `append_note_then_hang` 是测试样例，用于模拟“效果已发生但响应丢失”，不是生产工具。
- C06 的核查器是样例专用；真实工具是否可核查取决于工具本身。
- 执行状态和暂停/恢复由小样控制器驱动，不是正式调度器；C09/C10 以节点故障注入覆盖重入边界，独立复验另补了 4 个真实进程强杀窗口并通过，见 167；P4 仍需验证正式实现的组合恢复。
- MCP 工具返回的明确错误归 failed，响应超时及已发出调用后的连接中断归 unknown；连接建立阶段的失败归 failed，不进入 unknown 核查。具体分类见 `devDoc/166` 的“MCP 结果与错误分类”。
- 报告以 `runId` 校验归属；同一时刻只运行一个 `p0:all` 是当前约定。报告缺失、不可解析、归属不符或运行前清理失败时，该用例判失败而不是沿用旧报告。
- `step_key` 当前按每轮单一工具请求设计；任务与执行仍为 1:1，也没有前台／后台模式字段。多调用步骤身份、任务一对多及前后台承载按 P1 数据契约定清。
- `paused` 被新消息取代的基础场景由 168 的针对性探针覆盖，未进入 `p0:all`；正式调度、检查点保留策略及派发接纳边界留 P4。
- C08／C09／C10 是补充用例，不改变 165 第 5 节 C01～C07 的必需范围。
- C07 只验证正式提交的事务原子性；流式文本在提交失败时没有落为 interrupted 消息，完整的 DL-78 部分输出持久化由 C04 路径覆盖，正式实现仍需在后续阶段统一。
- Windows 下强杀进程后立即重开 SQLite 可能出现短暂的 `SQLITE_IOERR_TRUNCATE`，C03 通过“暂停子进程自报检查点数 + 恢复后重试打开”处理；这是文件句柄释放时序，不是业务重试逻辑。
- 依赖 `better-sqlite3` 原生二进制；Electron ABI、打包与跨平台预编译仍未验证。

## 证据

实现方自验记录见 [devDoc/166](../../devDoc/archive/01-backend-prototype/166-p0-implementation-record.md)。[独立复核记录](../../devDoc/archive/01-backend-prototype/167-p0-independent-review.md)保留首轮发现的 4 类问题和修正后通过证据：独立重跑类型检查、`p0:all` 的 37 项检查及原复核探针 5 个场景全部通过，新增真实强杀恢复 4 个场景通过。P0-01～P0-05 完成（小样范围），P1 尚未开始。

[168 第 9 节](../../devDoc/archive/01-backend-prototype/168-p0-followup-fix-list.md) 记录 L01、L03、L06 修正后的独立复核：类型检查、38 项回归、原探针 5 个场景、真实强杀 4 个场景、L01 报告归属 6 项及专项 2 项全部通过。新增 `reviews/20261103-followup-review.ts` 验证清理失败与版本保持；P1 开发准备见[169](../../devDoc/archive/01-backend-prototype/169-p1-role-storage-development-guide.md)。

原复核探针 `reviews/20261103-review.ts` 以输出的 `contractPassed` 判定契约，退出码 0 仅表示采集结束。真实强杀探针为 `reviews/20261103-crash-review.ts`，失败时断言退出非零；运行命令及产物位置见 167。L01 报告归属探针为 `reviews/20261103-l01-report.ts`，覆盖报告缺失、归属不符、无 runId、不可解析及清理删除；报告写入 `test-results/l01-report-ownership/`。
