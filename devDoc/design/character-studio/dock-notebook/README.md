# 昼夜手账Dock交互04采用参考

2026-10-28。用户采用的是本样板的Dock组件与交互，规范见[120](../../../120-dock-notebook-standard.md)。

- [打开采用参考HTML](home-motion-study.html)
- [白昼Dock](daylight.png) / [晚风Dock](nightwave.png)
- [本次归档的10组离线浏览器核验](verification.json)
- [主页方案取舍历史](home-motion-plan-assessment.md)
- [先前动效手记02](../motion-notes/motion-library-demo.html)

## 状态

已采用：图上文下、书脊底座、共享索引、白昼纸签/樱粉鱼尾、晚风布面/琥珀暖光，以及项内微跟随、按压、释放、到达和输入方式适配。

同页其余内容（环境光、便签纹理、签名分层、模拟事件/落款和88px首页留白）仍是候选。HTML中的“更多”占位路由不替代正式MoreMenu；正式PageDock尚未迁移，新变量登记不等于EXE已更新。

## 归档方式

来源为本次会话用户实际体验的`home-motion-study.html`及`dock-interaction-*.png`。为避免复制约8MB现有插画，HTML的`home-study-assets/`相对地址重映射到仓库现有`desktop/renderer/src/assets/themes/xiacheng/`；token样式重映射到`ui/character-tokens.css`，动效手记链接重映射到相邻归档。样板的DOM、CSS与交互逻辑保持不变；取舍说明同样只修正相对链接。

在完整仓库中双击HTML可离线查看；若只单独复制此HTML，需同时提供所引用的资源。采用截图保留当时外观，当前生成CSS新增的未消费变量不改变既有颜色和时长。

原样板已完成10组Dock交互与11组主页/28组布局检查。本次归档重新验证的结果单独记录在[121](../../../121-dock-standard-adoption-execution.md)，独立复核见[122](../../../122-dock-standard-independent-review.md)。HTML浏览器证据不替代真实业务、导航准入和Electron原生窗口验收。
