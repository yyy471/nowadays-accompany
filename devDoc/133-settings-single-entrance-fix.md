# 设置弹窗单一入场动画修复记录（131-R2）

日期：2026-10-28。对象：[131 前端组件与动效统一规范审计](131-frontend-component-and-motion-standard-audit.md)的 R2；R1 见[132](132-shared-motion-scope-fix.md)，R3/R4 见[134](134-dock-material-tokens-and-workbench-dock-fix.md)。状态：实现方自验完成，独立复验待做；未提交、未推送、未打包。

## 1. 问题与修复

- 原问题：`styles.css` 的 `.settings-dialog` 仍声明 `animation: settings-appear .2s ease both`，与公共 Modal 对同一 `.ui-modal-panel` 的 220ms WAAPI 同时控制 `opacity/transform`，同一元素存在两个动画所有者。
- 修复：仅移除 `.settings-dialog` 上的旧 `animation` 声明及无其他消费者的 `@keyframes settings-appear`；保留设置窗口的宽高、内容、配色、背景和业务交互。设置弹窗的进入、退出、中断、隔离与焦点全部由公共 `Modal` 负责。
- 没有为设置页新增第二套 Modal 或绕过公共动作；`SettingsDialog` 组件代码未改。

## 2. 证据

- 131 隔离 Chrome 探针（真实 `Modal` + `.settings-dialog` 类，全局 full）：
  - 修复前：`CSSAnimation settings-appear` 200ms + `Animation` 220ms。
  - 修复后：仅 `Animation` 220ms，无 CSSAnimation；R1 的局部 reduced 菜单、弹窗、确认队列和运行中切换仍保持通过。
- 实际 App（开发版/生产 dist）：
  - 打开设置时面板只有 1 个运行中的 WAAPI（type `Animation`，duration 220ms），无 `settings-appear`。
  - 关闭再打开仍只有 1 个 WAAPI；打开后快速 Escape 保持退出前隔离、结束后移除、滚动恢复且焦点回到设置按钮。
  - reduced 中途切换、Esc、焦点返回等既有检查继续通过。
- 门控：`npm run ui:tokens:check`、`npm run typecheck`、`npm test`（124 文件/1150 项通过、1 项既有跳过）、`npm run desktop:build`、`git diff --check` 通过；开发版 CDP 30/30、生产 dist 27/27；隔离 Electron 100% / 125%（1440 CSS）各 3/3。

## 3. 测试与边界

- 新增 CSS 契约：`.settings-dialog` 不再包含 `animation:`，`styles.css` 不再包含 `@keyframes settings-appear`；实际 App 检查断言进入、重开的面板动画只有一个且类型为 WAAPI。
- 未删除其他页面的独立入场动画；未改设置页布局、字段、草稿保护和退出协议。
- R1 的局部 reduced 下限与 R2 的单一动画所有者分别成立；R3（Dock 配方 token）、R4（样板复用正式 Dock）已由[134](134-dock-material-tokens-and-workbench-dock-fix.md)处理。
- 本轮为 R2 实现方自验，独立复验待做；未提交、未推送、未打包。
