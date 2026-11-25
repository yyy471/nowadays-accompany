# 桌面前端审美、交互与布局优化开发交付规范

> **定位**：由 **Gemini（审美与设计工程师）** 定调并裁决设计边界，由 **GPT-6.2-Astra** 主导后续端到端前端实施与自验，完成后交回 Gemini 做统一视觉与验收复核。
> **关联文档**：[前端设计规范](../../specs/frontend-design-system.md) · [设计令牌源](./tokens.json) · [协作守则](../../../GEMINI-GPT-DEV-GUIDE.md)

---

## 1. 当前接手基线（Batch 1 已落地状态）

Batch 1（全局底座、主题适配与死文件清理）已在工作区完成代码修改，均不涉及后端：

- **已完成修改**：
  - 新增 `apps/desktop/renderer/src/ui/fonts.css` 独立承载 `WJ Hand` / `WJ Title` 字体声明，移除 6 个已确认废弃的遗留文件（`styles/relationship-journal.css`、`styles/relationship-journal-integration.css`、`styles/relationship-journal-transition.css`、`styles/studio-overrides.css`、`ui/relationship-journal-transition.ts`、`assets/relationship-journal/clerk.svg`），保留两份 `.woff` 字体及 `relations-dossier.test.ts` 中的禁用词守卫。
  - 修复 `pages/Settings.tsx` 缺少 `data-ui-theme="xiacheng"` 导致的控件样式失灵，收敛 `styles/settings-workspace.css` 的按钮排除选择器、36px 输入框垂直内边距、夜间空画框与角色切换箭头、滚动条色彩，补全 `RoleEntry` 夜间 `--neutral-rgb`。
  - 拆分 `App.tsx` 的手动列表重试（`retryingRoles`）与详情重试（`retryingDetail`）及 `pages/Feed.tsx` 的 `useFeedRead` 重试态，保持 `refresh()` 永远不被阻塞。
  - 补全 `ConfigNotice.tsx`（`noticeKey`、语气色调、悬停暂停与点击关闭）、`AppearancePanel.tsx` / `Settings.tsx` 通知调用点，完善 `ShareSlip.tsx` / `ExtensionViews.tsx` 浮层层级、120ms 轻柔退场与窄屏防重叠宽度。
- **已运行验证（仓库 Node 24）**：
  - `apps/desktop/renderer`：`npm.cmd run check` 通过（27 个 CSS，令牌违规 0）、`npm.cmd test` 通过（139/139）、`npm.cmd run build` 通过。
  - `apps/desktop`：`node --test tests/unit/*.test.cjs` 通过（15/15）。
  - Batch 1 专项 E2E（`pack3-entry`、`settings-v6-behavior`、`settings-workspace`、`relations-desktop`、`extension-ui-slots`、`cross-page-share`）在最后一次 `App.tsx` / `Feed.tsx` 微调前全部通过（6/6 退出码 0）。
  - 根目录：`node scripts/check-docs.mjs` 与 `node scripts/check-repo-hygiene.mjs` 均 0 错误。

---

## 2. 审美总纲与防过度工程守则（Astra 必读）

1. **视觉人格唯一基准（严禁跑偏）**：
   - 完整保留 `xiacheng` 双预设气质：日间「白昼来信」（宣纸、暖米、朱砂/赭红印泥感、书页装帧）与夜间「晚风电台」（暖墨蓝、暗纸面、柔光窗景、克制的暖金点缀）。
   - **禁止**改成通用 SaaS 灰白卡片、大面积高对比亮白边框、霓虹发光、重阴影浮夸渐变或毛玻璃堆砌。
   - 所有反馈与动效都要像**书桌上的纸签、朱印、显影相纸与电台声波**：克制、轻柔、有物理停顿感。
2. **抑制防御性思考与过度设计**：
   - **禁止**为了假设扩展新增抽象状态机、全局事件总线、复杂动画调度框架或向后兼容垫片层。
   - 每个交互优先用最小、直观的局部状态 + 原生 CSS / 轻量 WAAPI 实现；绝不触碰 `apps/backend/`。
3. **工程硬性红线**：
   - 环境要求：Windows PowerShell 无 `python` / `rg`，统一用 PowerShell 与仓库自带 Node 24：
     `$env:PATH = (Resolve-Path '.tools/node-v24').Path + ';' + $env:PATH`
   - 令牌修改：只允许修改 `docs/design/character-studio/tokens.json` 并执行 `npm.cmd run tokens`，**严禁手改 `apps/desktop/renderer/src/ui/character-tokens.css`**。
   - 颜色棘轮：`settings-workspace.css`（`ds/color` 上限 33）与 `styles.css`（`ds/color` 上限 74）禁止新增十六进制颜色字面量，一律复用 `--nd-semantic-*` / `--cfg-*` / `color-mix()`。
4. **不可破坏的测试与几何契约**：
   - `config-texts.test.ts` 锁定的 `T1, T6, T8, T9, T12–T14, T16, T22, T27, T28, T31–T35, T38` 保持原文不变。
   - 保留 E2E 锚点：`白昼来信`、`晚风电台`、`aria-label="显示名"`、`textarea[aria-label="人物介绍"]`、`textarea[aria-label="角色设定"]`、`[aria-label="演出设置"]`、`隐藏底部导航栏`、`页面窗口`、`button[aria-label="编辑服饰：..."]`、标题 `衣柜` / `完成度`、`恢复活动`、`尚待清理`、`换一位`、`保存的原始记录`、`.share-slip aside > button:last-child`。
   - **全站绝对禁止出现“陪伴”二字**（`pack3-entry.e2e.cjs` 强校验）。
   - 严守 `.config-sum .ui-dot` 在 `1440 / 1280 / 720` 宽度下的水平 X 坐标对齐（`1296.67 / 1136.67 / 598.67`）。
   - 严守昼夜切换时**已有立绘的 `.config-stage .config-portrait`** 内部像素变化 `< 1%`（夜间画框调整只作用于 `:not(:has(img))` 空态）。
   - 严守关系页 `.edition-strip` 可见且不与其他区块重叠（`relations-desktop.e2e.cjs`）。

---

## 3. 分批开发路线图（严格按序推进）

### 第一步：Batch 1 收口验证
- 审查当前工作区 `git diff`（确认 `App.tsx` `detailRetry`、`Feed.tsx` `retrySeq`、`ShareSlip.tsx` 退场队列与 `ConfigNotice.tsx` 无边界瑕疵）。
- 补跑 `pack3-entry.e2e.cjs` 与 `cross-page-share.e2e.cjs` 确认最后微调完全绿灯。

### 第二步：Batch 2 — 全站 Tone B（轻度温润氛围）文案精修
**Tone B 风格要求**：温润、自然、克制、带有书房日常气息；去除开发术语与机械凑字废话，也不做娇柔堆砌；每条辅助说明压缩到 1 句自然中文。

1. **入口与角色卡（`entry/role-entry.ts`、`pages/RoleEntry.tsx`）**：
   - 将硬生生的系统管理员腔 `主角色 / 内置管理员 · 不可删除` 改为温润表述（如 `常驻主角色 · 默认保留`），`还没有写下介绍` → `暂未写下介绍`，`尚未就绪` → `准备中`。
   - **同步更新**耦合测试 `renderer/tests/pack3-entry.test.ts` 与 `desktop/tests/e2e/pack3-entry.e2e.cjs`。
2. **外壳、主页、扩展与分享卡（`App.tsx`、`Home.tsx`、`ExtensionViews.tsx`、`ShareSlip.tsx`）**：
   - 清理重复表达和过硬的状态占位词；保留 `白昼来信` / `晚风电台` 及主标语的诗意气质，统一加载、空态与重试错误提示口吻。
3. **对话、关系与动态页（`pages/Conversation.tsx`、`pages/Relations.tsx`、`relations/*`、`pages/Feed.tsx`）**：
   - 将偏内部实现直译的字眼改为面向读者的柔和中文；保护 `换一位`、`保存的原始记录`、`演出设置`、`隐藏底部导航栏`、`页面窗口`。
4. **配置工作区（`pages/Settings.tsx`、`components/config/*`、`appearance/*`、`voice/*`、`image/*`、`model/*`）**：
   - 打磨章节导语、表单提示与空状态文案，删掉与标题重复的说明，不触碰被测试锁定的 `T*` 常量及 E2E `aria-label` / 标题名。
5. **验收门槛**：跑通 `npm.cmd run check`、`npm.cmd test`、`npm.cmd run build` 及耦合 E2E（`pack3-entry`、`settings-workspace`、`settings-sheet-focus`、`dialogue-layout`、`relations-desktop`）。

### 第三步：Batch 3 — 页面布局细节与 6 套核心微交互（3A → 3B → 3C → 3D）

#### 六套核心微交互设计规格
| 名称 | 适用场景 | 视觉与体感规范 |
| --- | --- | --- |
| **1. 相纸显影** | 生图测试、场景图生成、衣柜上传与换装预览 | 等待期相纸框内现低对比斜向显影光带并附轻量提示；成图瞬间从轻淡低饱和与微糊（约 360ms）平滑定格；失败在框内直接给清晰原因与重试入口。 |
| **2. 折信测脉** | 测试模型、测试语音服务、测试生图服务 | 点击即进 `busy` 态，状态行原位显示「正在测试连接…」与柔和脉动点；成功时暖绿/朱砂微光轻扫状态行并输出关键指标，支持重复点击再触发；失败明示原因。 |
| **3. 声纹落句** | 对话语音生成/播放、音色试听、参考录音播放 | 合成期显 3–4 根错峰呼吸竖条（仅动画化 `transform: scaleY`）；播放态切为柔和律动波纹与清晰“停止”；出错有明确轻提示。 |
| **4. 朱印轻扫 + 纸签回执** | 保存、删除、解绑、状态切换、各类刷新图标 | 所有“点了无反应”的操作统一补全回执：按钮忙碌/旋转态 + 成功时纸笺轻量扫光或印章标签，并用 `ConfigNotice` 给纸签提示。 |
| **5. 指尖微触** | 全局按钮、图标按钮、开关、页签、可点击卡片 | 统一 hover 柔和选区底色、active 1px 轻压位移、清晰一致的 `:focus-visible` 焦点环，明确区分 `busy`（可聚焦+动画）与 `disabled`。 |
| **6. 寻迹定格** | 动态跳转对话定位、历史搜索定位、关系证据回看 | 目标元素落位后施加约 1.2s 暖纸高亮呼吸再平稳褪去，让视线一眼落定。 |

#### 四个子批次执行细节
- **3A（Shell / Home / RoleEntry / Extensions）**：
  - 适配 `1440x840`、`1280x800` 与 `720x540`：消除窄屏顶栏/底栏挤压与大屏过度留白，梳理 `RoleEntry` 卡片层次与 `Extensions` 密度，落地全局 **「指尖微触」**。
- **3B（Conversation 对话页）**：
  - 平衡宽屏/窄屏下头部栏、消息区、输入区与隐藏底栏模式的比例；落地 **「声纹落句」**、**「相纸显影」**、**「寻迹定格」**，补齐发送/中断/重生成反馈。
- **3C（Relations 关系页 & Feed 动态页）**：
  - 调整藏书票左右书页比例、弹层与记忆纠错面板细节（严守 `.edition-strip` 不重叠）；打磨动态页筛选栏窄屏横向呼吸感、“接下来”条带与时间线层次，落地 **「寻迹定格」** 与刷新反馈。
- **3D（Settings Workspace 角色配置 & 全局设置）**：
  - 在严守 `.config-sum .ui-dot` 对齐与立绘像素不变前提下，全面落地 **「折信测脉」**、**「相纸显影」**、**「声纹落句」** 与 **「朱印轻扫 + 纸签回执」**，收整 `Sheet` 分组间距与底部栏对齐。

> 每完成一个子包，立即运行 `npm.cmd run check`、`npm.cmd test`、`npm.cmd run build` 及对应模块 E2E。

### 第四步：Batch 4 — 动效统一收口与最终全量验证
1. **动效统一**：检查全站切页、纸笺推拉、浮层与折叠区过渡，全部使用合成层属性（`transform` / `opacity` / `@starting-style`）与 `--nd-semantic-motion-*` 令牌，消除闪烁与残影，确保 `data-motion="reduced"` 与系统减弱动效全覆盖。
2. **最终全量验收（Node 24，零跳过）**：
   - `apps/desktop/renderer`：`npm.cmd run check`、`npm.cmd test`、`npm.cmd run build`
   - `apps/desktop`：`node --test tests/unit/*.test.cjs`
   - 全量串行 Electron E2E：`node scripts/verify.mjs e2e`（或逐个运行 `apps/desktop/tests/e2e/*.e2e.cjs`）
   - 文档与仓库巡检：`node scripts/check-docs.mjs`、`node scripts/check-repo-hygiene.mjs`
   - 输出最新版 `test-results/page-layout/` 关键页面昼夜及宽窄屏截图，附带改动清单与精确验证报告，供 Gemini 最终统一审验。

---

## 4. 启动 GPT-6.2-Astra 执行命令（PowerShell）

在项目根目录 `d:\app\nowadays\accompany` 下执行：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@"
请仔细阅读并严格执行 docs/design/character-studio/frontend-polish-plan.md 中的全部设计方案、审美红线与分批实施计划（从第一批收口自检开始，严格按 Batch 1 收口 -> Batch 2 -> Batch 3A -> 3B -> 3C -> 3D -> Batch 4 + 全量验证顺序推进，并在每批结束跑通对应 check/test/build/E2E 后再进入下一批；完成后保留最新 test-results/page-layout/ 截图并提交完整汇报）。
"@ | codex exec -m gpt-6.2-astra -c 'model_reasoning_effort="high"' -s workspace-write -
```
