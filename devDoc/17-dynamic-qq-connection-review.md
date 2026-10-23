# 动态 QQ 接入与暖浅色样式修复验收

日期：2026-10-22。状态：本地开发验收通过，独立只读复核无阻断项。子代理完成服务控制器后因额度中断，用户要求继续，主代理接手Core、页面与样式实现；独立验收夹具在实现前建立，保留原断言。子代理随后恢复并进行了最终只读复核。

## 本轮要求

用户反馈工作台接入过于复杂，要求槽位动态增减，随应用启动 SnowLuma，页面直接展示可注入 QQ 进程，注入后识别真实账号并匹配已有数据。同时清理设置统计卡、事件输入框、总览步骤卡和资源路径/代码块等不协调的黑底。

本轮覆盖旧计划中“只连接外部 SnowLuma”的限制：允许应用启动和管理 SnowLuma 管理服务。QQ 仍由用户启动；注入和监听需要用户点击。启动管理服务不能顺带开启自动注入或恢复监听。

## 独立验收门槛

1. 普通接入流程不要求填写槽位ID、账号ID或手动创建实例；进入工作台展示进程与可执行操作。
2. 配置完成后随桌面应用启动管理服务；服务已运行时复用；缺少runtime、版本不支持、认证失败、启动超时可见；不弹出控制台窗口。
3. 管理服务自启不调用进程注入接口；hookAutoLoad开启时禁止错误地继续隐式注入。
4. 同一进程重复点击、多个进程同时操作不重复创建在线宿主；按注入后真实QQ账号绑定，已有账号的数据路径、角色卡、模型、历史保留。
5. QQ进程实际退出后只回收内部运行实例。临时管理服务请求失败不能误删账号数据或清空运行实例。
6. 退出应用只清理本应用启动的管理子进程，不结束用户QQ或外部服务；重启不会自动恢复监听。
7. 全站主要表单、统计、空状态、路径/代码区统一暖浅色；对话框、错误/展开状态也需检查，保留可读对比度。
8. 类型检查、全量测试、桌面构建及浏览器真实操作验证，记录本轮新增用例与真实环境限制。

## 基线与证据

上一轮最终基线：34个测试文件、222项全部通过；本轮最终需重新验证。用户四张截图是本轮视觉缺陷依据。开发参考QQ-Agent本地代码与SnowLuma 1.14.x manifest/API，不读取其用户data或管理密钥、不启动实际QQ或外部runtime。

## 首轮代码复核与改进要求

| 编号 | 问题 | 要求/复测 |
| --- | --- | --- |
| R-D1 | 受管服务已启动后再次ensure可能把owner写成external | 保留实际子进程所有权；重复检查不重复启动 |
| R-D2 | 启动超时未清理已有子进程，重试可能覆盖句柄 | 超时结束自有子进程；可重试且不能遗留进程 |
| R-D3 | 退出发生在异步校验期间，后续仍可能spawn | 在异步边界检查取消，退出等待启动收尾并禁止晚到spawn |
| R-D4 | 只靠页面GET触发回收，切页/托盘后进程退出不能及时清理 | Core内部定时成功快照回收；失败不计缺席，关闭时取消定时器 |
| R-D5 | 同PID仍存在但注入与协议均消失时旧连接未回收 | 两次成功快照确认`injected=false && connected=false`后回收；单纯connected抖动而注入仍在不回收 |
| R-D6 | 缺少hookAutoLoad字段被误认为明确关闭 | 保留autoLoadKnown，未知时阻止受管启动与注入操作 |
| R-D7 | stop已回收实例但REST随后查询实例，导致成功停止误报404 | 返回成功及`instance:null, removed:true`，浏览器复测通过 |

已发开发子代理修复。主代理新增`test/independent-runtime-controller.test.ts`与`test/independent-dynamic-connection.test.ts`，覆盖服务所有权/退出、进程列表无副作用、无槽位REST接入、重复点击、双号配对、重启与回收。当前尚未记录最终运行结果。

17:42主代理独立执行`npm test -- test/independent-runtime-controller.test.ts --reporter=dot`：4/4通过。R-D1～D3对应的所有权、超时与异步退出场景通过；等待Core与UI完成后整体验证。

## 实现与运行链路

桌面端开启`autoStartSnowLuma`和`manualStartOnly`：Core先开放本地UI，然后后台确保SnowLuma管理服务启动。复用已运行的服务；自行启动时校验runtime版本、内置Node、回环WebUI地址及关闭的hookAutoLoad，清除自动注入环境开关，并隐藏控制台。退出只终止本应用启动的子进程。

总览与实例页共用`QqConnections`：显示SnowLuma真实进程目标，点击“注入并监听”或“开始监听”只提交进程身份，不要求手填槽位/账号。后端串行处理同PID请求，读取登录后的真实UIN，再匹配兼容旧槽位或创建`qq-{uin}`内部实例。使用已有`accounts/{uin}`数据，角色绑定和模型配置沿用；缺少会话角色时仍不自动回复。

新内部槽位不写入slots.json。停止监听自动释放内部实例；Core后台定时探测确认连续两次缺席才回收，管理请求失败不计缺席。检测同PID换号会停止旧号连接，新号等待用户重新点击。进程与实例明确按PID映射，避免同账号多个进程误显示为同一个监听。旧手工创建的配置保留，普通页面不再要求创建。

样式将旧深色background硬编码替换为暖色语义变量，根color-scheme统一light，同时调整浅底文字、表单、路径、目录树、展开JSON、统计卡和窗口加载背景。

关键代码：

- `src/injection/snowluma/runtime.ts`：服务启动、Node校验、所有权、取消与退出。
- `src/injection/manual.ts`：无slotId接入、真实身份核验、重复点击合并。
- `src/core/core.ts`：动态实例、进程关联、后台回收、停止与账号数据复用。
- `src/service/server.ts`：停止后实例已回收时返回成功及`instance:null`，避免成功停止却误报404。
- `desktop/renderer/src/pages/QqConnections.tsx`、`Overview.tsx`、`Slots.tsx`：简化接入操作。
- `desktop/renderer/src/styles.css`、`Settings.tsx`、`desktop/main.ts`：暖浅色与管理设置。

## 本地验证

最终全量回归（19:37）为36个文件、238项全部通过（222项旧基线 + 16项新增验收）；类型检查与桌面构建通过。独立只读复核提出R-D5/D6后已修复、补测试，再复核确认无阻断项。

新增服务控制器4项：外部服务复用不终止、自有服务重复检查保持所有权、启动超时清理、Node校验途中退出取消spawn。动态接入12项：自动管理服务不注入、发现进程无副作用、重复点击、普通REST接入与停止、双号保留已有资料、重启不监听、stop回收、HTTP失败不误回收、无页面轮询时回收、同PID换号隔离、注入与协议同时消失回收、未知自动注入状态拒绝操作。

浏览器使用临时dataRoot、真实回环HTTP模拟管理服务及FakeChannel/Backend，不使用用户QQ。实际点击两账号注入/监听后分别显示在线；停止后实例数归零并提示成功，进程保留“已注入/开始监听”；主页仍能读出预先保存的账号昵称和签名。1280×720及1024×720检查，后者根和内容区均无横向溢出。

浏览器也复核设置空状态/添加服务表单、事件过滤与展开JSON、资源路径/目录树。展开JSON背景为`rgb(241,234,222)`、文字为`rgb(67,59,52)`，过滤框背景为暖白。

- [总览双账号已连接](../test-results/ui/dynamic-connection-review/overview-connected.png)
- [最终进程选择页面](../test-results/ui/dynamic-connection-review/overview-processes.png)
- [设置统计卡浅色](../test-results/ui/dynamic-connection-review/settings-light.png)
- [事件过滤框浅色](../test-results/ui/dynamic-connection-review/events-light.png)
- [资源路径与目录树浅色](../test-results/ui/dynamic-connection-review/resources-light.png)

## 首次启动与实机边界

首次在“应用设置 → SnowLuma管理”指定已经初始化的SnowLuma 1.14.x目录（含node.exe、index.mjs、config/runtime.json），保存管理密码，并关闭hookAutoLoad。之后应用自动启动管理服务；用户自行打开QQ，在总览点击注入/监听。缺少初始化、需要协议同意、版本不兼容、密码错误会显示原因。

本次未把QQ-Agent的第三方runtime或其用户数据复制进发行包，也未硬编码本机QQ-Agent路径；因此全新安装仍需上述一次配置。包内是Accompany自身，已有runtime可继续使用。当前不负责下载、安装或初始化SnowLuma，不自动启动QQ。

真实SnowLuma原生模块、QQ版本兼容、实际注入和收发、Windows安装后托盘/DPI与长期运行仍需实机验证；本轮没有执行用户QQ注入或真实发消息。便携EXE重新打包，旧setup安装包不更新；启动新版本前应从旧应用托盘完全退出，避免单实例锁转回旧进程。

最终`npm run desktop:pack`成功（含后端、renderer与Electron main/preload重建）。交付文件：`D:/app/nowadays/accompany/release/Accompany-0.2.0-portable.exe`。版本号沿用0.2.0，应以本轮重新生成的便携文件为准；旧setup不是本轮交付。浏览器及临时模拟服务已停止。
