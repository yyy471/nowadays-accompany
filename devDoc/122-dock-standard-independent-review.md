# 昼夜手账Dock规范采用独立复核

2026-10-28。独立复核方依据用户采用HTML交互04并要求更新前端规范的指令，审查[120 Dock标准](120-dock-notebook-standard.md)、[121登记与自验](121-dock-standard-adoption-execution.md)及对应文档、token和样板归档。复核方未参与这些文件的实施编辑；本记录与独立检查脚本由复核方编写。

## 1. 结论与范围

本工作包在规范同步、参数兼容与样板归档范围内通过，未发现阻塞问题。采用对象明确限定为Dock的图上文下、白昼纸签/晚风布面、微跟随、按压和到达反馈。正式React PageDock仍待迁移，其他主页环境光、便签纹理、签名分层、模拟事件与88px留白仍属候选；这些状态没有被合并为“已接入EXE”。

本次没有审核或确认新Dock的正式Electron实现。新增变量未被正式组件消费，现有PageDock、MoreMenu和业务流程保持原实现。生产迁移仍须按120完成导航准入、更多菜单、焦点、触摸、减少动效、强制颜色、原生缩放和生产构建等实际验收。

## 2. 文档与行为一致性

| 复核内容 | 结果 |
| --- | --- |
| DESIGN、105、110、117、120、两级AGENTS、公共UI README及开发导航 | 相互链接并区分采用目标、现有实现与其他候选；新增Dock标准没有扩散到普通按钮、账号切换或主题切换 |
| 尺寸与布局 | 120分别定义68/64/58px组件高度与现有72/64px旧Dock、104px壳预留的兼容关系；没有直接用样板88px留白覆盖全局布局 |
| 动效与状态 | 跟随/按压120ms、局部材质160ms、书签220ms与117节奏一致；位移合成、连续中断、清理、原生键盘激活和reduced均有约束 |
| 两主题 | 字体、结构、命中与节奏共用；白昼纸面和晚风布面/局部暖光仅作用于Dock，文字与选中语义另有明确规定 |
| MoreMenu与真实路由 | 120和公共UI明确禁止照搬HTML“更多”占位页；打开菜单不切页，非直接入口真实路由才对齐更多，保留currentLabel、草稿准入和返回焦点 |
| 当前源码核对 | PageDock继续组合ControlButton/Icon与MoreMenu，直接入口使用真实page及aria-current；MoreMenu继续通过DropdownMenu列出真实页面并调用onNavigate |

复核发现110共用骨架表的旧Dock尺寸缺少兼容基线标记，容易脱离120单读时误认作新目标。实现方已将110控件/骨架两行标注为旧实现基线，并补充新68/64/58px及圆角的120入口；105圆角表也同步补充适配入口。复核重读后此项关闭。

## 3. 独立实际检查

- 独立运行`npm run ui:tokens:check`通过，生成文件与JSON一致。
- 对`test-results/dock-adoption-tokens-before.json`递归比较，除`meta.version`外343个旧叶值全部不变；`component.dock`整体深比较相同。新增`primitive.dockNotebook`34项、`semantic.dockNotebook`34项、`component.dockNotebook`50项。
- 原生窗口生成文件`desktop/window-theme-tokens.ts`的SHA256仍为`B106CDBC2E240281465BD0570B4C4750B94756B31032892A3A8CB81CED98DE29`。
- 检索正式TS/TSX/CSS源码，排除生成CSS后未发现`dockNotebook`或新组件变量的消费，符合“参数已登记、正式组件待迁移”。
- 独立运行`vitest run test/character-tokens.test.ts test/character-theme.test.tsx test/ui-library-contract.test.ts --pool=forks --maxWorkers=1 --minWorkers=1`通过：3文件、13项。覆盖token生成/三层引用、主题与公共UI契约；不是新Dock运行交互验收。
- [归档HTML](design/character-studio/dock-notebook/home-motion-study.html)与用户体验版本按相同资源路径重映射后全文一致；[白昼图](design/character-studio/dock-notebook/daylight.png)及[晚风图](design/character-studio/dock-notebook/nightwave.png)与来源逐字节哈希一致。
- 检查相关Markdown链接及归档HTML静态本地资源路径；记录齐全后收口检查无缺失。`git diff --check`通过。

独立机器检查脚本/结果位于忽略产物`test-results/independent-dock-adoption.mjs`、`test-results/independent-dock-adoption.json`，定向测试输出在`test-results/independent-dock-vitest.log`。

## 4. 证据边界

复核方阅读了121及归档[浏览器报告](design/character-studio/dock-notebook/verification.json)，其中10组浏览器检查属于实现方本次自验，不计为独立方重复实测。截图一致性与HTML路径/内容检查不能替代实际交互或最终叠色对比度验收。

独立方没有运行全量Core测试、类型检查、桌面构建、Electron界面或发行包；本包未修改正式运行逻辑，仅同步规范、生成未消费变量并归档样板。未以旧版测试数、已安装EXE或其他主页候选证明本次正式迁移完成。
