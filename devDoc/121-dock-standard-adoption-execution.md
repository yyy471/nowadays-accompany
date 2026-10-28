# 昼夜手账Dock标准采用与规范同步记录

2026-10-28。用户明确采用HTML交互04，并要求检查更新前端动效、组件等规范。本次交付为规范/参数登记与采用参考归档；[120标准](120-dock-notebook-standard.md)定义目标，[122独立复核](122-dock-standard-independent-review.md)记录另一方证据。

## 1. 审计发现与更新

| 原规范/组件缺口 | 更新 |
| --- | --- |
| Dock仍以旧横排图文、commit/onSolid实色选中概括 | 120规定图上文下、书脊底座、共享索引、当前项text与entry图标；旧参数只保留兼容 |
| “同风格”未定义两主题独立材质边界 | 白昼纸面/樱粉鱼尾、晚风布面/缝线/琥珀局部暖光已采用，结构、命中与节奏共用 |
| 未覆盖指针跟随与按压的合成 | 内部各轴±1px、外层悬停上移2px，按压先收回悬停再下沉1px/缩至0.96；文字和点击区固定 |
| 鼠标/键盘/触摸/取消状态不完整 | 新增Enter/Space原生语义、触摸无hover、reduced/forced-colors、指针取消/离开/失焦/隐藏/尺寸/主题清理 |
| HTML“更多”是占位导航，生产为真实菜单 | 规范明确保留MoreMenu/DropdownMenu、currentLabel、草稿准入和焦点行为，不能照搬占位页 |
| 部分新几何/材质数值只有HTML常量 | token v1.3.0增加独立dockNotebook命名空间，旧dock值不变 |
| 采用与实施状态容易混淆 | 用户采用只覆盖Dock，正式React待迁移；同页环境光、便签、模拟叙事和首页留白仍为候选 |

已同步105 v1.4.0、110/117 v1.1.0、根DESIGN、根README、两级AGENTS、公共UI README与开发导航。120为Dock完整组件/交互标准，没有新增公共API或第三方动画库。

## 2. 参数与归档

- token新增34个primitive.dockNotebook、34个对应semantic引用与50个component.dockNotebook用途；后者复用16项已有时长、尺寸、颜色或缓动语义。
- 新参数尚无正式源码消费者，既有component.dock与所有旧值不变。生成CSS只增变量，由`npm run ui:tokens`生成；原生窗口token输出不变。
- [采用参考HTML及截图](design/character-studio/dock-notebook/README.md)复用已有插画，HTML只重映射仓内资源/CSS/相邻样板链接；DOM/CSS/交互逻辑与用户体验版本相同。白昼/晚风PNG与来源逐字节一致。
- 样板仍显示整体主页为候选，120与目录说明明确只有Dock已采用。其他主页优化未被默认为正式设计。

## 3. 实现方实际自验

- `npm run ui:tokens`、`npm run ui:tokens:check`通过。
- 对登记前快照`test-results/dock-adoption-tokens-before.json`递归比较：除meta.version外，343个旧叶值不变，旧component.dock完全相同。
- 原生窗口生成文件SHA256仍为`B106CDBC2E240281465BD0570B4C4750B94756B31032892A3A8CB81CED98DE29`。
- 定向`vitest run test/character-tokens.test.ts test/ui-library-contract.test.ts test/window-theme.test.ts --pool=forks --maxWorkers=1 --minWorkers=1`通过：3文件、17项，覆盖生成/三层/引用、公共控件归属与原生窗口主题。
- 在浏览器离线打开仓内归档HTML，10组Dock检查全部通过、无pageerror：跟随≤1px与文本/命中稳定；昼夜材质差异；真实鼠标按压/释放；即时导航与当前页不重播；Enter/Space；40次连续反向与选中签对齐；离开/取消清理；减少动效；两主题静态截图；375px触摸激活及≥44px命中。当前脚本`test-results/verify-archived-dock.mjs`，归档报告见[verification.json](design/character-studio/dock-notebook/verification.json)。
- 归档HTML与来源经同样路径重映射后完全一致，截图哈希一致；相关Markdown/HTML本地链接及`git diff --check`收口检查通过，机器报告在`test-results/dock-adoption-check.json`。

原HTML此前的11组主页/28组布局检查仅为样板历史证据；本次重新执行的是上述10组归档Dock检查，不把两者相加或当作正式应用验收。独立方的检查另见122。

## 4. 交付边界

本次没有修改正式PageDock、MoreMenu、运行样式或业务流程；新增生成变量尚未被它们消费。已安装EXE没有因文档与参数登记获得新Dock。未执行全量Core/QQ/模型、Electron原生窗口或发行包验收；不以以往测试数声称本次完成正式迁移。

后续正式接入依120扩展现有公共控件与样板，并实际验证导航准入、MoreMenu、焦点、退出锁定、缩放与生产构建。用户未采纳的主页候选继续单独评估。
