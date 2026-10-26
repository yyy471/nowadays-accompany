# 阶段 C：设置结构与导航执行记录

日期：2026-10-23。范围：设置结构子任务。保留现有阶段 A/B 未提交修改；未 reset、提交或打包。模型服务管理由另一个子任务实施，本文件不代表整个阶段 C 验收完成。

## 1. 实现

- `desktop/renderer/src/components/SettingsDialog.tsx`：分类顺序为模型服务、连接、外观、诊断。连接继续使用内部 `snowluma` key；公共基础控件仍来自 `../ui`。模型服务和 SettingsPage 保持固定树位置，仅用 hidden 切换可见性，隐藏表单继续挂载与登记草稿。
- `desktop/renderer/src/pages/Settings.tsx`：连接区只呈现 SnowLumaSetup（含既有恢复监听操作）；运行信息、容量限制、账号租约、期望状态、Runtime、指标、后续范围和原始诊断快照统一放在诊断区。没有复制诊断卡或连接编辑器。外观保留既有动效设置。
- `desktop/renderer/src/App.tsx`：SettingsDialog 将选择回传 App，会话内全局设置按钮按最后选择打开。实例的定向入口仍到连接；账号模型页的服务入口仍到模型服务；旧 `#/settings`、`#/models` 仍进入模型服务。
- ModelsPage 的 `onGoAccountModels` 经 SettingsDialog 传入。App 独立执行已有 `requestTransition({scope:{kind:'all'}})`，获准后关闭设置并到账号模型配置；底层本来就是账号模型配置时也执行全范围判断，不被同页面导航短路。异步判断完成后再次检查退出锁。
- 保留 `locked`、设置 Portal 的 inert、禁用关闭和批准退出后的不可关闭公共 Modal；标签点击在 locked 时也直接拒绝。没有改手动启动 QQ/SnowLuma 或恢复策略，没有新增后端写操作。
- 未修改 styles.css；已有 `.settings-dialog-content section[hidden]` 规则保证隐藏分区不受 flex 布局规则影响。

## 2. 自动验证

新增 `test/settings-navigation.test.tsx` 6 项，采用仓库已有组件函数/hook 调度测试方式，调用实际 App、SettingsDialog、SettingsPage、SnowLumaSetup 与真实 DraftRegistry/TransitionController：

1. 会话标签记忆，全局按钮重开，以及定向模型/连接入口覆盖。
2. 旧 settings hash。
3. 旧 models hash。
4. 底层已在账号模型配置时仍检查 all；取消保留底层草稿及设置，接受后放弃并关闭。
5. 实际连接编辑器密码输入产生 dirty，跨隐藏分类与取消关闭仍保留原输入；接受关闭后通过真实 discard 复位。
6. 实际 SettingsPage 的连接与诊断分区独立，连接编辑器、运行信息及诊断快照各一份，分类切换只修改 hidden。

验证结果：

- `npm run typecheck`：通过（模型子任务补齐约定 prop 后）。
- `npm test -- test/settings-navigation.test.tsx test/renderer-quit.test.tsx`：2 文件、12 项通过，含既有 6 项退出回归。
- `git diff --check`：通过。
- 未执行全量测试或构建；由父任务统一验收。

失败与修正记录：首次沙箱执行 Vitest 在依赖 realpath 触发 EPERM，未收集测试；获准同命令提权后执行。最初 5 项中 1 项失败为测试 harness 的跨组件 setter 错误引用全局 cells，修正为捕获所属组件 cells 后通过；补诊断结构测试时两次因 UI/API mock 缺少导出失败，补齐 mock 后 6 项全部通过。首次 typecheck 等待模型子任务的约定 prop，后续通过。以上测试辅助实现修正没有改动业务草稿策略。

UI/UX Pro Max：已读指定 skill，按既有暖色 token/布局与公共控件复用，检查导航命名、hidden 表单、退出 Portal 与可访问标题。技能 scripts 是文本链接占位，初次脚本路径不存在；改为实际 skill-hub 源目录后完成 `animation accessibility z-index loading --domain ux` 查询。

## 3. 尚未验收

这些是组件回调/hook 与树结构自动验证，不是浏览器布局或真实 Electron 验收。1024×720、125% 缩放、键盘焦点、设置长页滚动、真实慢 Core.stop 下 Portal 隔离仍由父任务验收。未连接真实 QQ、SnowLuma 或付费模型；不宣称模型管理或阶段 B 实机项已完成。
