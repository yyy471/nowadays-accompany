# EXT-D E2E 首轮证据

日期：2026-10-26。范围：仅记录 `test/agent-plugin-composition.test.ts` 的真实装配测试，不代表 EXT-D 放行。测试使用真实 Core、FakeChannel、FakeProviderAdapter 与实际插件 Worker；manifest、角色卡、账号 profile 和 Worker 门控文件均在隔离临时目录。未连接真实 QQ、网络或付费模型。

## 覆盖

- 角色卡、世界书、普通 Skill、插件 Skill、手工事实记忆与带来源插件补充数据共同进入真实模型请求；补充数据不进 system，工具调用/结果按 `call_1` 配对，恶意指令样文本只留在 tool 消息，普通历史不记录补充数据和工具协议，含补充数据的轮次不生成 MEM03 候选。
- 无工具能力模型仍执行 hooks；旧 `onMessage` 导出不产生回复。纯文本且 hook 无 addition 时保留 MEM03 候选路径。
- before hook 抛错及超时后的普通回复、依赖失败插件的 Skill/tool 排除；真实 Instance 的 sent/failed/suppressed afterTurn 持久状态；物理发送成功但历史写入失败仍报告 sent。
- Provider 调用超过 2 秒时 before/after hooks 各自仍在 500ms 界内；同一会话不同 messageId 复用服务端 `call_1` 可分别执行，同 messageId 重投不重复执行；同 r1 版本仅更新 profile config 后新 Worker 使用新 addition。
- 相关私聊撤权、角色变更和记忆变更的门控检查；无关 group 和其他账号 scope 变化；生成媒体期间撤权；Worker 关闭排空与迟到状态检查。

## 验证结果

命令：`npx vitest run test/agent-plugin-composition.test.ts`

首次沙箱运行在 Vitest 收集测试前因 Windows `EPERM` 解析 `node_modules/vitest/dist/spy.js` 退出。以同一单文件命令在获批的沙箱外重试后，20 项中 18 项通过、2 项失败：

| 用例 | 结果 | 观察 |
| --- | --- | --- |
| beforeContext 等待期间撤销对应私聊插件开关 | 首轮失败；修复后通过 | 初次复测仍发起 1 次 Provider 请求。EXT-D 修复了 before hook 返回后的有效策略/config digest 检查，当前测试确认旧轮未进入 Provider。 |
| Worker 挂起时关闭 Core | 首轮失败；修复后通过 | 初次复测发现 Core stop 返回后迟到创建 hook 完成标记。EXT-D 修复关闭路径对 Worker terminate promise 的等待；当前测试确认 stop 后放开门控不会完成 hook 或写入状态。 |

修复后命令 `npx vitest run test/agent-plugin-composition.test.ts`：**1 文件、20 项全部通过**，总测试时间约 6.4 秒。两项原失败断言均保留，没有放宽。未运行全量测试或构建；全量/build 的最终验证由主进程负责。
