# 书桌 v0.1.2 原生窗口与天气细化

沿用 [203 书桌 v0.1.1](203-desktop-desk-window-and-art-refinement.md) 的家具、机位、书脊和角色交互。Windows x64 便携文件为 `Nowadays-Desk-0.1.2-win-x64.exe`。

## 改动

- 窗口恢复完整的 Windows 原生标题栏和外框，最小化、最大化、关闭由系统绘制。书桌铺满标题栏下方的内容区，应用图标仍来自 `dev`。
- 玩偶按场景和台灯状态单独渲染透明图层。点击时移动正在显示的同一层，桌面接触阴影单独缩放。关灯使用低强度冷色反光，开灯增加随台灯切换的局部暖光。
- 主拍立得继续使用夏澄原立绘，背景从 `dev:desktop/renderer/src/assets/themes/xiacheng/scene-ink.png` 的画室取景。房间时间只改变相纸亮度。
- Blender 窗框增加压条、接缝和把手。窗玻璃按左右窗格遮挡，雨景由淡远雨和折射水滴构成，雪景使用带积雪的小院底图和不同距离的雪片。近窗枝叶轻摆，晴天桌面叶影跟随，冬天保留杯口热气。窗口隐藏后暂停天气绘制。

## 重建

使用 [书桌渲染脚本](../../../desktop/desk-preview/tools/render_desk.py)，传入原小院 Blender 工程、输出目录以及 `--snow` 指向 [积雪小院源图](../../../desktop/desk-preview/tools/source/snow-courtyard.png)。从 `dev` 读取画室 PNG 到渲染输出目录，运行 [拍立得渲染脚本](../../../desktop/desk-preview/tools/render_portrait.py) 和 [资源打包脚本](../../../desktop/desk-preview/tools/package_assets.py)。桌面打包入口沿 [202](202-desktop-desk-windows-v1.md#开发与复核)。

雪景用内置 ImageGen 编辑原小院底图。使用提示词：

> Use case lighting-weather. Edit the existing full-bleed 4:5 hand-painted anime background plate for a desktop window. Precisely preserve the crop, positions, roof outline and slope, partly seen house and window, branch geometry and camera perspective. Change only the season to an early winter day just after a light snowfall. Add a softly irregular thin layer of naturally settled snow on the existing slate roof, ledge and a few visible foreground branches; reduce foliage density a little while preserving silhouettes, turn foliage from yellow-green toward muted cold sage, keep an atmospheric painted cloudy blue-grey sky. The home is the same pale cream. Snow lies only on upward surfaces. Keep the anime background texture and modest contrast. No falling flakes, no separate window frame, no indoors, no new objects, no new building, no text. The image must be a full-bleed vertical outdoor plate with identical perspective, position and crop to the reference.

天气继续由应用离线模拟，后端联调按 [200](200-desktop-frontend-development-plan.md) 推进。

本机对打包窗口验证了原生窗口边界、最小化、最大化、还原、玩偶连点保留同一图层、雪夜开关灯、雨水在中梃处的遮挡、天气与叶影运动。另直接启动单文件便携 EXE，验证书桌和对话入口。
