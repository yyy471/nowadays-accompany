# EXT-E/F 复验修复记录（95-R3 / 95-R4）

日期：2026-10-27。依据：[95 修复独立复验](95-ext-e-f-fixes-independent-recheck.md)。未提交、未打包、未替换 EXE。

结论：95-R3、95-R4 均已关闭。生产侧只补了一处超时原因契约注释，其余为测试可靠性修复；类型检查、定向 45 项、全量连续两次 113 文件 1078 项通过/1 项既有跳过、桌面构建与空白检查通过。

## 95-R3：异步 wait helper 未真正等待（P2）

**根因**：[host.test.ts](../test/host.test.ts) 的本地 `waitFor` 把参数类型拓宽为 `() => boolean | Promise<boolean>`，循环仍是 `if (predicate()) return;`。`async` 谓词返回的 Promise 恒为真，条件尚未满足就会结束等待，门控用例的后续断言只能依赖 I/O 排序。

**修复**：

- 循环改为 `if (await predicate()) return;`，同步谓词与异步谓词走同一路径。
- 新增辅助函数反向检查：谓词保持 `false`（异步），经过一个 event-loop turn 后断言尚未结算；把条件翻为 true 后才允许完成。没有固定 sleep，也没有删除异步条件或门控断言。
- 原有门控持久化用例保持：append 被门控时发送已完成、无 `channel:outbound` seq、历史只有 `[in]`；释放后才读到 `[in,out]`。

**证据**：`test/host.test.ts` 5/5 通过；全量通过。

## 95-R4：超时原因码依赖计时器胜出顺序（P2）

**根因**：`caps one hook at 500ms...` 用例同时受宿主绝对 deadline 与 Worker 内部 handler deadline 约束。两者都以 500ms 为上限，宿主先到返回 `plugin_timeout`，Worker 先回响应则为 `plugin_handler_timeout`；两条路径都会终止该 Worker 代际并拒绝晚结果。断言精确到单一原因码会随调度顺序偶发失败。

**修复**：

- [plugin-worker.ts](../src/extensions/runtime/plugin-worker.ts) 的 `PluginHookOutcome` 增加契约注释：原因码是诊断信息，两个超时原因共享同一上限时可能竞争；调用方按可观察效果判断，不能依赖单一码。
- 通用预算用例接受 `plugin_timeout` 或 `plugin_handler_timeout`，同时保留全部行为断言：耗时 <650ms、runtime 快照为空（Worker 已终止）、750ms 后没有晚状态落盘、before/after 共享 2s 预算并以 `remainingMs=0` 结束。
- 未为让测试变绿修改超时行为或统一公开码；需要精确原因的路径仍由已有的 Worker handler 超时与宿主 deadline 专项用例覆盖。

**证据**：`test/extension-runtime.test.ts` 40/40 通过；全量通过。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.test.json --noEmit` | 通过 |
| `npx vitest run test/extension-runtime.test.ts test/host.test.ts` | 45/45 通过 |
| `npx vitest run`（第一次） | 113 文件通过；1078 项通过、1 项既有跳过 |
| `npx vitest run`（第二次） | 113 文件通过；1078 项通过、1 项既有跳过 |
| `npm run desktop:build` | Core、renderer、main/preload 构建通过 |
| `git diff --check` | 通过 |

## 边界

- 未运行真实 QQ、付费模型、浏览器交互或发布包验证。
- 超时用例仍依赖真实 500ms 计时；断言已改为行为集合而非胜出顺序，但极端机器负载下耗时上限仍需观察。
- EXT-G 的页面与扩展策略 HTTP 路由仍未实现；`/effective` 的 `selected`/`selectionReason` 需要页面正确消费，不能把 `available` 当作已注入。
