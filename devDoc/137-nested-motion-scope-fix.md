# 嵌套作用域减少动效下限修复记录（136-R1）

日期：2026-10-28。对象：[136 共享组件与动效规范修复独立复核](136-shared-motion-standard-fixes-independent-review.md)的 R1；R1 原修复见[132](132-shared-motion-scope-fix.md)。状态：实现方自验完成，独立复验待做；未提交、未推送、未打包。

## 1. 问题与修复

- 原问题：`appearance.tsx`的`UiThemeProvider`与`UiThemeScope`都用`motion ?? inherited.motion`合并局部偏好，后代的显式`full`会覆盖祖先的`reduced`；`useMotionPolicy`只能看到最近一层Appearance，无法恢复已丢失的祖先结论。
- 修复：在Appearance继承层新增唯一合并规则`mergeMotion`——祖先或当前任一`reduced`都优先，否则沿用当前显式值或继承值。`UiThemeProvider`与`UiThemeScope`共同使用该规则，嵌套`full`不能再解除祖先局部`reduced`。
- 保留既有语义：没有reduced下限时，显式`full`仍为full；全局`full`仍可覆盖系统减少动效；`UiAppearanceProvider`继续只提供确认请求发起时捕获的已合并外观，不向Portal重新改写队列语义。
- 未要求页面各自补Provider，也未新增第二套作用域或动效策略；CSS的`data-motion`与`useMotionPolicy`继续读取同一合并结论。

## 2. 测试与证据

新增/补充`test/ui-motion-contract.test.tsx`（20项通过）：

- 外层reduced → `UiThemeProvider motion="full"` → 内层显式full/未指定scope，三层DOM的`data-motion`均为reduced。
- 全局full + 外层reduced + 中间Provider full + 内层scope full，`useMotionPolicy`有效结论为reduced。
- 没有祖先reduced时，显式full仍输出`data-motion="full"`且有效策略为full，确认下限没有反向扩大。

隔离Chrome运行当前真实公共组件：

- 136原嵌套探针（复制到`test-results/review136-fix/original/`，不改写原复核证据）修复后全部通过：外层reduced+内层full时弹窗/菜单/确认均为reduced且无运行动画；外层动态切full后菜单正常出现动画（`localMidBefore.motion=full, running=1`），再切reduced立即收束（`running=0, opacity=1`）；设置弹窗仍只有1个220ms WAAPI。
- 扩展组合探针9/9通过（`test-results/review136-fix/nested-probes-fix.json`）：
  - 外层reduced→内层scope full：菜单、Modal Portal、两条排队确认均为`motion=reduced`、无运行动画、opacity 1。
  - 外层reduced→中间`UiThemeProvider(full)`→子组件：菜单、Modal、确认同样保持reduced。
  - 祖先动态full→reduced：已打开菜单和Modal均立即收束；Modal保持隔离，退出后滚动与inert恢复。
  - 没有祖先reduced时，内层full的菜单仍播放160ms动画，确认全局full语义未被改坏。

## 3. 门控

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | **124文件、1155项通过、1项既有跳过** | `test-results/review136-fix/full.log` |
| `npm run typecheck` | 通过 | `test-results/review136-fix/typecheck.log` |
| `npm run desktop:build` | 通过 | `test-results/review136-fix/build.log` |
| `npm run ui:tokens:check` | 通过 | `test-results/review136-fix/tokens.log` |
| `git diff --check` | 通过 | 本轮命令无空白错误 |
| 开发版CDP | **30/30** | `test-results/review136-fix/drive-dev.log` |
| 生产dist CDP | **27/27** | `test-results/review136-fix/drive-prod.log` |
| 隔离Electron 100% / 125%（1440 CSS） | **各3/3** | `test-results/review136-fix/electron-1.log`、`electron-1.25.log` |
| 131单层公共组件探针 | 通过 | `test-results/review136-fix/review131-probe.log` |

## 4. 边界

- 排队确认仍在发起时捕获已经合并的局部结论；已排队或已展示请求不随后续祖先变化改写，这是132既有队列语义，新请求会采用更新后的合并结果。本轮不把该队列语义改成实时订阅。
- 未连接真实QQ、SnowLuma或付费模型；未重新打包发行EXE。
- 本轮为实现方自验，136-R1的独立复验待做；不把自动化通过等同136整体收口。
