# SnowLuma 官方手动部署与引导式接入

日期：2026-10-22实施，2026-10-23完成验收。按用户选择，未取得额外自动部署授权时，采用用户自行获取和初始化、nowadays 连接已有服务的流程。

本文覆盖17号文档与后续页面中“管理服务随应用启动”的要求。桌面发行默认 `autoStartSnowLuma:false`；不自动下载、解压、初始化或启动 SnowLuma，不修改其协议接受状态。

## 首次与日常流程

首次向导：准备官方发行包 → 使用官方入口初始化及启动 → 绑定已有服务。准备步骤提供官方发布页、协议及文档链接，用户自行下载和解压；初始化步骤由官方界面接受协议、配置密码并明确关闭 hookAutoLoad；绑定只需目录和密码，管理地址作为可选高级设置，默认从 runtime.json 读取。

桌面提供原生目录选择器，浏览器保留手动输入。已配置用户直接查看连接状态，仍可返回准备说明或修改设置；分步切换保留未保存草稿，关闭时沿用既有草稿保护。

日常：用户自行启动 SnowLuma 官方服务和 QQ → nowadays 检测进程 → 用户点击注入/监听 → 按真实QQ账号自动匹配数据。停止或退出 nowadays 不终止外部服务。

## 后端及桌面契约

- `POST /injection/connection/test`：真实登录管理接口并读取进程列表，成功返回 `{ok:true,runtime,processCount}`。不注入、不分配实例、不更改官方运行文件。目录/版本/服务在线/自动注入状态不满足时失败，错误密码或待接受协议不能返回成功。
- `GET /injection/runtime`仍为只读状态查询，不能单独视为鉴权成功。
- 外部模式下旧 `/injection/runtime/retry` 请求被拒绝，不暗中启动服务。Core现有显式可选托管能力保留用于历史兼容，但桌面不启用或提供入口。
- `window.nowadays.chooseRuntimeDirectory()`仅返回用户选择的目录；主进程校验发送者、主框架与本机UI origin，目录选择不启动任何第三方程序。

## 许可边界

本轮是缩减自动化范围，不是许可获批声明。官方当前EULA第5.4条涉及自动化部署，LICENSE第4(b)条限制基于其开发发布其他项目；具体发行版本和独立接口接入方式仍需按对应条款确认。官方链接保留项目名称，不由nowadays代替用户接受。

- https://github.com/SnowLuma/SnowLuma/releases
- https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md
- https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE

## 验收

新增6项真实回环HTTP测试，覆盖鉴权成功、错误密码、协议未接受、自动注入开启、服务离线、旧重试启动接口拒绝；同时断言无进程启动、无注入/实例创建、官方配置未修改，以及退出后外部服务仍存活。全量测试39文件、261项通过。

页面实际验收通过：三步切换保留草稿；错误密码显示失败；修改草稿时不允许验证旧配置；保存后密码清空；正确密码通过真实回环HTTP接口验证后显示进程数量；关闭弹窗后总览展示模拟QQ进程，注入仍需手动点击。官方链接仅核对地址，未执行下载或接受协议。

证据：[首次准备](../test-results/ui/guided-snowluma-review/first-step.png)、[连接验证](../test-results/ui/guided-snowluma-review/verified-connection.png)、[总览进程](../test-results/ui/guided-snowluma-review/overview-ready.png)。所有账号、路径和管理服务均为隔离测试数据。

最终 `npm run typecheck`、`npm run dist` 通过，生成 `release/nowadays-0.2.1-setup.exe` 与 `release/nowadays-0.2.1-portable.exe`。版本0.2.1用于区别此前管理服务自启动版本。启动新版前先退出旧版托盘进程。

验收边界：未启动真实SnowLuma或QQ，未执行真实注入、监听或消息发送。桌面原生目录选择器已接入受限IPC并通过类型检查，其系统弹窗交互仍需用户桌面环境实测。
