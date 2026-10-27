# 晚风人物v2与前端规范落库记录

后续状态：本报告记录当时候选阶段；夜间坐姿人物现已正式采用，后续接入与生产包证据见 [112](112-night-character-adoption.md)。

2026-10-27。用户要求重新设计人物动作/神态/服装，并把深色模式标准及前端规范写进项目。本批交付候选图片、正式标准和项目入口；生产立绘仍保留原图，不把候选当作已经采用的实现。

## 1. 交付

| 交付 | 落点 |
| --- | --- |
| 新坐姿人物 | [character-night-v2.png](design/character-studio/night-character/character-night-v2.png) |
| 人物搭配预览 | [night-character-ui-preview-v2.png](design/character-studio/night-character/night-character-ui-preview-v2.png) |
| 生成提示词 | [character-night-v2-prompt.txt](design/character-studio/night-character/character-night-v2-prompt.txt) |
| 共用规范 | [105 v1.2.0](105-frontend-design-system.md) |
| 深色完整标准 | [110 v1.0](110-nightwave-ui-standard.md) |
| 项目执行入口 | 根[AGENTS](../AGENTS.md)、渲染层[AGENTS](../desktop/renderer/AGENTS.md)、根[DESIGN](../DESIGN.md)、根[README](../README.md)、公共[UI文档](../desktop/renderer/src/ui/README.md) |

## 2. 人物设计与状态

使用内置image_gen，以原夏澄作身份参考、夜间窗景作灯光参考，重新生成侧坐木凳、手托脸颊、膝上翻开手账、佩戴耳机的姿态。表情安静、略显放松，衣服为深色针织开衫、暖白针织上衣、长裙与袜子/室内拖鞋；保留长发、发夹与红色手账。原白天站姿与校服领结/帆布包不再用作这张候选的构图。

实际检查人物与手部、坐姿、木凳及完整鞋脚；冷月光与右侧暖光均已重画。图片保存在设计目录，未覆盖`src/assets/.../character.png`。搭配图由实际React界面＋内存样例接口制作，仅在一个隔离浏览器中替换图片响应、取消旧亮度滤镜；不是新人物已接入生产的证据。

采用该坐姿后仍需在正式页面调整占比与落点、去掉旧压暗滤镜，并复核小窗口/缩放。当前用户反馈阶段先保留候选；不自行扩展播放器或运行角色绑定系统。

## 3. 规范整理与遗漏修正

- 原规范已有基本nightwave色板，但缺少完整组件/状态差异及后续协作者的强制入口。新增110，涵盖语义色、表面、按钮/字段/开关/导航/菜单/弹窗/列表/消息、状态组合、Portal传播、资产和验收。
- 105中的“hover变深”“深蓝焦点”“浅粉选中”“纸白编辑面”等字面浅色描述改为语义标准；深色允许变亮，不另造一套字体/尺寸/组件。
- 清除“主页用自动回复开关”的过时说明；当前首页范围仍按108/109，不把已删除业务面板恢复回来。
- 根及渲染层AGENTS登记105/110和UI契约的读取顺序、三层token、双主题验收、首页不滚动和草稿/身份保护，供后续页面执行。
- 总规范v1.2.0和深色标准v1.0是文档版本；token数值仍为1.1.0，没有为排版或装饰新增未经需要的颜色。

复核夜间便签标签时发现accentDecorative #B78FA0在selection #343140上约4.490:1，低于项目普通小字4.5目标。已将`preset-appearance.css`中的便签小字改为既有textMuted，装饰色继续用于装饰。实际当前20组不透明token组合均通过各自4.5/3阈值，见 [nightwave-contrast.json](design/character-studio/night-character/nightwave-contrast.json)。这不是整页/屏幕阅读器完整认证。

## 4. 本次实际验证

- `npm run ui:tokens:check`通过，token和生成CSS同步。
- `npm run desktop:renderer`通过，候选图片未进入生产素材包。
- 既有token契约测试5项通过。
- 本地按sRGB相对亮度公式检查20组深色文字/图标/边界/焦点组合，通过。
- 当前主页验收入口`node desktop/scripts/verify-home.mjs --native`重新执行通过：10组检查、22组布局；Electron实际主屏150%与独立进程125%均通过，未改变OS缩放。结果见 [实际报告](design/character-studio/home-presets/review.json)。这份报告检查正式首页，人物v2搭配图单独作为候选预览。
- 根/渲染层AGENTS、README、DESIGN、105/110/111及公共UI文档的本地链接核对通过，`git diff --check`通过。

本批未更改业务TypeScript或数据契约，不重复把109的1124项历史全量测试记成本次执行结果。此次只有一个生产CSS语义修正，其余为文档和候选素材；未打包或覆盖发行EXE，未启动真实Core/QQ/模型。

## 5. 复核边界

本次为实现方自验及自动化/原生检查，没有另一个独立复核方；依项目纪律，独立复核可在后续补充，不能把本记录标题或自动脚本视为已完成两方复核。旧业务页目前只是深色色板桥接，后续逐页实现须按110逐状态验证。标准已落库不等于所有未来页面已达到标准。
