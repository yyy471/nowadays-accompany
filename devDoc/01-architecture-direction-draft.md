# Accompany 总体架构参考方向（底稿）

日期：2026-10-22

状态：参考方向，待分阶段讨论。本文整理首次架构评估，不代表全部细节已经确认，也不是立即实施清单。后续讨论可以修订或替换其中的建议。

## 1. 评估范围与结论

已检查当前项目源码，以及 `D:/app/QQAgent/QQ Agent/resources/app` 下的参考项目实现。首次评估时现有 18 个测试文件、94 项测试通过，TypeScript 检查通过；未启动 QQ，未验证真实注入链路。

当前项目适合保留作为长期底座。已有优势集中在 QQ 多账号运行与消息编排，下一阶段主要补齐 Agent 引擎、任务系统和能力层。

## 2. 当前实现

```text
Electron 主进程
  ├─ React 控制台 → 本地 HTTP / SSE → Core
  └─ Core
      ├─ InstanceSupervisor → QqInstance
      ├─ RuntimeRegistry → SnowLumaBackend → 已有 SnowLuma 运行时
      ├─ OneBotChannel → QQ 消息通道
      ├─ AgentHost → 每账号一个 Worker，运行该账号全部插件
      └─ 消息存储、账号档案、插件状态、制品与配置
```

值得保留：

- 注入运行时接口与消息通道接口分离。
- runtime、槽位、QQ 账号身份分别建模。
- desired/observed 状态、监督器、账号租约、账号目录隔离。
- 有界队列、背压、限流、回环过滤与幂等基础。
- AgentHostFactory 提供功能层替换点。
- 制品 revision、按账号滚动切换、失败保留旧宿主。

当前能力边界：

- SnowLumaBackend 为 attach 模式，`launch: false`；读取已有配置、探测端口并接入运行时，未实现完整的 QQ 启动与注入管理。
- 角色卡已解析和版本化，但默认未建立模型对话引擎；无插件时默认不创建 Worker 宿主。
- 插件接口以消息回调为中心，尚不能完整表达长任务、定时活动、浏览器资源和恢复。
- Worker 提供一定故障隔离，不是第三方代码安全沙箱。
- 账号租约在 Core 内生效，同一 dataRoot 有单写者锁；没有跨 Core、跨 dataRoot 的账号租约。

## 3. 建议目标架构

采用模块化核心、少量独立进程、能力驱动插件。继续使用 Electron、React、TypeScript，不急于引入微服务。

```text
桌面壳：窗口、托盘、安装更新、核心进程监督
  └─ 核心服务：账号、消息、策略、任务、存储
       ├─ QQ 运行时管理器 → QQ + 必要注入桥接层
       └─ Agent 引擎：人格、上下文、记忆、模型、工具循环
            └─ 能力代理：授权、配额、取消、审计
                 ├─ 插件执行进程
                 ├─ 浏览器执行进程
                 └─ 媒体处理进程
```

QQ 进程内只承担必要桥接。人格、模型、记忆、插件及浏览任务在外部运行。

Core 可在后续迁入 Electron utility process；独立进程用于故障隔离，不能直接等同于不可信代码安全隔离。

## 4. Agent 引擎

内置可替换的 AgentEngine，统一以下流程：

```text
消息 → 回应策略 → 连续消息合并 → 人格与配置
→ 记忆检索 → 有预算的上下文构建 → 模型调用
→ 工具循环 → 回复组织 → 统一发送出口 → 摘要与记忆更新
```

身份分别建模：accountId、personaId、conversationId，以及人格与对象之间的 relationshipId。账号可默认绑定人格，定义与运行状态应分开。

记忆作用域建议：

| 数据 | 范围 |
| --- | --- |
| 原始消息、摘要 | 账号 × 会话 |
| 人际关系记忆 | 账号 × 人格 × 对象 |
| 群体背景 | 账号 × 群 |
| 网页、视频经历 | 账号 × 人格，保留来源与可见范围 |

默认不跨会话传播私聊内容。记忆保留来源、时间、置信度和可删除状态。连续消息合并、回复打断、人工接管、免打扰应优先于复杂情绪数值。

## 5. 扩展机制

Plugin 作为安装、版本和生命周期单位，可以注册：

| 扩展点 | 调用方 | 示例 |
| --- | --- | --- |
| Hook | 确定性流程 | 入站过滤、回复后处理 |
| Tool | 模型 | 搜索、读取空间动态 |
| Capability provider | 按能力解析的系统模块 | 视频转写、图片理解 |
| Job handler | 调度器 | 定时浏览、记忆整理 |

核心依赖能力名，不依赖具体插件名。工具可用性、UI 状态和运行授权应使用统一判断。插件清单逐步补齐版本、配置 Schema、权限、能力依赖、状态版本与迁移。

调用上下文由宿主绑定账号、会话、任务和授权；插件不能凭请求参数冒用其他账号。参考项目的全局注册表和默认全局 manager 应改造成显式注入。

## 6. 长任务与资源调度

将消息处理与网页、视频等长任务分离：

- 对话：同一会话串行，不同会话受限并发。
- 长任务：独立队列，按任务、账号和资源限制并发。
- 共享资源：按浏览器身份、空间写操作等资源加锁。

对话创建 jobId 后返回；任务结果形成事件，再由 Agent 判断是否回复与记忆。

任务状态：queued、running、waiting_user、succeeded、failed、cancelled。记录发起账号、会话、插件版本、超时、重试、检查点和资源租约。

浏览器按 accountId + browserProfileId 隔离；消息登录态与空间网页登录态分别管理。区分“播放过视频”和“实际理解了字幕/画面”，经历必须有来源。

## 7. 优先技术调整

1. 取消从会话/任务传播至插件、HTTP 请求和页面操作；Promise 超时本身不会取消已有副作用。
2. AgentEngine 作为默认主回复决策者；其他插件输出结构化结果或显式动作，避免后插件覆盖前插件的 reply。
3. 分开 artifactRevision、完整配置指纹 profileFingerprint、运行代际 hostEpoch，以及 stateVersion。当前 profile revision 未覆盖插件配置，不应兼任宿主写入隔离代际。
4. 分离 QQ 连接状态与 Agent 状态，支持仅收消息、暂停 AI、人工接管。
5. 引入持久任务、工具调用记录和 outbox；可采用本地 SQLite，JSONL 保留作日志/导出。
6. 发送超时可能结果未知；outbox 改善恢复但不保证端到端恰好一次，不能对所有副作用自动重试。

## 8. 建议阶段

| 阶段 | 交付目标 | 验收重点 |
| --- | --- | --- |
| 1 | 单账号对话闭环 | 无业务插件也可聊天，暂停、接管、断线恢复 |
| 2 | 扩展契约 | 网页读取插件可独立安装、禁用、升级与取消 |
| 3 | 长任务与浏览器 | 不阻塞聊天，账号身份隔离，取消与恢复有效 |
| 4 | 主动陪伴 | 定时活动、经历记忆、视频/空间扩展可解释可暂停 |

阶段顺序为首次建议，需结合多账号基础目标继续讨论。每阶段补充真实边界验证：QQ 身份校验、断线重连、插件取消、浏览器崩溃、发送结果未知。

## 9. 参考

- 当前代码：src/core、src/instances、src/host、src/injection、src/config、src/artifacts。
- 原项目：resources/app/src/plugin-loader.js、tool-registry.js、orchestrator.js 等。
- Electron utilityProcess：https://www.electronjs.org/docs/latest/api/utility-process
- Playwright BrowserContext：https://playwright.dev/docs/api/class-browsercontext
