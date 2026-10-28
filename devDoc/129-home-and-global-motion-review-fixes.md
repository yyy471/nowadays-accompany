# 主页与全局公共动效复核修复记录（128-R1～R3）

日期：2026-10-28。对象：[128 独立复核](128-home-and-global-motion-independent-review.md)的 3 项 P2；原实现记录见[127](127-home-and-global-motion-integration-execution.md)。状态：三项已修复并完成实现方回归，独立复验待做；未提交、未推送、未打包。

## 1. 结论

| 复核项 | 处理 | 结果 |
| --- | --- | --- |
| 128-R1 未迁移主题内 Disclosure 不真正收起 | 折叠结构移入公共基础层 | 已修复 |
| 128-R2 菜单退出途中重开从起点重播 | 取消前保存绘制快照，重开用快照首帧 | 已修复 |
| 128-R3 退出减少动效重播业务页入场 | 路由入场与偏好收束拆分 | 已修复 |

没有新增第二套组件、动画引擎或模块级可变状态；公开 API 不变。

## 2. 128-R1：Disclosure 结构可见性

- 原问题：`grid-template-rows:0fr`、内部 `overflow:hidden` 等结构规则只在 `data-ui-theme="xiacheng"` 下生效。未迁移主题时 `inert` 只阻止交互，内容仍然占高可见。
- 修复：把 `.ui-disclosure-body` 的 grid/0fr、`[data-open="true"]` 的 1fr、`.ui-disclosure-inner` 的 `min-height:0;overflow:hidden` 移到公共基础层 [theme.css](../desktop/renderer/src/ui/theme.css)，使用 `var(--nd-component-motion-surface-enter, 220ms)` / `var(--nd-semantic-motion-ease, ease)`，在主题内消费 token、主题外有安全回退。
- 外观仍留在 [character-theme.css](../desktop/renderer/src/ui/character-theme.css)：边框、触发器排版、图标旋转、内容 padding 和颜色不外泄。组件仍是同一受控/非受控实现、同一编辑器 DOM、同一 inert 与焦点回退协议。
- 回归：
  - 新增主题无关结构契约测试，阻止 `.ui-disclosure-body` 规则被重新限定回 xiacheng。
  - 重跑 128 自带真实组件浏览器探针：未包主题时默认关闭 `aria-expanded=false`、`inert=true`、内容区实际高度 `0`，输入节点仍保留在 DOM。继续点开后高度 `21px`、`inert=false`、输入可聚焦同值；再收起高度回到 `0`、`inert=true`、焦点回到触发器，输入仍是同一节点且 `PERSISTED DRAFT` 未丢。
  - 工作台 xiacheng 样例继续验证展开 120px、收起 0px、草稿保留、关闭时焦点回触发器和重新打开后的值。

## 3. 128-R2：菜单反向重开

- 原问题：`requestOpen` 先 `scope.cancelAll()`，布局 effect 再读取“当前绘制值”时退出动画已被取消，只能读到基础 `transform:none`，因此从 `opacity:0/translateY(4px)` 重播。
- 修复：[menu.tsx](../desktop/renderer/src/ui/menu.tsx) 在取消旧动画前，先读取当前 `opacity/transform` 并存到组件实例的 `resume` 快照；进入布局 effect 使用该快照作首帧。`getComputedStyle` 的实时值在取消前即时复制，不保存 CSSStyleDeclaration 引用。
- 世代：重开时递增 `generation`，旧退出动画的 `finished` 回调即使晚到也不能结束新进入；快照读取后立即清空，首次打开仍从 `opacity:0/translateY(4px)` 进入。
- 回归：真实 Dock 更多菜单执行 3 次“退出中重开”，每次比较点击前计算值与新动画首帧：
  - 三次 opacity 原值与首帧完全一致（如 0.310013 → 0.310013、0.444386 → 0.444386）。
  - transform 的 scale 与 translate 在断言精度内一致（如 translateY -1.37997 → -1.37997）。
  - 结束后 Escape 关闭、面板移除、焦点回到 `.ui-dock-more`；reduced 途中切换仍由公共策略即时收束。

## 4. 128-R3：业务页入场触发边界

- 原问题：[App.tsx](../desktop/renderer/src/App.tsx) 的同一个 effect 同时依赖 `page` 与 `reduced`。仅在 reduced→false 时也会重新调用 `pageMotion.run`，把偏好变更误当导航，重播当前业务页入场。
- 修复：
  - 路由入场 effect 只依赖 `[page, pageMotion]`，并在读取时通过实例 ref 判断当前 reduced；非主页且非 reduced 才播一次。
  - 单独 effect 只在 reduced 为 true 时取消当前页动画；reduced→false 不启动新动画。
  - 增加卸载清理，移除本页 effect 持有的动画，不通过 App key 重建页面。
- 回归：实际 App 中停留在关系页，稳定后依次切 reduced、system、full，`.studio-legacy-page` 的运行中动画始终为 0；随后真实点击“模型”导航，入场动画运行中数量为 1。偏好切换不会重建页面或重播，真实路由仍入场一次。

## 5. 回归门控

| 命令/检查 | 结果 |
| --- | --- |
| `npm run ui:tokens:check` | Character tokens: up to date |
| `npm run typecheck` | 通过（test + 主进程 + 渲染层） |
| `npm test` | 124 文件、1146 项通过、1 项既有跳过 |
| `npm run desktop:build` | 通过（renderer + main/preload） |
| `git diff --check` | 无空白错误 |
| Chrome CDP 开发版 | 30/30 通过（原 28 项 + R2/R3） |
| Chrome CDP 生产 dist | 27/27 通过（原 25 项 + R2/R3） |
| 隔离 Electron 100% / 125%（1440 CSS） | 各 3/3 通过；DPR、Dock 68px、项 64×54、无滚动、弹窗隔离/退出/焦点不变 |
| 128 真实组件浏览器探针 | R1 关闭高度 0；R2 首帧与退出绘制值一致；确认队列串行未回退 |

本轮浏览器探针由实现方重跑，属于实现方证据，不替代独立复验。128 原审查结论保留为审查时状态。

## 6. 尚未覆盖

- R1～R3 的独立复验尚未进行；本记录不能宣告复核关闭。
- 无主题 Disclosure 的展开/再收起由结构 CSS、真实工作台样例和探针组合证明，但未新增独立业务页消费者；其他业务页仍不重设计。
- 126 中尚未取得的原生草稿取消/安全退出组合、真实触屏、真实业务保存消费者、真实 QQ/模型与完整发行包仍按 127 的第 10 节保留为待验收。
- 未提交、未推送、未打包或替换 EXE。
