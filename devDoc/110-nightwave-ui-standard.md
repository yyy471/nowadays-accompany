# 晚风电台深色界面标准 v1.0

2026-10-27。适用于`nightwave`预置。与 [105 总体规范](105-frontend-design-system.md)、[117 动效规范](117-frontend-motion-standard.md)、[DESIGN.md](../DESIGN.md) 和 [tokens.json](design/character-studio/tokens.json) 共同构成前端规范。当前token版本1.2.0，新版本登记共用动效参数，既有机器色值不变；本标准不复制第二套字体、尺寸或业务组件。

**实施状态：** 首页、壳、主题选择与公共主题基础已接入；夜间坐姿人物v2已正式采用并移除旧压暗滤镜，见 [112](112-night-character-adoption.md)。未迁移业务页目前只桥接原有调色变量，不能据此宣称所有旧页面的深色组件和状态已逐项验收。规范整理见 [111](111-nightwave-standard-and-character-review.md)。

## 1. 视觉目标与共同标准

晚风电台是一张安静的夜间桌面：墨蓝环境、低亮度纸面、清晰暖白文字、月光和局部台灯。人物、窗景、便签、导航和控件使用同一光色关系。高强调集中于当前操作，不向每个分区增加发光、半透明面或完整容器。

| 项目 | 与白昼共用的标准 |
| --- | --- |
| 字体 | 系统中文UI字体；展示与等宽回退沿用105，不增加网络字体 |
| 排版 | hero44/54、page32/40、section20/28、body14/22、control13/20、caption12/18；窄屏标题档位同105 |
| 间距 | 4px基础；字段组16、面内24、分区32；不因深色额外缩字号 |
| 控件 | 常规44高、紧凑36、图标命中≥40；按钮圆角9、字段/弹窗12、Dock24 |
| 骨架 | 顶部基准80、Dock72/紧凑64；首页一屏，无上下滚动；业务页及长菜单/弹窗按原契约滚动 |
| 行为 | 同一页面的操作位置、Tab顺序、草稿保护、取消分支、异步归属不随主题变化 |
| 动效 | 反馈120ms、控件160ms、面板220ms；尊重系统与应用减少动效偏好 |

完整动效遵循[117书签与落款](117-frontend-motion-standard.md)：浮层退出160ms、页面280ms，书签/勾选/阅读顺序/来源浮层两主题共用参数与命中范围；夜间只换语义色与表面，成功落款使用success。精细动效当前为已认可HTML参照、正式组件待接入；光影/纸纹等新视觉增强仍属候选，不借此自动扩展本深色标准。

## 2. 深色色板与用途

以下是当前token的可读映射。实现使用语义/组件变量；原始值只在JSON的primitive定义。更改时同步规范与token，重新检查真实叠色。

| 语义token（`semantic.color.*`） | 深色值 | 允许用途 |
| --- | --- | --- |
| canvas | #171D29 | 页面桌面底色 |
| surface | #202836 | 字段、独立编辑面、菜单、弹窗 |
| text | #EEE5D8 | 正文、标题、输入内容 |
| textMuted | #ABB0BE | 提示、时间、便签小字、占位与说明 |
| onSolid | #1B2230 | 浅实色动作面和当前项上的深色字/图标 |
| commit | #BDCBDE | 提交、导航当前项、开启状态 |
| commitHover / commitDepth | #D7E1EF | 提交悬停/实色下沿，沿用现有组件映射 |
| entry | #D4AA87 | 进入工作台等主题主入口 |
| entryHover | #E8BF99 | 入口悬停 |
| entryDepth | #896C56 | 入口下沿和箭头端片；其上使用onSolid图标 |
| selection | #343140 | 轻量选择、展开区域、夜间便签；配text/textMuted |
| accentDecorative | #B78FA0 | 非必要细线与装饰；不承担小字阅读 |
| lineDecorative | #3D4657 | 分组细线，不作为字段唯一边界 |
| lineControl | #7F8B9E | 可操作控件必要边界 |
| focus | #BDCBDE | 2px焦点环，2px间隔 |
| success / successSurface | #A2CABB / #253D38 | 成功文字及底面 |
| warning / warningSurface | #E0BC83 / #42392E | 提醒及原因说明 |
| danger / dangerSurface | #F0A4B2 / #462D3A | 错误、危险动作及其底面 |
| disabledText / disabledSurface | #9A9FAF / #2D3545 | 禁用，不对整个控件降透明度 |
| backdrop | rgba(5,9,17,.65) | 模态遮罩；正文面保持实色 |

浮层可与字段使用相同surface，通过控件边界、间距和浮层阴影建立层次；不靠不断新增更亮的卡片叠层。表面阴影`0 6px 18px rgba(3,7,14,.2)`，浮层阴影`0 12px 32px rgba(3,7,14,.4)`；不能用阴影代替必要边界。

## 3. 组件深色规格

| 组件 | 默认 | 悬停/当前/反馈 | 共同要求 |
| --- | --- | --- | --- |
| Button primary / ConfirmButton | commit底＋onSolid字 | commitHover；按下1px位移并收短下沿 | 44高，不因反馈改变宽度 |
| Button entry | entry底＋onSolid字；entryDepth端片 | entryHover；保留清晰端片图标 | 琥珀是主题入口，不冒充成功状态 |
| Button default / CancelButton | surface＋text＋lineControl | selection底 | 次操作仍清晰可见 |
| Button ghost | transparent＋commit文字 | selection底 | 焦点环和可读名称保留 |
| Button danger | dangerSurface＋danger字/边界 | danger实色时用onSolid字 | 明确动作与后果，不借入口琥珀表示危险 |
| IconButton | surface、必要边界、明确label | selection或组件既定悬停 | 同一组线宽；不依赖图标颜色识别动作 |
| Input / SearchInput / Select / Textarea | surface＋text，lineControl边界 | focus环/边界；invalid用danger | 标签、帮助与错误关联；保留输入、原生键盘和只读复制 |
| Checkbox / Radio / Switch | 复用公共原生/受控行为 | checked用commit；状态文字和形状同步 | 深色与浅色同命中尺寸，Space可用；busy阻止重复且保留焦点 |
| ThemeSwitcher | surface中按钮组 | 当前项commit＋onSolid、aria-pressed | 只切外观；无账号切换、导航或业务写入 |
| PageDock | surface、轻量边界 | 当前页commit＋onSolid、aria-current | 底栏不覆盖主操作；更多可达全部入口 |
| DropdownMenu | surface＋lineControl＋浮层阴影 | hover/focus用selection；disabled用disabledText | 视口内定位、长列表内滚动、Esc返回触发点；初始焦点不滚动外层视口 |
| Modal / useConfirm | surface、text、实色正文和backdrop | 危险动作danger；取消初始焦点 | Portal继承调用预置，锁滚动/焦点、嵌套和取消契约不变 |
| Disclosure / 列表 / 表格 | 以排版和装饰分隔组织 | 展开/行选中用selection并有明确标记 | selected与expanded分开；避免嵌套按钮；对齐和数据可读性保持 |
| InlineNotice / ErrorNote / Tag | success/warning/danger各用对应前景/底色 | 文字、图标或形状表达含义 | 错误不变空态，未知不当成离线；必需消息不短暂闪过 |
| Avatar / 图片占位 | 保持几何尺寸；缺图有可读回退 | 实际头像保留原色 | 不给头像、二维码、用户媒体统一压暗或反色 |

夜间便签的标签使用textMuted；accentDecorative只负责非必要的装饰边缘。新设计如需附加颜色，先增加有实际用途的token并补充验证，不在业务CSS临时写一个近似值。

## 4. 状态组合与键盘

| 状态 | 深色要求 |
| --- | --- |
| default | 默认语义前景、背景和必要边界完整 |
| hover | 根据预置增强对比；允许变亮，不统一套“变深” |
| focus-visible | focus2px外环、间隔2px；立即显示，不能被hover/selected/invalid覆盖 |
| pressed | 位移1px、下沿收短；不改变布局 |
| selected / expanded | 对应ARIA和外观一起更新；不能仅靠颜色 |
| disabled | disabledText/disabledSurface；正确阻止交互，保留需要时可达的原因说明 |
| loading / saving | 在原动作附近显示，保留目标、尺寸与焦点；只限制相关操作 |
| error / success | 只展示已确认结果；未知写入不自动重试，错误保留编辑内容 |

同时出现focus、selected、invalid、busy时，每种必要信息都要可辨。深色模式不改变动作归属、队列、幂等、账号隔离或草稿注册。

## 5. 主题传播与实现边界

1. `ThemePresetProvider`管理`daylight/nightwave`及本机偏好；存储不可用时仍能当次切换。首屏读取偏好，避免先亮后暗。
2. `UiThemeProvider`提供React上下文；`UiThemeScope`提供局部外观与`data-ui-preset`。根`data-ui-palette`只提供token。不要把账号策略和外观偏好混在一起。
3. `Modal`的body Portal必须携带预置；`useConfirm`队列记录发起时预置。不能只给首页背景变暗而漏掉菜单/确认/设置。
4. 业务CSS消费semantic/component变量；基础控件外观写在公共`ui/`，页面只管理排列和素材位置。
5. `tokens.json`的`presets.nightwave`覆盖在生成时合并到三层token；缺失/未知路径、循环引用及不安全值应被拒绝。生成CSS不能手改。
6. 未迁移页面的旧变量桥接是过渡状态；逐页迁移需实际检查所有控件与状态，不能只检查canvas颜色。
7. 系统窗口、文件选择、托盘、剪贴板权限与桌面桥沿用现有能力；`color-scheme:dark`只服务原生控件，不能假称它会重绘全部操作系统界面。
8. Windows标题栏/边框通过受信桌面桥与实际提交的预置同步：nightwave用nativeTheme.dark、背景canvas、accent surface；daylight恢复对应浅色。颜色由同一token JSON生成，不手写第二套。保持标准窗口按钮与关闭流程；高对比时边框accent交还系统。当前实际实现和Win32截图见 [116](116-native-window-theme-execution.md)，网页预览本身不能改变外层浏览器窗口。

## 6. 人物、场景与美术资产

- 晚风立绘允许与白昼有不同的坐姿、神态和室内服装；保持夏澄的脸型、长发、发夹等身份锚点。旧版单纯降低亮度属于过渡处理。
- 夜间姿态优先放松、收拢、安静倾听；使用暖灯与冷月光重画肤色、发丝和衣料，不向整个人物套黑色蒙层。
- 当前已采用侧坐木凳、轻托脸颊、手账置于膝上、戴耳机的v2人物，配室内针织上衣和长裙。素材与提示词见 [人物设计目录](design/character-studio/night-character/README.md)，生产接入见112。
- 采用透明PNG，完整边缘和比例，预留几何尺寸；场景保持局部透明干笔边缘。人物本身可换姿势，不能遮挡控件或迫使首页出现滚动。
- 专门绘制的夜间图接入后应取消旧压暗滤镜，防止二次变暗；准确构图位置需在1440、1280、1024及实际原生缩放中重新校准。接入前不能把候选预览写成生产结果。
- 装饰位移≤4px；减少动效时归零。缺图仍保留账号、文字和主入口。媒体/插画不能替代真实业务状态。
- 以上位移约束针对常驻场景跟随。用户显式昼夜切换可使用105定义的400ms天气换景与550ms装饰收尾：入夜右上至左下三片叶，白昼左下至右上晨光。公共主题层统一实施，两套插画预解码、冷加载保留上一套完整画面；不得冻结新页面的鼠标操作。见[113方案](113-theme-weather-transition-plan.md)与[114实施](114-theme-weather-transition-execution.md)。

## 7. 对比度与验收

普通正文和必要辅助文字以实际底面≥4.5:1为项目目标；必要图标/边界/焦点≥3:1。数值来自本地计算，属于token组合证据，不等于整页或完整无障碍认证。颜色不能是状态的唯一线索。

当前复核发现玫瑰灰#B78FA0在便签底#343140上仅约4.49:1，已改用textMuted。可读字与必要边界不得用装饰色替代。具体计算见 [对比度记录](design/character-studio/night-character/nightwave-contrast.json)。

每个新增/迁移页面至少检查：

- 浅色与深色的default/hover/focus/pressed/disabled/loading/error/success，以及selected/expanded组合。
- 按钮、字段、搜索、选项、开关、菜单、表格/列表、弹窗、嵌套确认、空/错/旧数据。
- 主题切换保持账号、路由、未保存输入和任务状态；不自动提交、不产生新业务请求、不重建编辑器。
- 键盘可达、关闭/取消、焦点返回；菜单靠边定位；长昵称/路径/签名/错误可用。
- 首页无上下滚动、无横向溢出、Dock不遮挡、破图回退、减少动效和强制颜色。
- 桌面1440×960/900、1280×800、1024×720与小窗口回退；Electron实际150%及进程125%的证据分开记录，不改用户OS缩放。
- 先确认token同步，执行适合改动范围的类型/契约/界面验证；涉及运行行为时按项目全量要求验证。文档或候选图更新不借用历史测试声称新页面通过。

## 8. 规范维护

105维护共用的字体、尺寸、行为；110维护nightwave的完整配色和美术/组件映射；token JSON维护数值。根DESIGN只提供入口与方向，AGENTS负责让协作者读到这些要求。冲突先同步这几处，再实施。

本标准已写入项目，不要求另建一套深色组件库。后续每页同时验收两套预置，执行记录明确列出已验证和仍待验证的范围。
