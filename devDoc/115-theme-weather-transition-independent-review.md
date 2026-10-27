# 昼夜天气过渡独立复核

2026-10-27。独立复核方执行；不将实现方114的结果计作本人的验证。范围为公共主题切换、token、浏览器交互；未运行真实Core、QQ或模型，未检查已安装EXE。

## 已执行证据

- `npm run ui:tokens:check`通过。
- 定向`vitest run test/character-tokens.test.ts test/character-theme.test.tsx test/ui-library-contract.test.ts --pool=forks --maxWorkers=1 --minWorkers=1`：3文件、12项通过。沙箱内首次因读取node_modules的realpath遭EPERM、没有运行测试；同一检查在获准执行环境中通过。
- 自建独立内存样例`127.0.0.1:50440/50441`，使用实际React/Vite渲染器及Chromium，未导入产品Core。诊断脚本与输出在`test-results/independent-theme-review.mjs/json`。
- 浏览器10项检查通过：昼夜往返收尾、同tick三次程序反向选择、真实资料编辑器DOM节点/未保存内容/选区/焦点/路由保留、应用减少动效、系统减少动效、完整动效覆盖系统、过渡期间减少动效立即收尾、原生API缺失降级、刷新记忆、编辑与主题操作没有业务写入。无pageerror。
- 上述程序点击检查不作为真实鼠标透传的证据。另用`independent-theme-pointer.mjs`检查最终源码，不注入CSS：动画中elementFromPoint命中白昼按钮的SPAN，真实`page.mouse.click`产生对应pointerdown并最终切至daylight。最终方案只保留旧root快照，令新root退出命名捕获，实际交互由保持挂载的新主题DOM承担；没有强制给所有后代覆盖pointer-events。
- 最终素材实现独立4项检查通过，见`test-results/independent-theme-cold-art.mjs/json`：两张夜图延迟900ms时，过渡ready仍是两张完整白昼图；夜图解码后两张均采用；反向切回白昼后晚到解码不覆盖最终选择；目标素材加载失败时显示明确占位并保持主要入口可用。无pageerror。
- 追加实际生产dist时长复核：`127.0.0.1:50350`加载`/assets/index-CORpykV_.js`，无`/src/`脚本。`test-results/independent-theme-production.mjs/json`记录实际WAAPI的`effect.getTiming()`和`getComputedTiming()`：入夜/白昼旧root均400ms，三片叶子各550ms，晨光550ms；双向均正常收尾，无装饰残留及pageerror。3组检查通过。

## 审查发现与状态

1. 叶片2原来`right:-2%`、宽26px，在1440px窗口会整个落在视口外，命名快照可能空白。已报告实现方并修正为`right:1%`；独立浏览器复验三片起点均在视口内。
2. 原生View Transition对捕获内容的命中抑制，不能仅靠过渡伪元素pointer-events:none解决。实现方真实鼠标检查发现；最终改为旧快照覆于真实新DOM、用注册百分比变量裁去旧快照。独立真实鼠标复验已通过，关闭。
3. 首次冷缓存夜间切换原先存在素材未完成即取快照问题。独立对两张夜间PNG延迟900ms，在`transition.ready`采集到scene-night和character-night均`complete:false/naturalWidth:0`。最终HomeScene采用有界两套素材的预解码Promise Map，并在冷加载时保留上一套完整插画；4项独立复验通过，关闭。慢加载情况下人物/场景可以稍后整体出现，页面换色不等待图片。
4. 实现方生产检查发现CSS压缩会把400ms写为.4s，直接parseFloat导致0.4ms。最终解析器按s/ms换算，独立实际dist复核上述6个动画的真实时长均符合400/550ms，关闭。

## 结论

最终实现的本地浏览器交互、实际dist动画时长与源码审查范围通过，所列问题均已关闭。独立证据为12项定向单测、10项常规浏览器检查、1组真实鼠标反向点击、4项冷加载/素材故障检查、3组实际生产动画检查。应用未出现新的业务写入口或模块顶层可变状态；临时过渡动画、监听器与装饰均由每个Provider实例持有并在收尾/卸载时清理。

实际Electron、双主题外观截图、生产构建与全量测试由实现方另记；本记录不将这些作为独立验证结果，不涉及已安装EXE或真实服务验收。
