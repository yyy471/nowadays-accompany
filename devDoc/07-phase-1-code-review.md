# 第一阶段代码复核报告

日期：2026-10-22

> 后续：R1-R7 已按本报告修复并补回归，见 `08-phase-1-review-fixes.md`；本报告保留复核时的原始结论与复现口径。

复核对象：当前工作区 0.2.0 源码，对照 03 优化方案、04 验收标准和 06 实施报告。当前源码均显示为 Git 未跟踪文件，无法基于已提交版本生成可靠增量 diff；本次按当前实现与既定契约审查。

## 1. 结论

暂不通过第一阶段验收。架构模块和主要流程已建立，但发现 7 项可复现问题，其中 4 项 P1，涉及授权撤销、付费请求重复、任务去重及配置丢更新。修复并补回归测试后，还需补齐真实环境验收与缺失的同账号跨会话测试。

本次不修改业务源码。新增本报告及 `test/diagnostics/phase1-review-repro.mts` 作为复核证据；构建会刷新派生产物。

## 2. 实际验证

| 项目 | 结果 |
| --- | --- |
| npm run typecheck | 通过 |
| npm test | 28 个文件、159 项通过 |
| npm run desktop:build | 通过：核心、Renderer、Electron 主进程与 preload |
| 定向复核脚本 | 7 项问题均获得可复现输出 |
| 真实 QQ 接入 | 本次未执行 |
| 真实模型 API | 本次未执行 |
| 安装包重新打包/安装/托盘交互 | 本次未执行；不以构建成功代替打包与人工验收 |

沙箱内 Vitest/Vite 的 realpath 与临时文件原子重命名遇到 EPERM；经工具自动审批在沙箱外重跑后，测试、构建和复核脚本成功。这些环境权限错误未作为产品代码缺陷。

复现命令：

```powershell
.\node_modules\.bin\tsx.cmd test/diagnostics/phase1-review-repro.mts
```

脚本使用假适配器、假 HTTP 响应及专用临时目录，不调用真实 QQ 或付费服务。退出码 0 仅表示复现场景执行完毕，不代表验收通过。

## 3. 必须修复的问题

### R1 · P1：授权撤销后，旧能力解析结果仍能发起调用

位置：`src/providers/router.ts` 的 `#executeWithFallback` / `#invoke`；异步调用方在 `src/agent/engine.ts` 的视频与生图任务中捕获 resolution。

触发：先解析允许的 image.generate 路由，再关闭该能力并清空 allowedProviders，随后使用旧 resolution 执行。

复现输出：

```json
{"currentEnabled":false,"called":["primary"]}
```

影响：排队任务可以在管理员撤销授权后继续使用原服务；媒体外发与付费能力不能以创建任务时的快照作为永久授权。

建议：允许保留目标模型快照，但在真正提交、每次重试和 fallback 前，用当前策略重新检查账号授权、能力开关与外发许可；配置撤销应取消或作废相关排队任务。执行后交付也应检查相应能力当前是否允许。避免仅通过重载宿主解决，因为任务绑定的是会话 signal，宿主重载不等于取消任务。

回归：用屏障让任务排队，撤销权限后释放；断言没有新增 HTTP 请求、没有图片/视频外发或发送。覆盖同服务授权撤销、能力关闭和云端上传许可撤销。

关联：POL-01/02/04、API-10、CON-08。

### R2 · P1：生图提交结果未知时仍自动 fallback

位置：`src/providers/router.ts` 的 `#executeWithFallback`，尤其非 retryable 错误后的 `continue`。

触发：主模型已经接单，但适配器抛出 `provider_generate_unknown`，且配置备用模型。

复现输出：

```json
{"called":["primary","backup"]}
```

影响：主模型可能仍在生成，系统又发起第二份生成请求，可能重复计费。`retryable:false` 只阻止同目标重试，没有阻止切换备用目标。

建议：按副作用结果分类，而非仅用 retryable。对于 generate_unknown、submit_unknown、job_unknown 等不确定状态停止整个自动执行链；只有明确未接受的失败才能按策略重试/回退。视频轮询失败不能自动从头重新提交已接受任务。

回归：主目标返回未知结果时，备用目标调用次数为 0，任务保留 unknown/interrupted 语义；明确拒绝且允许回退的场景另行验证。

关联：API-12、MED-06/07。

### R3 · P1：并发提交同一 actionId 会创建两个任务

位置：`src/jobs/service.ts` 的 `submit`：去重与容量检查在 await store.put 之前，任务注册在 await 之后。

触发：`Promise.all([submit(input), submit(input)])`，两份 input 的账号和 actionId 相同。

复现输出：

```json
{"duplicates":[false,false],"jobIds":["job-...1","job-...2"]}
```

影响：两次检查均未发现已有动作，分别落盘并执行，付费请求可能重复。同一临界区中的队列上限检查也可被并发提交穿透。

建议：将账号级去重、容量预留、持久化与注册作为原子操作，或维护立即生效的 in-flight action 索引并正确处理落盘失败；持久化层对 accountId + actionId 建立唯一约束/等价保障。不能只串行 store 的写文件操作。

回归：并发提交 20 次同动作，只有一个任务/执行，其余返回同一任务且 duplicate=true；并发不同动作也不越过账号/全局容量。

关联：MED-07、CON-05。

### R4 · P1：并发配置保存会丢失其他账号的修改

位置：`src/providers/config-store.ts` 的 upsertProvider、setAccountPolicy 等方法与 `#commit`。

触发：两个调用先基于同一 snapshot 形成 next，再分别进入文件写队列。写队列只保护落盘，不保护读取、修改和提交全过程。

复现：同时设置账号 20001、20002 的策略，最终输出：

```json
{"has20001":false,"has20002":true}
```

影响：两次 API 均返回成功，但后一份快照覆盖前一份修改；可能丢失账号策略、服务或授权变更。

建议：在统一更新队列内执行读取最新配置 → 应用 mutation → 校验 → 原子持久化 → 更新内存；或使用带 revision 的 CAS 并返回冲突。不要把已算好的全量 next 送进仅文件串行的提交队列。

回归：并发保存不同账号/不同服务，所有独立修改在内存和重载后的配置均保留；同字段冲突采用明确策略。

关联：UX-03/06/07、隔离与配置一致性要求。

### R5 · P2：从 Agent 切到插件回复模式后仍由 Agent 回复

位置：`src/core/core.ts:960` 附近的 `#reloadAgents`。

触发：账号已有插件，当前 replyMode=agent，保存 replyMode=plugins。此时按新模式判断命中 continue，跳过宿主切换。

复现输出：

```json
{"configuredMode":"plugins","reply":[{"type":"text","data":{"text":"agent reply"}}],"instanceAgent":{"mode":"agent","configured":true}}
```

影响：界面/配置与实际行为不一致，模式切换要等其他重载或重启才可能生效。

建议：比较当前与目标宿主类型，模式发生变化时执行原子替换；只在当前宿主确实无需刷新时跳过。覆盖 agent → plugins、plugins → agent、auto 的双向迁移。

回归：同一在线实例不重启保存模式后，下一条消息只由目标回复者处理，旧回复者不再推进状态或调用模型。

关联：POL-07、UX-03。

### R6 · P2：媒体下载超时仅覆盖响应头，未覆盖正文

位置：`src/media/service.ts:279` 附近。

触发：fetch 很快返回响应头，正文缓慢发送或永久不结束。计时器在 fetch 返回后的 finally 中被清除，reader.read 不再受 maxDownloadMs 约束。

复现：下载限额 15 ms，正文延迟约 100 ms，结果仍成功（实测总耗时约 117 ms）。

影响：媒体传输可能长期占住对话或任务；生图输出下载还没有传入 jobContext.signal，用户取消后底层下载也不能随任务立即停止。

建议：超时覆盖完整正文读取与重定向全过程，finally 放在完整下载外层；错误时取消 reader/释放响应。ingestGenerated 接收任务 signal 并传播至下载与写入前检查。

回归：及时返回响应头但不结束正文的假服务必须在限额内中止；生成输出下载期间取消不得继续读取、落盘或发送结果。

关联：MED-01、CON-08、API-13。

### R7 · P2：Skill 只有全局定义，缺少账号独立启用与私有覆盖

位置：`src/extensions/registry.ts` 的 SkillRuntime.resolve、`src/providers/types.ts` 的 Skill/AccountPolicy 模型。

触发：注册不依赖工具和能力的普通说明型 Skill，分别解析两个账号。

复现输出：

```json
[{"id":"10001","skills":["personal"]},{"id":"10002","skills":["personal"]}]
```

影响：目前只能通过全局 enabled、kind、peer 过滤，无法实现用户要求的“同一份公用 Skill 由账号 A 启用、B 禁用”；peer 相同也不能区分账号。公用定义被直接当成全部账号的运行启用集，定制说明可能进入非预期账号上下文。

建议：分开公用定义和账号引用/启用集，加入 source/id/revision 与账号私有配置；在此基础上再叠加私聊/群聊/具体会话过滤。已有配置迁移时明确默认继承行为，不能默默改变全部账号提示词。

回归：同一公用 Skill，A 启用、B 禁用；相同 peerId 下仍分开；私有同 id 可明确引用；不可用原因在 effective DTO 与实际上下文一致。

关联：第一阶段目标“每实例独立插件/Skill”、POL-05/06、ISO-07/08。

## 4. 验收证据的缺口

以下独立于上述代码问题：

1. `test/phase1-concurrency.test.ts` 的慢插件/现代 Agent 和挂起 chat 测试使用两个账号。CON-02/07 要求的同账号跨会话路径不能用此替代；应补单账号不同 peerId 的屏障测试。
2. 06 报告本身列出 CON-06、POL-04 未覆盖，CON-01/03/04、POL-01 部分通过，因此“A/I 全部完成”表述不成立。完成主链路可以保留，但应按验收清单逐项记录缺口。
3. 当前 video-polling-v1 定义了自有 POST/GET/DELETE 协议，仅假服务通过不证明兼容某个真实厂商。真实视频供应商/本地桥接需选定并实际验证。
4. ISO-09、API-14/15 及相关 M 级人工验收仍无实际证据；本次没有补做，不得标记通过。
5. 非终态任务启动后统一 interrupted，没有持久远端任务 ID 并恢复查询的实现证据；可查询远端任务恢复能力需要继续补齐，或先正式缩小验收范围，不能称为已经恢复查询。

## 5. 建议修复顺序

1. R1、R2：先封住授权撤销和未知副作用的自动再次提交。
2. R3、R4：补原子去重、容量预留、配置更新临界区。
3. R5、R6、R7：修复在线模式切换、完整下载取消与账号 Skill 选择。
4. 为每项新增反例回归测试，再补同账号并发、插件禁用和实际能力分发测试。
5. 修订 06 验收报告，安排真实双 QQ 与真实四能力接入。全部必选项完成后再进入下一阶段。

上述为复核发现与建议，未自动修复业务代码。
