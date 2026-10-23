# 前端基础控件统一与验收

日期：2026-10-23。版本：0.2.2。

## 盘点结论

原实现已有共享 Button、Field、Card、Icon 等，但存在页面直接实现 input/select/textarea/button、搜索图标和输入框组合、手拼 btn 样式、独立图标按钮及 window.confirm 系统弹窗。全局CSS还同时保留了旧控件样式和后加的暖色覆盖，基础控件没有明确的所有权边界。

## 实现

稳定导入入口为 `desktop/renderer/src/ui.tsx`，统一导出目录为 `ui/index.ts`。具体规范见 [组件库说明](../desktop/renderer/src/ui/README.md)。

| 层 | 内容 |
| --- | --- |
| 基础输入 | Input、Select、Textarea、Checkbox、SearchInput、Field |
| 操作 | Button、ConfirmButton、CancelButton、IconButton |
| 场景交互 | ControlButton，仅用于导航、Dock、折叠和步骤切换 |
| 弹窗 | Modal、ConfirmProvider、useConfirm |
| 通用展示 | 原有Card、Tag、StatePill、Empty、ErrorNote及Icon |
| 样式 | ui/theme.css，集中定义基础控件尺寸、颜色、圆角、焦点、禁用及确认弹窗 |

业务页面统一从公共入口导入；页内不再创建原生基础表单和按钮，不手写btn/search-box/icon-btn类，不调用系统确认框。原ui.tsx公共路径保持兼容。基础控件外观样式从历史全局覆盖中收敛到组件库，页面只负责宽度、排列与场景布局。

迁移覆盖 App、设置弹窗、SnowLuma向导，以及 Accounts、Activity、Artifacts、Home、Messages、Models、Overview、Policy、QqConnections、Settings、Tasks。历史Messages/Tasks源码同样迁移，但没有重新加入导航。

Field通过生成id与上下文关联label、输入及说明，避免原label内嵌操作按钮的问题。图标按钮具备必要名称，SearchInput内置统一搜索图标。导航/Dock保留自身布局，不套用普通确认按钮外观。

全部确认迁为等待结果的useConfirm；关闭、遮罩和Escape均视为取消，初始焦点落在取消按钮。共享Modal负责最上层焦点约束、背景隔离和关闭后的焦点恢复，包含设置上再次弹确认的情况。账号策略在异步确认后保留代际复验，QQ操作继续依赖后端进程身份校验。

## 防止再次分散

新增 `test/ui-library-contract.test.ts`：使用TypeScript语法树扫描库外源码，禁止原生input/select/textarea/button、系统对话框及手拼公共按钮/搜索/图标样式。该检查加入现有全量测试。

新增控件应先在ui目录实现并从index统一导出，在theme中定义外观，再供页面使用；已有控件优先增加明确变体，禁止复制另一份相近组件。

## 验收记录

- 全量40个测试文件、262项测试通过。
- 类型检查、桌面构建通过。
- 实际浏览器：搜索输入及筛选工具栏渲染正常；模型表单正确关联标签，输入草稿正常；共享确认初始聚焦取消；Shift+Tab循环、Escape取消、保留草稿正常；确认放弃后恢复底层页面及设置入口焦点，背景解除隔离。
- 页面操作在隔离数据和本机模拟模型服务下完成，未操作真实QQ或调用付费模型。
- 截图：[搜索与工具栏](../test-results/ui/ui-library-review/search-toolbar.png)、[统一确认弹窗](../test-results/ui/ui-library-review/confirm-dialog.png)。

`npm run dist`最终封装成功，产物为 `release/nowadays-0.2.2-portable.exe` 与 `release/nowadays-0.2.2-setup.exe`。运行新版前先退出旧版托盘进程。
