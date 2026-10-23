# nowadays 标识方案：日常里的微光

2026-10-22。首版使用内置 image_gen 生成；用户确认后已重绘为项目原生SVG，并接入程序及 nowadays 名称。

小写 n 的连续拱形表达陪伴与连接，右上琥珀圆点呼应日光和每一天。沿用项目暖褐灰、琥珀、燕麦及奶油白色系，主标识不依赖复杂装饰。

交付：`nowadays-logo-concept-v1.png` 为方案展示图，含主标识、nowadays 字标和应用图标示意。生成提示词见 `prompt-v1.txt`。

正式源文件：`desktop/assets/icon.svg`；使用项目现有 Electron 图标脚本生成 PNG 与多尺寸 ICO，前端使用 `nowadays-icon.png` 避免缓存旧图。原方案展示图不直接打包为图标。

视觉复核：字标拼写正确，图形与暖色界面协调；实际34px导航图标已在页面截图检查。托盘原生16px效果仍需用户环境复核。接入截图：`../../../test-results/ui/branding/nowadays-app-applied.png`。完整改名与兼容记录见 `../../19-nowadays-branding.md`。
