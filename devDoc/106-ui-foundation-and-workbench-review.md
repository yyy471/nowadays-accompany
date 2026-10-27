# 前端重写第一步：公共组件、主题样板与复核

日期：2026-10-27。状态：公共基础阶段完成并复核。本文保留当时的阶段结果与待办；后续正式主页、全局菜单、Provider安排与旧样式清理已完成，见 [107](107-home-and-shell-implementation-review.md)，不能把本文的历史待办当作当前状态，也不能用本报告代替104整体验收。

## 1. 实际交付

已将105规范落到实际React公共UI中，沿用已认可的夏澄、局部水墨场景和手账语言。交付的是供正式页面复用的组件基础及开发样板，不是另一份独立模拟HTML网站。

- 241个三层token、生成脚本及同步校验；原始数值仍由 [tokens.json](design/character-studio/tokens.json) 管理。
- 显式启用的UiThemeScope和公共控件外观；新主题不直接覆盖旧页面。
- 统一的按钮变体、八种按钮状态、字段错误关联、开关、菜单、折叠抽屉及导航外观。
- 普通Portal和排队确认的主题传递；原有模态隔离、草稿准入与退出协议继续复用。
- 真实公共组件样板 [ui-workbench.html](../desktop/renderer/ui-workbench.html)，使用隔离示例和本页内存状态。
- 可复跑的 [浏览器/原生复核脚本](../desktop/scripts/verify-ui-workbench.mjs) 与10项新增单元/契约检查。

未修改App、正式Home和main入口，未删除业务页面、用户数据或旧设计稿；未修改后端业务规则，未打包、安装或替换发行EXE。构建只更新既有本地构建输出。

## 2. 可查看的成果

- [桌面首屏截图](design/character-studio/workbench-desktop.png)
- [完整组件页截图](design/character-studio/workbench-full.png)
- [375px窄窗口截图](design/character-studio/workbench-mobile.png)
- [隔离Electron窗口截图](design/character-studio/workbench-electron.png)
- [机器可读复核结果](design/character-studio/workbench-review.json)

启动方式：`npm run desktop:ui`，再打开终端所示本机地址下的`/ui-workbench.html`。本次运行地址为`http://127.0.0.1:50318/ui-workbench.html`；机器重启或服务退出后需要重新启动，默认启动端口不保证是50318。

样板覆盖字体层级、账号标签、动作按钮、图标按钮、搜索、文本/只读/禁用/密钥/数字输入、原生下拉、文本域、勾选、单选、系统文件选择、开关、页面Dock、菜单、模态、确认队列、折叠保留、空/失败/旧数据和插画回退。

## 3. 复核发现与修正

| 编号 | 发现 | 本批处理 |
| --- | --- | --- |
| F01 | 规范只有数值文件，没有可供控件消费的CSS；手工抄写容易分叉 | 生成限定作用域的CSS；校验格式、三层引用、缺失引用、循环与变量重名；构建生成、测试检查同步 |
| F02 | 原公共按钮加载时原生禁用，主题交互可能丢失焦点 | 新主题改为保持焦点的aria-disabled及激活阻止；原主题保留原行为 |
| F03 | 等待图标及省略号字宽会改变按钮尺寸 | 预留图标槽并记录原宽度下限；实测保存样例加载时等宽；规范约束加载文案不变长 |
| F04 | 失败/成功反馈可能被primary的hover规则覆盖 | 修正组合状态配色，并检查失败后悬停仍是错误配色；焦点和错误边界可同时存在 |
| F05 | Field没有统一错误ID及控件关联 | Input/Select/Textarea合并调用者说明、hint和error ID；保留既有aria属性与正常字段行为 |
| F06 | Portal脱离DOM范围，局部主题会丢失 | 普通Modal传递React外观上下文到body下的backdrop；不会依赖页面全局选择器 |
| F07 | 外层ConfirmProvider不能自动获取发起确认处的局部主题 | useConfirm请求记录调用hook所在范围的主题与动效；Provider在范围外的样板也通过 |
| F08 | 确认队列若复用同一个已打开Modal，下一项可能停留在确认按钮 | 每个请求使用独立Modal身份；下一项重新聚焦取消；测试第一项确认、第二项取消与焦点恢复 |
| F09 | 弹窗期间滚轮可能移动背景 | 共享层管理器锁定body滚动，最末层关闭后恢复原值；嵌套弹窗仍维持背景隔离 |
| F10 | 菜单只朝下展开，贴近窗口边缘时可能越界 | 根据上下可用空间选择方向、限制高度和左右位置；支持方向键、首尾、搜索、Tab和Esc |
| F11 | 页面导航和旧账号Dock不能混用语义 | 新样板分别使用页面当前项、账号选择状态和动作菜单；外观统一放公共UI，不复制到页面CSS |
| F12 | 最初样板未覆盖密钥/数字/文件/单选以及抽屉编辑保留 | 补齐实际公共输入；文件选择不读取/上传内容；抽屉收起不卸载，键盘与内容保留通过 |
| F13 | 原设计规范层级30/40与现有Modal堆栈不一致 | 规范及token对齐现有1000起、每层递增10的共享管理器，保持原有隔离机制 |
| F14 | 长名称和素材失败容易破坏壳与主操作 | 顶部标签限制宽度，提供完整选择入口；插画保留几何空间，失败后主操作仍可用 |

上述问题在本批覆盖范围内已处理，没有仍待修正的本步阻塞项。下面的业务接入和原生覆盖项属于下一批，不视为已经验收。

## 4. 当前验证结果

| 检查 | 实际结果 |
| --- | --- |
| token同步 | `npm run ui:tokens:check`通过 |
| 类型 | `npm run typecheck`通过 |
| 桌面构建 | `npm run desktop:build`通过；没有执行打包或安装 |
| 全量既有及新增测试 | 120个文件通过，1111项通过、1项既有跳过；最终运行约51.6秒 |
| 公共UI所有权约束 | 通过；业务页未新增原生基础控件或第二套确认框 |
| 浏览器/原生场景 | 17组检查通过，详情见复核JSON |
| 布局 | 1440×960、1280×800、1024×720、819×576、768×900、414×896、375×812、320×780均无页面横向溢出、控件越界或插画加载失败 |
| 隔离Electron | 39.8.10；实测主屏scaleFactor=1.5，即150%；sandbox与contextIsolation开启，nodeIntegration关闭，无产品preload桥 |
| 运行错误和业务请求 | 样板检查未捕获pageerror；未产生账号/实例/事件/Provider业务请求；没有启动产品Core或QQ |
| 生产输出隔离 | 构建只有正式index及现有资源；未包含样板HTML、样板标记或演示密钥 |
| 差异空白 | `git diff --check`通过 |

新增的10项检查分布在 [character-theme.test.tsx](../test/character-theme.test.tsx) 和 [character-tokens.test.ts](../test/character-tokens.test.ts)。浏览器验证覆盖错误关联、焦点、重复激活、长名称、加载尺寸、反馈悬停、草稿取消/放弃、保存中关闭、折叠保留、确认队列、九项菜单、边缘定位、减少动效、素材回退、异步状态、高对比和原生窗口。

运行环境最初在沙箱内出现Vitest/Vite的realpath EPERM、浏览器本地网络访问限制；后续使用已授权的本机执行方式取得以上实际结果。没有将工具未执行或失败的尝试计为通过。

## 5. 后续接入时必须处理的边界

1. **真实页面与菜单仍待迁移。** 当前菜单动作是明确标记的入口样例；正式九项导航、旧深链接、账号选择和全部草稿路径按103/104实施。
2. **主题上下文与控制器位置。** useConfirm捕获hook所在范围，不能改变外层已创建回调的上下文。正式App现有DraftProtectionProvider层级本批未调整；新壳接入时需要同步安排主题和集中导航确认的范围，避免只包Home导致部分确认仍是旧主题。样板验证的是“外层ConfirmProvider、主题范围内DraftProtectionProvider”组合。
3. **真实账号和Agent动作。** 本步只有本页内存样例；跨账号迟到响应、账号移除、Agent写入归属、SSE续传及失败回读仍需真实适配层验证。当前renderer快照查询含`/slots`，102文档列有`/instances`；应复用并核对实际接口，不凭文档替换或增加重复轮询。
4. **旧样式清理。** 仍未替换主页和旧导航，因此没有提前删除其CSS。新壳接管后再按引用删除，并隔离未迁移业务页面。
5. **原生覆盖。** 当前150%缩放的隔离样板通过；125%系统缩放、正式应用托盘退出、完整窗口行为和发行包仍需下一批验证。819px辅助布局不冒充125%系统实测；没有修改用户系统缩放。
6. **人工可访问性。** 已检查键盘链路、错误关联、强制颜色形状与焦点；基础九组配色满足本项目设定的对比度目标。尚未进行完整屏幕阅读器人工验收，不宣称完整标准认证。

## 6. 文件落点与复跑

- 公共UI：`appearance.tsx`、`controls.tsx`、`foundation.tsx`、`modal.tsx`、`confirm.tsx`、`switch.tsx`、`menu.tsx`、`disclosure.tsx`及统一导出。
- 外观：`character-tokens.css`、`character-theme.css`、`navigation-appearance.css`；业务样板CSS负责排列、文字样本与插画位置。
- 样板：`desktop/renderer/ui-workbench.html`、`src/workbench/main.tsx`、`Workbench.tsx`、`workbench.css`。
- 工具：token生成器、浏览器复核脚本、独立原生窗口启动脚本；原生脚本不导入产品main、Core或preload。
- 工程：新增`ui:tokens`、`ui:tokens:check`、`desktop:ui`脚本；renderer构建先生成token；没有新增依赖或替换组件库。

复核脚本需要现有Playwright工具环境，不是生产依赖。可以通过`UI_PLAYWRIGHT_MODULE`指定已有的`playwright/index.js`，通过`UI_CHROMIUM_PATH`指定已有浏览器，通过`UI_WORKBENCH_URL`指定正在运行的本机入口，再执行`node desktop/scripts/verify-ui-workbench.mjs --native`。不自动下载依赖或浏览器。

最新复核同时写到`test-results/ui-workbench/review.json`和设计目录的`workbench-review.json`；最终全量测试日志为`test-results/ui-workbench/vitest.log`。正式页面迁移继续执行103，不把样板数据复制到业务。
