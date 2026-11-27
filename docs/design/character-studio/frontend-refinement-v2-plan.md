# 桌面前端二期创意精修与四阶段交付规范（`DL-194`～`DL-199` 接入）

> **定位**：由 **Gemini（审美与设计工程师）** 与 **GPT-6.2-Astra** 两轮联合共创并完成源码级契约压测后的定稿规范；**GPT-6.2-Astra** 主导分阶段实施与自验，每阶段完成后交回 **Gemini** 逐项复核，全部通过后再推进下一阶段。
> **基线**：`dev-front` 分支 `c575959`（已落地 `DL-194`～`DL-199`；**本轮严禁擅自改动 `apps/backend/`**）。
> **关联文档**：[前端设计规范](../../specs/frontend-design-system.md) · [设计令牌源](./tokens.json) · [首轮前端精修规范](./frontend-polish-plan.md) · [161 决策记录](../../161-digital-life-direction-decisions.md) · [当前状态看板](../../STATUS.md) · [协作指南](../../../AGENTS.md)

---

## 0. 已拍板产品决定与绝对禁止项

### 已确认决策（不可回退）
- **信息架构 = IA-1**：维持现有 **7 个顶层页面**，**不新增第 8 个顶层页面**；深化「扩展」页（宽屏左目录右台面；`720×540` 窄屏页内「台面 / 已安装」双视图切换）。
- **动态页布局 = B**：单栏书页 + 顶部可折叠「接下来」书签条。
- **主题切屏节奏 = B**：全站与对话页统一连续羽化遮罩，从点击到图层清理总时长 **≤ `550ms`**；关系页保留特色藏书票刻度折页，整体压缩至 **`800–900ms`**。
- **对话生图入口 = A**：仅最新一条已完成且可生图的 assistant 回复常驻显眼「生成过场图」入口，其余历史轮在 hover / `:focus-within` 下显现，完整保留 `DL-142` 指定历史轮生成、查看与重试路径。

### 明确否决项（严禁引入）
1. 严禁给停机角色立绘施加灰度/变灰等 CSS 滤镜（违背 [前端设计规范](../../specs/frontend-design-system.md) 无滤镜红线）。
2. 严禁将 `.config-role-switch` 原生 `<select>` 替换为自定义菜单组件（会破坏现有 3 条 E2E）。
3. 严禁静默跳过冷启动 `RoleEntry` 页面。
4. 严禁合并或隐藏对话页重生成/重试语义。
5. 严禁伪造任何后端/桥接未确认的状态回执（例如工程胶囊假的 1.2s「✓ 已落成」印章、共玩栏假的「已邀入局」提示）。
6. 严禁对用户自定义任意比例图片硬套 `object-position + scale` 裁头，严禁在每枚小头像上独立挂载 `RolePortrait` 触发重复拉图。

---

## 1. 信息架构定案（IA-1）与工程红线

### 1.1 为何采用 IA-1（不新增页面）
- **贴合扩展使用闭环**：用户交互扩展台面、排查工具作用域与故障交修均围绕具体扩展发生，宽屏保留「左目录 + 右台面」、`720×540` 窄屏引入页内**「台面 / 已安装」**切换，即可彻底缓解窄屏纵向拥挤，且零增加顶层导航深度。
- **为何否决并入「设置」（IA-2）**：设置已有 6 个页签；MCP/Skill 属于可编辑的全局/角色绑定资源，而热扩展 `selected_roles` 为版本只读作用域声明，并列会制造可编辑错觉；扩展崩溃时强制跳入设置还会触发草稿离开守卫，破坏 `DL-197` 页内交修回执。
- **为何本轮否决新增「工坊/工程」第 8 页（IA-3）**：后端 `GET /v1/engineering/jobs` 与 SSE 目前仅投影运行中任务，既无历史记录接口也无发起窗口归属——独立工程页会在任务结束瞬间变成空白；当前以左下角「案头工签」承接在途工程最为诚实。

### 1.2 环境、令牌与颜色棘轮红线
- **运行环境**：Windows PowerShell 无 `python` / `rg`，统一使用仓库 Node 24：
  `$env:PATH = (Resolve-Path '.tools/node-v24').Path + ';' + $env:PATH`
- **零新增语义色、零提高棘轮上限**：
  - 基线已实测 `apps/desktop/renderer/src/styles/settings-workspace.css` 颜色 `33/33`、阴影 `14/15`，`apps/desktop/renderer/src/styles.css` 颜色 `74/74`、阴影 `2/2`，两份样式文件颜色余量均为 0。
  - 所有纸底、细边、墨点、暖色羽化带与焦点环一律复用现有 `surface`、`lineDecorative`、`textMuted`、`accentDecorative`、`focus` 与 `color-mix()`。
  - 动效复用 `themeReveal`（400ms）、`themeTotal`（550ms）、`scene`（900ms），**不得全局缩短 `sceneLong`**；仅当 300ms 按钮反馈延迟确需跨组件共享时，方可在 `tokens.json` 新增具名时间令牌并运行 `npm.cmd run tokens`。**严禁手改 `apps/desktop/renderer/src/ui/character-tokens.css`**。
- **几何与文案红线**：全站严禁出现「陪伴」二字；严守锁定 `T*` 文案常量、`.config-sum .ui-dot` 水平 X 对齐、已有立绘 `.config-stage .config-portrait` 主题切屏像素变化 `< 1%`、关系页 `.edition-strip` 可见不重叠、`RoleEntry` 冷启动前置与 7 页边界。

---

## 2. 全站四角浮层空间预算总表（防撞契约）

`PageDock` 挂载在页面底部 footer，左侧栏占宽为 **0px**（`720×540` 下普通壳底栏最小高 `80px`，设置页与动态页底栏 `54px`，Dock 高 `48px`；业务壳内仅对话页开启「隐藏底部导航栏」时收起 Dock；冷启动 `RoleEntry` 不挂载四类浮层）。按 `720×540` CSS 像素统一预算如下：

| 浮层区域 | 层级与定位基准 | 720×540 尺寸与防撞预算 | 交互与可访问性硬要求 |
|---|---|---|---|
| 顶部居中 `ConfigNotice` | `z=1020`，`top: 66px`，水平居中 | 宽 ≤ `420px`，高 ≤ `80px`（长文允许换行） | 避让两侧主题、返回、关闭按钮命中区；不把跨页导航按钮塞进 `aria-hidden` 且自动关闭的提示条 |
| 左下统一列（`EngineeringCapsule` + `ExtensionOverlays`） | **合并为单个 `z=60` 容器**，`left: 24px`，`bottom: 104px`（隐 Dock 时 `24px`） | 宽 ≤ `320px`，**整列总高 ≤ `192px`**（工程单行摘要 `40px` + 间距 `8px` + 扩展余 `144px`） | `720×540` 工程胶囊默认收起为单行摘要；展开后在同一 `192px` 预算内滚动，单项取消按钮始终可达；不得遮挡 Dock「更多」菜单与 `Sheet` 操作区 |
| 右下 `ShareSlip` | `z=60`，`right: 24px`，`bottom: 104px`（隐 Dock 时 `24px`） | 宽 ≤ `320px`，高 ≤ `144px`（长摘要正文区内部滚动） | 满宽时左下占 `x=24..344`、右下占 `x=376..696`，**中间净距 `32px`**；关闭与「查看对话」固定可点 |
| 页内 `DialogueToast` | 取消 `fixed bottom: 24px`，**迁回对话栏工具条下方页内反馈位** | 距工具条 `8px`，宽 ≤ `min(320px, 栏宽 − 32px)`，高 ≤ `64px` | 普通提示 `pointer-events: none`；沿用 `role="status"` 并保留完整错误文本；不得阻挡对话输入、推进与语音按钮 |

### `Sheet` 与全局 `Modal` 分离验收规则
- **配置 `Sheet` 打开时**：`.config-book` 建立局部层叠上下文并升至 `z=11`，壳级 `ShareSlip`（`z=60`）必须保持可命中可点击（守住 `cross-page-share.e2e.cjs:109–125` 真实点击与草稿守卫）；同步在 `720×540` 视口实测 `Sheet` 保存/关闭按钮、`ShareSlip` 查看按钮与 Dock「更多」菜单均无遮挡、均可点。
- **全局 `Modal` 打开时**：`Modal` 使用 body portal（首层 `1000`，逐层 `+10`）并将顶层 backdrop 以外的 body 子节点设为 `inert` / `aria-hidden`；此时四类背景反馈一律暂停交互，新到达分享保留待处理。本规范只统一 CSS 预算与显隐规则，保留各组件原有的消息所有权与播报区。

---

## 3. 四阶段实施明细与阶段验收门禁

### 阶段一：新功能深度融入 Tone B 纸感美学（`DL-194`～`DL-199`）

1. **「案头工签」与左下角统一浮层列**
   - 涉及：`apps/desktop/renderer/src/components/shell/EngineeringCapsule.tsx`、`styles/engineering-capsule.css`、`extensions/ExtensionViews.tsx`、`styles/extensions.css`。
   - 将工程胶囊从左上角迁入左下角统一 `z=60` 容器，共享第 2 节高度预算；`720×540` 默认收起为单行摘要「后台工程 N 项」并可展开取消。
   - 补齐 `.ui-floating-surface` 纸感阴影、1 枚安静呼吸墨点、极轻暖色底线、`busy={cancelling}` 态与全宽错误提示；工程结束移除时干脆淡出，严禁伪造「✓ 已落成」。

2. **「扩展」页深化与三项微创新**
   - 涉及：`apps/desktop/renderer/src/extensions/ExtensionViews.tsx`、`ExtensionSlotFrame.tsx`、`slot-bridge.ts`、`repair-request.ts`、`use-extensions.ts`、`styles/extensions.css`、`App.tsx`。
   - **宽窄分治与视图状态**：宽屏保留左目录（版本与工具Scope降为紧凑次级行，故障与交修留在行内）+ 右台面；`720×540` 窄屏增加页内「台面 / 已安装」切换（有微页/挂件时默认台面，新快照到达保留用户所选视图，切换不重复挂载同一 iframe，失效槽位及时撤下）。
   - **诚实空态「空台邀请笺」**：仅当本次连接**已收到成功 `snapshot` 且未筛选的 `items.length === 0`** 时，在 `.extension-catalog` 呈现安静的桌面邀请笺及次级按钮「去对话里提一个想法」（仅导航，不自动发消息；若直指主角色需明确写出目标，禁止静默切角色）；首次读取与断线重连分别呈现加载与「正在重连」，绝不因 `onerror` 清空数组而误报未安装。
   - **「按人翻工具目录」**：在已安装目录顶部增加本地角色筛选丸（含「全部」入口兜底，确保故障与无工具扩展始终可见），直接复用现有 `tools.scope`/`roleIds` 与启用态。
   - **「对坐席签」共玩栏**：标签改为 Tone B「一起玩的角色」+ 小型 `RoleFace` + 原生 `<Select>`（窄屏自动换行）；按钮按 `DL-198` 继续显示当前点名对象名；`busy` **仅覆盖单次点击往返**（不得锁定 5 秒合并窗）；扩展 `slot-bridge.ts` 使宿主 `play()` 收到可区分的 ok/error 结果（成功交给游戏本体与真实 `ShareSlip`，失败在按钮旁轻提示，换版/导航/卸载后的迟到结果不污染新按钮）。
   - **页级交修回执**：将 `windowId + extId + faultFingerprint` 提升至页级状态，同时持有在途状态、`submissionId` 与已送达态，仅当权威快照确认故障消失或变化时清理；故障行保留 `role="status"`（空闲不渲染空 `<p>`，失败改 `role="alert"`），送达后显示「已交给主角色排查」（不强行臆测绑定同名工程流）。
   - **「台面留一枚书签」**：在扩展台面点击 `ShareSlip` 跳转对话时，于 `App` 记录临时返回位置（视图 + 扩展 + 文件），对话页提供轻返回胶囊「回到刚才的台面」；仅承诺回到刚才所在位置，回访时校验启用态（换版展示新版，已删回落目录）。

3. **「导入工具陈列盘」与持久下一步入口**
   - 涉及：`apps/desktop/renderer/src/components/config/ExtensionImport.tsx`、`pages/Settings.tsx`。
   - 表单按 `MediaGroup` / `.config-actions` 规范重排；将 `L170` 裸 `<select>` 替换为设计系统 `<Select>`；`discover`、`probe`、`save` 各自独立 `busy`；工具探测结果由唯一 `ProbeFeedback` 播报（探测 0 工具仍属有效成功）。
   - MCP 配置解析展示安全摘要条：仅列选中 server、安全命令名（**剥离个人绝对路径**）、参数个数与待补 env key，绝不回显敏感值。
   - Skill 扫描区分三条路径：未扫描 / `400 SKILL_DIRECTORY_EMPTY`（温和提示目录无 Skill）/ `400 SKILL_DIRECTORY_UNREADABLE` 与提交导入时的 `409 SKILL_DIRECTORY_CHANGED`（清空旧选择并允许重扫）。
   - **「导入后留一个下一步」**：放进刚导入资源的**持久可聚焦详情操作区**（不塞入 `ConfigNotice`），提供「去角色配置启用」按钮，扩展 `workspaceRequest` 支持 `'ext'` + 对应 `resourceId` 定位高亮（批量 Skill 按实际选中 `resourceId` 定位，严格遵守 `editId` 与草稿守卫）；成功回执仍只播报一次。

- **阶段一验收门禁（完成即交 Gemini 复核）**：
  - `apps/desktop/renderer`：`npm.cmd run check`、`npm.cmd test`、`npm.cmd run build`；
  - `apps/desktop`：`npx -y node@24 --test tests/unit/*.test.cjs`；
  - E2E：`extension-ui-slots`、`engineering-capsule`、`cross-page-share`（补窄屏 `720×540` 与折叠实测）、`workflow-real-backend-chain`、`settings-workspace`；
  - 交付变更清单 + `720×540` / `1280×800` 昼夜截图。

---

### 阶段二：跨页壳层、四角浮层收口与「晨落暮升」主题切屏

1. **四角浮层防撞落实与 `DialogueToast` 迁址**
   - 涉及：`apps/desktop/renderer/src/styles/settings-workspace.css`、`styles/engineering-capsule.css`、`styles/extensions.css`、`styles/share-slip.css`、`styles/conversation.css`、`pages/Conversation.tsx`。
   - 按第 2 节总表落地全部宽高、边距与 `DialogueToast` 页内定位，实测 `Sheet`、`Modal` 与 Dock「更多」菜单零遮挡。

2. **「晨落暮升」统一主题切屏与关系页折页提速**
   - 涉及：`apps/desktop/renderer/src/ui/config-theme-transition.tsx`、`conversation/dialogue-theme.ts`、`relations/exlibris-theme.ts`、`styles/theme-transition.css` 等。
   - 全站与对话页统一连续羽化遮罩（白昼自上而下、夜幕自下而上），羽化带内嵌极淡暖色过渡（`color-mix()`，**取消 1px 亮金硬线**以规避 Windows 高 DPI 闪烁）。
   - **点击至清理严格 ≤ `550ms`**：设置页不再在 2-rAF 之后才起 550ms 定时器，改用共享点击截止时间；克隆页壳时**剔除活动扩展 `<iframe>`** 避免子页重加载；保留立绘挖空（`< 1%` 像素不变）。
   - 关系页保留特色藏书票折页，兼容装饰条 **25 / 41** 两档刻度，同步校准提交点、末刻度与清理点至 **`800–900ms`**；完善 `data-motion="reduced"` / `prefers-reduced-motion` 即时清理。

3. **紧凑壳层微调与基础控件修补**
   - 涉及：`apps/desktop/renderer/src/App.tsx`、`components/shell/PageDock.tsx`、`ui/menu.tsx`、`ui/button.tsx`。
   - 底部壳层**保留紧凑的「N 位角色」文字**，新增由真实后端健康/请求可达性驱动的极简连接墨点（严禁读取仅判空字符串的 `api-config.json.connected`）。
   - 修复 `ui/menu.tsx` 向上展开方向算式与键盘边界导航；`Button` 解耦立即锁定 `busy`/`aria-busy` 与 **300ms 延迟显现的 spinner**（快响应不闪烁、连点立即拦截）。

- **阶段二验收门禁（完成即交 Gemini 复核）**：
  - 渲染器全检 + 单测 + 构建 + 桌面单测；
  - E2E：`theme-transition`（按第 4 节同步更新断言并在渲染进程内测净耗时）、`settings-media-sheet`、`relations-desktop`、`dialogue-layout`、`cross-page-share`、`workflow-real-backend-chain`；
  - 交付变更清单 + Windows DPI 下羽化实机核验记录 + 截图。

---

### 阶段三：核心四页细节打磨（对话 / 动态 / 入口 / 骨架）

1. **对话页「纸间落墨」**
   - 涉及：`apps/desktop/renderer/src/pages/Conversation.tsx`、`styles/conversation.css`、`conversation/*`。
   - `.dialogue-messages` 顶部 16px 羽化仅在 `scrollTop > 0` 时启用，滚回顶部立即撤掉，确保首行与「加载更早消息」绝对清晰。
   - 「生成过场图」入口仅对**最新一条已完成且可生图的 assistant 回复**常驻显示（跳过末尾用户消息与生成中回复），历史轮在 hover / `:focus-within` 下显现，完整保留 `DL-142` 指定轮生成/查看/重试能力。
   - 气泡当前已是 `width: 94%; flex: 0 1 94%`（`conversation.css:116`），本项保持不变、不做无谓改动。

2. **动态页「单栏书页 + 顶部可折叠『接下来』+ 往来合笺」**
   - 涉及：`apps/desktop/renderer/src/pages/Feed.tsx`、`styles/feed.css`。
   - 取消左右双挂载 `nextContent`，统一为单栏书页 + 顶部可折叠「接下来」书签条，确保窄屏四条安排均可达且整页无横向溢出。
   - 角色往来卡片升级为「合笺」样式（双人姓名、主题、回合数收拢于同一张纸卡）；详情页按一根竖向细墨线串联各轮时间序，清晰呈现谁发起、谁收口。

3. **轻量 `RoleFace` 与「此位」印记**
   - 涉及：新建轻量 `RoleFace` 组件、`apps/desktop/renderer/src/pages/RoleEntry.tsx`、`styles/role-entry.css` 等。
   - `RoleFace` 仅消费已有图片 URL/资产，按**素材身份**区分（主角色同样可换自定义图）：受控预设素材用校准头部裁切，自定义图用带纸底的安全 `contain`，缺图/破图回退单字印章。
   - 选角卡复用现有 `aria-pressed`，在卡片纸边落一枚克制的「此位」印记，避让姓名/徽章并明确区分 `:focus-visible` 焦点环。

4. **首屏低对比纸感骨架**
   - 为对话列表/消息、动态页、关系页与扩展目录补充低对比纸纹骨架（仅首次真实读取中呈现，尊重减弱动效模式）。

- **阶段三验收门禁（完成即交 Gemini 复核）**：
  - 渲染器全检 + 单测 + 构建 + 桌面单测；
  - E2E：`role-exchanges`（按第 4 节同步更新断言）、`dialogue-layout`、`pack3-entry`、`relations-desktop`；
  - 交付变更清单 + 四页昼夜及 `720×540` / `1280×800` 截图。

---

### 阶段四：Electron 启动封面（`BootGate`）与关窗/托盘退出纸笺（独立打包验收）

1. **真实 `BootGate` 启动时序重排**
   - 涉及：`apps/desktop/electron/main.cjs`、`preload.cjs`、`renderer/src/conversation/backend-base.ts`、`renderer/src/App.tsx`。
   - 消除当前 `main.cjs:166` 等待后端就绪才建窗、`backend-base.ts:4` 缓存空地址、`App.tsx:214` 早于 `booted` 提前订阅扩展 SSE 的问题。
   - 启动后立即建窗展示贴合已存主题的轻量静态启动封面，待后端健康检查、协议代理与主帧请求头全部就绪后再挂载业务壳；启动失败提供页面内重试按钮与明确原因。

2. **关窗隐藏 vs 托盘退出页内确认纸笺**
   - 涉及：`apps/desktop/electron/main.cjs`、`preload.cjs`、`renderer/src/App.tsx`。
   - 存在未保存草稿时：点击关窗弹出纸笺询问「保留草稿并隐藏」，触发托盘退出弹出纸笺询问「放弃修改并退出」。
   - 关窗与退出共用单个在途请求编号，连续触发仅接收一次主帧回执；渲染器超时无响应时回落原生对话框，并与 `beforeunload` 互斥不重复弹两次询问。

3. **阶段四独立实机验收矩阵（最低 6 项，本阶段需单独打包验收）**
   1. 慢启动（窗口秒开封面且主题正确，就绪后无缝入壳，无空地址缓存/SSE 抢跑错误）；
   2. 启动失败后页面内点击重试成功恢复；
   3. 脏草稿下点关窗 →「保留草稿并隐藏」→ 托盘重开窗口草稿完好；
   4. 脏草稿下托盘退出 → 取消退出（应用继续运行且草稿保留）；
   5. 脏草稿下托盘退出 →「放弃修改并退出」（干净退出，无二次 `beforeunload` 拦截）；
   6. 模拟渲染器无响应时触发退出，走原生兜底正常退出。

---

## 4. E2E 测试契约影响清单

### 4.1 必须同步更新的 3 处 E2E
| E2E 文件与定位 | 冲突原因与必须更新的断言 | 必须同场守住的原语义 |
|---|---|---|
| `apps/desktop/tests/e2e/extension-ui-slots.e2e.cjs:120`、`274–303` | `120` 行逐字匹配旧 `<p>` 文案「尚未安装扩展。」；改测「成功空快照 → 空台邀请笺 → 按钮可进对话」，补测首次读取与断线重连不显示邀请笺；`274–303` 增加交修成功按钮态与切视图往返断言 | 保留 `121–140`、`158`、`236` 居中与栏宽几何、`194` 共玩按钮显示当前点名对象、故障行 `role="status"` 及真实送达/停机/重试断言 |
| `apps/desktop/tests/e2e/theme-transition.e2e.cjs:147` | `149–152` 锁旧快照 opacity 帧，`203–231` 锁旧光束与逐行 `.flipped`/`--band`，`257–261` 要求 520ms 历史层仍在扫；改测白昼向下、夜幕向上、羽化中间帧与渲染进程内实测点击至清理 `≤550ms`（排除截图耗时） | 保留 `165–195` 关系页刻度、对齐、交叉淡化与最终主题（补测 `800–900ms` 总长），保留 `273–293` 零 ripple 与减少动效即时清理 |
| `apps/desktop/tests/e2e/role-exchanges.e2e.cjs:75`、`89–98` | `75` 锁旧句式「甲角色 与 乙角色 进行了对话」；`89–98` 锁 `.feed-next-strip` 横滚；分别改验合笺卡含双人姓名/主题/轮数，以及唯一「接下来」书签的展开/收起与四条安排均可达 | 保留 `81–83` 逐轮姓名/正文/时间与顺序、`97`、`99–100` 角色筛选可滚、间距 ≥8 与整页不横溢 |

### 4.2 100% 原样严守红线（严禁放宽或绕过）
- **扩展与工程真实性**：`extension-ui-slots:143–151, 157, 176–204, 215–235, 251–264, 276–303`（沙箱隔离、主角色零误唤醒、目标角色一次唤醒、旧版拒绝、停用卸载与唯一求助）；`engineering-capsule:60–88`（并发、输入保焦、单项取消、原窗交付）。
- **浮层、草稿与焦点**：`cross-page-share:95–101, 109–149, 176–191`（补读去重、真实点击命中、不打断输入生成、游标重连）；`settings-workspace:353–358, 683–710`（长纸签几何与悬停暂停）；`settings-sheet-focus:289–303`（Tab/Esc 与脏草稿守卫）。
- **主题、壳层与对话**：`settings-media-sheet:151–171`（立绘 `< 1%` 像素不变与反切收敛）；`pack3-entry:74–100, 150–166, 188–204`（选角前置、无「陪伴」、7 页边界）；`dialogue-layout:186–213, 217–245`（窄窗消息区 `> 160px`、隐 Dock 增高 `> 70px`、偏好持久化、历史定位与焦点）；因阶段二保留「N 位角色」，`relations-desktop:201` 与 `relations-review-234:80` 原样通过。
- **按钮、导入与动态返回**：`workflow-real-backend-chain:673–686, 814–831`（显式启用、立即拦截重复点击、迟到结果丢弃）；`role-exchanges:108–130, 137–171`（真实刷新、部分失败回执、原卡返回与新导航优先）。

---

## 5. 交付节奏与复核收口约定

1. **严格逐阶段交付与复核**：每完成一个阶段（Stage 1 → 2 → 3 → 4），即停止向下推进，提交本阶段改动文件清单、全部检查命令真实输出及昼夜/`720×540`/`1280×800` 截图（统一写入 `test-results/`），交由 **Gemini** 逐项对照红线复核；复核通过并闭环问题后再开启下一阶段。
2. **文档与收口门槛**：阶段实施与多轮复核记录后续统一归档于 `docs/archive/02-desktop-ui-and-relations/` 内同一份专题文档中；全阶段完成后跑通仓库级 `node scripts/verify.mjs e2e`、`node scripts/check-docs.mjs` 与 `node scripts/check-repo-hygiene.mjs`。
