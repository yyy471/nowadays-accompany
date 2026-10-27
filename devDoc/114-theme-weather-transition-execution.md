# 昼夜天气过渡实施与自验

2026-10-27。用户授权实现「晚风翻夜 / 晨光揭晓」，方案见[113](113-theme-weather-transition-plan.md)，独立复核见[115](115-theme-weather-transition-independent-review.md)。

## 最终行为

- 晚风：柔边夜色由右上至左下揭示，三片手绘SVG叶片沿不同弧线飘过。晨光：从左下向右上揭示白昼，暖杏/浅粉余光消散。
- 主题换景400ms、装饰总长550ms，来自tokens.json的primitive→semantic→component引用。沿用既有色彩语义与缓动；105、110及公共UI文档同步记录昼夜切换这一动效。
- 首屏按本机偏好直接显示，不播放入场。重复点选不重播；快速反向只保留最后目标。系统减少动态效果、应用reduced、强制颜色、窗口隐藏、API缺失时直接完成；full显式覆盖系统减少动态效果。过渡中改成减少动效或隐藏窗口会收尾。
- React页面与编辑器持续挂载，保存原草稿、焦点、选区、滚动与路由。主题仍只写本机外观偏好，不写账号配置、不请求业务修改接口。
- 首页两套本地插画预解码；每个HomeScene只缓存两个主题Promise。目标插画慢加载时保留上一套完整人物/场景，解码后同批采用；反向切换不采用晚到素材，失败使用原有占位。

## 结构与修正

- `ui/theme-transition.ts`：每个Provider独立持有控制器、代际、活动动画和监听器；收尾/卸载取消动画并移除标记与监听器。
- `ui/theme-weather.tsx`、`theme-transition.css`：Portal只承载aria-hidden、无焦点且透传输入的装饰，命名快照将三片叶与晨光分离。
- 仅保留旧root绘制快照，用注册百分比变量推进柔边透明区域，露出保持真实DOM的新页。更新回调里让新root退出命名捕获，解决浏览器对捕获元素命中抑制的问题。规则依据见[W3C视图过渡绘制/命中说明](https://www.w3.org/TR/css-view-transitions-1/#view-transition-rendering-model)。没有复制业务React树或克隆编辑器。
- 过渡期间暂停控件CSS transition，避免快照中捕获旧背景/新文字的混合状态。
- 叶片2改成可见起点，避免视口外快照为空。生产CSS会把400ms/550ms压缩为.4s/.55s，读取时显式换算成WAAPI需要的毫秒；生产检查验证真实时长。

## 实际自验

- `npm run typecheck`通过（最终代码，包含renderer）。
- `npm test`通过：122文件、1124项通过、1项既有跳过。最终完整日志在`test-results/theme-transition-vitest.log`。随后生产检查发现并修复的时长单位换算，已通过最终类型检查、生产构建和实际生产动画检查。
- `npm run desktop:build`通过。最终JS为`assets/index-CORpykV_.js`，CSS为`assets/index-IFPBO3XF.css`；主进程、preload构建通过。没有重打NSIS/portable。
- `npm run ui:tokens:check`与`git diff --check`通过；生成CSS由生成命令更新。
- `desktop/scripts/verify-theme-transition.mjs --native`对实际开发渲染器和最终生产dist各执行8组检查，均通过；最终保存的是生产dist结果。生产预览为127.0.0.1:50350，API代理到隔离内存样例50341，不导入Core、QQ或模型。
- 覆盖双向命名快照与400/550ms真实时长、实际鼠标反向点击、30次同tick交替选择、真实编辑器节点/草稿/焦点/选区/滚动/路由保持、system/reduced/full与动画中改变偏好、强制颜色、API缺失/存储拒绝、刷新记忆、无业务写入、1440×900/1024×720/375×812两主题无溢出，以及Electron 39隔离沙箱窗口。
- [结构化报告](design/character-studio/theme-transition/review.json)、[入夜中段截图](design/character-studio/theme-transition/nightwave-midpoint.png)、[晨光中段截图](design/character-studio/theme-transition/daylight-midpoint.png)、[Electron入夜](design/character-studio/theme-transition/nightwave-electron-midpoint.png)、[Electron晨光](design/character-studio/theme-transition/daylight-electron-midpoint.png)。截图暂停的是实际动画的190ms帧，没有替换生产素材。

首轮沙箱执行受到Windows realpath/本机网络权限限制；同一检查在获准环境中实际执行通过，未把未运行的测试算作通过。浏览器实际点击首次发现输入命中问题；生产dist首次发现时长单位问题，均修正后复验通过。

独立方另执行12项定向单测、10项常规交互、真实鼠标反向点击、4项冷加载/故障与3组生产时长/收尾核查，见115。两方证据分别记录。

## 查看与边界

使用当前源码开发版或`npm run desktop:start`查看顶部昼夜切换；已安装的旧EXE不会随本次源码更新。生产隔离预览明确显示「样例数据」，只用于检查界面。慢磁盘/人为限速下插画可能稍后整体切换，页面换色不等待图片；没有真实QQ/模型联调或发行包验收结论。
