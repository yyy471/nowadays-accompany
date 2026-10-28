# 131共享层审计最终回归（实现方）

日期：2026-10-28。范围：[131 前端组件与动效统一规范审计](131-frontend-component-and-motion-standard-audit.md)的R1～R4修复后，由实现方执行的最终回归。**本文不是独立复核**；130/128/119等独立记录继续各自有效，131 R1～R4的独立复验仍待安排。

> 2026-10-28补充：[136独立复核](136-shared-motion-standard-fixes-independent-review.md)发现R1的嵌套显式full仍能解除祖先局部reduced；已由[137](137-nested-motion-scope-fix.md)修复，回归补证后全量为124文件1155项通过/1项既有跳过。本文R1的实现方通过状态以137为准。

## 1. 结论

**R1～R4在实现方自验范围内已处理完毕，公共共享层与开发样板回到同一动效策略、同一动画所有者、同一Dock组件；未发现新的阻塞问题。** 最终门控、开发版/生产dist浏览器回归、隔离Electron 100%/125%及131 R1/R2探针复跑均通过。独立复验、真实QQ/模型、真实触屏与发行包验收不在本轮范围。

## 2. 四项处理结果

| 审计项 | 处理 | 记录 | 当前状态 |
| --- | --- | --- | --- |
| 131-R1 局部reduced未约束WAAPI | `useMotionPolicy`合并局部motion，局部reduced为不可解除下限；CSS/WAAPI/Portal一致 | [132](132-shared-motion-scope-fix.md) | 实现方通过 |
| 131-R2 设置弹窗双入场 | 移除`.settings-dialog`旧CSS动画，公共Modal为唯一动画所有者 | [133](133-settings-single-entrance-fix.md) | 实现方通过 |
| 131-R3 Dock材质配方未全进token | token 1.4.0登记23个材质参数，`dock-notebook.css`消费component变量，数值不变 | [134](134-dock-material-tokens-and-workbench-dock-fix.md) | 实现方通过 |
| 131-R4 样板未复用正式Dock | Workbench直接渲染正式`PageDock`，本地假路由；导出`dockDestinations`供标签读取 | [134](134-dock-material-tokens-and-workbench-dock-fix.md) | 实现方通过 |

## 3. 最终门控

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `npm run ui:tokens:check` | 通过 | `test-results/hm/r3r4-final-tokens.log` |
| `npm run typecheck` | 通过 | `test-results/hm/r3r4-final-typecheck.log` |
| `npm test` | **124文件、1152项通过、1项既有跳过** | `test-results/hm/r3r4-final-vitest-2.log` |
| `npm run desktop:build` | 通过 | `test-results/hm/r3r4-final-build.log` |
| `git diff --check` | 通过 | 本轮命令无空白错误 |
| 开发版CDP | **30/30** | `test-results/hm/report.json`、`r3r4-drive-dev.log` |
| 生产dist CDP | **27/27** | `test-results/hm/report-prod.json`、`r3r4-drive-prod-final.log` |
| 隔离Electron 100% | **3/3** | `test-results/hm/electron-1.json`、`r3r4-electron-1.log` |
| 隔离Electron 125%（1440 CSS） | **3/3** | `test-results/hm/electron-1.25.json`、`r3r4-electron-1.25.log` |
| 131 R1/R2共享探针 | 通过 | `test-results/review131/browser-probes.json`、`r3r4-after-fix.log` |
| R3/R4专项探针 | 4/4 | `test-results/hm/r3r4-probe.json` |

## 4. 需要保留的波动与证据修正

- **全量首轮1项HTTP超时**：`test/http-body-adapters.test.ts`的“stalled chat body abort”在首轮全量中失败；该文件单独复跑4/4通过，随后全量124文件1152项通过。代码未改该路径，按运行环境时序波动记录；不据此宣称所有历史失败均已消除。
- **生产dist偶发26/27**：前两次生产回归的“再次点击当前页不重播选中签”检查把按压产生的`CSSTransition`也计为动画，采样到1个98ms的`box-shadow`/`translate`过渡；专项探针与重跑确认无WAAPI重播。检查已收敛为“不得出现WAAPI `Animation`”，同时保留CSS过渡明细；最终27/27，明细为`waapi=[]`，CSS过渡为合法的按压反馈。这不修改组件行为，只修正证据判据。
- **样板点击探针首次失败**：Workbench页面存在平滑滚动，固定等待后坐标仍在滚动中；探针改为等待滚动稳定并重新取坐标后通过。正式PageDock行为未改。
- 现有AST门禁与自动化仍不能替代真实触屏、原生草稿取消/安全退出组合、真实保存落款消费者；这些继续按126待补。

## 5. 边界

- 本轮未连接真实QQ、SnowLuma或付费模型；浏览器与Electron检查均使用隔离临时目录和假数据。
- 未重新打包、未替换发行EXE、未提交或推送。
- 未把“实现方最终回归通过”写成“独立验收通过”。131 R1～R4的独立复验、130之后的最终收口判断仍应由独立复核记录给出。
