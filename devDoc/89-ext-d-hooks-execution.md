# 89 EXT-D D-D 钩子接线与 D-E 端到端执行记录

范围：`devDoc/79-agent-extension-execution-plan.md` 的 EXT-D D-D/D-E，验收依据为 `devDoc/80-agent-extension-acceptance.md`。D-A～D-C 已由 87 号记录完成。本轮使用单一插件标准和 Agent 编排；未访问真实 QQ、未调用付费模型、未提交、未打包或更新 EXE。

## 交付

| 子项 | 状态 | 实际行为 |
| --- | --- | --- |
| D-D：Agent 插件钩子接线 | 已实现 | `beforeContext` 的补充数据带插件身份与来源，被标成不可信数据并追加到非 system 的当前消息；hook 失败时该插件本轮的工具、Skill 和补充数据退出，文字回复继续。含插件数据的轮次不会标记为 MEM03 用户事实候选。 |
| D-D：真实 `afterTurn` 结果 | 已实现 | `Instance` 在最终发送边界报告 sent、suppressed 或 failed。物理发送成功但历史写入失败仍报告 sent；重复发送、撤权和失效作用域报告 suppressed；通道发送失败报告 failed。旧轮快照失效时不会将旧结果通知给新插件代际。 |
| D-D：hook 预算和晚到结果 | 已实现 | 单个 hook 硬上限 500ms，before/after 共用每轮 2s，队列等待计入，模型耗时不计入。排队 hook 超时后出队时会跳过，不终止正在执行的长工具；已派发 hook 超时会结束对应 Worker 代际，关闭等待真实线程终止及 25ms cancel grace，晚结果不写状态。 |
| D-D：快照与策略 guard | 已实现 | 仅以当前账号、kind/peer、参与插件、有效状态授权、工具/Skill/hook 内容、插件 revision/config 摘要及相关 Worker 代际生成扩展快照。角色、世界书和记忆的 history epoch 不因扩展策略变化而改变。自身 hook 故障可从当前轮排除；排除前会重验有效策略，无法用刷新快照掩盖外部撤权。 |
| D-D：关闭及 config 换代 | 已实现 | 插件运行时关闭可打断挂起的 profile 同步；旧 profile 晚到或失败不能关闭新一代 runtime。同 revision 的 config 改动会重建 Worker；profile 已更新但 Worker 尚未同步时，当前有效插件 config 摘要也会立即使旧轮失效。 |
| D-D：媒体幂等与协议预算 | 已实现 | 内置媒体动作使用执行器提供的稳定宿主 invocation key。不同入站消息或模型回合复用 `call_1` 会独立执行；同宿主 key 的重投仍由既有账本幂等。临时工具协议消息按完整序列化请求预算，工具结果全轮累计不超过 24KiB；超过预算的参数或结果不进入无限增长的后续请求。超长原始用户文本保留原有纯文字路径，插件补充和工具续答在无空间时关闭。 |

## 代码与回归

主要实现位于 `src/agent/engine.ts`、`src/agent/context.ts`、`src/host/contract.ts`、`src/instances/instance.ts`、`src/application/extensions/extension-tool-service.ts`、`src/application/extensions/plugin-runtime-service.ts`、`src/extensions/catalog.ts`、`src/extensions/effective.ts`、`src/extensions/runtime/account-runtime.ts` 和 `src/extensions/runtime/plugin-worker.ts`。共享序列化预算裁剪位于 `src/platform/text/truncate.ts`。

正式回归覆盖了插件数据进入真实 Provider 的非 system 消息、角色/世界书/记忆与 Skill 同上下文、hook 抛错或超时后的普通回复、有效与无关作用域变更、三种真实 afterTurn outcome、MEM03 候选、Worker 关闭、同 revision config 换代、不同消息复用相同 provider call id、工具协议与结果预算、超长输入及历史占满后的工具续答。

已取得的自动化证据：

- `npx tsc -p tsconfig.test.json --noEmit`：通过。
- `test/extension-tool-service.test.ts`：1/1 通过，验证 profile config 更新早于 Worker 同步时旧快照立即失效，且无关插件 config 不影响当前快照。
- 主进程运行 `test/extension-runtime.test.ts`：40/40 通过，包含队列中 hook 超时不误杀长工具、500ms 单 hook 上限及 before/after 共享 2s 预算。
- D-E `test/agent-plugin-composition.test.ts`：20/20 通过；撤权门控未发起 Provider，Core 关闭后放开门控也没有迟到 Worker 写入。
- 主进程独立 `review90/hooks.ts` 探针通过：sent/failed/suppressed 状态与持久化一致，来源进入非 system 消息，含补充数据的轮次 MEM03 候选为 0。
- 主进程独立 action id 探针通过：不同入站消息在同一私聊复用 `call_1` 时产生 2 个独立任务；同宿主调用重投仍按原账本幂等。
- 主进程的有界文本与原子写定向回归 13/13 通过；Provider 边界另有 5 项预算用例通过，覆盖中文、引号、反斜线、累计 24KiB、协议拒绝、13,000 字输入和历史填满。

本记录写入时，主进程正在执行最终 9 文件定向复验及全量、构建检查；其结果由主进程最终报告，不在此提前宣称全项目通过。此前全量基线为 1011 项通过、1 项既有跳过。
