# EXT-E/F 修复独立复验

日期：2026-10-27。依据：[93 复核要求](93-ext-e-f-independent-review.md)、[94 修复记录](94-ext-ef-review-fixes.md)。本轮只复核并补充记录，未修改生产或正式测试代码，未提交、推送或打包。

## 结论

原 R1（P1）与 R2（P2）已通过独立复验；原 R3 的首个测试已改为等待持久化事件，但新增门控测试的异步等待实现仍有遗漏，不能标记完全关闭。另一次独立全量暴露既有插件超时测试的错误码竞争，需补充处理。

当前未发现新增 P0/P1；仍有 2 项 P2 测试可靠性问题。生产侧 EXT-F 核心修复可认可，但本轮验收尚不能声明完整全绿。94 的“R1–R3 全部关闭、全量通过”只代表作者当次结果，不替代以下独立证据。

## 已关闭项

### R1：实际 Skill 请求预算

`engine.ts` 的尾部回退已经不再依赖 `toolsCouldBeOffered`；没有工具时同样按最终序列化大小检查 Skill，工具开销只影响预留量。只要曾选出 Skill，后续历史也进入 JSON 实际开销裁剪路径。

主进程复用 93 的同一真实 Core/Provider 探针，通过正常保存接口写入 8000 个双引号的合法 Skill，再发送短消息。配置仍是无工具支持模型、12000 上限，实际请求由原来的 **16299 降到 254 字符**，工具数为 0。

正式 `agent-tool-loop` 新增回归还覆盖支持 tools 但无工具授权、转义混合正文、13000 字原始输入仍完整保留。该文件本轮 23 项定向通过。

### R2：可用与标准选择状态

`SkillStatus` 增加 `selected`、`selectionReason`，Core 的转换现在保留这两个字段。9 项短 Skill 仍可以同时保持 scope available，但只有 8 项 selected，第 9 项明确标记 `skill_limit`；累计预算排除也通过 HTTP 回归提供 `instructions_budget`。

独立探针已按 93 允许的修复方案调整断言：不再要求 available 必须减到 8，而是检查 available=9、selected=8、排除原因保留。独立探针与 HTTP 的 6 项正式回归均通过。页面在 EXT-G 中仍需正确消费这些状态，不能把 available 当成具体轮次已注入。

## 待修 95-R3 / P2：异步条件没有真正被等待

位置：[host.test.ts:24](../test/host.test.ts#L24)、[host.test.ts:27](../test/host.test.ts#L27)。

本轮把辅助函数的参数类型拓宽成 `() => boolean | Promise<boolean>`，但循环仍写成：

```ts
if (predicate()) return;
```

新增门控用例释放 append 后调用 `waitFor(async () => ...)`。Promise 对象始终为 truthy，辅助函数会在条件尚为 false 时直接结束，后续文件断言仍依赖偶然的 I/O 排序。

主进程复制当前测试辅助函数到忽略目录，对真实函数运行受控反向探针：异步条件保持 false，等待一个 event-loop turn 后检查是否已结算。实际结果：

```json
{"ready":false,"settled":true,"checks":1}
```

这与预期的“ready=false 时不得完成”等待相反，属于确定性复现。原首个测试使用同步谓词并等待 `channel:outbound.seq` 的修复有效；问题只在新增异步等待分支，但会使 R3 的完整关闭证据不可靠。

修复要求：在循环中使用 `if (await predicate()) return;`，或复用项目已有正确支持异步条件的测试辅助函数。保留“未落盘时只有 in、释放后读到 in/out”的断言；不要删掉 async 断言或增加固定 sleep。另加对 wait helper 的门控反向检查，证明异步 false 不会提前返回。

## 待修 95-R4 / P2：超时用例依赖计时器胜出顺序

位置：[extension-runtime.test.ts:855](../test/extension-runtime.test.ts#L855)。这是既有用例，本轮未修改该文件。

独立全量实际失败为：

```text
expected reason: plugin_timeout
received reason: plugin_handler_timeout
```

宿主绝对 deadline 和 Worker 内部 handler deadline 都受 500ms 上限约束。宿主路径返回 `plugin_timeout`；Worker 先返回超时响应时，`PluginWorkerManager.#beforeContext` 明确返回 `plugin_handler_timeout`。响应接收路径同样终止该 Worker 代际。因此不能仅因为两条合法超时路径胜出顺序不同，就判定超时边界失效。

本轮读取代码未发现此差异绕过代际终止或允许晚状态写入；6 文件定向中该用例又通过，符合竞争断言而非确定性超时功能失败的特征。仍保留全量失败，不能将后续定向通过用作删除现场的理由。

修复要求：明确错误码契约。若保留宿主/Worker 两种原因，通用预算测试应接受两者，并保留 elapsed、Worker 已终止、晚状态不提交、before/after 共享总预算等行为断言；需要精确错误码时分别构造受控路径。也可在公开钩子边界统一原因码，但须保留内部诊断，不宜仅为测试变绿改写行为。

## 本轮主进程运行证据

| 验证 | 实际结果 | 输出位置 |
| --- | --- | --- |
| 独立全量 `npm test` | 113 文件中 112 通过、1 失败；1076 项通过、1 失败、1 既有跳过；失败为 95-R4 | `test-results/ext-ef-recheck-parent-initial.log` |
| 6 文件定向 | 92/92 通过，包括 Skill service/API、工具循环、媒体、host、插件运行时 | `test-results/review95/targeted.log` |
| 原 Skill 失败探针与过期复制 CAS 对照 | 3/3 通过：R1 请求有界、R2 选择状态保留、私有过期 revision 拒绝 | `test-results/review95/probes.log` |
| 当前 host wait helper 反向探针 | 1 个确定性失败，见 95-R3 | 同上 |
| `npm run typecheck` | 通过，包含测试与 renderer | `test-results/review95/typecheck.log` |
| `npm run desktop:build` | Core、renderer、main/preload 构建通过 | `test-results/review95/build.log` |
| 空白检查 | 已跟踪 diff 检查通过；另逐个读取 11 个未跟踪文本文件，未发现尾随空白或多余 EOF 空行 | 工具输出 |

探针输出中的 skip 是 `-t` 过滤复制 fixture 的其他测试，未修改项目 skip；全量仍只有原有 1 项跳过。

## 后续收口

先补齐 95-R3 的 await，再修正 95-R4 的超时契约/竞争断言，然后复跑定向与全量。原 R1/R2 无需重做架构；也不应为修测试而降低预算、撤权、持久化或晚状态拒绝的标准。保留 93、94 与本次原始结果，最终全量通过后再更新整体放行状态。
