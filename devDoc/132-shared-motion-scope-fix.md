# 共享层局部动效策略修复记录（131-R1）

日期：2026-10-28。对象：[131 前端组件与动效统一规范审计](131-frontend-component-and-motion-standard-audit.md)的 R1；R2 见[133](133-settings-single-entrance-fix.md)，R3/R4 见[134](134-dock-material-tokens-and-workbench-dock-fix.md)。状态：实现方自验完成，独立复验待做；未提交、未推送、未打包。

> 2026-10-28补充：136复核发现嵌套显式`full`仍能覆盖祖先局部`reduced`，已由[137](137-nested-motion-scope-fix.md)在Appearance继承层统一补齐；R1的reduced下限现在覆盖整条作用域链。

## 1. 统一规则

`reduced` 是不可解除的下限，`full` 只表示“没有减少要求”，不能解除任何已成立的 reduced 结论。CSS、WAAPI、Portal 和确认队列消费同一份结论。

| 全局策略 | 局部 UiThemeScope | 有效结果 |
| --- | --- | --- |
| `system`，系统无 reduce | 未指定 / `full` | 正常动效 |
| `system`，系统 reduce | 未指定 / `full` | reduced |
| `system`，系统无 reduce | `reduced` | reduced |
| `full`（覆盖系统 reduce） | 未指定 / `full` | 正常动效 |
| `full` | `reduced` | reduced |
| `reduced` | 未指定 / `full` / `reduced` | reduced |

- 局部 `reduced` 会约束其后代，包括嵌套 `UiThemeScope`；嵌套 scope 未显式指定时不重置。
- 局部 `full` 不能覆盖全局或系统的 reduced；只有**全局 full** 可以覆盖系统 `prefers-reduced-motion`。
- 排队确认在发起时捕获局部外观（含 motion），与既有 theme/preset 捕获一致；排队和展示期间全局偏好仍按当前策略更新。scope 后续变化只影响新请求，不改已排队请求的局部外观。

## 2. 代码变更

| 文件 | 变更 |
| --- | --- |
| [motion.tsx](../desktop/renderer/src/ui/motion.tsx) | 新增 `applyScopedMotionPolicy()`；`useMotionPolicy()` 合并全局 Context 与当前 `UiAppearance.motion`，局部 reduced 成为下限 |
| [appearance.tsx](../desktop/renderer/src/ui/appearance.tsx) | `UiThemeScope` 未显式指定 motion 时继承调用处，并写入 `data-motion`；`UiThemeProvider` 同样保留继承的 motion |
| [character-theme.css](../desktop/renderer/src/ui/character-theme.css) | 系统 reduce 的全局规则不再排除局部 `data-motion="full"`；只有根 `html[data-motion="full"]` 可解除 |
| [dock-notebook.css](../desktop/renderer/src/ui/dock-notebook.css) | 同上，Dock 图标的 reduced 静态规则不再被局部 full 绕过 |
| [ui-motion-contract.test.tsx](../test/ui-motion-contract.test.tsx) | 新增局部优先级、嵌套继承和 CSS 下限契约 |

`Modal`、`Menu`、`PageDock`、`Home` 等消费者不需要各自再嵌 Provider；它们继续调用 `useMotionPolicy()`，自动获得局部结论。Portal 通过 `appearance.motion` 写入 `data-motion`，排队确认通过既有 `UiAppearanceProvider` 继承请求时的局部外观。

## 3. 实际组件证据

使用 131 的隔离 Chrome headless 探针，重新打包当前真实组件与公共 CSS；全局 `MotionPolicyProvider preference="full"`，局部 `UiThemeScope motion="reduced"`：

| 检查 | 结果 |
| --- | --- |
| 局部 reduced 弹窗 | `data-motion=reduced`；运行中动画 `[]`；opacity `1` |
| 局部 reduced 菜单 | 运行中动画 `0` |
| 局部 reduced 确认队列 | `motion=reduced`；运行中动画 `[]`；opacity `1` |
| 菜单运行中把局部切为 reduced | 切换前 `full`、运行中动画 `1`；切换后 `reduced`、运行中动画 `0`、opacity `1` |
| 既有设置弹窗双动画 | 仍同时存在 `settings-appear` 与 Modal WAAPI，属于未处理的 131-R2，本记录不作为 R1 通过依据 |

探针位于 `test-results/review131/`（忽略目录）。本轮为定位确认队列的真实调用位置修正过探针结构：`useConfirm` 必须在 `UiThemeScope` 内调用；修正后确认了局部 reduced 已传入 Portal。该证据由实现方执行，不替代独立复验。

## 4. 回归门控

| 命令/检查 | 结果 |
| --- | --- |
| `npm run ui:tokens:check` | Character tokens: up to date |
| `npm run typecheck` | 通过 |
| `npm test` | 124 文件、1149 项通过、1 项既有跳过 |
| `npm run desktop:build` | 通过 |
| `git diff --check` | 无空白错误 |
| Chrome CDP 开发版 / 生产 dist | 30/30、27/27 通过 |
| 隔离 Electron 100% / 125%（1440 CSS） | 各 3/3 通过 |

## 5. 边界与后续

- R1 修复不改任何业务页面布局、导航目的地或保存流程；R2（设置弹窗双动画）已由[133](133-settings-single-entrance-fix.md)处理，R3（Dock 配方 token）、R4（样板复用正式 Dock）已由[134](134-dock-material-tokens-and-workbench-dock-fix.md)处理。
- 局部 reduced 的 CSS 下限已覆盖公共主题与 Dock；旧页面自身的非公共 CSS 若仍有独立动画，随各页面迁移处理，不并入本包。
- 131 的独立复核结论保持历史状态；本修复待独立复验后再更新关闭状态。
- 未提交、未推送、未打包；预览服务器在验证后停止。
