# 后端目标架构与调整方案

日期：2026-10-23。状态：待实施的目标方案，不代表已经完成重构。

核验依据：[25 后端收口核验与架构治理计划](25-backend-consolidation-review-and-plan.md)。任务分配依据：[27 后端改造任务包与验收](27-backend-refactoring-work-packages.md)。

## 1. 总体决定

采用模块化单体：Electron主进程继续运行一个Core，每个QQ账号保留独立的运行会话、资料和插件worker。HTTP、CLI与桌面入口调用同一套应用用例。

调整重点是统一能力归属和依赖边界，不是批量改目录名。保留现有领域目录、数据格式和公开接口，分阶段迁移；不引入微服务，不为本次整理更换数据库，不扩展世界书、长期记忆等产品范围。

### 必须保持的产品行为

- 用户自行启动QQ及外部SnowLuma，应用检测并在用户明确操作后注入/监听；不自动部署、启动SnowLuma或替用户接受协议。
- 同一账号只有一个有效持有者；进程PID不是账号身份。注入前提示信息与连接后身份分开，匹配失败不能绑定本地数据。
- 每个私聊、群聊显式绑定角色卡，没有账号默认角色继承。
- 模型配置按账号选择；语音、生图是可授权的AI工具，不因配置了模型就自动开放。
- 跨账号数据与插件状态隔离；暂停自动回复不等同于断开QQ。
- 公用资源负责分发，不在实例之间共享对话经历或开放隐式跨账号调用。

## 2. 分层与依赖

```text
Electron / CLI / HTTP
          │
          ▼
Core公共门面与应用服务
          │
          ▼
现有领域模块：接入、实例、角色、策略、模型、Agent、媒体、任务、制品、插件
          │
          ▼
平台基础能力：文件、串行、并发、网络读取、脱敏

bootstrap在进程启动时装配具体依赖；contracts承载传输契约。
```

| 层 | 负责 | 禁止 |
| --- | --- | --- |
| 入口/适配层 | 参数解码、鉴权、HTTP状态、IPC、响应和订阅 | 自行判断恢复资格、角色回退、账号绑定等业务规则 |
| 应用服务 | 完成一个业务用例，协调领域模块、持久化和通知 | 接收整个Core当作服务定位器，复制原Core实现 |
| 领域模块 | 拥有状态机、授权规则、生命周期及业务格式 | 依赖React、Electron或HTTP路由实现 |
| 平台基础层 | 提供小而明确的可复用机制 | 决定哪个QQ可连接、哪个模型可调用等业务规则 |
| bootstrap | 创建对象、注入端口、约定启动/关闭顺序 | 承载日常业务用例 |
| contracts | 纯类型的传输DTO与事件契约 | 引入文件系统、凭据实现、HTTP服务器或Electron |

允许领域模块通过明确契约协作。例如任务模块执行媒体工作时调用模型路由和媒体服务，不要求所有领域模块完全互不依赖。禁止形成环形依赖；涉及反向控制时注入窄接口或回调。

## 3. 目标目录

```text
src/
  index.ts                         # 兼容现有公开导出
  bootstrap/
    assemble-runtime.ts            # 构造具体对象，返回运行容器；不导入Core实现
  core/
    core.ts                        # 公开门面，委托用例和生命周期
    events.ts / bus.ts / limits.ts  # 暂保留现有公共能力
  application/
    accounts/                      # AccountService、AccountPresentation
    qq-connections/                # QqConnectionService、ProcessReconciler
    model-settings/                # ModelSettingsService
    deployments/                   # DeploymentService
    lifecycle/                     # RuntimeLifecycle
    ports/                         # 用例所需的窄接口
  platform/
    fs/atomic-write.ts
    async/serial-executor.ts
    async/keyed-serial-executor.ts
    async/semaphore.ts
    http/bounded-body.ts
    security/redaction.ts
    errors.ts                      # 公共错误基类，旧路径保留同对象重导出
  contracts/
    accounts.ts / injection.ts / models.ts / events.ts
    control-api.ts                 # 控制面端口，脱离server.ts
  service/
    server.ts                      # HTTP服务启动/停止
    http/                          # 鉴权、JSON、错误映射、SSE、静态资源
    routes/                        # 按accounts/injection/models等注册路由
  profiles/
    account-directory.ts           # 默认/自定义账号目录唯一解析入口
    display-store.ts               # 展示资料读改写、版本与提交
    ...                            # 现有profile、role-bindings等
  providers/ channels/ instances/ injection/ agent/
  policy/ jobs/ media/ artifacts/ host/ storage/ work/
                                   # 现有领域模块，按任务逐步调整
```

旧`storage/atomic-write.ts`、`core/concurrency.ts`等在迁移后保留兼容重导出。公共能力只有一份实现，不能把旧文件和新文件各保留一套实现。

Core构造拆分放在服务提取之后：`Core.create()`可调用不依赖Core类的`assemble-runtime`取得依赖，再构造门面。bootstrap不反向调用`Core.create()`，避免产生初始化环。保留现有`createCore()`导出和生命周期行为。

## 4. 应用服务与规则归属

| 服务 | 拥有的用例 | 协作边界 |
| --- | --- | --- |
| AccountService | 账号列表、展示资料修改、插件资料修改、会话角色绑定 | 使用AccountDirectory、资料/角色Store；通过窄端口请求运行实例重载 |
| AccountPresentation | 合并真实昵称、本地展示名、本地头像及QQ头像回退 | 不负责登录认证、账号租约、修改QQ资料 |
| QqConnectionService | 管理连接配置、注入/监听、停止/卸载、恢复监听、操作结果 | 复用ManualInjectionService、Supervisor、ListeningStore；不另写注入状态机 |
| ProcessReconciler | 周期发现进程、核对映射、处理失联和换号、发布已提交的快照 | 清理规则从现有扫描逻辑迁移；查询者读取快照 |
| ModelSettingsService | 全局模型服务维护、凭据变更、候选发现、配置验证和账号模型设置 | 复用ConfigStore、PolicyService、ProviderRouter；不复制能力解析与授权规则 |
| DeploymentService | 制品部署/回滚用例、账号目标枚举、结果查询 | 复用RollingDeployer和制品Store；不另起部署调度器 |
| RuntimeLifecycle | 有序启动、拒绝新工作、停止定时器、排空任务/实例、释放资源 | 每个组件只登记一次生命周期所有者 |

ManualInjectionService继续拥有恢复资格和注入操作规则；Supervisor继续拥有实例收敛；QqInstance继续拥有单账号会话与发送边界；ProviderRouter继续拥有能力解析、执行计划和调用前复核。

## 5. 共享机制的精确定义

### 文件与提交

`writeFileAtomic`负责同目录临时文件、完整替换、权限与清理，不提供业务事务。

同一文档的字段修改应在同一串行域内完成：

```text
取得文档/账号串行资格
  → 读取最新已提交状态
  → 校验并合并patch，构造next
  → 原子写入next
  → 发布内存快照/版本和变更事件
  → 返回结果并释放资格
```

持久化失败时不得发布“已保存”结果。跨文件操作采用明确的补偿或恢复记录，不能假定多次rename组成事务。对当前仍先更新内存的Store逐一决定回滚或失败后恢复方式，不在公共写入函数里猜测。

Windows临时占用若需要重试，仅针对同一临时文件的替换进行有限次数、有限总时间的重试；不得删除目标文件强行替换，不得重跑整个业务操作掩盖并发问题。

### 串行与并发

- SerialExecutor提供`run(task)`、`drain()`、`close()`；KeyedSerialExecutor增加按键隔离与空闲键清理。
- 实例由Core运行容器创建和拥有，不使用模块级全局队列。写入同一物理文件的调用者必须共享同一串行资源。
- 文档修改按规范化文件资源键串行；同一`config.v2.json`包含多个账号时，其提交需要文档级串行。不能为了“按账号并行”破坏同一文件的一致性。
- 消息会话FIFO、注入按PID串行、模型端点限流、媒体任务调度保留自身业务包装，不统一成一个全局队列。
- 队列有明确容量与关闭状态；失败不阻止后续任务。取消排队任务可不执行，已开始任务需协作中止；不能超时返回后立即放行下一次写入，而让上一个任务继续在后台修改同一资源。
- Semaphore名额直接交接，release幂等，排队者不被新请求越过。EndpointLimiter的动态限制、取消和统计等差异保留，未完成等价验证前不强制替换。

### 网络、错误与契约

先共享有界响应体读取、信号中止、总超时和基础脱敏，不先建设一个自动重试所有请求的万能客户端。端点访问策略、协议解析、业务重试与生成结果未知的处理由对应模块负责。

业务错误回到所属领域，公共错误基类只有一个构造器；HTTP仅做统一映射。跨前后端DTO可共享纯类型，密钥和内部错误原因不会直接传入DTO。内部应用端口放`application/ports`，避免把所有类型堆入一个文件。

## 6. 新架构运行链路

### 启动与退出

Electron/CLI → `createCore` → 装配运行容器、取得dataRoot锁 → 加载持久状态 → 启动HTTP/收敛任务 → 就绪。待恢复记录只建立候选，是否恢复监听仍遵守当前配置与用户操作。

退出时先停止接收新修改、停定时器，再按依赖排空用例和实例；需要凭据/存储的在途任务结束后才关闭这些依赖，最后释放dataRoot锁。每次启动失败也必须回收已创建资源。

### 账号检测与连接

ProcessReconciler读取SnowLuma → 得到进程及身份提示 → AccountPresentation补齐展示资料 → API返回卡片快照。

用户连接 → QqConnectionService → ManualInjectionService按PID串行校验并执行 → 读取真实登录身份并核对预期账号 → Supervisor建立/恢复账号实例 → OneBot身份复核 → 匹配该账号本地数据 → 记录监听结果。

刷新接口可以请求一次明确的reconcile并等待新快照；普通查询不自行停止或删除实例。服务不可达是“扫描失败”，不能当成“所有QQ消失”。保留代际检查和失联阈值，避免旧扫描删除新映射。

### 收到消息与调用模型

OneBot事件 → QqInstance身份/回环检查和会话队列 → 读取当前私聊/群聊角色绑定与账号策略 → 内置Agent或插件宿主处理 → ProviderRouter验证能力和执行计划 → 按账号选择对话/视觉/视频服务，按授权调用生图/语音工具 → 统一发送出口与账号存储。

已有执行前授权/凭据版本复核必须保留；这是防止排队期间配置变化，不能作为重复校验删除。

## 7. 推进边界

先修已复现问题，再收口基础能力，再按业务提取服务，最后拆构造与HTTP。禁止同时搬迁所有目录、修改数据schema和重写业务规则。每个任务均须交付唯一实现入口、兼容方式和可复现验收，任务细则见27号文件。
