# 307 前端设计规范

2026-11-12。本文是桌面渲染层（`desktop/desk-preview/renderer/src`）的统一设计规范，把已有的 `--nd-*` 设计令牌、`ui/` 组件和 motion-detail 动效与细节规范（演示稿 `nowadays-motion-demo/motion-detail-spec.md`，结论已并入第 6 节）合在一处，并说明由 `npm run lint:styles` 强制的检查规则。

## 0. 先读这里

- **先用令牌，再用组件，最后才写样式。** 字体、间距、圆角、阴影、时长、曲线、颜色都有令牌；按钮、输入框、菜单、弹窗、开关、折叠区都有现成组件（第 8 节）。页面可以排布组件，不重写组件外观。
- **令牌的唯一来源是 [`design/character-studio/tokens.json`](design/character-studio/tokens.json)**。`ui/character-tokens.css` 由 `npm run tokens`（`desktop/scripts/generate-character-theme.mjs`）生成，不手改；`npm run tokens:check` 检查二者是否同步。
- **样式里禁止直接写**字体栈、`cubic-bezier()`、`ms`/`s` 时长、十六进制与 `rgb()`/`hsl()` 颜色、带模糊的 `box-shadow`、`border-radius` 的 px 字面量（第 11 节）。确需例外，写带原因的豁免注释。
- 自检：在 `desktop/desk-preview/renderer` 运行 `npm run check`（令牌同步 + 样式检查 + 类型检查），`desktop/desk-preview` 的 `npm test` 也包含样式检查。

## 1. 字体

### 1.1 字体角色（`--nd-semantic-font-*`）

| 角色 | 令牌 | 用在哪里 | 字体栈（取自 tokens.json） |
| --- | --- | --- | --- |
| 正文 | `--nd-semantic-font-body` | 界面文字、按钮、输入框、说明 | Segoe UI Variable Text → Microsoft YaHei UI → … → 无衬线 |
| 标题 | `--nd-semantic-font-heading` | 页面与分区标题（目前与正文同栈，保留角色以便分开调整） | 同正文 |
| 展示 | `--nd-semantic-font-display` | 首页大标题、品牌展示 | Segoe UI Variable Display → … |
| 等宽 | `--nd-semantic-font-code` | 编号、时间、代码、手账里的小号标签 | Cascadia Mono → Consolas → … |
| 手写 | `--nd-semantic-font-hand` | 手账/藏书票里的署名、批注、手写感短句 | WJ Hand → KaiTi → STKaiti → … |
| 书名 | `--nd-semantic-font-title` | 藏书票、手账的书名式标题 | WJ Title → SimSun → Songti SC → serif |

- 项目字体 WJ Hand / WJ Title 的 `@font-face` 目前在 `ui/relationship-journal.css`（字体文件在 `assets/relationship-journal/`），页面只引用令牌，**不得再写 `"WJ Hand"` 之类的字体名**，也不得在页面里另起 `--hand`、`--title`、`--f-mono`、`--mono`、`--sans` 这类别名（旧别名已全部移除，检查会拦截字体栈写在自定义属性里）。
- 手写/书名只用于装饰性短文本，不用于长段正文、表单和按钮。
- 按钮与输入框的字体已由 `--nd-component-button-font` / `--nd-component-input-font` 指向正文；其余表单控件写 `font-family: inherit`。

### 1.2 字号与行高（`--nd-semantic-type-*`）

| 档位 | 字号 / 行高 | 用法 |
| --- | --- | --- |
| hero | 44 / 54 | 首页主标题 |
| page | 32 / 40 | 页面标题（`.studio-page-heading h1`） |
| section | 20 / 28 | 分区标题 |
| subtitle | 16 / 24 | 小节标题、突出说明 |
| body | 14 / 22 | 正文、列表、说明（默认） |
| control | 13 / 20 | 按钮、输入框、菜单项 |
| caption | 12 / 18 | 辅助说明、时间、状态 |

字重只用 `type-regular`（400）、`type-emphasis`（600）、`type-heading`（700）。时间、日期、计数等数字用 `font-variant-numeric: tabular-nums`，避免跳动。图标线宽现为 1.7（`Icon`），动效规范建议 1.5 与 400 字重对齐，尚未采纳。中文正文行高不低于 1.6；长文本阅读区（对话、日记）按页面需要放宽，但要写成该页面的组件令牌，不在页面里临时试数。

## 2. 间距网格

间距以 4px 为基本单位，`--nd-primitive-space-*`：4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64。语义别名：

| 令牌 | 值 | 用法 |
| --- | --- | --- |
| `space-icon-label` / `space-label-field` | 8 | 图标与文字、标签与输入框 |
| `space-field-hint` | 4 | 输入框与提示 |
| `space-field-group` | 16 | 表单字段之间 |
| `space-panel-inset` | 24 | 面板/弹窗内边距 |
| `space-section` | 32 | 分区之间 |
| `space-page-inset` / `-compact` / `-narrow` | 32 / 20 / 16 | 页面左右留白（常规 / 窄 / 更窄） |

新代码的 `padding` / `margin` / `gap` 取网格值；确需 2px、6px、10px 这类半步值时，只限图标内部微调和装饰元件，并写清用途。当前页面样式里仍有大量历史间距字面量，检查规则暂不覆盖间距（见第 12 节）。

## 3. 圆角

| 令牌 | 值 | 用法 |
| --- | --- | --- |
| `radius-tick` | 2px | 刻度、胶带、细条、纸角 |
| `radius-chip` | 4px | 标签、小块、纸片 |
| `radius-action` | 8px | 按钮、列表项、小控件 |
| `radius-field` / `radius-surface` | 12px | 输入框、面板、卡片、菜单、弹窗 |
| `radius-card` | 16px | 大卡片、图片框 |
| `radius-navigation` | 24px | Dock、大面板 |
| `radius-round` | 999px | 胶囊、圆形头像 |

百分比（`50%`）、`0` 与 `var()`/`calc()` 不受限制。组件级令牌（`--nd-component-button-radius` 等）已指向上表，页面优先用组件令牌。本规范把原来混用的 2/3/4/5/6/7/8/9/10/11/12/13/14/15/16/17/18/20/22/24px 收敛到上表 7 档（9px 与 10px 归入 8px，13px 归入 12px，14px 归入 12px，15～18px 归入 16px，20～24px 归入 24px）。

## 4. 阴影与层级

### 4.1 阴影（`--nd-semantic-shadow-*`，白天与晚风各一套）

| 令牌 | 用法 |
| --- | --- |
| `shadow-rest` | 静止的纸张/卡片：近处实、远处虚的双层阴影 |
| `shadow-hover` | 可点击卡片悬停、粘性操作条 |
| `shadow-raised` | 菜单、下拉、浮层（`--nd-component-menu-shadow`） |
| `shadow-overlay` | 弹窗、设置对话框（`--nd-component-modal-shadow`） |
| `shadow-focus-halo` | 焦点外圈光晕，叠在 `outline` 之外（`--nd-component-focus-halo`） |

- 夜间由 `presets.nightwave.primitive.shadow` 提供同名的一套（纯黑底色、不透明度更高）。`box-shadow: var(--nd-semantic-shadow-rest)` 在两个预置下都不需要再写覆盖。
- 无模糊的描边环（`0 0 0 2px var(--…)`、`inset 0 0 0 1px …`）和 `none` 不受限制，可以直接写。
- 带模糊的阴影必须用上表令牌；手账、藏书票、配置书里按「每件纸」调校的纸感阴影是历史豁免（第 11.4 节）。

### 4.2 层级（`--nd-semantic-layer-*`）

`base 0 → scene 1 → shell 10 → popover 20 → modal 1000 → nested-modal 1010 → notice 1020 → tooltip 1030`。`z-index` 只用这些令牌，不写裸数字。

## 5. 颜色

- **只用语义色**：`--nd-semantic-color-*`（canvas / surface / text / text-muted / line-decorative / line-control / selection / accent-decorative / commit / entry / focus / success / warning / danger 及各自的 surface、hover、depth / disabled-* / backdrop）。页面里不写十六进制与 `rgb()`；需要半透明用 `color-mix(in srgb, var(--nd-semantic-color-…) 40%, transparent)`。
- **昼夜规则**
  - 昼夜由 `data-ui-preset="daylight|nightwave"` 切换，所有语义色在两个预置下各有取值；页面不要用 `@media (prefers-color-scheme)` 或自己的 `.dark` 类。
  - **图片不随主题重新着色**：立绘、角色图、场景图不加 `filter`/`mix-blend-mode` 去适配昼夜；只调整它们周围的纸、边框、阴影。品牌符号按预置选 `fold-light.svg` / `fold-dark.svg`（`BrandMark`），这是换图，不是着色。
  - **切换结束时不闪**：昼夜切换由 `ui/theme-transition.ts` 的视图过渡完成，结束帧必须与新主题静止帧一致。不要给根节点或页面容器加只在过渡里存在的背景，不要在切换结束后再追加一次颜色过渡。
  - 页面内部自带局部昼夜（如藏书票的 `data-theme`）时，局部色与全局预置要成对翻转，不能只改一半。
- **减少动效 = 瞬时**：见 6.5。
- 状态色只表达状态（成功/警告/危险），不作装饰；装饰用 `accent-decorative`、`selection`。
- 颜色对比：正文与背景至少 4.5:1，辅助文字至少 3:1；强制颜色模式（`forced-colors`）下边框与焦点环已有兜底，新组件需照做。

## 6. 动效

本节合并自 motion-detail 规范（`nowadays-motion-demo/motion-detail-spec.md`）：三档时长、进入慢出退出快收、只用位移加淡入、一次只动一处、减少动效即瞬时、材质靠阴影不靠变色。规范演示稿用 `--md-*` 变量，这里改由 `--nd-semantic-motion-*` 承载，取舍见 6.6。

### 6.1 三档时长 + 退出档（`--nd-semantic-motion-*`）

| 档位 | 进入 | 退出（约 0.75×） | 用法 |
| --- | --- | --- | --- |
| 微交互 | `micro` 120ms | `micro-exit` 90ms | 悬停、按下、焦点环、图标转向 |
| 组件 | `component` 220ms | `component-exit` 160ms | 展开/收起、菜单、筛选切换、弹出层 |
| 页面 | `page` 360ms | `page-exit` 260ms | 页面切换、共享元素过渡 |
| 补充 | `linger` 600ms | — | 非交互的状态淡出（如「新」标记看过后） |
| 补充 | `decay` 1400ms | — | 数据刷新高亮褪去 |
| 场景 | `scene` 900ms / `scene-long` 1800ms | — | 手账翻页、藏书票等编排型场景（只用于有编排的页面） |
| 常驻 | `ambient` 12s | — | 呼吸、漂浮等环境循环（周期 ≥10s，且必须能被 reduced 关掉） |
| 错峰 | `stagger` 35ms / `stagger-fine` 16ms | — | 逐项延迟的步长（首屏错峰最多 6 项，总长 ≤300ms） |
| 主题 | `theme-reveal` 400ms / `theme-total` 550ms | — | 昼夜视图过渡，仅 `theme-transition.ts` 使用 |

旧名 `feedback`（=micro）、`control`（=component-exit）、`disclosure`（=component）保留为别名，新代码用档位名。

**规则**：

- 新增动效先在三档里选；退出用对应退出档，退出比进入快。选不到才考虑补充档/场景档，且要写明理由。
- 不写 `120ms` 这类字面量，也不写 `0.3s`；时长通过令牌引用，才能被减少动效统一归零。
- 编排型动画里的 `animation-delay` 用 `calc(var(--i) * var(--nd-semantic-motion-stagger))`，不手写毫秒。
- 与 TS 定时器耦合的时长（如关闭动画结束后卸载节点）必须在 TS 里用 `readMotionTime(element, '--nd-component-motion-…', 兜底值)` 读同一个令牌，不要 CSS 写一个数、TS 再写一个数。

### 6.2 曲线（`--nd-semantic-motion-ease-*`）

| 令牌 | 值 | 用法 |
| --- | --- | --- |
| `ease-out`（别名 `ease`） | cubic-bezier(0.2, 0.8, 0.2, 1) | **进入**：先快后慢。默认曲线 |
| `ease-in` | cubic-bezier(0.4, 0, 1, 1) | **退出**：先慢后快 |
| `ease-standard` | cubic-bezier(0.4, 0, 0.2, 1) | 位置在两端来回移动（滑块、双向滑动） |
| `ease-overshoot` | cubic-bezier(0.3, 1.3, 0.5, 1) | **有意回弹**：仅书签、印章等需要落定感的元件；新页面不用 |

没有第五种曲线。不要写 `cubic-bezier()`；线性循环（旋转、扫光）用 `linear`。

### 6.3 位移与克制

- 位移 4–8px + 淡入即可；不用缩放弹跳。`--nd-semantic-motion-detail-*` 里有现成的位移量（`page-offset`、`press-offset`、`modal-offset-x/y`、`modal-scale`、`drawer-offset` 等），引用它们。
- 唯一用到 `scale` 的是按钮按下（只压不弹，≈0.98）和弹窗进入（`modal-scale`）。
- 首屏错峰：每项 35ms、最多 6 项、单项 120ms，总计不超过 300ms。
- **同屏同时只有一处在动**：首屏错峰、「新」标记淡出、刷新高亮这类非用户触发的动效排队一个接一个；用户直接触发的交互（悬停、按下、展开、跳转）永远立即响应、不排队。常驻环境动效周期 ≥10s（`ambient`），通道忙时暂停。
- 动画尽量只改 `opacity` 和 `transform`（及项目已有的 `translate` 属性），不动画 `width`/`height`/`top`/`left`。折叠区使用已有的 `grid-template-rows: 0fr → 1fr` 方式（`Disclosure`）。
- 共享元素过渡用 View Transition（`document.startViewTransition()`），同名组使用 `page` 档 + `ease-out`；不支持或减少动效时直接切换。
- 不要用动效传达唯一信息（关闭动效后信息必须仍然完整）；不要给图片加滤镜或随明暗切换变色。

### 6.4 JS 动画

通过 `ui/motion.tsx` 的 `readMotionTime / readMotionValue / readMotionPx` 读取令牌，`createMotionScope()` 持有并统一取消动画；不要在组件里写死 `duration: 220`、`easing: 'cubic-bezier(…)'`。

### 6.5 减少动效 = 瞬时

- 判定：`html[data-motion="reduced"]`，或系统请求减少动效且 `html` 未显式设为 `full`（`ui/motion.tsx`）。
- 实现：`ui/motion-reduced.css` 在这两种条件下把全部「档位」令牌（micro…scene-long、stagger、旧别名）归零；因此用令牌写的 `transition`/`animation` 自动瞬时。`ambient` 与 `theme-*` 不归零：环境循环由各组件在 reduced 下自行停止，主题切换由 `theme-transition.ts` 单独判断。
- 瞬时的意思是**没有位移、没有淡入淡出、没有延迟**，不是缩短。除了时长归零，位移类写法（`translate`、`transform`）要配 reduced 下的「不移动」覆盖，参考 `ui/dock-notebook.css`、`ui/character-theme.css` 的 reduced 段。
- 检查脚本允许 `0.01ms` 这类 ≤1ms 的值，用于全局兜底（`animation-duration: .01ms !important`）。

### 6.6 与演示稿（motion-detail-spec）的取舍

- 时长、退出档、`linger`、`decay`、`ease-out`、`ease-in`、错峰步长 35ms 与演示稿一致；演示稿的 `--md-*` 变量不再单独存在，由上表令牌承载。
- 页面档由旧的 280ms 改为 360ms；旧 `control`（160ms）并入退出档（`component-exit`），旧 `feedback`（120ms）= `micro`。
- 页面位移量仍是仓库现有的 4px（`motion-detail-page-offset`），演示稿建议的 8px 尚未采纳。
- 演示稿主张「没有 y>1 的曲线」；仓库里书签、印章等有意回弹的元件保留，收敛为唯一的 `ease-overshoot`，并限定用途。
- 演示稿的 `--md-hairline`、`--md-skeleton-*`、`--md-flash` 未入令牌。

## 7. 交互状态

适用于所有可交互元素，沿用 `ui/character-theme.css` 的现行实现：

| 状态 | 规则 | 令牌/实现 |
| --- | --- | --- |
| 默认 | 纸面 + 1px 描边 | `color-surface`、`color-line-control` |
| 悬停 | 卡片/纸签：**不改颜色**，阴影从 `shadow-rest` 加深到 `shadow-hover` 并抬起 1–2px；离开用退出档 + `ease-in`。现有 `Button` 等控件悬停变底色，沿用现状。只在有悬停能力的设备生效（`@media (hover: hover)`） | 进入 `micro` + `ease-out`，离开 `micro-exit` + `ease-in` |
| 按下 | 现有控件向下压 1px（`translateY`，`--nd-semantic-motion-detail-press-offset`），主按钮的深色底边收窄；新的卡片/按钮可用 `scale(0.98)` 轻压，松开回到 1，只压不弹；不放大 | `micro` 档 |
| 键盘焦点 | **只在 `:focus-visible` 显示**：`outline: var(--nd-component-focus-width) solid var(--nd-component-focus-color); outline-offset: var(--nd-component-focus-offset)`（2px 实线、偏移 2px）；需要更醒目时再叠 `box-shadow: var(--nd-component-focus-halo)` | 强制颜色模式下改用 `Highlight` |
| 禁用 | 底色 `color-disabled-surface`、文字 `color-disabled-text`、`cursor: not-allowed`，**不用降低 opacity** 表示禁用；`aria-disabled` 与 `disabled` 同样处理 | |
| 忙碌 | 保留可聚焦，`aria-busy`；按钮宽度不抖动（`Button` 已锁最小宽度），重复触发被拦截 | `Button busy`、`Switch busy` |
| 选中 | `color-selection` 底；菜单/导航用 `--nd-component-menu-selected-background`、`--nd-component-dock-selected-*` | |
| 错误 / 成功 | 错误用 `danger` + `danger-surface`；成功用 `success` + `success-surface`；同时有图标或文字，不只靠颜色 | `Button feedback` |

不要用 `outline: none` 去掉焦点环；点击的 `:focus` 不显示环，键盘的 `:focus-visible` 必须显示。

## 8. 组件目录

下表只列 `desktop/desk-preview/renderer/src/ui/` 中实际存在的导出（`import { … } from '../ui'`），属性以源码为准；组件的「夏澄」外观需要放在 `UiThemeScope`（或 `UiThemeProvider`）内才启用，旧页面不在其内时保持旧样式。

| 组件 | 文件 | 用法要点（真实 API） |
| --- | --- | --- |
| `Button` | `foundation.tsx` | `variant: 'default' \| 'primary' \| 'danger' \| 'ghost' \| 'entry'`；`size: 'sm' \| 'md'`；`busy`、`icon: IconName`；`feedback: 'error' \| 'success'` 配合 `feedbackKey`（相同键不重复播放）与 `resultLabel`（默认「已收好」，传 `false` 关闭落款）。业务动作一律用它；`entry` 是带书签箭头的入口按钮 |
| `ConfirmButton` / `CancelButton` | `actions.tsx` | 默认文案「确认」(primary) / 「取消」(default)，其余同 `Button` |
| `IconButton` | `actions.tsx` | 必填 `icon`、`label`（成为 `aria-label` 与 `title`），`size` 默认 17 |
| `ControlButton` | `controls.tsx` | 无外观的按钮原语（`type="button"`），用于导航/折叠触发；业务动作不用它 |
| `Input` / `Checkbox` / `Select` / `Textarea` | `controls.tsx` | 在 `Field` 内自动取得 `id`、`aria-describedby`、`aria-invalid`；`Input` 的 `type` 为 checkbox/radio/file/hidden/range/color 时用 `ui-input-<type>` 样式 |
| `Field` | `controls.tsx` | `label`（必填）、`hint`、`error`、`id`；错误态自动加 `field-invalid` 并置 `aria-invalid` |
| `SearchInput` | `controls.tsx` | 必填 `label`（`aria-label`），内置搜索图标 |
| `Switch` | `switch.tsx` | 受控：`checked`、`onCheckedChange`、必填 `label`；`busy`（显示「更新中…」并拦截重复触发）、`layout: 'leading' \| 'trailing'`；`role="switch"` |
| `Disclosure` | `disclosure.tsx` | `title`、`description`、`defaultOpen` 或受控 `open` + `onOpenChange`、`disabled`；折叠时内容保持挂载但 `inert`，焦点回到触发器 |
| `DropdownMenu` | `menu.tsx` | `label`、`items: MenuItem[]`（`{ id, label, icon?, disabled?, onSelect }`）、`currentLabel`；触发器可定制：`triggerIcon`、`triggerRef`、`triggerClassName`、`triggerLayout: 'inline' \| 'stacked'`、`triggerDecoration`。操作菜单，不用于账号选择或页面导航语义 |
| `Modal` | `modal.tsx` | `open`、`title`、`description`、`onClose`、`closeDisabled`、`className`/`backdropClassName`/`headerClassName`、`eyebrow`、`headerExtra`、`role: 'dialog' \| 'alertdialog'`、`source`（进入动画的出发元素）、`onExited`；自带背景隔离、焦点陷阱、Esc、焦点恢复、进退场 |
| `ModalLayerProvider` / `createModalLayerManager` / `useModalLayerManager` | `modal-layers.tsx` | 应用级持有弹窗栈（背景 `inert`、滚动锁、层级随栈顶）；无模块级可变状态 |
| `ConfirmProvider` + `useConfirm()` | `confirm.tsx` | `const confirm = useConfirm(); const ok = await confirm({ title, description, confirmLabel?, cancelLabel?, tone?: 'default' \| 'danger', signal? })`；并发请求排队，必须在 `ConfirmProvider` 内 |
| `Card` | `foundation.tsx` | `title`、`subtitle`、`actions`、`children`、`className` |
| `Empty` | `foundation.tsx` | `icon`（默认 `package`）、`title`、`description`、`action` |
| `ErrorNote` | `foundation.tsx` | `message`、`onRetry`（带「重试」按钮）；`role="alert"` |
| `StatePill` / `Tag` | `foundation.tsx` | `StatePill state={InstanceState}` 带语义色与文案；`Tag tone` |
| `AsyncBoundary` / `LoadingNote` | `async-state.tsx` | `loading`、`error`、`hasData`、`empty`、`onRetry`、`loadingText`、`errorPrefix`：只有「成功且确认无数据」才显示空态；有旧数据时错误显示在内容上方 |
| `Icon` | `icons.tsx` | `name: IconName`（`overview slots accounts artifacts messages activity settings play stop plus trash refresh send warning copy check close chevron more radio folder search clock shield bolt terminal user package speaker history image tune down person locate chev-left chev-right chev-up chev-down calendar reset upload sun moon`）、`size`（默认 18）；描边 1.7、`currentColor`。不够用先补进 `icons.tsx`，不要内联 SVG |
| `BrandMark` | `brand-mark.tsx` | 折信符号，按预置选亮/暗图，34×36 |
| `UiThemeScope` / `UiThemeProvider` | `appearance.tsx` | `UiThemeScope theme="xiacheng" preset? motion? className?` 渲染作用域节点（`data-ui-theme`、`data-motion`、`data-ui-preset`）；`UiThemeProvider` 只提供上下文。`reduced` 是不可解除的下限，后代 `full` 不能覆盖 |
| `useThemePreset` / `ThemePresetProvider` | `presets.tsx` | 昼夜预置 `daylight \| nightwave` 的读取与切换；页面可用 `useThemeTransitionStrategy` 注册自己的切换演出 |
| 动效辅助 | `motion.tsx` | `useMotionPolicy()`、`createMotionScope()`、`readMotionTime/Value/Px` |
| 焦点辅助 | `focus.ts` | `canReceiveFocus(el)`、`focusableControls(panel)`（弹窗/菜单的 Tab 陷阱共用） |
| 壳层组件 | `components/shell/` | `PageDock { page, onNavigate }`（桌面/关系/对话 + 「更多」）、`MoreMenu`（基于 `DropdownMenu` 的页面更多入口）、`ThemeSwitcher { disabled? }`（昼夜切换） |

**用法原则**

1. 需要按钮就用 `Button`，不要给 `<button>` 起新类名重画一遍；页面只通过 `className` 做**布局**（宽度、对齐、间距），不改颜色、圆角、阴影、字体。
2. 表单一律 `Field` + `Input/Select/Textarea`，不要手写 `<label>` 和提示的 `aria-describedby`。
3. 浮层只有两种：`DropdownMenu`（轻量操作菜单）和 `Modal`（需要隔离背景的对话）。确认类提示走 `useConfirm()`。
4. 新页面需要的组件在表里找不到时，先扩 `ui/`（并补本表），再在页面里用；不要在页面里复制一份。
5. 组件的外观由 `character-theme.css` 的 `[data-ui-theme="xiacheng"]` 选择器统一定义，组件令牌在 tokens.json 的 `component.*`（button、entryButton、input、focus、dock、menu、modal、switch、disclosure、notice、brand、motion）。

## 9. 页面布局原则

- **一级页面（主页、关系、对话等）以留白为主，适度装饰。** 一个视口里只有一个视觉重心；装饰（纸感、胶带、手写字、淡色渐变）服务于重心，不堆叠。装饰元件放在页面自己的样式里，用令牌取色，不引入新色板。
- **窗口尺寸**：桌面程序默认 1440×840，最小 720×540，常用验收尺寸 **1440×840 / 1280×800 / 720×540**，新页面三种尺寸都要看过（昼夜各一遍）。窄屏断点沿用 `styles/shell.css` 的 1199 / 959 / 599 / 高度 600。
- **外壳结构**：`.studio-shell` 三行网格（页头 / 内容 / 底部 Dock）。内容区左右留白用 `space-page-inset`（≥1200 常规 32px，窄屏用 `-compact`/`-narrow`），首页最大宽度 1560px，其他页面内容容器自己限制最大宽度。
- **Dock 与浮层**：Dock 高度 `size-dock`（72px，紧凑 64px），底部区域预留 `size-dock-zone`（104px）；菜单 `layer-popover`，弹窗 `layer-modal`。
- **文字区**：正文行宽约 36–42 个汉字，长文本不满铺容器；标题 `page` 档，正文 `body` 档，辅助 `caption` 档。
- **不发明内容**：角色台词、旁白、占位文案都不得自行编写，缺内容用 `Empty` 的真实空态文案。
- **图片**：立绘与场景图保持原色和比例（`object-fit`），不随主题改色；只给图片外的容器换纸与边框。
- **留余量**：三种尺寸下文字不得被截断到不可读，必要时折行或换成两行布局，而不是缩小到小于 `caption`（12px）。

## 10. 令牌命名与新增流程

### 10.1 三层结构

`tokens.json`（格式 `nowadays.design-tokens/1`）分三层，生成 CSS 变量 `--nd-<层>-<路径 kebab>`：

1. **primitive**：原始值（色板、字体栈、像素、时长、阴影）。只有这一层写字面量。
2. **semantic**：语义名，**必须以 `@primitive.x.y` 整值引用 primitive**（如 `semantic.radius.action → @primitive.radius.action`）。页面和组件样式引用这一层。
3. **component**：组件私有名，**必须引用 semantic**（如 `component.menu.shadow → @semantic.shadow.raised`）。

**令牌的有效范围**：`--nd-*` 只在主题作用域（`[data-ui-theme="xiacheng"]`、`.ui-modal-backdrop` 及其后代）里有值；例外是字体与圆角令牌（不随昼夜变化），生成器另在 `:root` 输出一份，供 `body`、`:root` 级自定义属性（如 `--control-radius`）与作用域之外的节点使用。作用域外的元素引用其他令牌会得到浏览器初始值（`box-shadow` 消失、`transition` 无时长），所以 `body`/`html`/`#root` 与未包进 `UiThemeScope` 的节点不要引用字体、圆角以外的令牌。

`presets.nightwave.primitive.*` 覆盖夜间取值；昼夜只在 primitive 分别给值，semantic 与 component 不分昼夜。引用只支持整值 `@a.b.c`，不支持拼接；命名用驼峰（生成时转 kebab），按「用途」命名，不按「数值」命名（反例：`duration420`、`c0002`）。

### 10.2 新增或修改令牌的步骤

1. 先查现有令牌能否满足；能用就用。
2. 在 `tokens.json` 的 primitive 加原始值（夜间不同则同时写 `presets.nightwave.primitive`），在 semantic 加语义引用；组件才需要的再在 component 加。
3. 在 `desktop/desk-preview/renderer` 运行 `npm run tokens` 重新生成 `ui/character-tokens.css`，**不要手改生成文件**；`npm run tokens:check` 应通过。
4. 同一个 PR 里用到它，并更新本文对应表格。没有使用者的令牌不新增。
5. 值取舍需要设计确认的（新档位、新曲线、新阴影），在 PR 说明里写明与现有档位的差异，不要悄悄新增近似值。
6. 删除令牌前确认 CSS/TS（含 `readMotionTime(…, '--nd-…')` 这类字符串引用）没有使用。

### 10.3 遗留令牌

`relationshipJournal.*` 里有按值命名的颜色令牌（`c000`、`cfff`、`c6b5fb5`…）和 5 个被 `relationship-journal-transition.ts` 读取的时长令牌（`duration1`、`duration180`、`duration380`、`duration900`、`duration1500`）。它们是手账页面的历史产物：不要新增同类令牌，新颜色走语义色，新时长走第 6 节的档位；这 5 个时长在 TS 与 CSS 同时迁移之前保留。

## 11. 样式检查

### 11.1 运行方式

```bash
cd desktop/desk-preview/renderer
npm run lint:styles                 # 只跑样式检查
npm run check                       # tokens:check + lint:styles + typecheck
node ../../scripts/check-design-tokens.mjs --list-allow   # 列出所有豁免及命中数
node ../../scripts/check-design-tokens.mjs --json         # 机器可读输出
```

`desktop/desk-preview` 的 `npm test` 里的 `tests/design-tokens.test.cjs` 同样会跑（含规则单元测试与仓库当前状态）。

**选型说明**：仓库原本没有 stylelint 或任何样式检查，CSS 文件又大量是单行压缩写法。自写脚本 `desktop/scripts/check-design-tokens.mjs`（约 200 行，用 renderer 里已有的 postcss 解析器，仅新增 `postcss` 一个 devDependency）比引入 stylelint + 插件 + 自定义规则更省依赖：规则是仓库专属的（令牌前缀、豁免上限、生成文件白名单），逻辑只有几十行，且不改变构建链。若以后需要更多通用规则（如属性顺序），再引入 stylelint 与本脚本并行。

### 11.2 规则

| 规则 | 禁止 | 允许 |
| --- | --- | --- |
| `ds/font-family` | `font-family`、`font` 简写、名字含 font/hand/title/mono/sans/display 的自定义属性里写字体栈 | `inherit`、`var(--nd-…)`；`@font-face` 声明本身 |
| `ds/cubic-bezier` | 任何 `cubic-bezier(…)` | `var(--nd-semantic-motion-ease-*)`、`ease`/`linear` 等关键字 |
| `ds/duration` | 非自定义属性值里的 `ms`/`s` 时长与延迟 | `0`、≤1ms（reduced 兜底）、`var(--nd-…)`；`font`/`src` 里的数字不算 |
| `ds/color` | `#rgb[a]`、`rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()` 里写字面量 | `var(--…)`、`rgba(var(--x-rgb), .5)`（只含变量的写法）、`currentColor`、`transparent`；`url()` 与字符串里的 `#` 不算 |
| `ds/shadow` | 带模糊半径（第 3 个长度 >0）的 `box-shadow` 层 | `none`、`var(--nd-…shadow…)`、零模糊的描边环 |
| `ds/radius` | `border-radius` 及单角圆角里的非 0 的 px 字面量 | `0`、百分比、`var()`、`calc()` |

范围：`renderer/src` 下所有 `.css`；`ui/character-tokens.css`（生成物）整体跳过。检查针对 CSS 声明，不检查 TSX 内联样式（见第 12 节）。

### 11.3 豁免

两种写法，**都必须写原因**（`—` 之后，至少 4 个字符），未知规则名也会报错：

```css
/* 块级：只豁免紧随其后的那一条声明（或那一条规则里的声明） */
a { /* ds-allow: ds/color — 品牌色与主题无关 */ color: #fff; }

/* 文件级：写在文件第一行；必须给出现有数量上限，超出即报错（只减不增） */
/* ds-allow-file: ds/color=74, ds/shadow=2 — 旧版琥珀调板整体迁移前保留 */
```

文件级的数量上限是「棘轮」：收敛后应同步调低数字；新增的字面量会让检查失败，从而避免历史豁免继续膨胀。新增豁免需要在 PR 说明里写原因。

### 11.4 当前豁免清单（共 389 处）

| 文件 | 规则 | 数量 | 原因 |
| --- | --- | ---: | --- |
| `styles.css` | color | 74 | 旧版琥珀色调板（:root 变量 + 各处 rgba 色阶），不属于 xiacheng 语义色；换成语义色会整体改变外观，需设计决策后迁移 |
| `styles/settings-workspace.css` | color | 33 | 配置书的封面/书脊/丝带是昼夜两套艺术色（--cfg-*），与语义色不同值；待设计确认再入令牌 |
| `styles/relations-exlibris.css` | color | 25 | 藏书票页的局部夜间色（--depth、背光、玻璃高光）；页内 data-theme 独立切换，直接换令牌会随全局预置翻转 |
| `ui/theme.css` | color | 16 | 旧版控件调色板（--control-*、按钮色阶），与 styles.css 同源；随旧调板一起迁移 |
| `styles/conversation.css` | color | 13 | 对话页昼夜两套纸色/提示线色（--dlg-*）与光束渐变，非语义色同值 |
| `styles/appearance.css` | color | 2 | 彩色底上的纯白文字与强调金色，待并入 onSolid/强调令牌 |
| `ui/theme-transition.css` | color | 2 | mask-image 的不透明遮罩（#000 仅表示不透明度，不是视觉颜色） |
| `styles/voice.css` | color | 1 | 彩色按钮上的纯白文字 |
| `styles/relations-exlibris.css` | duration | 62 | 场景编排时间轴与 relations/exlibris-theme.ts（520/1780ms）、Relations.tsx（950ms）的定时器及关键帧百分比耦合；逐值收敛需连同 TS 一起改 |
| `styles/conversation.css` | duration | 8 | 昼夜换色的光束/扫掠（1.05s、1.2s…）与 conversation/dialogue-theme.ts 的 PALETTE_MS/SWEEP_MS/END_MS 联动，且 >700ms 不属于交互档 |
| `ui/relationship-journal.css` | shadow | 120 | 手账纸张阴影，每件纸的偏移/负扩散逐件调校，颜色已走 --nd-component-relationship-journal-c* 令牌；整体并入层级阴影会改变纸感，待设计确认 |
| `styles/settings-workspace.css` | shadow | 15 | 书页/纸片投影用 color-mix 配色的逐件几何（负扩散、偏移），暂不并入 rest/hover/raised/overlay |
| `styles/relations-exlibris.css` | shadow | 9 | 藏书票/纸张投影，几何与 color-mix 配色逐件调校 |
| `ui/dock-notebook.css` | shadow | 5 | dock 纸质悬浮与书签的阴影，色值来自 dockNotebook 令牌（含 night 专用色） |
| `styles.css` | shadow | 2 | 旧版琥珀光晕/卡片阴影的有色投影，几何逐处调校 |
| `styles/conversation.css` | shadow | 2 | 光束的有色辉光，颜色随光向变化 |

按规则合计：color 166、duration 70、shadow 153。块级豁免（`ds-allow:`）目前 0 处。

## 12. 未覆盖与后续

- **颜色未收敛（166 处豁免）**：旧版琥珀调板（`styles.css`、`ui/theme.css`）、配置书/藏书票/对话页的昼夜两套艺术色与光效渐变，值与语义色不同，直接替换会让夜间表现翻转或改变外观。迁移前需设计确认，建议逐页建「页面级语义令牌」（如 `--nd-component-config-book-cover`）再替换。
- **纸感阴影未收敛（手账 120、配置书 15、藏书票 9 等）**：几何逐件调校，等设计确认是否并入 `rest/hover/raised/overlay` 后再收。
- **场景编排时长（藏书票 62、对话 8）**：与 TS 定时器耦合，需要把 TS 常量改成读令牌之后再收敛。
- **间距、字号、`z-index`、`font-size` 字面量**暂无检查规则；历史样式里仍有大量 px 字面量，后续可按本文第 1、2、4 节增加规则。
- **TSX 内联样式**不在检查范围内。
- 焦点光晕 `shadow-focus-halo` 已作为令牌提供，尚未在全部控件上启用。
