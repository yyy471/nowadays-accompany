# 桌面书房界面分批实施与复验

实施依据为[分批设计方案](../../design/character-studio/frontend-polish-plan.md)和[前端设计规范](../../specs/frontend-design-system.md)。以下为 Windows 本机、仓库 Node 24 的实施记录。子代理承担开发，主进程检查差异、截图，并串行运行 Electron。测试使用临时角色库、本机后端或离线服务样例。

## 分批记录

各批均执行渲染器 `npm.cmd run check`、`npm.cmd test` 和 `npm.cmd run build`。专项 Electron 用例表中省略文件后缀 `.e2e.cjs`。每批的命令输出位于仓库根目录的 `test-results/polish-<批次>/`。

| 批次 | 可观察的改变 | 通过的专项 Electron 用例 |
| --- | --- | --- |
| 1 | 收口已落地的主题、字体和旧文件清理；角色与动态重试隔离旧响应；通知可悬停暂停，分享纸笺退场时停止接收点击。 | pack3-entry、cross-page-share |
| 2 | 选角页标识统一为「常驻主角色 · 默认保留」。外壳、对话、关系、动态和设置使用简短的状态说明，入口单测同步检查新标识。 | pack3-entry、settings-workspace、settings-sheet-focus、dialogue-layout、relations-desktop |
| 3A | 720 宽的标志和主题切换同一行，服饰图注移到立绘下方。选角列表可滚动到首尾，扩展区按宽度排列。公共控件区分忙碌、禁用、悬停与键盘焦点。 | startup-flow-fixes、pack3-entry、extension-ui-slots、cross-page-share |
| 3B | 窄窗给消息留下阅读高度，关闭历史后焦点回到命中消息。声纹区分合成和播放，共用预取请求时保留服务端错误；场景图生成、解码、重画与重试在图框内反馈，旧成功图片仍可回看。 | dialogue-layout、theme-transition、cross-page-share、startup-flow-fixes、workflow-real-backend-chain |
| 3C | 书页眉按面包屑、装饰条与页码实占宽度排列；证据可原位重试并聚焦。动态筛选与近期安排可独立横向滚动，手动刷新反映两组读取的实际结果，从对话返回时定位原卡。 | relations-desktop、role-exchanges、relations-review-234、pack3-entry、cross-page-share |
| 3D | 服务测试显示进行状态、指标和失败原因。样图解码后显影，上传失败可在图框内重试；暂存录音可直接播放、停止。保存、删除、解绑和活动变更按真实结果给纸签回执。 | settings-real-backend、settings-media-sheet、settings-workspace、settings-v6-behavior、settings-sheet-focus、settings-review-fixes、settings-auto-reload、settings-binding-recovery、token-usage、startup-flow-fixes、workflow-real-backend-chain、pack3-entry |
| 4 | 切页、折叠、编辑纸笺和通知按透明度与位移过渡；快速切换或中途开启减少动效时清理在途快照。关系页保留 41 个刻度，对话按 14 档逐行换光。夜间衣柜差分计数改用主题纸面色和墨色。 | 全部 19 个 Electron 脚本串行执行，另运行夜间布局截图 |

## 复验发现与修正

- 跨页分享和首次启动回归分别锁定了「放弃修改」与「即将赶来」。恢复两处提示并重跑原流程。
- 对话布局测试在 Chromium 的相邻矩形边界测到小于 0.00001 CSS px 的差值。几何测试采用 0.5 CSS px 容差，同时保留窄窗消息区高度和可见性断言。语音测试让点播加入未完成的预取，核对只发起一次请求，且失败原因与该请求一致。
- 窄窗经历页原先让装饰条与面包屑实际重叠约 1.7 px。三列页眉现在按内容分配宽度，回归还检查了 320 宽时的间距。动态页曾被长列表撑宽，修正嵌套网格的最小列宽与间距令牌后验证了独立滚动和焦点恢复。
- 设置用例实际切换昼夜，逐像素比较同一区域已有立绘；另在打开纸笺前后比较画框。校验失效上传时的服务端错误、旧图保留和后续成功解码；配置保存使用后端已返回的服饰记录更新界面。
- 分享队列在已有纸笺退场期间到达新消息时保留顺序。测试监听实际透明度过渡并在其中途切换减少动效。夜间窄窗衣柜截图暴露了剩余差分计数的低对比度，现与相邻缩略图分别取色。

## 最终验证与截图

最终构建为 `index-DAPLtWI0.js` 和 `index-z_czVvnc.css`。19/19 个 Electron 脚本逐个退出 0，追加的夜间选角和布局用例也退出 0。已校验 72 张分主题原图的文件格式、像素尺寸以及同一页面的昼夜图像差异。完整脚本清单、构建与截图 SHA-256 保存在 `test-results/polish-verified/summary.json`。

| 项目 | 复验结果与证据 |
| --- | --- |
| 环境与构建 | Windows，仓库 Node v24.22.2，渲染器 check、test、Vite build 均通过。令牌生成物同步，32 个 CSS 文件无违规。渲染器 140/140、桌面壳 15/15，均零跳过。 |
| 几何 | 昼夜两套预设下，1440、1280、720 宽的配置状态点横坐标分别约为 1296.67、1136.67、598.67 CSS px。各行偏差断言保留 0.5 CSS px 容差。原始测量在 `test-results/settings-media-sheet/v6-behavior.json`。 |
| 立绘 | 主题切换前后，已有立绘框内部 301×577 区域共 173,677 像素，变化 0 个。开纸笺前后也逐像素相同。原图在 `test-results/settings-media-sheet/portrait-*.png`。 |
| 行为 | 完整用例包括本机后端写入与回读、假端点生成与播放、重试与取消、选角和导航、跨页分享、伸缩与换光、配置焦点与遮罩、扩展槽位。试生图的重复点击还检查了焦点、ARIA 状态和上游请求数。 |
| 产物 | `test-results/page-layout/{daylight,nightwave}/{720x540,1280x800,1440x840}/` 按主题和窗口大小保存 12 种页面状态。日间平铺截图保留原入口。两张 `*-overview.jpg` 可对照查看；逐脚本日志在 `test-results/polish-verified/`。 |
| 巡检 | 文档巡检零错误、零警告。仓库卫生巡检零错误，三条大文件警告分别涉及 conversation-service.ts、Settings.tsx 与 character-tokens.css。生产构建报告入口 JS 超过 500 kB 的体积提醒。 |

复现时，先将仓库 `.tools/node-v24` 加到 PATH。在 `apps/desktop/renderer` 执行上述渲染器命令，再在 `apps/desktop` 运行 `node --test tests/unit/*.test.cjs`，并逐个串行运行 `tests/e2e/*.e2e.cjs`。另设 `PAGE_LAYOUT_THEME=nightwave` 再运行一次 `pack3-entry.e2e.cjs`，该用例通过真实主题按钮保存夜间偏好并重新进入选角页。

## 证据边界

初次交付通过主进程本机复验，随后收到下节的视觉复核意见。真实外部模型服务和打包安装未纳入本轮门禁。

前端自有文案遵守用词约束。角色介绍、历史对话等业务内容按保存值呈现。仓库后端默认播种的人物介绍含方案禁词，本轮遵守后端目录边界并保留了该介绍；首屏主页禁词断言仍在。已保存的语音参考通过合成试听，暂存于本机的参考录音另有原声播放入口。

## 视觉复核后的补修

| 复核位置 | 调整与验证重点 |
| --- | --- |
| 配置回执 | 通知在顶栏下方居中，长文案换行，悬停和点击仍可操作。用长服务名实测还发现编辑标题会撑开纸笺网格，把关闭按钮推到窗外；纸笺列现在允许收缩，为关闭按钮保留宽度。 |
| 历史搜索 | 输入区的键盘焦点环沿外层圆角绘制。清除按钮有独立焦点指示，强制颜色模式使用系统焦点色。 |
| 扩展目录 | 单栏时标题与卡片一起在窗口居中；存在槽位时展开双栏。 |
| 过场图 | 收起和重新生成共用有底色、细边与轻阴影的纸签按钮。重画时保留旧图、按钮焦点与防重复提交。 |
| 文案与时间 | 经历、日记眉标分别使用「经历 · 回看」「日记 · 随笔」。证据以本机时区显示年月日和时分，保留原始机器可读时间。连接测试显示「正在测试连接…」，对话输入区说明发送和换行按键，选角错误分清列表与详情并给出原因和对应重试。 |
| 配置书签 | 悬停使用横向位移，不改变布局边距；当前书签保持贴合，减少动效下保持原位。 |
| 纠错弹窗截图 | 等待当前面板与遮罩的入场动画完成再截屏，保留弹窗既有实色表面。 |

补修构建为 `index-DN1cgUyL.js` 和 `index-Dwa8_FOz.css`。仓库 Node 24 下渲染器 check、build、140/140 单测、桌面壳 15/15 单测通过；全部 19 个 Electron 脚本串行通过，额外夜间截图用例通过。设置测试实测宽窄窗内长回执的关闭、返回和主题按钮点击命中；历史搜索测试实测键盘 Tab、Enter 和强制颜色模式；过场图重画用例实测保留焦点并拦截重复提交。立绘昼夜检查变化 868/173,677 像素，约 0.50%，满足小于 1% 的契约。

已刷新 `test-results/page-layout/` 的 72 张原图及总览、`test-results/full-chain-review/` 的对话和设置截图、`test-results/relations-v2/` 的关系与纠错截图。逐用例日志和最新构建、截图 SHA-256 清单在 `test-results/polish-visual-review/`。
