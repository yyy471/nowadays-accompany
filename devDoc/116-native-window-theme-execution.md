# 原生窗口标题栏与边框主题联动

2026-10-27。用户截图显示：网页已进入晚风，但Windows标题栏和边框仍浅色。本批让原生窗口跟随实际提交的昼夜预置，保留标准系统窗口及按钮。

## 方案与实现

- React的ThemePresetProvider在首屏读取本机预置、以及天气过渡实际提交新预置时，调用可选`setWindowTheme`桌面桥。浏览器无桥时继续正常显示。
- preload只暴露两个预置的窄接口；main复用现有`isTrustedWindowSender`验证当前窗口、主frame及控制面origin，退出时拒绝。适配器拒绝任意颜色、对象和非预置字符串。
- `desktop/window-theme.ts`设置应用级nativeTheme.light/dark、窗口背景及Windows窗口accent。没有修改OS设置、注册表或持久化业务配置。
- 白昼：窗口底#F5F0E8、原生强调#FFFCF7；晚风：窗口底#171D29、原生强调#202836。Windows负责实际边框、标题文字和按钮绘制。高对比时accent交还系统；非Windows不调用Windows专属accent API。
- 原生窗口配色由现有token生成器从同一份JSON的canvas/surface语义生成`desktop/window-theme-tokens.ts`，`ui:tokens:check`同时校验两份生成物，避免在main重复写色值。
- 保留默认frame、原生窗口按钮、拖动/缩放/吸附、菜单、托盘、草稿和关闭流程，天气过渡实现未被替换。

实现依据为本机Electron39.8.10的类型声明，以及官方[nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme#nativethemethemesource)、[窗口accent接口](https://www.electronjs.org/docs/latest/api/browser-window#winsetaccentcoloraccentcolor-windows)文档。实际Windows显示效果以本机原生验证为准。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck`通过 |
| token同步 | `npm run ui:tokens:check`通过 |
| 完整桌面构建 | `npm run desktop:build`通过 |
| 定向回归 | window-theme、character-tokens、settings-navigation、renderer-quit，4文件32项通过 |
| 全量Vitest | 123文件通过、1135项通过、1项既有跳过；日志`test-results/window-theme-vitest.log` |
| 真正原生窗口 | 使用生产preload＋窗口主题适配器、实际renderer及隔离内存接口，未启动Core/QQ/模型 |
| 原生往返与恢复 | 晚风→白昼→晚风，nativeTheme、背景和accent匹配；刷新恢复晚风，非法值被拒绝 |
| 非客户区截图 | Windows PrintWindow捕获自建测试窗口的原生标题栏和边框；晚风标题背景RGB32/40/54、白昼255/252/247，与token一致 |

证据：[晚风窗口](design/character-studio/window-frame/nightwave-native-frame.png)、[白昼窗口](design/character-studio/window-frame/daylight-native-frame.png)、[机器记录](design/character-studio/window-frame/review.json)。

最初desktopCapturer窗口缩略图会去掉原生非客户区，因此没有把它当标题栏证据；最终改为按自建窗口handle使用Win32 PrintWindow，图片已实际包含标题、最小化/最大化/关闭按钮。只捕获该测试窗口，不读取其他窗口内容。测试profile和截图均在工作区，测试进程结束后关闭。

## 交付与边界

main/preload发生变化，需要重新启动当前开发版`npm run desktop:start`，仅刷新网页无法替换已运行的主进程。之后在应用中切换预置，窗口与页面即时联动。没有重打包或覆盖旧发行EXE。

本批没有无边框窗口或自绘标题栏，没有改变QQ/SnowLuma、鉴权HTTP契约及安全退出。本机原生、类型与测试是实现方自验，不冒称另一个独立复核方；其他Windows版本和高对比人工外观仍由后续现场验收覆盖。
