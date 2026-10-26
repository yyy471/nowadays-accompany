# EXT-A～C 复核修复执行记录

日期：2026-10-26。依据[79执行方案](79-agent-extension-execution-plan.md)、[80验收标准](80-agent-extension-acceptance.md)和[84独立复核](84-ext-a-c-independent-review.md)。用户明确采用单一插件协议，本轮不做旧插件兼容，不实施EXT-D Agent大循环。

FIX1～5及复核追加的执行授权边界已完成代码与正式回归。定向、类型检查、桌面构建通过。最终全量和独立验收由主进程运行，本记录不代替其结论。

## 实现摘要

- **FIX1 初始化截止：**宿主截止覆盖插件导入、init和握手；stop可打断未完成的start。账号runtime关闭时立即停止manager，不等待sync链结束。阻塞初始化期间关闭和健康插件继续启动均有回归。
- **FIX2 内部超时：**Worker以结构化 `plugin_handler_timeout` 标记并abort handler；宿主终止该代际，拒绝后续任务、丢弃晚状态。队列等待计入绝对deadline。无法确认的action记为 `unknown`。
- **FIX3 signal/guard：**signal、deadline及guard贯通执行器、插件队列、RPC和状态提交。handler guard重跑完整 `ToolExecutor.#gate()`，检查当前工具、`ToolView.authorized`、handler代际、角色guard和取消状态。postMessage前及原子rename前重验；排队授权撤销动作0次。action已派发后被撤权、超时或代际终止时返回 `unknown`、不带jobId、不写晚状态；账本保留unknown。`submitted` 状态提交被撤权时也改为unknown。
- **FIX4 作用域：**运行时与目录/工具解析共用 `resolvePluginSwitch`，插件默认off，遵循账号默认→kind→会话的inherit/on/off软覆盖。账号defaults的off可被更具体的on覆盖；未安装、profile停用或sync移除的插件不能被细scope恢复。
- **FIX5 epoch/状态：**协议、插件状态与工具账本统一使用opaque角色 `contextEpoch: string`，缺失即拒绝。状态文件名使用epoch摘要。会话信封校验kind/peer/epoch；账号共享信封明确标记共享语义并按账号复用。状态写队列与atomic rename都重验guard。

关联签名：`PluginToolInput` 增加可选 `signal?: AbortSignal`、`guard?: () => boolean | Promise<boolean>`、`deadlineAt?: number`；`ToolHandlerContext.guard`执行完整准入重验；`PluginStateService.write(scope, stateVersion, value, at?, { guard? })`在排队和最终提交前检查授权。

## 验证

| 检查 | 结果 |
| --- | --- |
| EXT-A/B/C定向回归 | 3个文件78/78通过：`extension-runtime` 37、`extension-policy` 15、`tool-executor` 26。 |
| `npm run typecheck` | 通过，退出码0。 |
| `npm run desktop:build` | 通过，含renderer及desktop main/preload；未打包或替换EXE。sandbox内Vite曾遇Windows `EPERM realpath`，授权后重跑成功。 |
| `git diff --check` | 本文写入后执行。 |
| 既有记忆用例单文件复跑 | 全量曾超时的 `memory-extraction-provider-policy.test.ts > R2: extraction uses one primary attempt without fallback and enters cooldown`：1/1通过；`memory-extraction-runtime.test.ts > R1: long messages do not block admission; each trigger processes a bounded prefix`：8/8通过，含R1。 |
| 主进程最终全量 `npm test` | 105/106文件通过，1000项通过、1项跳过、1项失败。唯一失败为 `test/memory-extraction-runtime.test.ts > E2E: delete pauses extraction and re-activation only processes messages after the new boundary`；`waitFor` 在该测试405行报 `condition not met in time`。EXT runtime 37项全通过。 |

保留全量失败证据：早期一次为104/106文件通过、998项通过、1项跳过；其中一个EXT内部超时用例在旧测试期限下失败，已修正测试期限并由后续定向验证通过；另一失败是memory provider-policy R2等待超时。之后两次全量均为105/106文件通过、999项通过、1项跳过；唯一失败均为memory runtime R1：`test/phase1-helpers.ts:173` 的 `waitFor` 抛 `condition not met in time`，调用点在 `test/memory-extraction-runtime.test.ts:502`。最新主进程全量仍有一个记忆链路失败，具体为上表E2E用例在405行等待超时。R2与R1单文件复跑通过；没有修改记忆代码，也不将失败归因于机器负载。主进程报告其独立反向脚本中的本轮5项及追加授权边界均通过；最终范围结论以主进程记录为准。

本轮未运行真实QQ/付费服务，未接入EXT-D；未提交、未打包、未替换EXE。
