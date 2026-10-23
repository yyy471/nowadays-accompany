# 第一阶段再次复核与当前架构

日期：2026-10-22。范围：修复后的当前工作区代码；未修改业务源码。

后续范围修订：用户已明确无需自动启动 QQ，仅通过应用界面手动触发 SnowLuma 注入与监听。本文“受管 QQ launch”建议由 10-fixes-and-manual-snowluma-integration.md 替代；本报告中的复核事实保留。

## 复核结论

上一轮 R1–R7 的原定向场景均得到修复后预期结果。实际执行：29 个测试文件、173 项测试通过，类型检查通过，desktop:build 通过。已补同账号不同会话的并发屏障测试。

不过，新边界复核发现以下两个可复现问题，因此仍不建议宣称第一阶段完全验收。真实双 QQ、真实四能力 API 接入本次未测试；远端任务 ID 持久化和重启查询仍未完成。

## 新发现

### S1 · P1：校验当前服务配置，但执行的仍是旧服务快照

位置：src/providers/router.ts，#assertStillAuthorized 与 #invoke，以及调用适配器时使用的 target。

复现：先获取云端识图服务的 resolution；把同 id 服务改成本地地址，并撤销云端上传许可；使用旧 resolution 发起调用。

实际输出：当前配置为 http://127.0.0.1:8000/v1，allowCloudUpload=false，但适配器收到的调用地址仍为 https://old-cloud.example.test/v1、location=cloud。

原因：#assertStillAuthorized 验证当前 provider 的位置和能力，#invoke 却继续用旧 target.provider、target.adapter、target.model 和已捕获凭据构造请求。排队任务恰好会长期持有这种快照。

修复建议：服务配置使用 revision/指纹；执行前重新生成与授权校验完全一致的目标和凭据，或拒绝配置已变化的旧目标。不得使用一套配置校验、另一套配置执行。对于已经提交的远端任务，另保留不可变执行身份和专门的取消/查询权限，避免把配置切换当作远端任务迁移。

回归：在端点限流屏障后修改服务地址、location、适配器或凭据，释放屏障；旧调用必须被拒绝或安全重解析，禁止向已撤销云端发媒体。

### S2 · P2：暂停不约束旧插件宿主

位置：src/core/core.ts 的 #createDefaultHost/#reloadAgents；src/host/worker.ts 的 onMessage；src/instances/instance.ts 的消息分发。

复现：账号使用 plugins 模式，调用 patchAgentEnabled(accountId,false)，再收到普通文字消息。

实际输出：configuredAgentEnabled=false，但仍发送 legacy plugin still replies。

原因：暂停检查仅存在于内置 AgentEngine；旧插件路径未经过统一响应策略，也不会因暂停自动切换/停用。

修复建议：在公共消息执行入口和自动发送出口落实暂停、私聊/群聊作用域检查。暂停后仍可接收和保存消息，但不执行自动回复；人工发送另走显式入口。在途插件晚到回包也需检查，不仅阻止新回调。若产品需要“只暂停模型”，应新增独立开关，不能复用现有整体暂停交互而行为不一致。

回归：plugins/agent/custom（明确支持范围内）分别测试账号和会话暂停、恢复、在途回包，以及人工发送仍可用。

复现脚本：test/diagnostics/phase1-second-review-repro.mts。仅使用假适配器和 FakeChannel，不发起真实云端请求。

## 当前架构

```text
Electron 桌面主进程
  ├─ React 控制台 → 本地 HTTP/SSE → Core
  └─ Core
      ├─ Supervisor / RuntimeRegistry → 多个 QQ 账号会话
      ├─ SnowLuma attach + OneBot 消息通道
      ├─ 每个会话选择一种宿主
      │   ├─ 内置 AgentEngine：角色卡、历史、Skill、模型与媒体调用
      │   └─ 旧 Worker 插件宿主：账号内串行执行消息插件
      ├─ Policy + ProviderRouter → 云端/本地服务适配器
      ├─ 独立媒体任务队列 → 结果回到原会话
      └─ 账号目录：历史、档案、私有制品、状态、任务和媒体
```

公用制品库复用定义；账号分别保存运行状态。Skill 已支持账号启停与私有定义覆盖。当前仍是 attach，launch=false，不负责自动启动/注入 QQ。Core 仍在 Electron 主进程。Worker 面向可信插件，不是安全沙箱。

## 运行链路

1. EXE 启动，创建 Core、凭据库和控制 API，恢复槽位与期望状态。
2. 实例连接已有 SnowLuma，OneBot 校验 QQ 身份，绑定账号、读取档案并启动宿主。
3. 收到消息后校验归属、去重、落盘，进入会话队列。同会话串行，现代 Agent 跨会话有界并发；旧插件保持账号串行。
4. 内置 Agent 按当前策略构建角色卡、历史和 Skill 上下文；图片可走外部识图，再交给文字模型；视频和生图进入独立任务。
5. 任务结果回到原会话队列，再经身份/代际/能力检查和统一发送出口，通过 OneBot 发给原目标并保存记录。

## 后续改造建议

### 先修正确性

- 修复 S1 的配置执行一致性与 S2 的全宿主暂停策略。
- 补群聊作用域、插件禁用后回调、共享状态并行写测试，并完成实际服务验收。

### 再完善功能架构

- 将“Agent 与插件二选一”改为“内置 Agent + 扩展管理器”：插件注册工具、Hook、能力和任务，Agent 负责主回复决策。旧回复插件保留兼容模式。
- Skill/插件按账号与会话使用同一套可用性和授权判断，公用定义不等于全体实例自动执行。
- 完善任务持久化：远端 ID、执行服务版本、恢复查询、结果交付状态；不盲目重新提交付费任务。
- 补 SnowLuma 进程探测与用户手动注入监听：进程身份、账号绑定、版本兼容、异常处理和独立停止；不自动启动 QQ。实施与验收见 10 文档。
- 酒馆体系另开阶段：角色卡兼容、世界书触发与预算、记忆提取/检索/修正。当前主要是角色卡文本和近期历史，不能等同于完整长期记忆。

Core 迁至独立后台进程可随后进行，有利于桌面壳与后台故障隔离；当前不需要更换技术栈或拆微服务。
