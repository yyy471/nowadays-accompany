# 折信 N 品牌替换：方案、实施与自验

2026-10-28。用户明确采用折信原稿，不调整材质、高光或配色，并将展示字标首字母改为大写：`Nowadays`。本工作包由主代理实施，独立复核见[124](124-fold-logo-independent-review.md)。

## 采用方案与资产来源

来源：`E:/tmp/testWorkSpace/switchboard/nowadays-logo-n/fold/`。原目录不写入；只导入用户选定的折信方案，未导入书签或日轨方案。

- `nowadays-N-fold-app-light.svg`原样作为`desktop/assets/icon.svg`，用于固定酒红底应用图标。
- `nowadays-N-fold-app-light-16.svg`原样作为`desktop/assets/icon-small.svg`，用于16/20/24px帧。
- `nowadays-N-fold-symbol-light.svg`及`dark.svg`导入`desktop/renderer/src/assets/brand/fold-light.svg`及`fold-dark.svg`。仅将viewBox改为`246 234 532 556`，裁去画布留白，保留全部可见字形、渐变、光带和描边。
- 顶部图形盒34×36px，可见N约34px高；新增primitive → semantic → component.brand尺寸链，执行生成器，不手改生成CSS。token补丁版本1.3.1。

SVG是维护母版，PNG/ICO为构建产物。后续更新母版后先执行`npm run desktop:icon`，再执行桌面构建。

## 实际实现

- 公共`BrandMark`读取现有UiAppearance预置，正式壳和组件样板共用；daylight选light透明符号，nightwave选dark。导航仍调用原有goPage/草稿准入处理器。
- 顶部字标、窗口/网页标题、托盘提示、退出/失败提示及用户可见品牌文案使用`Nowadays`。`package.name`、CLI、appId、AppUserModelId、桥接标识、持久化键及显式userData目录规则保持原值。
- 图标构建使用Electron离屏渲染：1024px PNG，应用ICO八帧16/20/24/32/48/64/128/256，托盘ICO四帧16/20/24/32。小于32px使用专用小母版；其他帧使用应用母版。构建profile位于项目test-results，避免争用默认Electron缓存。
- Windows窗口使用多帧`icon.ico`；托盘直接加载`tray.ico`路径，不再将大PNG统一缩至16px。非Windows仍使用PNG。安装包win.icon、开始菜单/快捷方式展示品牌及打包资源复制均同步；favicon使用同步的多帧ICO，无令牌界面使用新的PNG。
- 独立初查发现窗口仍在使用PNG，已在最终构建前修正并由复核方关闭。

## 本次实际自验

| 检查 | 结果 |
| --- | --- |
| 图标生成 | `npm run desktop:icon`通过；实际查看1024 PNG，折信原稿正确 |
| 类型检查 | `npm run typecheck`通过，包含src/test/desktop及renderer |
| token同步 | `npm run ui:tokens:check`通过 |
| 全量Vitest | 最终123文件、1135项通过，1项既有跳过；`test-results/fold-logo-vitest-final.log` |
| 完整桌面构建 | `npm run desktop:build`通过；`test-results/fold-logo-build-final.log` |
| 生产dist实际页面 | 两主题×1440×900、1280×800、1024×720、800×600、390×740，共10组通过；logo成功解码、尺寸稳定、顶部无碰撞、页面无横纵溢出 |
| 导航与键盘 | 品牌返回主页、键盘Tab可见焦点、刷新恢复夜间主题通过 |
| 请求与鉴权页 | 切主题及返回主页无业务写请求；favicon HTTP 200，无令牌页使用新PNG |
| 空白检查 | `git diff --check`通过 |

生产dist使用Vite preview配隔离内存fixture，没有启动Core、真实QQ、SnowLuma或模型。验证脚本为`test-results/verify-fold-logo.mjs`，已关闭自建服务和浏览器。实际页面截图：[白昼](design/character-studio/fold-logo/daylight-1280.png)、[晚风](design/character-studio/fold-logo/nightwave-1280.png)；[机器记录](design/character-studio/fold-logo/review.json)。这些截图是本次实际构建的页面，不是候选样板。

验证过程中保留的失败：最初受限进程有96项因`EPERM lstat C:/Users/24349`失败，改用正常权限测试环境；随后13项暴露既有导航/退出测试的UI完整模拟缺少新增BrandMark导出，已补齐两处模拟后全量通过。键盘验证初版在鼠标点击后直接程序focus，未进入focus-visible；改为实际Tab/Shift+Tab后通过，没有修改焦点样式规避检查。

## 交付边界

源代码、生产dist、desktop-dist及图标产物已更新，旧发行EXE未重打包或覆盖；本次没有提交或推送。已运行的开发版需要重启主进程才能更新窗口/托盘图标。未将资产帧解析和网页截图称为实际Windows托盘、开始菜单缓存、安装包或其他DPI环境的验收。

开工前工作树已含Dock/动效规范与token的未提交更新，本次保留，只在当前基础上补充品牌采用记录与尺寸。
