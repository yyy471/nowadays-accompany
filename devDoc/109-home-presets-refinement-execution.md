# 首页精简与昼夜预置主题执行记录

日期：2026-10-27。依据 [108 方案](108-home-presets-refinement-plan.md) 实施；本记录替代107中的首页账号栏、自动回复和绑定摘要交付现状。107保留为上一批历史证据。

## 1. 已实施

- 按红框删除首页附加信息与操作。顶部账号栏替换为「白昼来信 / 晚风电台」主题组，实际QQ资料不随主题切换。
- 首页保留插画/便签、标题、账号资料和「进入工作台」。首页不再读取policy/role-bindings或调用Agent操作。
- 顶部重复菜单移除，全部九个入口仍通过底部「更多」可达；设置按钮保留。
- 重写首页高度分配，首页独立禁止滚动；其他业务页和菜单/弹窗保留滚动能力。长签名不再产生内层滚动条。
- 内置两套共享token预置，选择存本机localStorage；存储不可用时仍可当次切换。根Provider、局部scope和Portal传递预置，确认队列保存发起时的主题。
- 夜间为墨蓝、暖白和琥珀色动作，便签、导航、设置和菜单同步调整。旧业务页只桥接原有调色变量。

## 2. 素材与设计判断

夜景通过内置imagegen基于原场景编辑，保存为 [scene-night.png](../desktop/renderer/src/assets/themes/xiacheng/scene-night.png)。沿用同一位夏澄与现有透明立绘，夜间适度降低曝光和饱和度。保留透明干笔边缘，取消白天日照，增加月光、远处窗灯和右侧局部台灯光。

生成提示词存于 [scene-night-prompt.txt](design/character-studio/home-presets/scene-night-prompt.txt)。没有新增音乐播放器、假频率、模拟正在播放或无功能的声波装饰；「电台」先通过夜景与陪伴语气表达。

## 3. 复核发现

底部菜单初次打开时，默认焦点可能在位置更新之前触发文档scroll事件，菜单会被自己的滚动关闭逻辑收起。已将进入和返回焦点改为preventScroll，并只调整菜单内部scrollTop。独立诊断脚本复现修复前的scroll→关闭与修复后的稳定点击，随后全部菜单和公共样板重新验收。

这次自验由同一实现方完成，自动化和原生截图是实际执行证据，不记作另一个人的独立复核；独立复核仍可按项目纪律补充。

## 4. 实际验证

状态与数据以 [review.json](design/character-studio/home-presets/review.json) 及本批日志为准：

- 两主题合计22组窗口尺寸：1440×960、1440×900、1280×800、1266×803、1024×720、819×576、768×900、414×896、375×812、320×780、375×600。
- 两主题均无首页上下滚动、页面横向溢出、Dock遮挡或主按钮裁切；鼠标滚轮不改变首页scrollTop。
- 主题切换更改场景、文案和配色，保留QQ身份、不产生业务写入，刷新后保留选择。
- 九个入口、设置弹窗、资料草稿跨主题保持、取消/放弃导航、长昵称/签名、素材失败与减少动效通过。
- 隔离Electron39.8.10的实际主屏scaleFactor=1.5，以及独立进程1.25渲染通过；未改变OS缩放。每种缩放均检查两套主题。

类型检查、token同步检查与最终完整桌面构建通过。全量Vitest为122文件通过、1124项通过、1项既有跳过，日志`test-results/home-presets-vitest.log`。主页10组检查通过，覆盖22组窗口布局和两种原生缩放；公共组件样板17组通过，菜单键盘、边缘定位、确认队列及焦点恢复保持可用。生产renderer约462.72kB JS、127.80kB CSS；额外夜景约2.33MB，不新增依赖。

## 5. 查看

- [白昼来信，1280](design/character-studio/home-presets/daylight-1280.png)
- [晚风电台，1280](design/character-studio/home-presets/nightwave-1280.png)
- [晚风窄屏](design/character-studio/home-presets/nightwave-375.png)
- [实际150%原生晚风](design/character-studio/home-presets/nightwave-electron-host.png)
- [125%进程晚风](design/character-studio/home-presets/nightwave-electron-125.png)

执行`npm run desktop:home-preview`可看实际前端＋内存样例接口。正式入口仍接实际桥与API；本批不启动真实Core/QQ/模型，也未打包或覆盖发行EXE。
