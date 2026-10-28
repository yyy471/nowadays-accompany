# Dock材质token与样板复用正式Dock修复记录（131-R3/R4）

日期：2026-10-28。对象：[131 前端组件与动效统一规范审计](131-frontend-component-and-motion-standard-audit.md)的R3、R4；R1见[132](132-shared-motion-scope-fix.md)，R2见[133](133-settings-single-entrance-fix.md)。状态：实现方自验完成，独立复验待做；未提交、未推送、未打包。

## 1. R3：Dock材质配方进入token

- 原问题：`dock-notebook.css`的尺寸、跟随、按压与旗标已消费`dockNotebook`变量，但白昼/晚风表面混色、描边混色和接触阴影仍是CSS字面量；其中晚风还有`rgba(3, 7, 14, 0.25/0.2)`，不满足131要求的“同一参数来源”。
- 修复：`tokens.json`的`meta.version`由1.3.1升至1.4.0，在`primitive/semantic/component.dockNotebook`增加同一组23个材质参数，逐级引用；`dock-notebook.css`改为消费`--nd-component-dock-notebook-*`。所有替换保持原数值：例如白昼表面78%、纸缝80%、项表面92%、选中26%、书签表面74%、日影7%、晚风表面92%、缝线22%、书脊35%、暖光11%、深色阴影`rgba(3, 7, 14, 0.25/0.2)`。
- 未改为token的仍属布局或纯绘制细节：指针百分比、暖光半径、布纹透明度和渐变停点、项/书签几何与内缩。这与131“不机械地把每个0/1px都改成变量”的边界一致；`HomeScene`的4px跟随上限继续保留为局部字面值，不在本包扩大范围。
- 生成物：`npm run ui:tokens`已更新`character-tokens.css`；`npm run ui:tokens:check`通过。新增CSS契约测试检查23个用途变量均被`dock-notebook.css`消费，且文件不再出现`rgba(3, 7, 14`字面量。

实际证据：

- 隔离Chrome探针读取Dock计算样式：23个变量均解析为上述原值；白昼`box-shadow`不含暗色字面量，晚风Dock阴影含`rgba(3, 7, 14, 0.25)`、书签阴影含`rgba(3, 7, 14, 0.2)`；晚风布纹、琥珀暖光和22×2px旗标保持。
- 修复前后截图逐像素比对：`01-daylight-1440x900`、`04-nightwave-1440x900`、`05-compact-599x680`的Dock区域无差异；差异仅来自此前已存在的头部副标题文案和时钟。未用像素相似度替代行为检查，但可排除材质数值漂移。

## 2. R4：开发样板复用正式PageDock

- 原问题：`workbench/Workbench.tsx`手拼`nav.ui-page-dock`与`ControlButton`，缺少正式`.ui-dock-item`、共享选中签、更多入口和对应动作；后续开发者可能把旧结构当成组件契约继续复制。
- 修复：`components/shell/PageDock.tsx`导出正式直达目标`dockDestinations`，内部继续使用该表；`Workbench`删除本地`navItems`与手拼nav，直接渲染`<PageDock page={navigation} onNavigate={setNavigation} />`。导航仍只改本地样例状态，不访问业务后端。
- 样板说明文案改为“正式Dock与更多入口均只切换本页样例状态”；当前项标签按`dockDestinations`解析，更多菜单选中的非直达页面按`PAGES`解析，避免样板另维护一份路由名称。
- 未给样板新增假保存、假导航或第二套Dock；正式App的PageDock/MoreMenu和首页未改变结构。

实际证据：

- 静态契约测试：样板只渲染1个`.ui-page-dock`，包含`aria-label="主导航"`、共享`.ui-dock-marker`、`.ui-dock-more`和4个`.ui-dock-item`，不再出现“页面导航样例”。
- 隔离Chrome探针：点击“关系”后样板状态为`关系`，选中签与目标项左边界均为963.5px；打开更多菜单得到真实9项，选择“事件诊断”后样板状态为`事件诊断`，无`aria-current`，更多按钮`data-current="true"`且名称含“当前页面”，选中签与更多按钮左边界均为1175.5px，菜单关闭。

## 3. 本轮门控

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `npm run ui:tokens:check` | 通过 | `test-results/hm/r3r4-final-tokens.log` |
| `npm run typecheck` | 通过 | `test-results/hm/r3r4-final-typecheck.log` |
| `npm test` | **124文件、1152项通过、1项既有跳过** | `test-results/hm/r3r4-final-vitest-2.log` |
| `npm run desktop:build` | 通过 | `test-results/hm/r3r4-final-build.log` |
| `git diff --check` | 通过 | 本轮命令无空白错误 |
| 开发版CDP回归 | **30/30通过** | `test-results/hm/report.json`、`r3r4-drive-dev.log` |
| 生产dist CDP回归 | **27/27通过** | `test-results/hm/report-prod.json`、`r3r4-drive-prod-final.log` |
| 隔离Electron 100% | **3/3通过** | `test-results/hm/electron-1.json`、`r3r4-electron-1.log` |
| 隔离Electron 125%（1440 CSS） | **3/3通过** | `test-results/hm/electron-1.25.json`、`r3r4-electron-1.25.log` |
| 131 R1/R2共享探针复跑 | 通过 | `test-results/review131/browser-probes.json`、`r3r4-after-fix.log` |

全量测试首轮曾出现1项`test/http-body-adapters.test.ts`超时失败；该文件单独复跑4/4通过，随后全量124文件1152项通过，代码未涉及该HTTP路径。该次波动保留在[135最终回归](135-shared-audit-final-regression.md)中记录。

## 4. 边界与后续

- 本轮是R3/R4实现方自验；不把自动化通过等同独立复核或126完整验收。
- 未连接真实QQ、SnowLuma或付费模型；未重新打包发行EXE。
- 真实触屏、原生草稿取消与安全退出组合、真实业务保存落款消费者仍按126待补证据。
- 建议独立复核顺序：先核对token三层引用与Dock计算样式，再核对样板是否只保留一个正式Dock，最后复跑全量与浏览器/原生门控。
