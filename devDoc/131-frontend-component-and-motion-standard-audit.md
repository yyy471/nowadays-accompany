# 当前前端组件与动效统一规范审计

日期：2026-10-28。范围：当前工作区源码，依据105/110/117/120及公共UI契约。**只有主页完成页面级改造；全局壳和公共UI已经升级，其他业务页仍处于旧外观兼容阶段。** 本文不要求重做这些页面。

> 2026-10-28跟进：R1已由[132共享层局部动效修复](132-shared-motion-scope-fix.md)处理，R2已由[133设置弹窗单一入场修复](133-settings-single-entrance-fix.md)处理，R3/R4已由[134 Dock材质token与样板复用正式Dock修复](134-dock-material-tokens-and-workbench-dock-fix.md)处理；136复核补出的嵌套full问题由[137](137-nested-motion-scope-fix.md)处理；实现方最终回归见[135](135-shared-audit-final-regression.md)。四项均完成实现方自验，独立复验待做。本文件保留审计时结论。

## 1. 结论

**统一的组件入口与主要动效体系已建立，主页整体沿用既定规范，但共享层尚未完全做到同一契约、同一动作所有者、同一参数来源。** 发现2项P2共享契约问题与2项P3维护一致性问题，建议先收口共享层，再推进后续页面设计。

130关闭的原三项问题仍保持修复；本次是扩大到统一规范与组件边界的检查，不将历史页面未迁移等同于主页改造失败，也不把未验证的实际环境项改成完成。

## 2. 已统一的部分

| 检查面 | 当前结论 |
| --- | --- |
| 公共入口 | `ui.tsx`只是对`ui/index.ts`的兼容转导出，不是另一套组件库。页面的Button、Input、Modal等消费同一实现 |
| 原生控件归属 | 扫描与AST契约测试未发现业务页面直接创建原生button/input/select/textarea；Switch内部原生button属于公共组件实现，允许 |
| 确认/取消/搜索 | ConfirmButton/CancelButton组合公共Button；SearchInput有统一入口；公共useConfirm负责确认队列，无主页手写系统确认框 |
| 正式导航 | 正式App使用同一个PageDock/MoreMenu，真实菜单与导航准入保留；主题切换不承担账号切换 |
| 主页 | Home使用公共入口按钮、头像、错误/加载展示；场景及阅读组消费公共动效工具，无另一套主页表单或弹窗 |
| 动效主路径 | 主页、App路由、Dock、菜单、Modal使用MotionPolicyProvider/useMotionPolicy及createMotionScope；时长和关键位移大部分读取token |
| 主题和旧页边界 | 首页与壳提供新主题作用域；旧业务内容及设置保留原作用域，没有因统一动效被整页套成新模板 |
| 专用天气过渡 | createThemeTransition仍是公共UI内的专用ViewTransition控制器，有独立快照/中断用途；不同渲染机制本身不等于重复业务组件，不要求为形式统一删除已验证能力 |

页面CSS中的构图比例、插画专用位置，以及使用ControlButton组成导航/分段/折叠标题，不能仅因“不是一个通用组件”就认定违规。重点是不要重复基础动作和交互契约。

## 3. 需要收口的共享问题

### 131-R1 / P2：局部减少动效与JS动效策略不一致

- 位置：`ui/appearance.tsx:18`、`ui/motion.tsx`、`ui/modal.tsx:26`、`ui/menu.tsx:25`。
- 公共UI文档明确UiThemeScope包含局部减少动效范围，Portal/排队确认保留调用处外观。实际UiThemeScope只设置AppearanceContext和data-motion；Modal/菜单的WAAPI策略仅读取MotionPolicyContext，忽略该局部motion。
- 独立浏览器复现：全局策略full，局部UiThemeScope motion=reduced。弹窗Portal正确带data-motion=reduced，但35ms采样仍有220ms WAAPI运行、opacity约0.207991；同范围菜单仍有1个运行中的动画。CSS的减少动效不能取消WAAPI。
- 影响边界：当前主页主要使用全局偏好，本次没有复现“主页全局减少动效失效”。问题属于公共API已承诺的局部覆盖；工作台同时设置两个Provider掩盖了差异，未来页面单独使用公开scope接口会出现不一致。
- 修复方向：在同一公共策略层定义全局/局部优先级，并让CSS、WAAPI与Portal一致消费；至少保证局部reduced能够约束其后代，不要求每个页面再嵌一套Provider。明确排队确认的局部偏好捕获/更新规则，保持队列语义。
- 验收：全局system/full × 局部reduced，菜单、Modal、确认队列都无装饰运动；中途切换立即收束。全局/局部full的优先级应文档化并补对应测试，避免CSS和JS各自决定。

### 131-R2 / P2：设置弹窗仍有两套入场动作

- 位置：`styles.css:2664`的settings-appear与`ui/modal.tsx`公共进入动画。
- 实际同一个`.ui-modal-panel.settings-dialog`既运行旧CSS的200ms opacity/transform入场，又运行公共Modal的220ms WAAPI入场。
- 独立浏览器复现：实际Modal加正式settings-dialog类，35ms采样得到CSSAnimation settings-appear（200ms）和Animation（220ms），两者关键帧都包含opacity、transform。
- 影响：同一元素同一属性由两套节奏控制，普通运行可能被WAAPI覆盖而不明显，但中断、取消或参数升级时没有唯一动作所有者。这是全局公共Modal升级的遗留冲突，不是要求重做设置页面设计。
- 修复方向：保留设置窗口尺寸、内容、配色与业务流程，移除已被公共Modal接管的旧入场动画及无其他消费者的keyframes。其他真正独立的页面动画按迁移状态登记，不进行无差别删除。
- 验收：从主页/业务页打开设置时，面板只有公共进入动作控制opacity/transform；重开、快速关闭、reduced、Esc、焦点和草稿确认保持。

### 131-R3 / P3：新Dock材质配方尚未完全进入token

- 位置：`ui/dock-notebook.css:13`～14、114、127等；120第3节要求未登记的混色/阴影配方先补用途token。
- 尺寸、跟随、按压、旗标、布纹与暖光等关键参数确实消费dockNotebook变量，但新阴影与混色仍有CSS常量，例如rgba(3,7,14,.25/.2)、多组阴影几何值与混色比例。token同步通过只说明生成文件一致，不证明所有新配方都已登记。
- 建议：将有设计含义、需要双主题维护的Dock表面/描边/接触阴影配方收成组件用途token；保留合法的布局和纯绘制细节，不机械地将每个0/1px都改成变量。生成后做视觉等价检查，避免为了整理参数重新设计。
- 主页HomeScene的跟随上限4px也仍是局部字面值，当前符合≤4px规范，不作为行为故障；后续可纳入公共组件参数以减少重复维护。

### 131-R4 / P3：开发样板的导航没有复用正式Dock

- 位置：`workbench/Workbench.tsx:184`。
- 正式App已用PageDock，但样板仍手拼`nav.ui-page-dock`及ControlButton，缺少正式`.ui-dock-item`、共享marker、更多入口和对应动作；它无法代表本轮正式Dock的结构与行为。
- 影响仅在开发样板，不能说正式应用有两套运行中的主导航。问题是后续开发者把样板当组件契约时可能继续复制旧结构。
- 建议：样板直接渲染正式PageDock，onNavigate使用本地假路由状态，不访问业务后端；或将旧示例明确命名为“按钮语义示例”且移除生产Dock类。标准样板与实际组件必须能对应。

## 4. 旧页面保留项：不列为本轮主页违规

| 项目 | 例子 | 处理时机 |
| --- | --- | --- |
| 旧页面独立排版与外观 | 角色、模型、资源、插件、设置的原表单/分区 | 各页面设计确认后迁移，不批量套主页构图 |
| 搜索语义尚未全部收口 | WorldbookEditor使用公共Input type=search，而不是SearchInput | 随对应页面迁移；不影响主页，不能算第二套原生输入实现 |
| 旧折叠/分段结构 | Models/ProviderManager的ControlButton折叠、原生details、Extensions分段选择 | 页面迁移时按语义采用Disclosure/Switch等；并非所有分段都应改成开关 |
| 旧theme.css时长/缓动 | .16s/.12s及ease等旧兼容值 | 同语义有统一契约要求时逐步桥接；本轮不因此重画旧页或删除必要状态反馈 |
| 保存结果消费者未接 | 勾画/落款当前主要在公共样板 | 页面有真实操作结果后再接，不向主页添加假保存或假成功 |

其他页面未改造不意味着可以再造基础控件；新增功能仍须走公共入口和统一行为。旧实现的兼容保留与新增重复实现应分别判断。

## 5. 测试覆盖与门禁缺口

本轮实际执行：

- 公共组件归属、动效、token、主题、主页、设置导航与退出定向7文件：**43项通过**，见`test-results/review131/targeted.log`。
- token同步检查通过，见`test-results/review131/tokens.log`；`git diff --check`通过。
- 真实公共组件隔离Chrome headless探针确认R1/R2，见`test-results/review131/browser-probes.json`、`.log`、`entry.tsx`与`browser-probes.mjs`。不启动Core/QQ/模型，不使用用户浏览器资料。

现有AST门禁能防止页面原生控件、手拼btn类和系统确认；它不检查“局部CSS/JS是否同一策略”“同一元素是否两套动画”“样板是否复用正式组件”，所以43项通过不能消除上述问题。建议优先补这三类有实际行为意义的回归，再增加关键组件token消费的轻量约束，避免写大量镜像实现的样式快照。

本次为规范边界审计，未修改运行代码，没有重复执行上一轮的全量/构建或原生验收；130的1146项全量与30项实际App检查仅是历史证据，不作为本轮新增执行结果。当前源码的结构与探针结论不等同于对EXE的全部视觉/交互验收。

## 6. 建议执行顺序

先修共享R1动效优先级和R2单一入场所有者，再整理R3的用途token、R4的样板。四项均可在公共层/样板完成，不需要重做其他页面；基础层收口后再进入下一张页面设计。

文档状态也应同步：部分105/120/公共UI README仍写“独立复核待做”或“新增参数不改变消费者”，需区分规范登记时的历史状态与130修复已复验的当前状态，避免下一轮根据旧说明另造组件。

本轮只新增本审计文档、导航和忽略目录探针，未修改生产代码、未提交或推送。
