# 动效规范登记与样板归档执行记录

2026-10-27。用户要求先把之前认可的动效写入前端规范，再讨论新增视觉增强应在应用还是HTML验证。此次范围为规范/参数登记与样板归档，独立复核见[119](119-motion-standard-independent-review.md)。

## 交付

- 新增[117动效规范 v1.0](117-frontend-motion-standard.md)，统一书签按钮、逐笔保存落款、导航书签、分层阅读、来源弹窗、抽屉/折叠/开关、连续中断、减少动效与正式接入验收。
- 105升级v1.3.0；同步DESIGN、110、根README、两级AGENTS、公共UI和开发导航，新增明确入口与实施状态。
- token升级v1.2.0：登记18个`primitive.motionDetail`值、对应semantic引用与24个`component.motion`用途（其中6个复用原时长/缓动）。生成变量用于后续公共组件接入，目前无新消费者；既有变量值、颜色、字体、尺寸与原生窗口调色保持不变。
- 归档[精致版02](design/character-studio/motion-notes/motion-library-demo.html)、[初版01](design/character-studio/motion-notes/motion-library-demo-v1.html)及[说明](design/character-studio/motion-notes/README.md)，离线可读，初版对照链接可用。两份HTML与用户查看的原样板逐字节一致。

## 规范与实施的边界

昼夜天气过渡已在114/115实际接入；普通反馈、开关、场景跟随已有基础实现。书签端片、逐笔落款、导航书签、分层阅读、来源浮层与精细中断只在独立HTML验证，正式React组件仍待接入。token登记、归档和规范认可不作为应用已迁移的证据。

样板与正式规范存在明确差异：样板按压2px，正式公共按钮按既有1px收紧；真实跨页不要求所有页面常驻，继续按导航/草稿契约处理。样板模拟保存/资料/原生dialog不替代业务请求和公共Modal。

新光影、材质、专属图标及角色/模型页构图仍为候选。推荐先HTML做双主题/窗口对照，选定后更新视觉规范与token，再在公共React样板和真实Electron页面验证焦点、草稿、异步及缩放。

## 本次自验

- `npm run ui:tokens`、`npm run ui:tokens:check`通过。生成CSS由生成器更新；未手改生成物。
- 对登记前token快照逐项比较：除meta.version外，283个既有叶值不变；新增值保持primitive→semantic→component约束。原生窗口生成文件SHA256仍为`B106CDBC2E240281465BD0570B4C4750B94756B31032892A3A8CB81CED98DE29`。
- 定向`vitest run test/character-tokens.test.ts test/ui-library-contract.test.ts test/window-theme.test.ts --pool=forks --maxWorkers=1 --minWorkers=1`：3文件、17项通过，覆盖token/引用/生成同步、公共UI契约与原生窗口配色。
- 对11份相关文档检查262个本地链接，全部可达；样板相对初版对照文件存在，两份归档SHA256与原文件一致。`git diff --check`通过。核验脚本与报告在`test-results/check-motion-standard.mjs`及`motion-standard-check.json`。
- 实际打开仓库中归档HTML重新执行12组离线浏览器交互检查，全部通过、无pageerror、无外部请求；涵盖保存结果/逐笔落款、快速切页、输入保留、键盘焦点、弹窗中断、昼夜反向、减少动效/半速及双主题三组窗口。当前检查入口`test-results/verify-archived-motion.mjs`，报告`test-results/motion-demo-review.json`；不将这项结果当作真实业务页面迁移证据。

没有以往全量测试计作本次结果。此次不改变运行行为，不安装动画库，不执行全量Core/QQ/模型验证，不重新打包EXE。
