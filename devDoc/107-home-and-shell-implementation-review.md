# 第一批交付：正式主页与全局菜单重写

日期：2026-10-27。状态：实现、构建和本批自动化复核完成。真实QQ/服务联调与发行包验收另行记录。本批以 [103](103-home-and-shell-rewrite-plan.md) 为范围，以 [105 v1.0.2](105-frontend-design-system.md) 为视觉和组件规范。

## 1. 交付结果

正式`pages/Home.tsx`已重写，App已使用顶部品牌、主页账号切换、底部Dock和完整菜单。它使用实际React组件、鉴权API和共享查询，未嵌入设计HTML或把样例数据写入生产页面。

主页保留已认可的左侧局部水墨场景、夏澄立绘、姓名索引与便签；右侧显示实际账号昵称、QQ号、签名和主要动作。开关采用右置布局，与手账红入口和深蓝导航统一。鼠标只使场景和立绘产生相反方向、最多几像素的轻微移动，系统或应用减少动效时清零。

新增角色绑定摘要，完整区分accountId、kind与peerId。点击群聊42或私聊42会分别进入既有角色页的相应行，聚焦和滚动到目标；主题夏澄独立于真实绑定，不假称她是所有会话的运行角色。未设置签名时，默认寄语明确标记来源。

## 2. 查看与启动

- [1440×960正式前端截图](design/character-studio/implementation/home-1440.png)
- [1280×800截图](design/character-studio/implementation/home-1280.png)
- [1024×720截图](design/character-studio/implementation/home-1024.png)
- [375px辅助布局截图](design/character-studio/implementation/home-375.png)
- [实际150%缩放的隔离Electron窗口](design/character-studio/implementation/home-electron.png)
- [125%进程渲染检查](design/character-studio/implementation/home-electron-125.png)
- [机器可读界面验收结果](design/character-studio/implementation/review.json)

运行`npm run desktop:home-preview`后，默认打开`http://127.0.0.1:50320/?token=home-preview&preview=1#/home`。这是**实际前端＋内存测试接口**，品牌下明确显示“隔离界面预览 / 样例数据”。接口只绑定本机，不读取用户账号目录、不启动Core、QQ或模型；关闭服务后样例状态消失。重启电脑后需重新运行该命令。

常规`npm run desktop:build`已构建正式前端、main与preload；正式入口继续使用实际桌面桥、鉴权和API地址。预览服务器不被生产前端导入。本批没有打包、安装或覆盖`release`中的EXE。

## 3. 导航与迁移边界

底部四个直达项为桌面、关系、模型、收藏；更多及顶部全部菜单可达主页、总览、实例与监听、资料与角色、插件与Skill、模型配置、事件诊断、应用设置和资源库。总览等次级页在“更多”上有当前页标记，设置仍使用已有弹窗。

旧业务页继续真实接入，没有被替换成占位页。原hash、历史补偿、`#/models`/`#/settings`旧链接、设置关闭和退出协议保留。账号切换与页面跳转继续走统一草稿准入，取消时不修改账号、路由或草稿。

本批顶部明确标记为**主页账号**。在旧业务页切换它，会先检查所有草稿，再回到所选账号的主页；旧页自己的账号控件继续保留，避免把顶部A误当成正在编辑的B。后续逐页迁移时再收敛各页选择方式。主页进入角色页携带账号与完整目标，进入模型页使用所选主页账号作为初始账号。

首次可选第一个有效账号；显式选择记录为本地会话UI偏好。当前账号之后从服务端列表消失时保留失效选择并提示重新选择，不能默默替换为另一个账号。异步确认后复验目标是否仍存在。

## 4. 数据与写入

| 内容 | 实际接入 |
| --- | --- |
| 账号及展示资料 | 复用App的`/accounts?avatars=1`查询及现有AccountAvatar管线；增加坏图回退 |
| 连接状态 | 复用`/slots`；按accountId匹配，只有online且connected才显示已连接；未知/失败不写成离线 |
| 自动回复 | 读取`/accounts/:id/policy`的账号级设置，沿用服务端默认继承规则 |
| 角色绑定摘要 | `/accounts/:id/role-bindings`，过滤当前账号，按完整键导航 |
| 暂停/恢复 | 仅显式点击调用`POST /accounts/:id/agent`，请求体仅`{enabled:boolean}`；不调用停止、注入、卸载或发送接口 |
| 事件与其他快照 | 保留原有SSE、鉴权、断线续传和App查询，不另建连接 |

主页不使用虚构的`peerId=0`生效查询来宣称所有会话就绪。配置开关、QQ连接与逐会话规则分别表达；离线时可以看到“已开启，等待连接”，绑定为空/失败/读取中分别表达。

Agent操作在第一步异步等待前锁定目标账号并登记忙碌状态。请求进行中重复激活不会新增POST，账号和页面离开被既有准入阻止。结果不明时保留已确认状态并回读；网络或服务端未知结果仍要求显式重新读取核对，不自动重试写入。每个请求有超时和取消处理，代际检查阻止迟到结果覆盖其他账号或重新进入后的状态。

共享查询新增可选的重入刷新和已确认数据发布：主页返回时重新校验策略/绑定；发布POST结果会递增查询版本，让更早启动的GET不能覆盖它。其他调用方的默认缓存行为保持原约定。

## 5. 主题隔离和旧代码清理

- `UiThemeProvider`只提供React上下文，位于ConfirmProvider和DraftProtectionProvider外，使App控制器的全局确认使用新主题。
- `data-ui-palette`只提供token值；顶部、主页和底部各自使用UiThemeScope提供控件外观。
- 未迁移内容及设置使用空主题上下文，旧控件继续使用原外观；界面检查确认旧资料输入框仍为原12.5px规格，没有被新14px输入规则污染。
- 旧主页实现、头像账号Dock、旧顶栏/侧栏及悬浮设置展示已移除，不保留HomeOld/HomeLegacy。
- 从原`styles.css`移除135条已无使用的主页/壳选择器，约335行；保留共享控件和未迁移业务样式。清理记录在`test-results/home-migration/removed-selectors.json`。
- 原“旧主页头像Dock”键盘测试由真实顶部AccountSwitcher测试替代，保留方向键、首尾、快捷键、取消后不切换和溢出选择的验证。

## 6. 复核发现与修正

| 问题 | 修正与证据 |
| --- | --- |
| 仅在Home包主题会漏掉外层导航确认；全局包控件CSS又会改变旧页面 | 分离React主题上下文、token范围和控件DOM范围；草稿、设置和旧输入隔离均实测 |
| 初次账号加载后的短暂空选择可能被误写成“账号已移除” | 空初值渲染采用首个账号；非空失效ID保留为失效状态，不自动回退 |
| 账号切换经过异步确认后，目标可能已移除 | 提交前再次核对目标、当前选择及退出状态；单元测试覆盖 |
| 较早GET可能覆盖刚确认的开关POST结果 | 共享缓存增加版本校验；旧成功/失败结果均不能污染已发布状态，未来新读取仍可更新 |
| 超时/断开后的回读不能证明原写入已终止 | 未知结果即使回读成功也保留核对门槛，要求显式重新读取，避免自动再次写入 |
| 同号群聊与私聊可能错误跳转 | 完整键生成DOM定位ID，分别实测两种42目标及账号B |
| 非直达页没有底部当前项 | “更多”提供对应页名称和选中外观，不冒充一个直接页面链接 |
| 旧文案测试假定菜单常量必须位于App | 更新为检查App导入统一导航目录，以及目录中的原文案；未删除文案契约 |
| 无效头像可能留下破图 | AccountAvatar按来源失败回退；主题图失败保持空间与主操作 |
| 实际壳尺寸与规范token不一致 | 顶部使用80px token；Dock使用72px基准、64px紧凑token，布局与截图重新复核通过 |
| 隐藏原生窗口截图被后台节流阻止 | 仅测试窗口关闭后台节流并用capturePage；profile/session放在工作区测试目录，未改产品窗口行为 |

隔离接口中缺失的世界书空态曾使预览无法继续；已修正测试接口契约，没有为测试修改世界书业务逻辑。所有结果以最终成功运行记录为准。

## 7. 最终验证

| 检查 | 结果 |
| --- | --- |
| `npm run ui:tokens:check` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run desktop:build` | 通过 |
| 全量Vitest | 122个文件通过；1124项通过、1项既有跳过 |
| 主页浏览器/原生复核 | 19组通过，无pageerror |
| 公共组件样板复核 | 17组通过；原有8种布局和确认队列继续通过 |
| 主页布局 | 1440×960、1440×900、1280×800、1024×720、819×576、768×900、414×896、375×812、320×780，均无页面横向溢出、控件越界、破图或Dock遮挡 |
| 原生窗口 | Electron39.8.10，实际主屏scaleFactor=1.5；另一个隔离进程以1.25渲染通过，未更改OS缩放 |
| 旧功能 | 全部菜单入口、旧模型设置深链接、浏览器返回取消、资料草稿取消/接受、退出回归通过 |
| 生产边界 | 正式输出包含新主页、主题与两张原画；不包含预览服务器、样板HTML或演示密钥 |

最终测试日志：`test-results/home-migration/vitest.log`。新增/更新的重点测试为`query-cache.test.tsx`、`home-presentation.test.tsx`、`account-switcher-keyboard.test.tsx`、`settings-navigation.test.tsx`、`renderer-quit.test.tsx`及导航文案契约。

全量验证后只调整顶部/Dock的CSS与尺寸token，未改变业务代码；补跑token契约4项、renderer构建，以及主页19组和组件17组界面检查均通过。当前三层token共244项。

检查脚本 [verify-home.mjs](../desktop/scripts/verify-home.mjs) 使用明确的隔离预览接口，覆盖只读无写入、账号切换、绑定完整键、九项菜单、草稿/历史取消、忙碌和重复激活、未知结果回读、迟到响应、离线、首次失败、缓存过期、写失败、空列表、账号移除、28账号搜索、长文本、素材失败与减少动效。

## 8. 尚未声称完成的事项

1. 没有用用户真实QQ、SnowLuma或付费模型做联调；实际HTTP契约、后端回归与隔离UI验收已经通过，真实服务联调仍需单独执行。
2. 125%是独立Electron进程渲染参数检查，实际主屏OS为150%；没有把它写成真实OS设置125%的验收。
3. 退出协议的既有单元回归已通过；真实托盘、真实服务释放与发行包启动尚未做本批现场联调，没有覆盖旧发行EXE。
4. 其他业务页仍保留原布局，本批只增加必要入口上下文与焦点定位；下一页继续沿用同一规范迁移。
5. 完整屏幕阅读器人工验收不在已通过项目内。

## 9. 主要文件

- 应用入口与协调：[main.tsx](../desktop/renderer/src/main.tsx)、[App.tsx](../desktop/renderer/src/App.tsx)。
- 正式主页：[Home.tsx](../desktop/renderer/src/pages/Home.tsx)、[HomeScene.tsx](../desktop/renderer/src/components/home/HomeScene.tsx)。
- 菜单与账号：[AccountSwitcher.tsx](../desktop/renderer/src/components/shell/AccountSwitcher.tsx)、[PageDock.tsx](../desktop/renderer/src/components/shell/PageDock.tsx)、[MoreMenu.tsx](../desktop/renderer/src/components/shell/MoreMenu.tsx)、[navigation.ts](../desktop/renderer/src/lib/navigation.ts)。
- 数据与状态：[use-home-data.ts](../desktop/renderer/src/lib/use-home-data.ts)、[home-presentation.ts](../desktop/renderer/src/lib/home-presentation.ts)、[hooks.ts](../desktop/renderer/src/hooks.ts)。
- 布局：[shell.css](../desktop/renderer/src/styles/shell.css)、[home.css](../desktop/renderer/src/styles/home.css)；公共外观位于ui目录。

本批没有新依赖或新状态管理框架。保留原画约4.02MB，构建后renderer JS约472.32kB、CSS约110.74kB；这只是本次本地构建体积，不是性能或用户规模指标。
