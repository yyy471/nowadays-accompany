# 前端动效规范 v1.1.0：书签与落款

2026-10-27初版，2026-10-28追加用户采用的昼夜Dock交互04。本文为[105总体规范](105-frontend-design-system.md)第8节的正式补充，白昼/晚风共用；颜色与夜间表面遵循[110](110-nightwave-ui-standard.md)，Dock详细契约见[120](120-dock-notebook-standard.md)。2026-10-28的正式接入与验证见[127](127-home-and-global-motion-integration-execution.md)；本文的“已接入”指公共组件与主页消费者，不代表所有业务页完成重设计或真实保存链路已接。
## 1. 生效范围与实施状态

已认可的动作语言是「一本会回应的手账」：按下像书脊收短，导航像书签移位，保存像完成落款，浮层有明确来处，内容按阅读顺序进入。相同语义使用相同动作，不按每个按钮随机设计特效。

| 内容 | 当前状态 | 依据 |
| --- | --- | --- |
| 昼夜天气过渡、快速反向、减少动效 | 已接入正式公共主题层 | [114](114-theme-weather-transition-execution.md)、[115](115-theme-weather-transition-independent-review.md) |
| 普通按压、开关、局部场景跟随 | 已统一到公共动效策略；旧业务页未重设计 | 公共UI源码、[127](127-home-and-global-motion-integration-execution.md)及105/110 |
| 书签端片、勾画落款、导航书签、分层阅读、来源浮层、中断衔接 | 公共Button/PageDock/Modal/Menu/Disclosure与主页阅读已接入；勾画的真实业务保存消费者待接 | [127](127-home-and-global-motion-integration-execution.md)、[精致版样板](design/character-studio/motion-notes/motion-library-demo.html) |
| 昼夜Dock图标/标签、纸签/布面、跟随/按压/到达 | 用户已采用并迁移正式PageDock/MoreMenu，自验通过 | [120](120-dock-notebook-standard.md)、[127](127-home-and-global-motion-integration-execution.md) |
| `component.motion.*`与`component.dockNotebook.*`精细参数（含Dock材质配方） | 已登记、生成并由正式组件消费 | [token v1.4.0](design/character-studio/tokens.json) |
| Motion for React等第三方引擎 | 技术建议，尚未安装或确定为强制依赖；当前使用CSS/WAAPI | 本文第7节 |
| Dock之外的新光影、纸张材质、专属图标、角色/模型新构图 | 仍为候选，尚未作为正式视觉标准采用 | 第9节 |

写入规范表示后续实现遵循此标准，不等于所有效果已进入EXE。HTML中的模拟保存、示例资料和页面标签不能替代真实业务与导航验收。

## 2. 统一节奏与参数来源

所有正式数值来自tokens.json，遵循primitive → semantic → component；精细位移/比例通过`motionDetail`登记，组件消费`component.motion.*`。下表是便于阅读的映射，不是第二份可独立修改的数值来源。

| 场景 | 时长 | token用途 |
| --- | --- | --- |
| 按压、即时回应 | 120ms | `motion.feedback` |
| 控件变化、勾选描画、菜单、浮层退出 | 160ms | `motion.control` / `motion.surfaceExit` |
| 折叠、导航书签、弹窗/抽屉进入、落款出现 | 220ms | `motion.surfaceEnter` |
| 页面完整入场 | 280ms | `motion.page` |
| 昼夜换景 / 装饰收尾 | 400ms / 550ms | 现有`themeTransition.reveal` / `themeTransition.total` |

普通反馈沿用`motion.ease`的cubic-bezier(0.2,0,0,1)；书签/浮层可用`motion.surfaceEase`的cubic-bezier(0.22,0.61,0.36,1)。只在书签和抽屉末端允许有界轻微回弹，正文不弹跳。退出快于进入；真实业务等待不因动画强制延长。

JS读取CSS时间时同时支持ms与s，WAAPI需要换算为毫秒；生产压缩可能改变单位。样板半速仅用于观察，不是应用的新增业务设置。

## 3. 动作目录

### 3.1 按钮与保存落款

- 普通按钮按下平移`pressOffset=1px`并收短实色下沿，不改变布局占位。焦点立即可见，键盘激活具有相同结果反馈。
- 主入口书签端片在可悬停指针或键盘focus-visible时探出`bookmarkReach=3px`；尾部最多`bookmarkTail=8px`，箭头移动`arrowOffset=2px`。按压时端片收回。外扩装饰透传输入，不能被父级裁切或引起横向溢出。
- 保存开始保留按钮宽度、焦点及图标槽，关联操作busy期间阻止重复提交；不禁用整页。成功由真实请求完成触发，勾选沿路径逐笔画出，再出现局部“已收好”落款；落款初始`stampStartTilt=-6deg`，结束`stampTilt=-4deg`，220ms收束。
- 标准动作名和准确状态文字继续保留；“已收好”可以是装饰副标，不覆盖“已保存”等真实结果。落款使用成功语义色，不把主入口色当成功色。
- 失败保留输入，在操作附近显示原因与下一步，不晃动整页。危险操作保持明确动作与原确认流程。
- HTML按压有2px示意；正式控件采用本规范token的1px，不把样板每个字面值当作生产值。

### 3.2 导航书签与页面阅读

- 选中书签滑向新目标；末端回弹不超过`bookmarkOvershoot=1.5px`。选中标记之外的文字和图标保持位置。滚动、缩放、窗口尺寸变化后重新对齐。
- 页面内容使用`pageOffset=4px`的轻微入场；前进可从下方进入，返回可小幅向左呼应。顶部与Dock保持稳定，不进行整窗翻转或正文三维变形。
- 标题、正文、注脚依阅读顺序出现：各组延迟步长`readingStagger=24ms`，累计最多`readingDelayMax=72ms`；每组时长按`280ms - 本组延迟`收紧，整次入场仍在280ms内结束。长列表不按行无限追加延迟。
- 正式路由先完成草稿准入，再切换与动画；取消准入时原页保持原位。不能为了播放动画反复改变整个App/编辑器的key，不保持第二份可交互业务页，不触发重复请求。
- 折叠保留原编辑器节点、内容与选区；真实跨页导航沿用原页面生命周期及草稿契约，不把样板标签页“全部保留DOM”扩展成所有正式页面常驻。
- 同一页面内切换主题或刷新状态不重播整页；SSE/轮询更新不重播列表入场。历史前进/返回保留既有路由、焦点和滚动行为。

### 3.3 菜单、弹窗、抽屉与折叠

- 菜单在160ms内轻微淡入，保留既有键盘导航、视口边缘定位及Esc返回行为。
- 弹窗从触发点方向轻轻展开，位移按来源距离收紧，最大横向`modalOffsetX=18px`、纵向`modalOffsetY=12px`，比例从`modalScale=0.97`恢复到1，220ms完成；退出可收至`modalCloseScale=0.985`，160ms结束。来源不可用时采用中心的小幅进入。
- 抽屉从对应窗口边缘进入，位移`drawerOffset=24px`，末端回弹最多`drawerOvershoot=1px`；退出向原边缘移动`drawerCloseOffset=16px`。这些是浮层位移，不扩大105对主要正文或常驻立绘跟随的位移上限。
- 遮罩与面板同步，面板保持实色和可读对比。弹窗开启立即建立模态隔离与焦点范围；退出期间继续隔离并拦截重复关闭，结束后恢复触发点焦点，嵌套层遵循公共Modal契约。
- 折叠220ms内展开/收拢，箭头同步；关闭后内容不进入Tab顺序和辅助技术的可操作范围，DOM与草稿仍保留。内部焦点在收拢前移回触发点。
- 开关滑动160ms，视觉与`aria-checked`/真实状态同步；保存中的状态归属仍按账号与对象契约处理。

### 3.4 昼夜Dock：靠近、悬停、按下、到达

采用交互04，详见120。图标悬停上移2px；内部跟随X/Y各±1px，120ms衔接，文字与命中框固定；主键/原生键盘按压下沉1px、缩至0.96，120ms反馈；纸面/暖光160ms回应；真实导航提交后共享书签220ms移动、末端回弹≤1.5px。两层图标运动分开合成，按压时收回悬停位移。

白昼纸面阴影与樱粉鱼尾、晚风布面和琥珀局部暖光分别表现同一动作。点击当前页不重播页面，装饰不延迟导航；更多仍保留原菜单语义。触摸只按压/选中，reduced禁用跟随/缩放/抬起/回弹；离开、取消、失焦、隐藏、resize和主题变化均清理临时状态。参数消费`dockNotebook`，不得借实现新增业务成功提示。

## 4. 中断、连续操作与状态归属

1. 动效不排队；连续切页/反向选择取最新目标，重复选择当前项不重播。
2. 开始新动画前读取当前绘制位置，再取消同一元素同一用途的旧动画，避免先跳回起点。弹窗刚展开就关闭时从当前transform/opacity收回。
3. 过渡、计时器和事件监听器由组件/Provider实例持有；完成、取消、卸载时清理，不新增模块顶层可变状态。
4. 动画完成回调不能提交业务、重试请求、改绑账号或复活旧页面。晚到结果仍按原有代际与目标归属检查。
5. 昼夜全屏过渡与路由/浮层变化并发时，先收束过期全屏快照，确保最新真实DOM与焦点可操作；不能叠加两套全屏捕获屏蔽输入。

## 5. 减少动效与性能

- 全部CSS、WAAPI及未来动画引擎共用现有system / reduced / full偏好：system跟随系统，reduced取消非必要运动，full显式覆盖系统减少动效；强制颜色仍关闭天气/材质装饰。
- `reduced`是不可解除的下限：全局或局部任一显式reduced都生效；局部`UiThemeScope motion="reduced"`约束其后代，嵌套显式full不能解除祖先局部reduced，也不能解除全局或系统reduced，只有全局full覆盖系统reduce。嵌套scope未显式指定时继承调用处；排队确认在发起时捕获已合并的局部结论，全局偏好仍实时更新。详情与证据见[132](132-shared-motion-scope-fix.md)，嵌套补齐见[137](137-nested-motion-scope-fix.md)。
- 减少动效时立即显示最终状态，取消位移、缩放、回弹、路径描画与装饰旋转动画；保留清晰静态勾选、错误、busy文字及焦点。切换偏好时收束在途动画，释放装饰层，不清空输入。
- 不默认启用持续呼吸、粒子、闪光、打字机正文或循环角色位移；加载等待有明确文字，并尊重减少动效。
- 常规反馈优先transform/opacity，禁止transition:all。不在每帧读写全页布局；折叠高度动画限公共组件内单一区域，关闭后保留内容但排除交互。
- 最终在Electron原生窗口、生产dist及实际缩放下检查；开发预览通过不代表生产CSS单位、模态和输入命中已通过。

## 6. HTML样板的使用范围

仓库归档包含[精致版](design/character-studio/motion-notes/motion-library-demo.html)、[初版](design/character-studio/motion-notes/motion-library-demo-v1.html)与[说明](design/character-studio/motion-notes/README.md)。两者为单文件离线样板。新增[Dock交互04采用参考](design/character-studio/dock-notebook/home-motion-study.html)复用仓库本地插画/CSS，双击HTML离线查看；其中只有Dock作为本次采用范围，详见目录说明。

HTML是已认可的视觉动作参照，不是第二套生产UI组件库。其独立原生dialog、标签切换和本机JS不能直接替换公共Modal、草稿准入和真实异步流程。正式接入应使用项目公共UI并消费token，检查本规范与样板的已注明数值差异。

## 7. 正式组件的实施边界

- 基础反馈由公共Button/ControlButton、Switch、Disclosure维护；页面只选择语义，不自写各套动画。
- 页过渡接在现有导航准入之后；Modal/useConfirm继续管理焦点、隔离、确认队列与退出协议。技术命名如PageTransition、ActionFeedback只是建议，尚未作为已有导出API承诺。
- 优先复用CSS与WAAPI。Motion for React可在正式实施时评估，用于布局/存在状态等复杂编排；如引入，收口在公共动效适配层，统一偏好、token与清理，不在业务页散落多套引擎。
- 本批仅登记规范、参数和参考样板，不安装动画依赖，也不声明新增动效已接入应用。

## 8. 后续接入验收

两主题均检查hover/focus/pressed/disabled/busy/success/error；鼠标、触摸与键盘；快速连续/反向操作；来源消失与窗口变化；冷加载与素材失败；减少动效中途切换；弹窗嵌套、Esc和焦点返回；实际草稿/选区/滚动；无新增业务请求与重复提交；动画无残留、无布局抖动。

新增动效逐步进入现有React组件样板，再按范围做真实Electron与生产构建验收。纯规范登记不借用此前全量测试或HTML检查声称应用迁移完成。

## 9. 后续视觉增强的决策顺序

光影、材质、专属图标及不同业务页构图，先在HTML中做白昼/晚风与窄窗口对照，明确认可后再登记规范与token。Dock局部纸签/布面/暖光现已依120采用，其余主页环境光、便签纹理、模拟叙事、首页留白与角色/模型构图继续保持候选状态。

已认可的动效进入应用时，以公共UI样板和真实业务页面完成第二阶段验证；焦点、草稿、真实异步和窗口缩放必须在应用中验收。HTML适合选择视觉，Electron负责确认实际交互。
