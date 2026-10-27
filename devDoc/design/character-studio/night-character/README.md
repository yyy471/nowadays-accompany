# 晚风电台 · 夏澄人物候选

2026-10-27。本目录保留人物设计素材及原候选预览。当前v2已正式采用到晚风主题，见 [112](../../../112-night-character-adoption.md)；v1未采用。

当前采用 **v2：侧坐、托腮、耳机听歌**，姿态、表情和室内服装均已重画。生产路径为`desktop/renderer/src/assets/themes/xiacheng/character-night.png`，原候选阶段及规范记录保留在111；实际采用证据以112为准。

- [v2透明人物](character-night-v2.png)
- [v2界面搭配预览](night-character-ui-preview-v2.png)
- [v2完整生成提示词](character-night-v2-prompt.txt)
- [深色token组合对比度](nightwave-contrast.json)

下方v1为之前站姿候选，保留比较：

- [人物透明PNG](character-night-v1.png)：内置image_gen生成，沿用夏澄面部、长发、发夹和红色手账；重画颈间耳机、灰蓝针织衫、自然站姿及冷暖双光源。
- [完整提示词](character-night-prompt.txt)：包含身份和灯光参考的职责、服装与姿态要求、透明背景约束。
- [界面搭配预览](night-character-ui-preview.png)：现有React界面＋隔离内存数据，通过单个浏览器中的图片请求替换生成；仅在该预览取消旧的亮度滤镜，未更改正式样式或业务数据。

深色组件建议：按钮采用琥珀强调、菜单/弹窗/输入区采用分层墨蓝纸面、次文字使用足够亮的灰蓝；状态色继续遵守成功/警告/错误语义。布局和操作位置延续浅色版。当前组件已有基础深色映射，后续可依据人物定稿进一步统一材质与细节。
