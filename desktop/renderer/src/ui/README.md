# nowadays UI 组件库

前端规范入口：[105共用标准](../../../../devDoc/105-frontend-design-system.md)＋[110晚风深色标准](../../../../devDoc/110-nightwave-ui-standard.md)。深色和浅色共用字体、尺寸、行为与本目录组件；色板、状态、浮层和资产按预置映射。修改前同时遵循仓库与渲染层AGENTS。

Dock已采用[120昼夜手账组件与交互规范](../../../../devDoc/120-dock-notebook-standard.md)，正式PageDock/MoreMenu已迁移：图上文下、纸面/布面索引、项内±1px跟随、悬停/按压与220ms书签移动。参数消费`component.dockNotebook.*`，表面混色、描边与接触阴影已收进token v1.4.0（[134](../../../../devDoc/134-dock-material-tokens-and-workbench-dock-fix.md)）；旧`component.dock.*`值仅保留兼容。接入范围与自验见[127](../../../../devDoc/127-home-and-global-motion-integration-execution.md)，独立复核待做。

公共动效同时遵循[117「书签与落款」规范](../../../../devDoc/117-frontend-motion-standard.md)：书签端片、勾画落款、导航书签、阅读顺序、来源浮层，以及快速中断/减少动效/焦点契约。`component.motion.*`已由本目录组件消费。公共导出包括`MotionPolicyProvider`/`useMotionPolicy`/`createMotionScope`/`readMotionTime`/`readMotionPx`/`readMotionValue`、`ModalLayerProvider`/`createModalLayerManager`，以及`Modal.source/onExited`、`DropdownMenu`的trigger组合、`Button.feedbackKey/resultLabel`。`useMotionPolicy`会合并全局策略与调用处`UiThemeScope`/`UiThemeProvider`的局部motion：局部reduced是不可解除的下限，嵌套显式full也不能解除祖先局部reduced；局部full不能解除全局/系统reduced。嵌套scope继承未指定值，确认请求在发起时捕获已合并的局部外观。勾画的真实业务保存消费者仍待接；扩展公共组件时不要复制样板的原生dialog或标签导航到业务页。

所有业务页面统一从 `../ui` 导入；应用根目录使用 `./ui`。`src/ui.tsx` 是稳定入口，`ui/index.ts` 为导出目录。基础控件仅允许在此目录内部创建原生DOM。

## 已采用的Dock（正式组件已迁移）

PageDock组合公共ControlButton/Icon与现有MoreMenu，样式集中在`dock-notebook.css`，样板见[交互04](../../../../devDoc/design/character-studio/dock-notebook/home-motion-study.html)。图标的抬起/按压与内部跟随分层；文字、命中框与已提交路由保持稳定；`aria-current`表示真实当前页，不用tablist冒充导航。样式统一在ui维护，不在每个页面复制。

白昼采用奶油纸签、樱粉鱼尾和纸面阴影；晚风采用墨蓝布面、细缝线、琥珀上沿与项内暖光。当前项文字为text、图标为entry，旧commit/onSolid实色选中暂留兼容，不能以旧样式反推新目标。

鼠标按120规范处理进入/项内移动/离开、按压/释放/取消；Enter/Space使用原生激活，触摸不留hover，减少动效直接落到静态状态。更多仍打开现有DropdownMenu，只有实际路由属于非直接入口才对齐其选中签；打开菜单不自动导航。草稿确认、Esc/返回焦点、锁定/退出inert与历史行为沿用原契约。样式类名与pointer状态属于组件内部实现，不是新增公共API；浏览器与原生接入证据见[127](../../../../devDoc/127-home-and-global-motion-integration-execution.md)。

| 用途 | 组件 |
| --- | --- |
| 普通文字、密码、数字、模型名及文件输入 | Input（保留原生属性与ref） |
| 搜索与文本过滤 | SearchInput（必须传label，内置图标与搜索样式） |
| 下拉、文本域、勾选 | Select / Textarea / Checkbox |
| 标签与说明 | Field（自动关联label、控件及hint） |
| 普通操作、保存确认、取消返回 | Button / ConfirmButton / CancelButton |
| 仅图标按钮 | IconButton（必须传icon和label） |
| 导航、Dock、折叠行、步骤切换 | ControlButton（布局由对应场景定义） |
| 设置及其他弹窗 | Modal |
| 二次确认 | useConfirm，由根ConfirmProvider提供 |

确认默认主按钮，取消默认次按钮，危险动作使用 `tone:'danger'` 的确认请求及danger按钮变体。按操作语义命名按钮；不要在页面手工写 `btn-*`、`search-box` 或 `icon-btn`。ControlButton不能用来绕过Button手拼普通操作按钮。

```tsx
import { Field, Input, SearchInput, ConfirmButton, CancelButton, useConfirm } from '../ui';

const confirm = useConfirm();
const accepted = await confirm({
  title: '放弃修改？', description: '未保存内容会丢失。',
  confirmLabel: '放弃修改', cancelLabel: '继续编辑', tone: 'danger'
});
if (!accepted) return;
```

`theme.css`集中控制尺寸、圆角、边框、颜色、焦点、禁用和确认弹窗外观；页面CSS仅负责排列、宽度和场景布局。避免追加另一套外观覆盖已有控件。

Modal统一处理背景隔离、最上层Escape、Tab约束、嵌套弹窗与焦点恢复。进入从真实来源小幅位移，退出结束前继续隔离并拦截重复关闭，完成后才恢复背景、滚动和焦点；`source`可显式指定触发点，缺省使用打开时的焦点元素。确认初始焦点位于取消按钮，点击遮罩/关闭/Escape均作为取消。确认返回Promise，必须等待结果并保留取消分支；异步等待后应复验账号、进程等操作目标是否仍有效。设置弹窗沿用原类名、尺寸和布局，不再自带 `settings-appear`；其进入、退出、中断和焦点只由公共 Modal 控制。

Disclosure 的 grid 折叠、内部裁切和 `0fr ↔ 1fr` 结构位于不依赖主题的 `theme.css`；`character-theme.css` 只维护边框、排版、颜色和内容留白，未包 `UiThemeScope` 的调用也必须真正收起。DropdownMenu 退出中重开从取消前复制的绘制快照接续，不回到进入起点；业务页入场只在已提交路由变化时触发，reduced 切换只取消当前动画，不重播。

`test/ui-library-contract.test.ts`使用TypeScript语法树检查页面原生控件、系统对话框和手拼样式，阻止新增重复实现。迁移范围包括当前入口和历史页面，历史页面不会因此重新加入导航。

## 夏澄主题与组件样板

当前支持daylight「白昼来信」与nightwave「晚风电台」，见 [109](../../../../devDoc/109-home-presets-refinement-execution.md)。ThemePresetProvider只保存本机外观，UiThemeScope继承preset并传给Portal，useConfirm按调用时预置排队。顶部主题组不承担QQ账号切换；旧业务页保持尺寸与布局，仅桥接深色调色变量。

实际提交预置时，ThemePresetProvider也通过可选`setWindowTheme`桥同步原生窗口，不影响网页预览降级或天气过渡。原生颜色由token生成的`desktop/window-theme-tokens.ts`维护，不手改；main/preload改动需重启应用。实现见 [116](../../../../devDoc/116-native-window-theme-execution.md)。

昼夜切换共享「晚风翻夜 / 晨光揭晓」：旧页面快照按柔边遮罩退开，新页面保持真实DOM及鼠标命中；叶片/晨光为无焦点、透传输入的独立命名装饰快照。换景400ms、总长550ms取自themeTransition token；减少动效、强制颜色、隐藏窗口或不支持API时直接切换。应用full显式覆盖系统减少动效。连续选择只保留最后目标，不重建编辑器；首屏不播放。见[114实施与验收](../../../../devDoc/114-theme-weather-transition-execution.md)。

总体标准见 [105](../../../../devDoc/105-frontend-design-system.md)，组件阶段复核见 [106](../../../../devDoc/106-ui-foundation-and-workbench-review.md)，正式主页与菜单实施见 [107](../../../../devDoc/107-home-and-shell-implementation-review.md)。开发入口为 `npm run desktop:ui` 启动后打开 `/ui-workbench.html`；不加入正式路由，也不参与默认生产HTML构建。开发样板的导航区直接渲染正式`PageDock`，只切换本地样例状态，不再手拼第二套Dock；见[134](../../../../devDoc/134-dock-material-tokens-and-workbench-dock-fix.md)。

新主题采用显式作用域。按顺序加载 `theme.css`、生成的 `character-tokens.css`、`character-theme.css`；使用 `UiThemeScope theme="xiacheng"` 包住要迁移的界面。未迁移页不要直接放进新主题的DOM范围。`navigation-appearance.css`由新主题导入，统一账号标签、页面Dock和分段选择的外观，页面只管理排列。

`character-tokens.css`由 `devDoc/design/character-studio/tokens.json` 生成：修改JSON后执行 `npm run ui:tokens`，用 `npm run ui:tokens:check` 检查同步；不能手改生成CSS。桌面renderer构建会先生成token。

| 新增或扩展 | 使用约定 |
| --- | --- |
| `UiThemeScope` | 主题及减少动效的局部范围；普通Modal通过React context将其传给body下的Portal |
| `UiThemeProvider` | 只提供React主题上下文；无theme时恢复旧控件上下文，不添加DOM或外观 |
| `Field error` | 自动生成错误ID，关联Input/Select/Textarea的aria-describedby及aria-invalid；自定义ID放在Field上，避免标签和控件不一致 |
| `Button variant="entry"` | 主题入口与箭头端片，白昼手账红/晚风琥珀；提交仍使用primary，危险操作使用danger |
| `Button feedback="error" / "success"` | 与操作附近的结果文案配合；不单用颜色；只使用确认过的结果 |
| `Button busy` | 新主题保留焦点、预留图标空间和原宽度下限，并阻止重复激活；加载文案保持简短，不引入新的长动作名；旧主题仍保留原有原生禁用行为 |
| `Switch` | `label`、`checked`、`onCheckedChange`必填；busy保留焦点并阻止重复；layout默认leading，可选trailing；当前首页没有业务开关；不会自行推断服务端状态 |
| `DropdownMenu` | 菜单动作列表；支持方向键/Home/End/文字搜索/Esc/Tab，窗口边缘定位；账号选择不冒充菜单当前页 |
| `Disclosure` | 受控或非受控折叠；收起只隐藏内容，不卸载编辑器；受控模式需提供onOpenChange |

确认的公共调用API不变。`useConfirm`记录其hook所在范围的主题和动效，每个队列请求保留自己的外观；即使ConfirmProvider位于主题范围外，确认框也能使用调用处的主题。每个请求重新建立Modal，初始焦点回到取消。Modal统一管理背景滚动锁定与恢复。

主题范围以React调用位置为准，不能改变外层已经捕获的回调。正式入口采用UiThemeProvider包住ConfirmProvider与DraftProtectionProvider，让App控制器的全局确认使用新主题；壳的data-ui-palette只提供token值，顶部、主页和底部以UiThemeScope提供局部控件外观。未迁移内容与设置使用空UiThemeProvider并保持在新控件DOM作用域外。不能只给Home加CSS就宣称所有导航确认都已完成主题迁移。

## 折信品牌

`BrandMark`由公共入口导出，读取当前UiThemeScope的外观预置，使用透明底SVG原稿；装饰图片为空alt，由外层品牌按钮提供可访问名称。盒尺寸消费`component.brand.markWidth/markHeight`（34×36px），与字号独立；正式壳与组件样板共用。系统图标和托盘见[123](../../../../devDoc/123-fold-logo-adoption-execution.md)。
