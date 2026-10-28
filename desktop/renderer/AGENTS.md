# Electron渲染层协作要求

继承仓库根AGENTS.md。修改页面、组件或样式前读取：

1. [根DESIGN](../../DESIGN.md)：品牌方向与规范导航。
2. [105总体规范](../../devDoc/105-frontend-design-system.md)：字体、尺寸、公共行为、布局。
3. [110晚风深色标准](../../devDoc/110-nightwave-ui-standard.md)：夜间色板、组件/状态、Portal和资产要求。
4. [公共UI文档](src/ui/README.md)：实际入口与组件契约。
5. [开发状态](../../devDoc/README.md)：当前批次与实际证据。
6. [117动效规范](../../devDoc/117-frontend-motion-standard.md)：书签、落款、页面/浮层、中断、减少动效与实施状态；不能将独立HTML能力当作公共UI已有API。
7. [120昼夜手账Dock标准](../../devDoc/120-dock-notebook-standard.md)：已采用的交互04，含图上文下、纸签/布面、微跟随/按压/到达与真实MoreMenu行为；正式组件已迁移，接入范围见[127](../../devDoc/127-home-and-global-motion-integration-execution.md)。

默认同时支持白昼来信与晚风电台。复用React/TypeScript/Vite和已有UI，页面不自行创建原生基础控件或重写系统弹窗；共享外观维护在`src/ui/`。

token唯一来源是`devDoc/design/character-studio/tokens.json`；修改数值后执行`npm run ui:tokens`和`npm run ui:tokens:check`，不可手改生成CSS。页面消费语义/组件变量。

首页一屏不滚动；业务页按任务保留滚动，菜单/弹窗可内部滚动。主题切换只改本机外观，保留账号、路由、编辑草稿和异步任务，不得触发写入。

保留鉴权、SSE、账号隔离、草稿准入、历史导航与安全退出机制。修改菜单/弹窗需检查键盘、Esc、初始焦点与返回焦点；Portal/确认队列必须继承预置。

候选素材和预览见开发文档中的状态标记；没有明确采用记录前，不用候选图覆盖生产素材。夜间专属图接入后重新校准构图和光照，避免再叠旧压暗滤镜。

验证应与改动相符：仅文档/候选素材查链接与可读性；token/共享控件查同步、契约和双主题实际界面；行为变更遵循根AGENTS的全量与复核纪律。不得用历史测试数字代替新改动的证据。
