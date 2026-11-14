# 桌面书桌首版样机实施记录

关联 [200 桌面前端计划](200-desktop-frontend-development-plan.md) 的 FE-01、FE-02。状态为实现方样机，待画面评审和独立复核。

## 运行

双击 [书桌入口](../../../desktop/desk-preview/index.html)，或在 PowerShell 中运行：

```powershell
Start-Process (Resolve-Path '.\desktop\desk-preview\index.html').Path
```

样机使用本地 HTML、CSS、JS 和 WebP 资产。页面默认按本地时间选择日间或夜间，右上角可预览晴天、阴雨和夜间。点台灯可在任意光照下独立开关。点主拍立得进入对话，按 Esc 或点「书桌」返回。挂历下的照片和底栏都可换角色。

## 本轮交付

- 由 Blender 小院版输出近机位日间、阴雨和夜间，各一对真实开灯／关灯底图。拍立得的可替换印面、玩偶、时钟、日期与纸条由页面叠合。主照片和点击区域使用 Blender 导出的相机锚点。
- 夏澄与阿柚为离线示例。角色独立保存本次打开期间的草稿和样例消息。阿柚暂无专属玩偶素材，页面切换后隐藏该物件层。照片使用同一张角色图连接独立聊天页，窄窗口与减少动态效果采用简化切换。
- 当前为昼夜离散预览。晨昏连续关键帧、四季资产、天气来源、真实 HTTP/SSE、桌面壳和数据持久化在后续工作包验收。此次保留独立静态入口供审查，桌面框架仍按计划实测选型。

## 资产与自验

资产来源为此前的 Blender 小院工程 `dorm-blender-courtyard/dorm-lighting-study.blend`。页面自带运行资产。需要重出底图时，用 [Blender 导出脚本](../../../desktop/desk-preview/tools/render_desk.py) 读取原工程，再用 [资产打包脚本](../../../desktop/desk-preview/tools/package_assets.py) 生成 WebP 与锚点。原始工程需使用此前的小院版交付文件，打包脚本使用 Pillow。

实现方以本地 Edge 验证 1440×900 与 510×720 布局、角色与草稿隔离、中文输入法事件、进入和返回焦点、日间开灯、阴雨预览、夜间开关灯和减少动态效果。浏览器样例消息为本地固定文本。视觉评审重点为近机位构图、窗外与主拍立得的亮度关系、夜间相纸及玩偶清晰度。
