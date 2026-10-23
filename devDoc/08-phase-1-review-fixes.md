# 第一阶段复核问题修复报告

日期：2026-10-22
对象：`devDoc/07-phase-1-code-review.md` 的 R1-R7。
验证：`npm run typecheck` 通过；`npx vitest run` 29 个文件、173 项通过；`tsx test/diagnostics/phase1-review-repro.mts` 输出与修复后预期一致。

## 1. 修复明细

| 编号 | 修复 | 回归证据 |
|---|---|---|
| R1 | `ProviderRouter` 在每次提交、重试与 fallback 前，用当前配置和策略重新检查能力开关、provider 授权、模型/适配器、云端上传与 direct vision；Agent 交付生图/视频结果前再次检查能力；策略或 provider 撤销后取消该账号非终态任务。 | 旧 resolution 在关闭能力、撤销 provider、撤销云端上传后均被拒绝且适配器未调用；重试前复核会在第二次请求前拦截；排队任务在撤销后被取消，未再调用 provider，也未发送图片。 |
| R2 | 将 `provider_generate_unknown`、`provider_submit_unknown`、`provider_job_unknown` 视为不确定副作用，重试与跨目标 fallback 全部停止。 | 主模型返回 unknown 时，备用模型调用次数为 0；生图与视频轮询各一条。 |
| R3 | `MediaJobService.submit` 的 actionId 去重、账号/全局容量检查、落盘与内存注册进入同一串行临界区；关机等待提交队列。 | 20 路并发同 actionId 只产生一个任务、一次执行；账号容量 1 与全局容量 1 下并发提交只接受一个。 |
| R4 | `ConfigStore` 的所有 mutation 走统一更新队列，在队列内读取最新快照、应用修改、校验、原子落盘并更新内存；`replace`/`restoreBackup` 同样入队。 | 并发保存 20001/20002 策略与两个 provider 后，内存和重新加载的文件都保留全部修改。 |
| R5 | `#reloadAgents` 仅在当前宿主已是 plugins 时跳过；模式变化时重新装载宿主。 | 在线从 agent 切到 plugins 后 `hostEpoch` 递增、下一条只由插件回复，Agent 未再调用。 |
| R6 | 下载超时改为覆盖重定向、响应头与完整正文，读取与 abort 竞速；`ingestGenerated` 接收任务 signal，取消时中止下载、清理未完成媒体，落盘前后检查取消。 | 不结束正文的响应在 25ms 限额附近失败（实测约 26ms），不落盘；生成下载取消后媒体列表为空。 |
| R7 | 账号策略新增 `skills.enabled`、`skills.disabled`、`skills.definitions`；`SkillRuntime` 按账号合并公用/私有定义并返回 `source`；effective DTO 与 UI 展示来源。未显式配置的账号继续继承公用 Skill。 | 同一公用 Skill 在 10001 用私有定义覆盖、10002 被禁用；相同 peerId 下结果仍按账号分离；实际 Agent prompt 中只有 10001 出现私有说明。 |

## 2. 行为变化

- 授权快照不再被视为长期许可；排队任务在撤销后失败/取消，而不是继续外发或计费。
- 生图结果未知时宁可保留“未知”语义，也不自动切换备用模型重复付费。
- 并发提交同一动作只创建一个任务；不同动作仍受账号与全局队列上限约束。
- 并发配置保存不再丢其他账号/服务的修改。
- 在线切换回复模式立即生效，无需重启。
- Skill 默认继承行为不变；账号禁用/私有覆盖是显式配置。

## 3. 新增测试

`test/phase1-review-fixes.test.ts`（12 项）覆盖 R1-R7 的核心反例；`test/phase1-identity.test.ts` 增加 agent → plugins 在线切换；`test/phase1-concurrency.test.ts` 增加同账号不同会话的并发屏障测试。`test/diagnostics/phase1-review-repro.mts` 已改为输出修复后预期结果。

## 4. 仍未覆盖

- CON-06（同一插件状态并行写）、POL-04（禁用插件后的在途回调）、POL-01（群聊作用域下工具/Hook/直接调用端到端）仍无独立测试。
- ISO-09、API-14、API-15 与 UX-03/04/05 的 M 级真实 QQ/真实模型证据仍未提供。
- 真实视频供应商协议兼容性仍未验证；`video-polling-v1` 只对假服务通过。
- 远端任务 ID 持久化与重启后恢复查询仍未实现，重启后非终态任务按 interrupted 处理。

因此本报告只证明 07 的 R1-R7 已修复，不改变第一阶段整体“未全部验收”的结论。
