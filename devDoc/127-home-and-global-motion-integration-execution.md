# 主页与全局公共动效接入执行记录（HM-0～HM-4）

日期：2026-10-28。方案：[125](125-home-and-global-motion-integration-plan.md)；验收：[126](126-home-and-global-motion-integration-acceptance.md)。状态：实现方自验完成；独立复核见[128](128-home-and-global-motion-independent-review.md)（3项P2），修复见[129](129-home-and-global-motion-review-fixes.md)，独立复验待做；未提交、未推送、未重打发行包。范围限本地自动化、生产dist与隔离Electron，不含真实QQ、付费模型和正式发行包验收。

> 后续：[128 独立复核](128-home-and-global-motion-independent-review.md)提出3项P2，修复与复验见[129](129-home-and-global-motion-review-fixes.md)。本文件保留修复前的实现方自验数据（1145项、开发28项、生产25项），当前结果以129为准。

## 1. 交付结论

公共按钮、菜单、Modal/确认、Disclosure、Switch、PageDock/MoreMenu 与主页阅读入场已接入同一套动效策略；页面设计只改主页，工作台仅作为公共组件样板更新，其他业务页未重排布局或业务流程。Dock 由 `PageDock` 直接组合公共控件，没有第二套导航、菜单或弹窗实现，也没有新增动画依赖或模块级可变单例。

| 工作包 | 结果 | 主要落点 |
| --- | --- | --- |
| HM-0 策略与层管理 | 完成 | `ui/motion.tsx`、`ui/modal-layers.tsx`、`preferences.ts`、`main.tsx`、`Modal` |
| HM-1 按钮与结果 | 完成 | `ui/foundation.tsx`、`character-theme.css` |
| HM-2 手账Dock | 完成 | `PageDock.tsx`、`MoreMenu.tsx`、`ui/menu.tsx`、`ui/dock-notebook.css` |
| HM-3 浮层/折叠/开关 | 完成 | `Modal`、`confirm.tsx`、`DropdownMenu`、`Disclosure`、`SettingsDialog` |
| HM-4 主页与组合 | 完成 | `Home.tsx`、`HomeScene.tsx`、`App.tsx`、`styles/home.css` |

## 2. 公共策略与生命周期（HM-0）

- 新增 `MotionPolicyProvider` / `useMotionPolicy`。有效偏好统一为：`system` 跟随系统；`reduced` 直接终态；`full` 覆盖系统 reduce。Provider 观察根节点 `data-motion`、`prefers-reduced-motion` 与 `forced-colors`，可选 `preference` 供工作台锁定 reduced；Portal 通过 Context 继承，不依赖主题作用域。
- 新增 `createMotionScope()` 管理 WAAPI：同一元素同一 slot 替换时取消旧动画，卸载时 `cancelAll()`；`readCssTime` 同时解析 `ms` 与压缩后的 `s`，运动参数经 `readMotionTime/Px/Value` 从 CSS token 读取。
- `preferences.ts` 只保留存储读取与 `applyMotionPreference` 转出，实际策略实现在 `ui/motion.tsx`；`main.tsx` 渲染前应用本机偏好，并在应用根装配 MotionPolicyProvider 与 ModalLayerProvider。
- 审计并移除 `ui/modal.tsx` 的模块级 `layers/backgroundState/previousBodyOverflow`。新增 `createModalLayerManager()`：每个 Provider 实例独立持有层栈，负责 `inert`/`aria-hidden`、背景滚动锁、层级与恢复；`Modal` 无 Provider 时退化为自己的实例。多个应用/样板实例互不串扰。
- 活动中切换偏好时，各消费者按同一结论收束：Dock 在 reduced 下重新对齐并取消移动，菜单/Modal 取消自身 WAAPI 进入，主页取消阅读/场景动画，页面包装层直接移除；不依赖等待动画播完。

## 3. 全局按钮与真实结果（HM-1）

- `Button` 新增可选 `feedbackKey` 与 `resultLabel`（默认「已收好」）。成功状态以 `feedbackKey` 作为勾画与落款的重播键：勾画是一次性的 SVG 路径，落款为无焦点的装饰副标；失败仍只保留错误色与警告图标，不出现勾画/落款。
- entry 按钮的端片、尾部、箭头和按压收回全部由 `component.motion.*` 驱动：悬停/`focus-visible` 探出 3px、尾部最多 8px、箭头 2px，按压收回，装饰不裁切也不扩大命中框；普通按钮仍是原 1px 按压语义。
- busy 维持既有宽度与图标槽，`aria-disabled` 阻止重复激活；危险、禁用、导航按钮不获得书签端片外观。
- 真实消费者：Dock 与主页「进入工作台」等入口自动获得端片反馈；现有业务页面没有调用 `feedback="success"` 的真实保存结果输入，工作台样板是当前唯一勾画/落款消费者。**真实业务保存落款仍为待接点**，本轮没有为接落款虚构保存流程或监听请求。

## 4. 手账Dock与更多菜单（HM-2）

- `PageDock` 仍按「桌面 / 关系 / 模型 / 收藏 / 更多」渲染，内部由公共 `ControlButton`、`Icon`、`DropdownMenu` 组合；没有复制路由或菜单项。图标在文字上方；选中书签、hover、按压、指针跟随分层。
- 选中签只跟随已提交路由：导航准入完成前不移动；取消不移动；当前页重复点击不重播；快速反向从当前绘制位置衔接；前进/返回、窗口变化、字体就绪后重新对齐。非直接入口路由把当前签对齐「更多」，并给出 `更多，当前页面：…` 标签；打开更多菜单本身不切页。
- `MoreMenu` 只把图标、ref、class、布局与装饰转交公共 `DropdownMenu`，没有新增嵌套按钮；真实菜单项仍走原导航与草稿准入。
- Dock 视觉集中到新的 `ui/dock-notebook.css`（限定 xiacheng 作用域），`navigation-appearance.css` 删除旧 Dock 规则，`shell.css` 删除与 token 冲突的紧凑覆盖。尺寸消费 `component.dockNotebook.*`：常规 68px、≤599px 64px、≤599px且≤680px 高 58px，单项命中不小于 44px；白昼纸签/鱼尾，晚风布面/琥珀上沿，减少动效直接静态，forced-colors 保留选中与焦点。
- 鼠标进入缓存稳定命中框，跟随每帧至多一次且限制 ±1px；离开、抬键、`pointercancel`、失焦、隐藏、resize 均释放按压；触摸不继承 hover；Enter/Space 仍是原生激活。

## 5. 浮层、折叠与开关（HM-3）

- `Modal` 保持原公开属性，新增可选 `source`（真实触发点）与 `onExited`。进入 220ms 从来源方向小幅位移/缩放，缺少来源或来源断开时退化为中心；退出 160ms，退出完成前继续持有层隔离并拦截重复关闭，结束后才恢复背景、滚动和焦点。Escape 只由层栈顶部响应，关闭中或 `closeDisabled` 不重复 `onClose`；Tab 约束与安全退出行为沿用原契约。
- `useConfirm` 在发起时记录真实焦点来源；活动请求被 abort 时立即呈现下一条；队列中请求被 abort 只移除自身；正常结果经 `onExited` 后再推进下一条，避免透明挡板残留。`SettingsDialog` 不再在关闭瞬间卸载，保证设置弹窗有完整退出。
- `DropdownMenu` 增加可选 `triggerIcon/triggerRef/triggerClassName/triggerLayout/triggerDecoration`，并改为 160ms 进退场；退出期间 `inert` 且不响应重复关闭，进入途中切到 reduced 会取消自身动画并保持可见，Escape/选择后焦点回到 trigger，边缘定位、长菜单内部滚动与键盘行为保留。
- `Disclosure` 保留同一内容 DOM，去掉 `hidden`，以 `data-open`、`inert` 与内部 `.ui-disclosure-content` 做 `0fr↔1fr` 展开；关闭前把内部焦点先还回触发器，再退出 Tab/辅助技术，草稿与选区保留。
- `Switch` 仍是受控真实值，`aria-checked` 不等待动画；CSS 只过渡 thumb 的 `component.motion` 时长，busy 阻止重复切换，减少动效直接落位。工作台样例覆盖展开、关闭、重开与草稿保留；业务页仍使用原有折叠/开关实现，未借本包重设计。

## 6. 主页阅读与组合（HM-4）

- `Home` 保留原插画、文案与只读账号结构，只划三组：叙事标题 → 账号/加载/欢迎 → 主入口。组间 24ms、最大延迟 72ms、总时长不超过 280ms、位移 4px，均从 `component.motion.*` 读取；只在本页真实挂载时播放一次，切主题、轮询、SSE 刷新、错误重试不重播，减少动效立即可读。
- 错误注记移到阅读组之外，移除 `max-height/overflow` 裁切并允许换行；长昵称省略、长签名两行截断，入口不被 Dock 或立绘覆盖，主页仍一屏无纵向滚动。
- `HomeScene` 改用 `useMotionPolicy`，保留既有场景幅度；入场仅在挂载时执行，减少动效、窗口隐藏/失焦、卸载时取消，不新增环境光、纹理或模拟事件。
- `App` 只为非主页的公共页面包装层提供一次轻量进退场（280ms/4px），主页自身负责阅读顺序，减少动效直接跳过；主题切换仍只走既有天气过渡，不重建页面或编辑器。

## 7. 公共 API 与状态边界

| 能力 | 状态 | 真实消费者 |
| --- | --- | --- |
| `MotionPolicyProvider` / `useMotionPolicy` / `createMotionScope` / `readMotion*` | 已导出并接入 | 应用根、PageDock、Home、HomeScene、App、Modal、工作台 |
| `ModalLayerProvider` / `createModalLayerManager` | 已导出并接入 | 应用根、工作台；`Modal` 无 Provider 时自持实例 |
| `Modal.source/onExited` | 已导出 | `useConfirm`；现有业务 Modal 无需改动 |
| `DropdownMenu` trigger 组合 | 已导出 | `MoreMenu`；其他菜单调用方式不变 |
| `Button.feedbackKey/resultLabel` | 已导出 | 工作台样板；真实业务保存结果待接 |
| 公共 `Disclosure` / `Switch` | 已更新 | 工作台样板；业务页原生折叠/自有分段控件未迁移 |
| `component.dockNotebook.*` / `component.motion.*` | 已由正式组件消费 | PageDock、Modal、Menu、Button、阅读组与主页场景 |

token 数值与生成文件未手改；`npm run ui:tokens:check` 通过。抽屉仍无真实消费者，未为本轮发明页面或业务入口。

## 8. 失败与修复

1. Dock 页面切换后选中签动画在 1ms 内被取消。根因是 resize/字体观察回调依赖 `align` 身份，切页时重跑并取消新动画；改为观察器只在挂载时建立、回调走 `alignRef.current(false)`，并新增“切换过程中确有动画”的断言。
2. 折叠内容收起后仍占 48px 高度。根因是 `overflow:hidden` 的内层自身带 padding；把 padding 移到新内层 `.ui-disclosure-content`，实测收起 0px、展开 120px。
3. 隐藏 Electron 窗口不推进 WAAPI 时间轴，弹窗取样停在 `opacity:0`；仅为原生检查增加 `animation.finish()` 收口。隐藏窗口的 `capturePage` 还会滞后一帧，改为先触发一次截图再取图，弹窗与夜间截图才对应真实状态。
4. 原生脚本用程序化 `.click()` 打开设置，Chromium 不会因此聚焦触发点，退出后焦点落回 `body`；真实指针/键盘激活会先聚焦。脚本改为先 `focus()` 再点击，应用焦点恢复逻辑未放宽。
5. Node 渲染层测试没有 DOM，`useConfirm`/`Modal` 捕获触发点与 Portal 会触发 `HTMLElement is not defined`；相关访问加 `typeof HTMLElement` 保护，并新增层栈的独立 DOM 桩测试。
6. CDP 用 `Network.setBlockedURLs` 屏蔽图片时破坏了 Vite 图片模块，页面空白；改用 `Fetch` 只对 `resourceType=Image` 失败，并轮询应用就绪后再取数。
7. 新增公共导出导致两个既有渲染层 mock 缺少 `useMotionPolicy` 等符号；补齐桩后原导航/退出断言不变。
8. 途中切换的弹窗检查最初把 `Element.getAnimations()` 默认包含后代的动画误算作弹窗自身动画，并对既有非 xiacheng 设置弹窗的 `settings-appear` 要求为零；改为只读取组件根，自身 WAAPI 必须清零，旧 CSS 动画允许为已 finished 的 0.01ms 终态，同时继续校验 opacity/transform/隔离。

## 9. 验证结果

最终门控（全部在最终工作树上执行）：

| 命令 | 结果 |
| --- | --- |
| `npm run ui:tokens:check` | Character tokens: up to date |
| `npm run typecheck` | 通过（test + 主进程 + 渲染层） |
| `npm test` | 124 文件、1145 项通过、1 项既有跳过 |
| `npm run desktop:build` | 通过（renderer + main/preload） |
| `git diff --check` | 无空白错误 |

稳定性备注：首次将 `npm test` 与 `npm run typecheck` 并行启动时，Vitest 汇总出现 2 个 worker 错误且未给出失败用例（收集到 122 文件/1126 项）；随后单独运行及再次并行复跑均为 124 文件/1145 项通过/1 项跳过，未改代码。记录为当时环境波动，仍需在独立复核时留意。

浏览器驱动（Chrome CDP，假数据 fixture，未接触真实QQ/模型）：

- Vite 开发版：28/28 检查通过。覆盖主页三组阅读、Dock 尺寸/命中/端片/跟随/按压/路由提交与不重播、更多菜单真实项/Escape/焦点、非直接入口对齐、设置弹窗进入/隔离/退出/焦点、双主题、减少动效立即收口、**Dock移动/菜单与弹窗进入途中切换 reduced 的即时收束**、1280/1024/600/599/599×680/360/320 视口、system/reduced/full 的 CSS 与 JS 一致、工作台成功勾画/落款、折叠草稿与焦点、开关 busy、长身份、缓存失败重试、无账号、图片失败回退。
- 生产 `desktop/renderer/dist`（自定义静态服务 + fixture 代理）：25/25 检查通过；工作台为开发入口，生产检查未包含其 3 项。
- 途中切换检查的结果：Dock 选中签从运行中的移动直接落到目标且动画清零；菜单清空自身动画并保持展开可见；设置弹窗被取消进入动画、保持背景隔离与滚动锁。设置弹窗是既有非 xiacheng 门户，其旧 `settings-appear` 在 reduced 下由全局策略压成 0.01ms 并已 finished，计算样式为 opacity 1/transform none，按“已收束”记录，不把该旧 CSS 动画计为运行中。
- 证据文件：`test-results/hm/report.json`、`report-prod.json`、截图 `01`～`08`。控制台中的 503/404 来自故意失败 fixture 与 favicon，`ERR_FAILED` 来自故意阻断的图片，检查本身 0 失败。

隔离 Electron 原生窗口（无 preload/Core/托盘/应用数据，使用生产dist）：

| 场景 | 结果 |
| --- | --- |
| 100% 缩放，1440 CSS 视口 | DPR 1；Dock 358×68，五项各 64×54；无文档纵向滚动；晚风书签旗 22×2；设置弹窗打开时背景 `inert`/滚动锁定，Escape 后弹窗移除、滚动恢复、焦点回到设置按钮 |
| 125% 缩放，1152 DIP 窗口（1155×722 CSS） | DPR 1.25；Dock 358×68、项 64×54、无滚动；面板宽 1099.2 的小数像素下仍完整；夜间材质与弹窗隔离/退出/焦点通过 |
| 125% 缩放，1440 CSS 视口 | DPR 1.25；CSS 视口 1443×902；Dock 68px、项 64×54、无滚动；夜间材质与弹窗隔离/退出/焦点通过 |

证据文件：`electron-1.json`、`electron-1.25.json`、`electron-1.25-css1440.json` 及同名前缀的 daylight/nightwave/settings 截图。隐藏窗口的连续动画不纳入原生证据，连续中断由浏览器驱动断言；原生证据用于布局、命中框、缩放、隔离与终态。

## 10. 尚未覆盖与后续

- 独立复核未做。本记录是实现方自验，不能替代 [126](126-home-and-global-motion-integration-acceptance.md) 的独立检查与复核记录。
- 真实业务保存结果尚无消费者，勾画/落款仅在公共层与工作台样板验证；不得据此宣称业务保存已接入。
- 真实业务页的公共 `Disclosure`/`Switch` 消费者未迁移；Extensions 仍使用自身分段控件，旧页原生 `<details>` 保持布局不变。抽屉仍后置。
- 原生窗口的草稿取消/退出组合、真实触屏 `pointerType`、真实 QQ/模型和正式安装包未在本轮验证；125% 的两种窗口模型均在隐藏窗口取样，未做人工可见交互。
- 其他页面未重设计；公共控件影响已做工作台、设置和旧页代表性回归，但不代表这些页面设计通过验收。

## 11. 规范与导航回写

已同步 [105](105-frontend-design-system.md)、[110](110-nightwave-ui-standard.md)、[117](117-frontend-motion-standard.md)、[120](120-dock-notebook-standard.md)、公共UI README、根 DESIGN/README、渲染层 AGENTS 与 `devDoc/README.md` 的接入状态：Dock、书签端片、导航书签、分层阅读、来源浮层与策略/层管理标记为已接入；真实保存结果消费者、业务页 Disclosure/Switch、抽屉和发行包保持未接入/后置。125/126 仅回写状态并指向本记录，方案与验收门槛不变。
