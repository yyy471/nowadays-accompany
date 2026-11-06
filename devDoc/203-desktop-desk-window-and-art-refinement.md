# 书桌 v0.1.1 窗口与场景细化

本轮延续 [202 Windows 前端初版](202-desktop-desk-windows-v1.md)，保留书桌机位、家具和交互入口。便携文件名为 `Nowadays-Desk-0.1.1-win-x64.exe`。

- 应用图标和托盘图标来自 `dev:desktop/assets/icon.ico` 与 `dev:desktop/assets/icon.png`。折信标志来自 `dev:desktop/renderer/src/assets/brand/fold-light.svg` 和 `fold-dark.svg`。主界面去除上下栏，书桌直接铺满窗口。上缘可拖动，右上角保留 Windows 的窗口控制。
- 书脊在 Blender 内使用活动记录、角色相册、角色资料、模型配置、技能与连接、应用设置六个名称。书脊仍可轻抽，物件悬停时的外框已移除，键盘焦点保留虚线提示。
- 便笺纸面和图钉参与场景渲染，文字叠到纸面。玩偶静止时使用与房间同光照渲染的局部层，点击时短暂切到可弹动图层。
- 灯光的位置对齐灯泡，发光表面与灯泡外形一致。原立绘重新与清晰的庭院背景合成。花瓶保留原模型，换成有花瓣厚度、花芯、枝条与叶片的几何花材。

资源沿 [书桌渲染脚本](../desktop/desk-preview/tools/render_desk.py)、[拍立得渲染脚本](../desktop/desk-preview/tools/render_portrait.py) 和 [资产打包脚本](../desktop/desk-preview/tools/package_assets.py) 生成。对应日夜、天气与台灯的底图及玩偶局部层一同打包。交付范围仍为本机 Windows 前端，天气与对话使用离线场景数据。

实现方验证了打包窗口的满幅场景、窗口控件、鼠标悬停、六本书、拍立得、灯光和环境设置，并直接启动最终便携 EXE 进入对话。用 Windows 提取便携 EXE 和应用 EXE 的 32×32 图标，与 `dev` 原图标的对应尺寸逐像素一致。
