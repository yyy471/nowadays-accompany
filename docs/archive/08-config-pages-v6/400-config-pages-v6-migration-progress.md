# 角色配置页 + 设置页 v6 迁移 · 实施记录与交接文档

> **当前进度**见 §26。P1–P6 的桌面配置页迁移和离线复核已完成，最终构建的 14 条 Electron 门禁均通过。角色六分区、五类设置服务、依赖维护、交互动效及读屏的证据和系统适配边界集中在末节。
> **交接目的**：本文档面向后续协作者（含有视觉能力的模型），完整记录 v6 迁移的规范来源、关键决策、当前进度、已完成改动清单、门禁命令与后续阶段的执行指引。
> **基准来源**：v6 demo 权威目录为 `E:\tmp\testWorkSpace\switchboard\nowadays-config-v6-demo`（源目录，与早先临时副本 `E:\tmp\test\nowadays-config-v6-demo` 的 28 个文件逐字节一致，2026-11-19 复核）。开发规范权威文本在该副本同级的 `config-pages-dev-spec (1).md`（1358 行；源目录未附规范，仅副本有）。与 demo README 冲突时以规范为准；标「示例专用」的值一律换令牌。

## 1. 任务全貌

把仓库现有「配置书」（`SettingsWorkspace`，角色配置 / 设置两页共用一本）按 v6 开发规范整体迁移：

| v6 核心变化 | 要点 |
| --- | --- |
| 右页结构 | 分区标题(h2) → 摘要行(值+第二行+7px 状态点) → 紧凑/完整纸笺；同一时间最多一张纸笺 |
| 暂停并保存 | 活动中可编辑草稿；保存按钮「暂停并保存 N」→「正在暂停…」→「正在保存…」；成功后页脚 T30「已为保存暂停 {角色}　继续活动」；失败 T32 三态 |
| 昼夜切换 | veil 令牌方案 theme-reveal 400ms / theme-total 550ms，图片框挖空 |
| 已停止置灰 | 设置页角色状态卡（第六章，唯一图片改色例外；现 `[data-stopped] .config-portrait img` 规则改写为卡级 220ms ease-out） |
| 停用/删除异常态 | 全局停用服务下拉禁用+后缀 T33；已选被删 error T34 |
| 文字减法 | 删所有分区说明、页脚常驻文字、`config-folio`、`config-dirty-ribbon`、手风琴、`config-active-note`、`config-poster-top`/初始化行；T1–T38 只在触发条件下出现 |
| 底栏角色切换 | 原生 `<select>`（+「新建角色…」项）；删藏书票墙对话框与脏提示 |

**用户已确认的两个决定**（AskUserQuestion，2026-11-19）：
1. **后端语音/生图服务写入本轮一并改为「按依赖角色暂停」**（对齐模型服务 `maintenancePlan` 模式；DL-148 的修订需在 `docs/161-digital-life-direction-decisions.md` 追加变更记录）。
2. **阶段式推进**：每阶段跑完门禁、汇报确认后再继续。

## 2. 分支与阶段

- 分支：`codex/config-pages-v6`（自 `dev-front` 切出，基线 commit `23f1537`）。
- 阶段：P1 基础件 → P2 角色配置页 → P3a 后端依赖暂停口径 → P3b 设置页 → P4 主题 veil 与动效 → P5 E2E 收口 → P6 打磨与无障碍实测。
- 完整计划文件：`C:\Users\24349\.claude\plans\e-tmp-test-demo-demo-cheeky-stallman.md`（含目标文件结构、D1–D6 架构决策、后端工作包细节、测试策略、风险清单）。

## 3. P1 已完成内容（全部已落地并过门禁）

### 3.1 令牌（`docs/design/character-studio/tokens.json` + 生成 CSS）

- `primitive.layer.sheet = 60` / `semantic.layer.sheet`（720 纸笺层）。
- `primitive.layer.themeTransition = 2000` / `semantic.layer.themeTransition`（veil 层，高于 modal/notice/tooltip）。
- `component.sheet.{background,border,radius,layer,shadow}`（纸笺静止投影走 `shadow.overlay`，昼/晚两套由 preset 自动切）。
- 已跑 `npm run tokens` 重新生成 `ui/character-tokens.css`（禁手改）。

### 3.2 新增文件

| 文件 | 内容 |
| --- | --- |
| `renderer/src/ui/status-dot.tsx` + `status-dot.css` | `<StatusDot status label bare faint>`；`.ui-dot.dot` 全套（ok/follow/off/dirty/error/none、bare 带 `role="img"`、faint 0.8 且 off 不淡化、forced-colors CanvasText/Canvas/Mark）；已入 `ui/index.ts` 导出与 `main.tsx` CSS 引入 |
| `renderer/src/ui/live-announcer.tsx` | `announceLive(text)`（清空+40ms 置入）+ `<LiveAnnouncer/>`（工作区内渲染 `aria-live="polite" aria-atomic` 区域，直接 DOM 写，无 React 状态抖动） |
| `renderer/src/ui/dom-mask.ts` | `collectWellRects` / `applySubtractMask` / `clearSubtractMask` + `CONFIG_WELL_SELECTORS`（压暗层与主题 veil 共用的图片框挖空） |
| `renderer/src/components/config/config-texts.js` + `.d.ts` | T1–T38 全量文案模板（T18 已删）、`foldNames`（>3 位折叠「A、B 等 N 位角色」）、ARIA 模板、PLACEHOLDER 表；`.js+.d.ts` 兄弟文件模式与 `model-picker.js` 一致，可被 node:test 直载 |
| `renderer/src/components/config/summary.js` + `.d.ts` | §3 状态矩阵纯函数：`bindingIssue`/`chatRowStatus`/`memoryRowStatus`/`imageRowStatus`/`voiceRowStatus`/`extensionRowStatus`/`rowDotVisible`、`imageKeys`/`voiceKeys`/`quotaKeys`/`extensionValue`/`extensionKeys`、`localDate`（本地时区）、`quotaLimitBad`（T28 校验） |
| `tests/config-texts.test.cjs` | 3 组用例钉死 T 文案原文、参数拼接与折叠规则；断言全表不含「停止后可编辑」「可编辑」 |
| `tests/summary-derive.test.cjs` | 8 组用例钉死每个状态项的触发条件与第二行值拼接 |

### 3.3 修改文件

- `renderer/src/ui/icons.tsx`：新增 `edit` 图标（铅笔，demo PEN 形状）。
- `renderer/src/ui/index.ts`：导出 status-dot / live-announcer / dom-mask。
- `renderer/src/main.tsx`：引入 `ui/status-dot.css`。
- `renderer/src/pages/Settings.tsx`：`changeSection`（原 :342）硬编码 `200ms cubic-bezier(.2,.7,.2,1)` → `readMotionTime(--nd-semantic-motion-component, 220)` + `readMotionValue(--nd-semantic-motion-ease-out)`；import 行补两个工具。
- `renderer/src/styles/settings-workspace.css`：文件尾追加「v6 基础件」段（**样式已就位但 DOM 未启用**，P2/P3 接管 DOM 后生效）：`.config-sec-head`、`.config-sum` 摘要网格（132px|1fr|auto、分隔线、hover 进出分档）、`.config-sum-slot` 同宽槽位（ghost 撑宽→状态点同列）、`.config-chip-v/k` 值片段、`.config-skel` 骨架、`.config-load-err`、`.config-empty-state`、`.config-sheet`（完整/紧凑两形态 + `.config-grp` 吸顶）、`.config-scrim`/`.config-book-scrim`（背景走 `--nd-semantic-color-backdrop`）、`.config-save-btn/.config-save-n`（M18 徽标）、≤900 的 720 桶（纸笺 `position:fixed` + `--nd-semantic-layer-sheet` + 贴底紧凑 + 书本 `calc(--nd-semantic-layer-shell + 1)` 抬层）、减少动效瞬时。一处 lint 修正：骨架条圆角 5px → `radius-chip`。

### 3.4 P1 门禁结果（全部通过）

| 门禁 | 结果 |
| --- | --- |
| `renderer npm run check`（tokens:check + lint:styles + tsc） | 0 违规（24 个 CSS，豁免命中 388 不变） |
| `renderer npm run build` | ✓ |
| 桌面单测 `npx -y node@24 --test tests/*.test.cjs` | **160/160**（原 148 + 新 12） |
| E2E `startup-flow-fixes-check` / `settings-review-fixes-check` | exit 0 |
| E2E `settings-workspace-check` | 见 §4 排障结论：**连跑 4 次全过**（含干净基线对照） |

### 3.5 排障记录（重要，勿重复踩坑）

P1 期间 `settings-workspace-check.cjs` 出现 3 次失败（`until` 超时在 `:468/:469`，等待「读取模型列表」的 `[role=option]` 或「已读取 1 个模型」文案），随后：

1. 用 `git stash` 对照干净代码跑同一脚本（dist 未重建，即同一份新 bundle）→ **通过**。
2. 带改动重跑 2 次 → 失败；写临时复现脚本（`tests/tmp-repro-model-list.cjs`，已删除）走相同路径 → **通过**（模型列表请求确实发出、候选正常渲染）。
3. 加诊断跑 1 次：请求 `POST /v1/resources/m1/models` **确实发出**、`:468` 通过、`:469` 文案等待失败 → 提示为**时序窗口**而非功能损坏：`use-model-probe.ts:100-121` 的配置键变化效应会 `clickLogSeq.current += 1` 作废在途列表请求的 notice 文案。
4. **带改动连跑 3 次（run1/2/3）+ 恢复脚本后确认跑 1 次 → 全部 exit 0**。

**结论：预置的低频时序抖动**（与 STATUS.md 记录的包 3「遗留 1 次 `:942` 抖动」同源——均为 `until` 16s 窗口内 React 状态更新时序的偶发落空），**不是 P1 改动造成的回归**。P1 改动未触碰模型列表链路（唯一 TSX 改动是 `changeSection` 动画参数）。若后续偶发复现，按惯例重跑即可；根治需在 P2 统一写入管线时收敛（届时该脚本要整体移植，顺带把该断言改为等待请求+候选双条件）。

已恢复现场：`tests/settings-workspace-check.cjs` 的临时诊断已撤销（`git diff` 为空）；临时复现脚本已删除。

### 3.6 未提交状态

P1 改动**尚未 commit**。工作区状态（`git status`）：

```
M renderer/src/main.tsx
M renderer/src/pages/Settings.tsx
M renderer/src/styles/settings-workspace.css
M renderer/src/ui/character-tokens.css（npm run tokens 生成）
M renderer/src/ui/icons.tsx
M renderer/src/ui/index.ts
M docs/design/character-studio/tokens.json
?? renderer/src/components/config/（config-texts.js/.d.ts、summary.js/.d.ts）
?? renderer/src/ui/dom-mask.ts、live-announcer.tsx、status-dot.tsx、status-dot.css
?? tests/config-texts.test.cjs、summary-derive.test.cjs
```

建议提交信息：`feat: 配置页 v6 基础件——层级令牌、状态点、读屏播报与遮罩工具`

## 4. P2 执行指引（角色配置页 v6）

**目标 DOM**（右页六分区）：设定=内联表单（显示名 ≤320 / 人设自增高 cap=`max(140, min(窗口高×0.4, pane高−120))` / T5 字数 / M19 琥珀细线 / 底部「删除角色…」组）；外观=服饰卡网格 `auto-fill minmax(150px,1fr)`（bare 点，卡片点开「编辑服饰」完整纸笺）；模型=四行摘要（对话/记忆整理/生图/语音，行与值/参数片段的纸笺映射见规范 §二.3）；扩展=MCP/Skill 两行；额度=「今日」一行（整行紧凑纸笺「每日额度」）；完成度=只读清单（`check-row`：项 ··· 状态点 + 查看）。

**关键机制**（计划文件 B1–B6 有完整设计）：

1. `sheet-context.tsx`：workspace 级单纸笺状态 `{owner, item, group, shape, anchorEl}` + `pendingAfterClose` 队列；重复点击去重；所有者组件用**自己的草稿 state**渲染纸笺体（RoleEditor 常驻挂载的现有模式不变，避免草稿大搬家）。
2. `Sheet.tsx`：full（`.leaf` 内 absolute，`left clamp(20px,6%,56px)`，M1 从右滑出）/ compact（`min(600px,100%-40px)` 右锚，top=行顶−10 夹紧）/ confirm 三形态；焦点陷阱用 `ui/focus.ts focusableControls`（语义已符合规范 §7.3）；Esc 阶梯：写入中→无效、确认条→回第一字段、干净→关闭；打开时 `.config-leaf-body/.config-leaf-foot` 设 `inert`；**动效必须 `if (readMotionTime(el, token) > 0)` 才 `animate`**（`createMotionScope` duration 0 仍会建 Animation 对象，跳过才能满足「16ms 内 getAnimations().length===0」）。
3. `scrims.tsx`：右页 + 书本两层，`ui/dom-mask.ts` 挖空图片框；点击右页层 = `requestClose()`。
4. `write-runner.tsx`：收敛 `ensureRoleStopped`(:424-453) + `guardAction` + RoleDeletion 私有 `ensureStopped`(:705-721)；`runWrite({pause, where, verb, rollback, commit, done, fail})`；**P2 阶段先沿用全停口径**（P3a 后端改完、P3b 再切依赖口径）；单飞 ref 锁（StrictMode 安全）；`pausedRoleIdsOf` 回读沿用；T29/T30/T32 文案全部走 `config-texts.js`。
5. 底栏 footer 门户（`#config-footer-left/right` 槽位保留）：左侧 ident（角色名+T19 状态点）；右侧 `<select>`（已停止后缀「（已停止）」+ 尾项「＋ 新建角色…」→ 紧凑新建纸笺）；设定脏 → T37 确认纸笺。
6. 语音按服务会话缓存（§10.3）：`by[roleId:serviceId]` 提升到 workspace state；脏检测只比当前服务份；切回原服务配置还在。

**要删的**：手风琴 `config-model-row/toggle/details`、`config-dirty-ribbon`、`config-folio`、页脚固定文字与 `config-return-footer`（设置页改页头「‹ 返回角色配置」——页头属共享壳层，P2 一起改）、`config-active-note` 文案、`config-stage-label` 的「人物档案 NN / 立绘」（立绘框上方只留当前服饰名 `#stage-cap`，11px 单行省略）、藏书票墙对话框/`config-dirty-prompt`/`chooseRole` 飞行动画。

**书脊**：`.tab-dot`（7px 实心 warning，`top 8 / right 7`，2px 标签底色环）+ `aria-label` 追加「，有未保存的改动」；↑↓/Home/End 移焦点、Enter/Space 切换。

**E2E 移植**：`settings-workspace-check.cjs` 角色页段（编辑隔离、脏确认、暂停保存、外观管理、双删除路径、绑定保留、额度）+ `startup-flow-fixes-check.cjs` 选择器；mock server 原样保留。

## 5. P3a 执行指引（后端依赖暂停）

现状（已核实）：
- `apps/backend/src/http/config-writes.ts`：`GLOBAL_CONFIG_WRITES` = 语音/生图 PATCH+DELETE 四条 → `globalWrite` 守卫（**所有**角色须停止）；`ROLE_CONFIG_WRITES` 不变；MCP/Skill 走 `RESOURCE_CONFIG_WRITES` 由服务层占用判断。
- 模型服务 PATCH 已按依赖暂停：`routes.ts:644-716`（`maintenancePlan(resourceId, body)` → `pauseRoleIds` → `services.resources.pauseRoles` → 响应带 `maintenance.pausedRoleIds`；失败 `withMaintenanceDetails` 回带已停名单；`waitForInflightIdle` 结算已停角色的在途调用）。
- 错误类型：`domain/errors.ts:768-790`（`RoleNotStoppedError`/`RolesNotStoppedError`）。

改造（对齐模型服务同款模式）：
1. 语音/生图 PATCH 移出 `GLOBAL_CONFIG_WRITES` → 服务层按「当前用该服务且未停止」的角色算维护计划：连接字段（url/协议/密钥/超时）或 `enabled: true→false` 变化 → 暂停这些活动依赖角色；仅名称/默认引擎/`enabled: false→true` → 不暂停。
2. 语音/生图 DELETE：有**活动中**依赖角色 → 新错误（携带角色名单，前端 T17 文案用）；仅停止角色在用 → 允许。
3. `config-writes.ts` 注释同步；`docs/161-...-decisions.md` DL-148 追加变更记录（用户已确认）。
4. 后端测试更新 + 保持 444 全绿 + `accept-offline.mjs` 21 步。
5. **E2E mock server 同步**（`settings-workspace-check.cjs` 等对语音/生图写入的 409 行为改为镜像新契约）——与 P3b 同一变更落地，勿提前单独改前端预期。

## 6. P3b–P6 指引摘要

- **P3b 设置页**：目录（kind 分段 M12 滑块/骨架/空态 T36/T35）、服务摘要（管理开关**即时写**+失败回滚「已恢复原状」、占用行折叠「…等 N 位」、删除虚线行 T17）、五类服务纸笺（紧凑按组/页头编辑=完整/＋添加=新建 T10/T11、测试探测陈旧重置、T12 只看主机+端口）、角色状态卡（第六章置灰 G1-G9、T20/T21/T22、M27/M30 用 `--nd-semantic-motion-decay` 1400ms、刷新 M28）、本机（动效偏好+版本连接，锚点无副标题）；occupancy 语音/生图前端推导（模型/MCP/Skill 仍走 `/references`）。移植 4 条回归脚本（409 合并、跨页失效、密钥回显、真实后端序列——各自回归契约逐条保留）。
- **P4 主题 veil**：重写 `ui/config-theme-transition.tsx`（保持 `ThemeTransitionStrategy` 契约）：克隆 `.studio-shell`→`.veil`（`--nd-semantic-layer-theme-transition`、inert、嵌套 `data-ui-preset` 标注——现代码 :20-21 已有）、复制输入值+滚动（:23-35 复用）、`dom-mask` 挖空图框、`commit(to)` 立即换色、副本 opacity 1→0（theme-reveal 400 ease-standard）、theme-total 550 时**同帧移除+强制回流**、`announceLive` 播报；连点由 `theme-transition.ts` 代际号天然合并；`settings-workspace.css:108` 的 `html[data-config-switching]` 全关过渡开关保留。扩展 `theme-transition-check.cjs`（点击→移除 ≤650ms、中/末帧 `compareRect` 逐像素）。
- **P5 收口**：新 `tests/settings-v6-behavior-check.cjs`（断言清单在计划文件「测试策略」节：减法 DOM、圆点令牌色、**对齐硬指标 1296/1136/598±0.5px**、纸笺几何、焦点全表、写入全流程、删除确认、T28、语音往返、veil 时序、减少动效、深链兼容）；移植 `workflow-real-backend-chain-check.cjs`（~300 选择器，20 步业务链逐字节不变）；全量 12 脚本连跑；刷新 STATUS.md 基线；设计规范 §8 组件表补 StatusDot/LiveAnnouncer；本记录归档至 `docs/archive/08-config-pages-v6/` 并登记 `docs/README.md`。
- **P6 打磨**：长文本三尺寸、forced-colors、G9 对比度实测记录、T 触发巡检、NVDA 实测（规范 Q10 遗留）、语音会话缓存与后端单份存储偏差说明。

## 7. 门禁命令速查

```bash
cd apps/desktop/renderer && npm run check && npm run build   # tokens:check + lint:styles + tsc + vite
# 改 tokens.json 后先: cd apps/desktop/renderer && npm run tokens
cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs    # 单测 160/160
cd desktop/desk-preview && npx -y node@24 tests/<script>.cjs          # 各 E2E
cd apps/backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit
cd apps/backend && npx -y node@24 --import tsx --test tests/*.test.ts      # 444 全绿
cd apps/backend && npx -y node@24 scripts/accept-offline.mjs              # 21 步
node scripts/check-docs.mjs                                          # 文档巡检（仓库根）
```

注意事项：
- E2E 必须先 `npm run build`（Electron 加载 `renderer/dist`，脚本不自动重建）。
- `settings-workspace-check.cjs` 存在已知低频时序抖动（见 §3.5），偶发失败先重跑一次再定性。
- 后端用 Node 24（`npx -y node@24`）；根目录旧 `node_modules` 不得混用。

---

## 7. P2 进度（2026-11-19 接管，部分完成）

接管时 P1 改动仍在工作树未提交；已复核门禁并提交 `2c248fa`（基础件）。随后按计划开始 P2，**当前为可运行的中间态**：纸笺引擎与「设定」分区已切到 v6，其余分区仍是旧渲染，待后续切片迁完后再整体收口（P2 门禁尚未满足）。

### 7.1 已完成

1. **纸笺引擎**（`renderer/src/components/config/sheet/`）
   - `sheet-context.tsx`：单纸笺状态、`open/requestClose/closeNow`、脏计数、T9 关闭确认、关闭后焦点回到触发元素（找不到时回 `[data-edit]`，再退到 `h2`）。
   - `Sheet.tsx`：完整 / 紧凑 / 确认三形态；`role="dialog" aria-modal`；打开时对 `.config-leaf-body`／`.config-leaf-foot` 设 `inert`；首字段聚焦、组内滚动、Tab 陷阱、Esc 阶梯（写入中无效 → 确认回编辑 → 关闭）；紧凑形态按触发元素顶边对齐。
   - `scrims.tsx`：右页 + 书本双层压暗，点击关闭；用 P1 的 `dom-mask` 把图片框从两层挖空，随窗口尺寸重算。
2. **写入管线**（`write-runner.tsx`）
   - `runWrite({ roleIds, verb, commit })`：先重读活动态 → 必要时 `POST activity/stop` → 250ms 轮询 ≤20s 等 `stopped` → 写入；失败区分「暂停失败」与「已暂停但写入失败」（T32），暂停记录保留供 T30 恢复。
   - `resumePaused()` 与 `pausedRoleIds`；`PausedRolesFooter` 把 T30「继续活动」投到两页页脚右侧。
3. **设定分区 v6**
   - 删除 `ConfigHeading` 的编号/英文/说明与 `config-active-note` 提示；标题只留 `h2`。
   - 页脚按 T6：「设定 · N 处改动未保存」+「放弃」+「保存 N / 暂停并保存 N」；干净态页脚 `data-empty` 收起为 0 高。
   - 保存改走 `runWrite`，不再用旧 `ensureRoleStopped` + 「已暂停」提示条；保存成功后由 T30 提供一键恢复。
4. **删除角色确认纸笺**：设定底部「删除角色…」打开确认（T31：保留 / 一并删除本机数据），写入同样走 `runWrite`；只剩一个角色时禁用；内置助手仍显示不可删除说明。旧 `RoleDeletion` 与 `config-delete-options` 已移除。
5. **文字减法与书脊**：角色页删除 `config-dirty-ribbon`、`config-folio`；书脊草稿标记改为 `.tab-dot`（7px warning，右上角 2px 底环），按钮 `aria-label` 追加「，有未保存的改动」。

### 7.2 自验

- `renderer npm run check`：通过（24 个 CSS 零违规、`tsc` 通过）。
- `renderer build`：通过。**环境注意**：本机执行 `npm run build` 会被 sandbox 的 safe-delete 垫片以 `state lock timeout` 拦在清空 `dist` 一步；用 `NODE_OPTIONS= node ./node_modules/vite/bin/vite.js build` 可正常构建，属环境问题而非代码。
- 桌面单测：**160／160**。
- 临时 Electron + 真实后端探针（未入库，两轮）：
  1. 进入角色配置 → 标题「设定」、页脚干净态收起；改显示名 → 页脚「设定 · 1 处改动未保存」+「保存 1」；先恢复活动再保存 → 页脚出现 T30「继续活动」，点击后恢复 `active`，页面无异常。
  2. 新建普通角色 → 切换编辑对象 → 「删除角色…」→ 确认纸笺：`data-shape=confirm`、宽 600、顶边对齐触发行（top 6）、右页与书本两层压暗均开启、正文 `inert`、初始焦点在「保留本机数据」单选；确认删除后纸笺收起、角色从 `/v1/roles` 消失，无页面异常。
- **实现注意**：纸笺必须通过 portal 挂到 `.config-leaf`（正文之外）。早期把纸笺渲染在 `.config-leaf-body` 内，再对该正文设 `inert`，会把纸笺自身一起禁用、焦点落不到字段。
- **未跑**：`settings-workspace-check.cjs` 等既有 E2E 仍指向旧 DOM（保存按钮文案、`.config-delete-options`、丝带/folio），在 P2 全部迁完并移植脚本前预期失败，不作为本轮回归结论。

### 7.3 尚未完成（P2 余下）

1. 外观（服饰卡网格 +「编辑服饰」完整纸笺 + 删除服饰确认 T27）、模型（四行摘要 + 服务/连接测试纸笺，复用 `ModelNamePicker`）、扩展（MCP/Skill 两行 + 开关纸笺）、自主额度（今日 + 每日额度 + T28）、完成度（只读清单 + 查看）五段正文与纸笺。
2. 底栏原生 `<select>` 角色切换（+「＋ 新建角色…」项）、T37 设定脏切换确认、删除 `config-dialog` / 藏书票墙 / `config-dirty-prompt`。
3. 语音按服务会话缓存（`by[roleId:serviceId]` 提升到 workspace state）。
4. 旧 `VoicePanel` / `ImagePanel` / `AppearancePanel` 的纸笺分组化与组副标题删除。
5. `settings-workspace-check.cjs` 角色页段与 `startup-flow-fixes-check.cjs` 选择器移植；P2 门禁重跑。

---

## 8. 独立复核（2026-11-19，P1 通过；P2 中间态**未达验收**）

复核基准：`E:/tmp/test/config-pages-dev-spec (1).md`（1358 行）与其 §四 58 条验收清单、`nowadays-config-v6-demo`、本文档 §3.4／§7.2 门禁。结论来自独立实跑与自建 Electron 探针，不采信自验。

### 8.1 门禁实跑（与文档声明一致）

| 门禁 | 结果 |
| --- | --- |
| `renderer npm run check` | 通过（24 个 CSS 零违规、`tsc --noEmit`） |
| `renderer npm run build` | 通过（本机 `npm run build` 直接成功；先前 safe-delete 拦截未复现） |
| 桌面单测 | **160／160** |
| `node scripts/check-docs.mjs` | 0 错误 0 警告 |

### 8.2 已落地部分实测通过项

1. **文字减法（设定分区）**：`.config-sec-head` 只有 `h2`（「设定」）；`.config-folio`／`.config-dirty-ribbon` 为 0；干净态页脚高 0，脏态高 52px 且文案为 T6「设定 · 1 处改动未保存 / 放弃 / 暂停并保存 1」，与规范 §二.5 一致。
2. **书脊草稿点**：改显示名后 `.tab-dot` 出现 1 个，`aria-label` 追加「，有未保存的改动」，符合验收 15。
3. **删除确认纸笺**：`role=dialog`、`aria-modal=true`、正文 `inert`、初始焦点落在第一个单选（`data-sheet-focus`），符合验收 30／31；实测紧凑顶边 = 行顶 − 10（1280 下 74.1 对 68.1）。
4. **基础件**：令牌 `layer.sheet=60`／`themeTransition=2000` 与 `component.sheet.*` 已生成；`settings-workspace.css` 中 `ms` 与 `cubic-bezier()` 字面量为 0，符合验收 37。
5. **既有 E2E**：`theme-transition-check` 退出 0；`startup-flow-fixes-check`、`settings-review-fixes-check`、`settings-workspace-check` 为红，但失败点全部落在已删除的旧 DOM（`.config-dirty-ribbon`、`.config-delete-options`、`保存设定`、`config-active-note`），与 §7.2「P2 未移植前预期失败」一致，非新增产品回归。

### 8.3 已迁移切片中的硬性缺口（P2 验收阻塞）

| # | 问题 | 实测证据 | 对应规范／验收 |
| --- | --- | --- | --- |
| V1 | **压暗层不可见且书本层点不动**：`.config-scrim.on` 与 `.config-book-scrim.on` 都只有 `pointer-events`，没有把 `opacity` 从 0 提到 1；书本层连 `pointer-events:auto` 都没有 | 探针：`scrimOpacity=0`、`scrimAnimations=0`、`bookOpacity=0`、`bookPointer=none` | §7.1／M5／M6；验收 27／31 |
| V2 | **纸笺零动效**：`Sheet.tsx` 未调用 `readMotionTime`／`animate`，CSS 无 `config-sheet` 关键帧；打开时 `getAnimations().length=0` | 探针 1280 与 720 均 `sheetAnimations=0` | M1～M4／M31；验收 34／36 |
| V3 | **读屏播报区未挂载**：`LiveAnnouncer` 从未被渲染，`announceLive()` 因找不到节点直接 return；页面无 `[aria-live]` | 探针：`liveIds=[]`、`#live=false`、`#config-live=false` | §7.10；验收 56 |
| V4 | **设定人设自动增高与改动细线缺失**：`Textarea rows={8}` 静态，无 `cap=max(140,min(视口×0.4, pane−120))` 计算；无 `.ctl:before` 琥珀线；T5 字数放在组名副行而非输入框右下 | 代码核对：`Settings.tsx` 无 cap 公式、`settings-workspace.css` 无 `ctl:before` | §二.5／M19；验收 33 |
| V5 | **主题切换仍是 v5 旧方案**：`ui/config-theme-transition.tsx` 为 900ms 圆形扩散 + 64px 羽化 + 暖／冷光环，且仍由 `Settings.tsx` 接入；v6 规范明确作废 | 代码核对：`/900`、`feather=64`、halo 渐变仍在 | §5.3／M34；验收 39 |

说明：V1–V4 位于文档声明「P1 已完成／P2 设定已切片」范围内，属于**已迁移部分的裁剪**，不是「尚未推进的阶段」；V5 属于 P4 未开始，按计划可后置，但当前页面仍是旧动效。

### 8.4 与 demo／规范对照的功能与适配结论

- **没有偷偷删掉整块模块**：P2 余下五段正文、底栏原生 `<select>`、语音按服务缓存、E2E 移植，以及 P3a 后端依赖暂停（`GLOBAL_CONFIG_WRITES` 仍含语音／生图 PATCH+DELETE）、P4 veil、P5／P6 都按 §7 明确列为待推进，属于阶段式推进而非隐藏阉割。
- **P1 基础件目前是死代码**：`StatusDot`、`summary.js` 只在单测中出现，未接入任何 TSX；探针实测页面 `.ui-dot.dot=0`、`.config-sum=0`。因此验收 13／14／16～25 的摘要点对齐（1296／1136／598±0.5px）目前无法核验。
- **720 适配**：探针实测紧凑纸笺宽 696、顶 254.8（视口 720×540，书页顶 52.2），未见明显越界；但未做逐像素比对、横向滚动检查与 6 组尺寸×主题全覆盖，验收 A1／A2／D20 暂不构成通过证据。

### 8.5 验收标准核对汇总（规范 §四）

- **明确通过**：4／5／8（设定分区文字与页脚减法，仅角色页设定）、15（书脊草稿点）、30／31（纸笺焦点与 inert，实测首字段聚焦）、37（无时长字面量）。
- **明确不通过**：27（书本层点关闭失效）、33（人设自动增高）、34／36（纸笺与压暗层动效）、39（主题仍 900ms 旧方案）、56（读屏播报）。
- **暂无法核验／阶段未完成**：1／2（6 组尺寸×主题全覆盖）、13／14／16～25（摘要矩阵与像素对齐）、26／28／29／32（其余分区映射与关闭规则）、35（保存反馈扫光）、38／40／41（veil 与图片像素）、42～58（设置页专项、置灰、写入异常与 720 专项）。

### 8.6 结论与建议

**文档自身 P1 门禁通过；P2 中间态未达到验收标准**（文档 §7 已声明 P2 未完成，此处独立确认），且「已迁移」的设定与纸笺切片存在 V1～V4 四项可见裁剪，与 demo 的实际观感不一致——具体表现为开纸笺时背景不变暗、纸笺直接闪现、保存与恢复没有读屏播报、人设输入框不会自动增高。

建议按此顺序收口：① 先修 V1～V4（scrim `opacity` 与 `pointer-events`、纸笺按 `readMotionTime` 做 M1～M6、挂载 `LiveAnnouncer` 并把 id 对齐验收的 `#live`、实现人设 cap 与 M19），② 再继续 P2 余下五段与底栏 `<select>`、同步移植 E2E，③ 最后按 §四 58 条跑 6 组尺寸×主题全量验收。证据：`apps/backend/test-results/400-v6-recheck-20261119/`（`probe-v6-ui.json`、`probe-v6-720.json`、`probe-v6-focus.json`、四条 E2E 日志）。

## 9. V1–V4 补修（2026-11-19，自验通过，待独立复核）

按 §8.6 的建议顺序先收口 V1–V4（已迁移切片里的硬性裁剪），**未推进 P2 余下五段**；V5（主题切换）按计划属 P4，本轮不动。

### 9.1 V1 · 压暗层不可见且书本层点不动

- 根因：[settings-workspace.css](../../../apps/desktop/renderer/src/styles/settings-workspace.css) 里 `.config-scrim.on` 只写了 `pointer-events`，没有把 `opacity` 从 0 提到 1；`.config-book-scrim` 连 `.on` 规则都缺失，两层因此一直是 `opacity:0`，书本层还不可点。
- 改法：`.config-scrim.on{opacity:1;pointer-events:auto}`、`.config-book-scrim.on{opacity:1;pointer-events:auto}`；淡入淡出交给 WAAPI（见 9.2），CSS 只保留稳态值，避免两套时长打架。

### 9.2 V2 · 纸笺与压暗层零动效

- 纸笺 [Sheet.tsx](../../../apps/desktop/renderer/src/components/config/sheet/Sheet.tsx)：进入按 M1/M3（桌面 `translate(calc(100% + 32px), 10px) → none`，投影 6px → 静止）与 M4（≤900 用 `translateY(100%)`），时长取 `--nd-semantic-motion-page`（360）、曲线取 `--nd-semantic-motion-ease-out`；退出按 M2 反向，取 `--nd-semantic-motion-page-exit`（260）与 `--nd-semantic-motion-ease-in`。关闭时用 `held` 保留上一张纸笺到动画结束再卸载，期间 `data-exiting` + `pointer-events:none` + `aria-hidden`，键盘与指针都不再响应。
- 压暗层 [scrims.tsx](../../../apps/desktop/renderer/src/components/config/sheet/scrims.tsx)：进入按 M5（`opacity 0→1`，component 220 / ease-out），退出按 M6（`1→0`，page-exit 260 / ease-in），淡出结束后才卸载 portal。
- 减少动效：令牌归零时 `readMotionTime` 返回 0，直接跳过建动画对象（不建、不缩短），满足 §四.36。
- 顺带修掉一个会打断动画的结构问题：`Sheet` 原先在「无纸笺 / 有纸笺」两个分支里把 `<SheetScrims/>` 放在不同子节点位置，React 会重挂载它、导致压暗层动画从头开始；现在两个状态都在同一位置渲染。

### 9.3 V3 · 读屏播报区未挂载

- [live-announcer.tsx](../../../apps/desktop/renderer/src/ui/live-announcer.tsx) 的区域 id 由 `config-live` 改为规范与验收都用的 `#live`，并在 [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx) 的工作区根挂载 `<LiveAnnouncer/>`；新增 `.ui-live` 视觉隐藏样式（此前该 class 没有样式，挂上去会直接显示文字）。
- 播报点：`write-runner` 的「正在暂停…／正在保存…」原本就在，另补写入成功「已{verb}」与恢复成功「已恢复活动」；三条 #live 专用文案放在 `config-texts.js` 的 `LIVE`（不作为可见文字，故不进 T 表）。
- 未覆盖：测试/探测结果与主题切换的播报——前者随设置页五类服务纸笺在 P3b 接入，后者随 P4 veil 重写；验收 56 仍待补齐后复验。

### 9.4 V4 · 人设自动增高、M19 细线与 T5 位置

- 人设 `Textarea` 去掉 `rows={8}`，改为 `growDefinition()`：`height=auto → min(max(scrollHeight+2, 136), cap)`，`cap = max(140, round(min(窗口高×0.4, 正文可视高−120)))`；超上限时 `overflow-y:auto` 并打 `data-capped`（细滚动条用 `line-control` 70%）。触发时机：内容变化、窗口 resize、字体加载完成、切回设定分区。
- M19：[Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx) 给显示名与人设各包一层 `.config-ctl`，逐字段比较后打 `data-dirty`；CSS 补 `.config-ctl:before`（左侧 −12px、2px 琥珀线、`opacity 0→1` + `scaleY(.4)→1`，component 220 / ease-out）。
- T5：字数从组名副行移到输入框右下 `.config-field-foot`（等宽 11px，数字用 text 色），并以 `aria-describedby="config-definition-count"` 关联。

### 9.5 自验证据（真实 Electron + 假后端，探针取自 §8 同一支并做时序修正）

证据目录：`apps/backend/test-results/400-v6-fix-20261119/`（`probe-v6-ui.cjs` 与 `probe-v6-ui.json`、`v6-sheet-1280.png`）。

| 项 | 实测 |
| --- | --- |
| V1 | `.config-scrim`／`.config-book-scrim` 稳态 `opacity=1`、`z-index=5`；`elementFromPoint(120,300)`＝`config-book-scrim on`；在左页派发 `pointerdown` 后纸笺与两层压暗在退出动画结束后全部卸载（验收 27） |
| V2 | 打开时 `.config-sheet` `getAnimations()`＝1、`duration=360`；两压暗层各 1 个动画（220）；`data-motion="reduced"` 下 16ms 内三处均为 0、纸笺 `transform=none`（验收 34／36） |
| V3 | `#live` 存在、`aria-live=polite`、`aria-atomic=true`；写入成功/恢复会写句 |
| V4 | 初始高 136；填入 4000 字后高度=cap=320、`overflow-y:auto`、`data-capped`；字数 `4000` 且 `#config-definition-count` 存在；显示名与人设 `.config-ctl[data-dirty]` 均命中、`::before` 透明度过渡到 1 |

门禁：`renderer npm run check`（24 CSS 零违规、`tsc` 通过）与 `vite build` 通过；桌面单测 **160／160**；`theme-transition-check`、`pack3-entry-check` 退出 0。`startup-flow-fixes-check`／`settings-review-fixes-check`／`settings-workspace-check` 仍为红，失败点分别是 `保存设定` 文案、旧删除弹窗选择器、`.config-dirty-ribbon`——都在 P2 已删除的旧 DOM 上，与 §8.2 记录一致，非本轮回归；这三条要等 P5 移植后才能重新作为门禁。

**性质说明**：本轮为实施者自验，V1–V4 是否收口以独立复核的实跑为准；V5（v5 900ms 主题动效）按计划仍在 P4；P2 余下五段、底栏 `<select>`、语音按服务缓存、E2E 移植未动。

---

## 10. V1–V4 补修独立复核（2026-11-19，**补修通过；P2 整体仍未达验收**）

在 §9 工作树上独立复核，结论均来自自行实跑与自建探针，不采信 §9 自验数字与探针。**§8.3 的 V1–V4 四项硬性裁剪已全部确认收口；V3 播报仅覆盖保存/恢复两条（与 §9 声明一致）；V5 与 P2 余下范围按计划未动，故 P2 整体仍未达验收。**

### 10.1 门禁实跑

| 门禁 | 结果 |
| --- | --- |
| `renderer npm run check` | 通过（24 个 CSS 零违规、豁免 388、`tsc --noEmit`） |
| `renderer npm run build` | 通过 |
| 桌面单测 | **160／160** |
| `node scripts/check-docs.mjs` | 0 错误 0 警告 |
| E2E `theme-transition-check`／`pack3-entry-check` | 退出 0（18s／2s） |
| E2E `startup-flow-fixes-check`／`settings-review-fixes-check`／`settings-workspace-check` | 仍为红，失败点与 §8 留证**逐字一致**（`new-role-activity-synced:263`、`cancelFocus:71`、`:301`），非本轮回归 |

说明：§9 自验把三条 E2E 的失败点描述为「保存设定文案／旧删除弹窗选择器／`.config-dirty-ribbon`」，与我复跑的实际失败点（`new-role-activity-synced`／`cancelFocus`／`:301`）不完全吻合，但两轮日志（§8 与本轮）自身一致，故「非本轮回归」的结论不变；这三条要等 P5 移植后重建前置。

### 10.2 V1–V4 独立复验（自建 Electron 探针，含负向对照）

| 项 | 独立方法 | 实测结果 | 验收 |
| --- | --- | --- | --- |
| **V1** 压暗层 | 打开删除纸笺，采稳态 `opacity`／`pointer-events`／`elementFromPoint`，并真实点击书本层空白 | 稳态 `.config-scrim`／`.config-book-scrim` 均 `opacity=1`、`pointer-events:auto`；`elementFromPoint(120,300)` = `config-book-scrim on`；点击后纸笺＋两层压暗全部卸载 | 27 通过 |
| **V2** 动效时长 | 打开后 25ms 采 `getAnimations().effect.getTiming().duration`；1280 与 720 各跑一次 | 纸笺 `1×360ms`、两层压暗各 `1×220ms`，1280／720 一致；退出 260ms（M2/M6）；720 下纸笺层 `z-index=60`（媒体查询抬层，符合规范） | 34 通过 |
| **V2** 减少动效 | 设 `html[data-motion=reduced]` 后重开纸笺 | 纸笺／两层压暗 `getAnimations()` 均 **0**、`--nd-semantic-motion-page=0ms`、`transform=none` | 36 通过 |
| **V3** 播报区 | 采 `#live` 语义；MutationObserver 捕获完整写入序列（修正假后端活动态可切换） | `#live` 存在、`aria-live=polite`、`aria-atomic=true`、视觉隐藏（1×1）；写入序列 `正在暂停… → 正在保存… → 已保存设定 → 已恢复活动`（四条齐全） | 56 **部分**（删除/测试/主题切换播报未覆盖，见 §9.3） |
| **V4** 人设增高 | 填入 4000 字前后采高度、`overflow`、`data-capped`、字数 | 初始 `rows=4`／高 136／`overflow:hidden`；4000 字后高 320（`cap=max(140,min(800×0.4, pane−120))`）、`overflow:auto`、`data-capped=true`、字数 `4000 字`、`aria-describedby=config-definition-count` 命中 | 33 通过 |
| **V4** M19 细线 | 改字段后采多个时间点，确认属性所在元素 | 显示名／人设各包 `.config-ctl` 并逐字段 `data-dirty`；dirty 字段 `::before` 在 260ms `opacity=0.79`、500ms 达 `1`／`transform:none`、宽 2px、琥珀色；非 dirty 字段保持 0 | M19 通过 |
| **V4** T5 / 书脊点 | 采字数位置与书脊点 | 字数移入 `.config-field-foot` 右下（等宽 11px）；改字段后 `.tab-dot` 出现 1 个 | 15 / T5 通过 |

**两处采样陷阱已排除**（避免误判为缺陷）：① 首次探针在 200ms 采 M19 得 `opacity=0`，聚焦探针按 40/120/260/500/1000ms 连采确认是 220ms 过渡未走完，稳态为 1；② 首次探针播报只到「正在暂停…」，原因是假后端 `activity` 恒返回 `active` 导致 20s 轮询卡住，改为 stop→`stopped`／resume→`active` 后四条播报齐全。两处均属探针问题，非产品缺陷。

### 10.3 按 58 条验收清单的变化（相对 §8.5）

- **由不通过转通过**：27（书本层点关闭）、33（人设自动增高）、34（动效时长/曲线）、36（reduced 归零）。
- **由无法核验转可通过**：部分 16～25 的前置——`StatusDot`／`summary.js` 本轮仍未接线，但纸笺几何（紧凑顶边、宽、720 抬层）已在自建探针中实测；摘要点像素对齐（1296/1136/598±0.5px）仍因基础件未接线无法核验。
- **仍不通过**：39（主题仍 900ms 旧方案，V5 按计划 P4 未动）。
- **部分通过**：56（保存/恢复四条播报到位，删除/测试/主题切换未覆盖）。
- **仍未完成/无法核验**：1／2（6 组尺寸×主题全量）、13／14／16～25（摘要点像素矩阵）、28～32、35（保存扫光）、37 已通过、38／40／41（图片像素）、42～55／57／58（设置页专项、写入异常、720 专项、高对比）。

### 10.4 结论与范围

**V1–V4 补修通过**，§8.3 指出的「已迁移切片的可见裁剪」已消除：开纸笺背景变暗且可点关闭、纸笺按时长令牌滑入滑出、保存/恢复有读屏播报、人设输入框自动增高并带改动细线。**P2 整体仍未达验收**——V5、P2 余下五段、底栏 `<select>`、语音缓存、E2E 移植、58 条中的多数专项按 §7／§9 计划尚未推进，不属隐藏阉割，但不可宣称 P2 完成。

**遗留（不阻塞本次补修结论）**：
1. V3 播报缺删除/测试/主题切换三条（随 P3b／P4 接入）。
2. `LIVE.theme(name)` 已定义但当前无调用方（主题播报待 P4 接线）。
3. 三条旧 E2E 的前置仍是 v5 DOM，需 P5 重建后才能恢复为门禁。
4. 720 适配仅做动效与几何采样，未做 6 组尺寸×主题逐像素比对。

**证据**：`apps/backend/test-results/400-v6-verify-20261119/`（`report.json`、`report-live.json`、`report-m19.json`、`report-720.json`、`e2e/*.log`、`verify-sheet-1280.png`、`verify-sheet-720.png`）。

---

## 11. 迁移口径确认与展示层缺口重判（2026-11-19，DL-160）

用户确认口径（[DL-160](../../161-digital-life-direction-decisions.md)）：**展示层严格对照 demo 与开发规范，不因分期裁剪用户可见效果；非展示层按系统实际灵活适配**。据此重新判定缺口：

### 11.1 边界

- **严格按 demo（展示层）**：主题切换 400/550 veil、纸笺 360/260 滑入滑出、双层压暗可点关闭、状态点与摘要、文字减法、无图空态与 720 布局、`#live` 读屏播报、M19 细线与 T5、焦点与关闭／键盘规则。验收以规范 §四 58 条为准。
- **按系统实际（非展示层）**：真实后端读写接口、SQLite 分库与角色 id、暂停／恢复真实流程、模型与服务真实连接。不照搬 demo 的定时器模拟（暂停 900ms／写入 500ms 等）、`ROLE_STORE`／`switchRole()` 示例数据与示例专用外壳（上传差分、整理素材、示例角标按钮等）；两者不一致以开发规范为准。

### 11.2 缺口重判

| 缺口 | §8/§10 原判 | 按 DL-160 新判 |
| --- | --- | --- |
| V1–V4 | 已补修通过 | 维持通过；无需再动 |
| **V5 主题切换** | 不通过，按计划属 P4 后置 | **展示层，不得后置**：现为 v5 的 900ms 圆形扩散＋光环，与 demo 的 400ms `theme-reveal`／550ms `theme-total` veil＋图片挖空不符，须按 demo 改造（验收 39） |
| V3 剩余三条播报（删除／测试／主题切换） | 部分通过，随 P3b/P4 | **展示层，须补**：`#live` 在删除、测试、主题切换后各播一句（验收 56） |
| P2 余下五段正文、底栏 `<select>` | 阶段未完成 | 属展示层，按 demo＋规范继续推进，不以「未排期」长期搁置 |
| 三条旧 E2E 前置 | 非本轮回归 | 属测试脚本（非产品展示），按 P5 移植计划重建前置即可 |

### 11.3 执行原则

按可见性与影响排序逐项收口，一项一验：**先 V5 主题切换（唯一明确「不通过」的展示硬缺口）→ 再 V3 三条播报 → 再 P2 余下五段与底栏**。每项按规范 §四对应条款做独立探针＋真机实测，不以自验替代；展示层改造只动渲染与交互，不触碰后端接口与数据契约。

### 11.4 基准 demo 目录核对（2026-11-19）

用户指出 v6 demo 的权威位置是 `E:/tmp/testWorkSpace/switchboard/nowadays-config-v6-demo`，怀疑早期记录指向错误版本。已做两目录逐文件 SHA-256 比对：**28 个文件（README、index.html、assets/app.js、css/、fonts/、roles/ 全部）逐字节一致**，`E:/tmp/test/nowadays-config-v6-demo` 是源目录的副本，内容同为 v6（README 标题「角色配置 + 设置 · v6 示例」，主题切换为 400/550 veil，明确声明 v5 的 900ms 圆形扩散已删除）。因此：

- **版本判断正确**：§8／§10／§11 对照的都是 v6 demo，未误用 v3/v4/v5。switchboard 源目录中确有三个历史版本目录（`nowadays-config-v3-demo`／`v4`／`v5`），但本次引用的 `nowadays-config-v6-demo` 是其同级 v6 目录。
- **路径记录已更正**：本文开头与本节统一标注源目录为权威，副本路径仅作规范文本的所在位置（switchboard 源目录未附 `config-pages-dev-spec`，规范只存在于副本同级）。
- V5 改造按 v6 demo §5.3 的 veil 方案实施并经真机探针验证（400ms `theme-reveal`／ease-standard、图片挖空、550ms `theme-total` 收尾、reduced 直切、两路径均有读屏播报），与 v6 一致。

---

## 12. V5 主题切换按 v6 demo 改造（2026-11-19，独立复核通过）

依 [DL-160](../../161-digital-life-direction-decisions.md) 口径，V5 属展示层不得后置。[config-theme-transition.tsx](../../../apps/desktop/renderer/src/ui/config-theme-transition.tsx) 由 v5 的「900ms 圆形扩散＋暖／冷光环」改为 v6 demo §5.3 的整页 veil 方案，**真机探针实测六要素全部对齐 demo**。

### 12.1 改造内容

- **veil 淡出**：clone 旧配色整页副本（`.studio-shell` 副本，`z-index:9000`、`inert`、`aria-hidden`），`opacity 1→0`，时长取 `--nd-semantic-motion-theme-reveal`（400ms）、曲线 `--nd-semantic-motion-ease-standard`（`cubic-bezier(.4,0,.2,1)`）；删除原圆形扩散 mask 动画与光环 `rim`。
- **图片挖空**：副本用 `maskComposite: subtract, add…` 挖掉每个立绘／缩略图框，真实页面始终绘制原图，不随主题重新着色。
- **收尾**：`--nd-semantic-motion-theme-total`（550ms）到点移除副本并 `finish()`；`data-config-switching` 期间 CSS 关闭真实页所有过渡，结束不闪。
- **连续点击**：交回框架的 `isCurrent()/cleanup` 裁决，只保留最后一次目标（与原实现一致）。
- **reduced**：框架直切路径无副本；读屏播报上移到 `ConfigThemeTransition` 组件层监听 `preset`，覆盖正常过渡与 reduced 直切两条路径，避免写在策略 `finish()` 里被 reduced 绕过。

### 12.2 独立实测（`apps/backend/test-results/400-v6-verify-20261119/`）

| 验证项 | 真机探针结果 |
| --- | --- |
| veil 出现 | 点击后 `.studio-shell` 副本出现（`shellCount=2`），旧配色保留 |
| 时长／曲线 | `duration=400`、`easing=cubic-bezier(0.4, 0, 0.2, 1)` —— 与 demo `theme-reveal`＋`ease-standard` 一致 |
| 图片挖空 | `maskCount=12`、`maskComposite="subtract, add"`，立绘／缩略图框被挖空 |
| 关过渡 | 切换期间 `data-config-switching` 存在、真实页 `transition:none` |
| 收尾 | 700ms 后 veil 移除、`switching=false`（`theme-total=550`） |
| reduced 直切 | 无 veil、直接换配色，无 `data-config-switching` |
| 读屏播报 | 正常路径「已切换到夜间」、reduced 路径「已切换到日间」，两路径各一句（验收 56 主题项） |
| 门禁 | `renderer check`（24 CSS 零违规、tsc）✓、`build` ✓、桌面单测 **160／160** ✓、`pack3-entry-check` 退出 0 |

### 12.3 遗留：`theme-transition-check` 的 50ms 时序抖动（既有，非本轮引入）

该 E2E 在对话页 `await delay(50)` 后立即断言 `dir:"dusk"`，我这边 3 次 2 过 1 败；**临时回退 V5 改动到父版本、重建后跑基线 3 次为 1 过 2 败**，抖动在改造前更严重，确认与本轮无关（失败点在对话页灯光，V5 策略只挂载于配置页、对话页已卸载）。建议把该断言改为轮询 `data-light-dir` 再来对齐 demo 的时序，归属测试脚本、非产品展示，不在 DL-160 的展示层收口范围。

### 12.4 V3 剩余播报与 P2 余下范围

- 主题切换播报已随 §12 补上（验收 56 主题项）。**删除／测试两条播报仍待补**：对应纸笺在 P3b/P4 才迁移，当前无调用点；按 DL-160 属展示层，须随对应分区迁移时一并接入，不以「后置」省略。
- P2 余下五段正文、底栏原生 `<select>` 属展示层，按 §11.3 顺序继续推进；本轮只收口 V5，未触碰这些分区。

---

## 13. P2 余下四段：外观 / 扩展 / 额度 / 完成度（2026-11-19，自验通过，待独立复核）

按 §11.3「一项一验」继续收口展示层。本轮把角色页余下四段正文从 v5 的 `config-ledger` / `ConfigHeading` 改为 v6 的摘要行与纸笺，并修掉两处基础件缺陷（纸笺归属、首帧焦点）。**P2 仍未整体达验收**：模型段与底栏原生 `<select>` 尚未迁移。

### 13.1 基础件修复（先行，影响全部纸笺）

1. **纸笺归属**：`Sheet` / `SheetScrims` 增加 `idPrefix`，只渲染自己负责的纸笺编号。此前「设定」的删除角色宿主无条件挂载一张空纸笺，多个分区同时挂载时会叠出空对话框与双层压暗。现 `delete-role`、`outfit:`、`ext:`、`quota` 各自前缀。
2. **首帧焦点**：焦点回调不再在 effect cleanup 里 `cancelAnimationFrame`。同一纸笺常因脏标记在同一帧再渲染一次，取消后焦点永远落不到字段；改为回调内校验 `isConnected`。实测「编辑服饰」打开后焦点落在名称框。

### 13.2 外观（衣柜）

1. **正文**：`AppearancePanel` 改为服饰卡网格（`minmax(150px,1fr)`、间距 16；≤900 110px/10），卡片含 2:3 缩略图、名称、`{N} 张差分`、右上角悬停淡入的「编辑」（M35）、bare 状态点（`当前服饰` / `可穿`）；空态显示 T36「还没有服饰。」；末尾虚线卡片「导入服饰」保留真实素材目录导入（非示例专用）。
2. **编辑服饰纸笺**（完整形态）：服饰（112 宽缩略图 + 名称 + 说明）、差分（52×52 小图 + `+N`、上传差分、替换主页立绘、逐张删除）、生图锚点（T25「去生图设置 →」，先关纸笺再跳转）、删除（「删除服饰…」危险描边，只剩一套时禁用并显示 T27）。
3. **写入**：改名 / 上传差分 / 换主页图 / 删除统一走 `WriteProvider.runWrite`，保存后左页立绘保持纸笺中的那套；保存成功用服务端返回列表刷新草稿，避免旧 `items` 把刚保存的名字又算成脏。
4. **左页**：立绘框上方去掉「人物档案 01 / 立绘」，只写当前服饰名（`stage-label`，单行省略）；`RolePortrait` 新增 `onOutfitName` 上报实际选中的服饰名，纸笺打开期间随预览切换。
5. **预置锁定**：预置服饰名称与删除按钮禁用，纸笺内给出只读说明（DL-153 既有策略，随新纸笺复验）。

### 13.3 扩展与自主额度

1. **扩展**：两行摘要（MCP / Skill），值为「已为角色开启 n / total」或 T36「设置里还没有…」，第二行写开启 / 停用名单；状态点 bare（生效中 / 全部关闭 / 有服务已停用 / 无）。整行打开紧凑纸笺，内含开关列表；全局停用项禁用并写 T33「已全局停用，不能开启」；有改动时页脚 T8 + 取消 / 保存，保存走 `saveBindings('ext')`。
2. **自主额度**：摘要行为只读今日（`今日已用 x / y 点` + 每日额度 / 日期 / 本机 00:00 重置 + 进度条），整行打开紧凑「自主额度 · 每日额度」；数字框 `min=1 max=1000000 step=1`，留空 / ≤0 / 小数 / 超上限均给 T28 并禁用保存，勾「不限制」时不校验；保存复用既有 `saveBudget`（含暂停管线）。

### 13.4 完成度

只读清单四行（设定 / 对话模型 / 记忆整理 / 角色状态），每行「编号 + 名称 + 点线 + 状态点 + 查看」；「查看」切到对应分区，角色状态跳设置页「角色状态」。行高与点线沿用既有 `.config-check-row`。

### 13.5 自验证据（真实 Electron + 本地后端，探针未入库）

| 验证项 | 结果 |
| --- | --- |
| 衣柜卡片 | 3 张（两套预置 + 一套接口新建），名称 / `19 张差分 · 预置` / 状态点「当前服饰」「可穿」正确；网格 4 列 176px、gap 16 |
| 预置锁定 | 名称框与「删除服饰…」均禁用，纸笺给出只读说明 |
| 编辑纸笺 | `编辑服饰`、四组「服饰 / 差分 / 生图锚点 / 删除」、焦点落名称框、页脚「取消 / 保存」 |
| 保存 | 改名后保存 → 后端名字更新、角色被暂停、左页标签跟随为「探针服饰·改」、页脚保存回到禁用 |
| 删除确认 | 提问文案为 T31「删除「X」？衣柜里不再显示，历史消息里引用的图仍保留。」；确认后纸笺收起、列表消失；无页面异常 |
| 扩展 | 两行摘要 `设置里还没有MCP。` / `设置里还没有Skill。`，状态点「无」；整行打开紧凑纸笺，标题 `MCP`、`data-shape=compact` |
| 额度 | 摘要 `今日已用 0 / 200 点`；紧凑纸笺标题「自主额度 · 每日额度」、只含「每日额度」组、焦点在数字框；填 0 → T28 + `aria-invalid=true` + 保存禁用；填 37 保存 → 后端 `dailyLimit=37`，摘要更新为 `0 / 37 点` |
| 完成度 | 四行均带「查看」；点「对话模型 · 查看」切到 `03 模型` |
| 门禁 | `renderer check`（24 CSS 零违规、`tsc`）✓、`build` ✓、桌面单测 **160／160** ✓ |

### 13.6 仍未完成（P2 余下）

1. 模型段四行摘要与「服务 / 连接测试」纸笺（复用 `ModelNamePicker`）。
2. 底栏原生 `<select>` 角色切换 +「＋ 新建角色…」+ T37 脏切换确认；删除 `config-dialog` 藏书票墙与 `config-dirty-prompt`。
3. 语音按服务会话缓存；`VoicePanel` / `ImagePanel` 的分组化（随模型段一起做）。
4. V3 删除 / 测试两条读屏播报的「测试」项随模型纸笺接入；`settings-workspace-check.cjs` 等旧 E2E 选择器移植。

---

## 14. P2 余下四段独立复核（2026-11-19，基线 b69d91e：**总体通过；1 项展示缺口 R10-1**）

在 `b69d91e`（工作树干净）上独立复核，结论来自自建真机探针，不采信 §13 自验。**外观／扩展／额度／完成度四段展示与纸笺归属修复实测通过；发现 1 项切分区不关纸笺的展示缺口（R10-1，P2）。**

### 14.1 通过项

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 渲染器门禁 | 实跑 `npm run check` + `build` | 令牌最新、24 CSS 零违规、`tsc` 通过、构建成功 |
| 桌面单测 | 实跑 `node --test tests/*.test.cjs` | **160／160** |
| 后端门禁 | 实跑 `accept-offline.mjs` | **21／21** 步、正式测试 **444／444**、`sourceUnchanged = true`、`realServiceCalls = 0`，报告 `apps/backend/test-results/p5-2026-11-19T09-25-32-589Z-e623ef65/summary.json` |
| 文档巡检 | `node scripts/check-docs.mjs` | 0 错误 0 警告 |
| 外观卡片 | 自建假后端 3 套服饰（2 预置＋1 自建） | 渲染 3 张服饰卡＋1 张「导入服饰」；名称、`19 张差分 · 预置`、状态点「可穿」正确；标题仅「衣柜」，无「人物档案／立绘」旧标题（空态「还没有立绘」是 demo 要求的 T22） |
| 编辑服饰纸笺 | 打开预置服饰 | `sheetCount/scrimCount/bookCount` 均 **1**（原会叠空纸笺＋双层压暗，归属修复生效）；四组分组、标题「编辑服饰」、`data-shape=full` |
| 预置锁定 | 预置服饰纸笺 | 名称框与「删除服饰…」均 `disabled`，给出只读说明（DL-153 策略） |
| Esc 关闭 | 打开服饰纸笺后 Esc＋等 500ms | 纸笺／两层压暗全部卸载（0/0/0） |
| 扩展段 | 切到扩展、点 MCP 摘要行 | 两行摘要「设置里还没有MCP./Skill.」+「开启 无」；纸笺标题「MCP」、`data-shape=compact`、单层 |
| 额度段 | 切到额度、点摘要行 | 摘要「今日已用 0 / 200 点／每日 200 点／本机 00:00 重置」；纸笺「自主额度 · 每日额度」紧凑形态、数字框预填 200 |
| 额度校验 | 数字框填 0 | `role=alert` 显示 T28「请输入 1–1000000 的整数」、`aria-invalid=true`、保存禁用 |
| 额度保存 | 填 37 保存 | 后端 `dailyLimit=37`、摘要更新「0 / 37 点」、纸笺收起；走既有暂停管线 |
| 完成度 | 切到完成度 | 四行（设定／对话模型／记忆整理／角色状态）各带「查看」，点「对话模型·查看」切到模型段 |

### 14.2 R10-1 · P2 · 切分区不关闭已开纸笺（展示缺口）

**复现**：扩展段打开 MCP 紧凑纸笺（不按 Esc），直接点页签「设定」，等 300ms 与 1500ms 两次采样，`sheets/titles` 始终是 `1 / ["MCP"]`、两层压暗仍在——纸笺不随分区切换关闭，停留在已离开分区的内容上。

**期望**（v6 demo §验收 29 与 `app.js` 的 `goSection`）：`if (state.sheet) requestClose(() => goSection(id))` —— 纸笺开着点另一分类，无改动应先关闭再切换，有改动先走关闭确认。仓库 [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L346) 的 `changeSection` 不检查 `sheet`，直接 `setRoleSection(id)`。

**定位**：`changeSection` 不在本轮 diff 中，属 P2 早期切片遗留；本轮纸笺归属修复（`idPrefix` 过滤）解决了多宿主叠加空纸笺，但没有补上切段关闭。按 DL-160 属展示层，不得以「既有遗留」长期搁置。

**修法建议**：`changeSection` 内先读 `useSheet()` 的当前 `sheet`（或暴露 `getSheet()`），若非空则 `requestClose(() => applySection(id))`，把实际切换放进回调；有脏时复用既有关闭确认阶梯。属纯前端交互改动，不触碰接口。

### 14.3 观察项（不阻塞）

1. **首帧焦点对 disabled 字段**：预置服饰名称框 `disabled`，探针 `focusOnName=false` 属预期（disabled 不可聚焦）；自验称「焦点落名称框」是非预置服饰场景，本轮未对非预置服饰复验焦点，建议下轮补。
2. **纸笺归属修复的 rAF 累积**：`Sheet.tsx` 去掉 `requestAnimationFrame` 的 cleanup 后，同一纸笺在首帧重渲染会累积多个回调；均以 `frame.isConnected` 校验后 focus，实测无异常，但高频重渲染下有冗余 focus，可后续加 `slot`/去重。
3. **§13 自验的「探针未入库」**：本轮证据已入库 `apps/backend/test-results/400-v6-verify-20261119-b69d91e/`，替代自验口径。

### 14.4 范围与环境

仅覆盖 P2 四段与纸笺归属的桌面端／离线范围；模型段、底栏原生 `<select>`、语音按服务缓存、P3a 依赖暂停、真实后端与模型联调不在本次范围。

## 15. R10-1 与 §14.3 观察项补修（2026-11-19，自验通过，待独立复核）

按 §14.2 的建议修 R10-1（切分区不关闭已开纸笺），并处理 §14.3 的前两项观察项。

### 15.1 R10-1 · 切分区先按关闭规则收纸笺

**问题**：`changeSection` 直接 `setRoleSection/ setSettingsSection`，纸笺开着点页签时不关闭，停留在已离开分区的内容上（违反验收 29）。

**改法**（纯前端，不触接口）：

1. [sheet-context.tsx](../../../apps/desktop/renderer/src/components/config/sheet/sheet-context.tsx) 的 `SheetProvider` 增加可选 `controller` 引用，把最新的 context 值挂到工作区层的 `MutableRefObject` 上——页签在工作区层、纸笺状态在 Provider 内，跨层只能靠这个引用，不需要把 Provider 整体外提。
2. [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx) 的 `changeSection` 拆成 `apply()`（真正的切换与 M9 淡入）和前置判断：`sheetController.current?.sheet` 非空时先 `requestClose(apply)`，让既有闭关闭规则接管——无改动直接关，有改动先出 T9 确认、确认「放弃」后才切；写入中 `requestClose` 自身会忽略。
3. 同步补齐 M2 时序：[sheet-context.tsx](../../../apps/desktop/renderer/src/components/config/sheet/sheet-context.tsx) 的 `closeNow` 先读纸笺的 `--nd-semantic-motion-page-exit`，`then` 待办（切换分区 / 保存反馈）改为退出动画结束后再执行；减少动效（令牌 0）时仍旧同步执行。

### 15.2 §14.3 观察项

1. **非预置服饰首帧焦点**：用 §14 同一支四段探针补测「我的搭配」（`isPreset:false`）：名称框 `disabled=false`、值 `我的搭配`、`document.activeElement` 就是该输入框（`focusIsName:true`）。预置服饰名称框 `disabled` 不可聚焦属预期，焦点落到下一个可聚焦控件。
2. **焦点 rAF 累积**：`Sheet.tsx` 的聚焦效应按「纸笺编号｜组名」去重，同一纸笺同一组只排一帧，重渲染时取消上一帧再排新的；关闭纸笺时清空。`owned` 变化不再累积冗余 `focus()`。
3. 证据目录说明属信息项，无需改动。

### 15.3 自验证据（真实 Electron + 本地假后端，复用 §14 探针并把时序写严）

证据目录：`apps/backend/test-results/400-v6-fix-r10-1-20261119/`（`probe-switch-delay.cjs` + `report-switch-delay.json`、`probe-four-sections.cjs` + `report-four-sections.json`）。

| 场景 | 实测 |
| --- | --- |
| 扩展段开 MCP 纸笺 → 点「设定」（无改动） | 300ms 与 1500ms 两次采样：`sheets/scrims/books` 全 0，页签 `01设定`、正文 `h2=["设定"]`（R10-1 收口） |
| 额度纸笺改 37 → 点「设定」（有改动） | 400ms 后：纸笺仍在、`confirm=true`、页签仍是 `05额度`、正文仍是「自主额度」——先确认不切段 |
| 上一步点「放弃」 | 600ms 后：纸笺 0/0/0，页签 `01设定`、正文 `设定` |
| 非预置服饰纸笺 | `nameDisabled=false`、`focusIsName=true`、`value="我的搭配"`、标题「编辑服饰」 |

门禁：`renderer npm run check`（24 CSS 零违规、`tsc` 通过）与 `vite build` 通过；桌面单测 **160／160**；后端 `accept-offline.mjs` **21／21 步**、正式测试 **444／444**、`sourceUnchanged=true`、`realServiceCalls=0`（报告 `apps/backend/test-results/p5-2026-11-19T09-43-05-872Z-03a0de97/summary.json`）；`node scripts/check-docs.mjs` 0 错误 0 警告；`theme-transition-check`、`pack3-entry-check` 退出 0。

`startup-flow-fixes-check`（`保存设定` 旧文案）与 `settings-workspace-check`（`.config-dirty-ribbon`）仍红，失败点都在 P2 已删除的旧 DOM 上，与 §8.2／§14 一致，非本轮回归。

### 15.4 复核对齐提示（未改）

§14.1 的「额度保存 … 纸笺收起」与同目录基线产物不一致：`report-four-sections.json` 的 `quotaSaved.sheets` 为 `1`，且 `QuotaSheetHost` 保存成功后并不调用 `requestClose`。本轮未改这一行为（属 P2 写入反馈范畴，规范 §7.5 要求「写入成功后纸笺收回再做 M7/M8 反馈」）。若确认要对齐规范，需要连同额度／扩展／模型／语音／生图五类纸笺的保存后收回与行内扫光一起做，建议并入 P5。

**性质说明**：本轮为实施者自验，R10-1 是否收口以独立复核实跑为准。

---

## 16. 模型段与底栏角色切换（2026-11-19，自验通过，待独立复核）

接续 §15 的工作树，把模型段从「四行折叠表单」改为 v6 摘要行 + 纸笺，并把底栏的「切换角色」按钮换成原生 `<select>`。**生图 / 语音仍沿用旧折叠行**（见 §16.4），P2 整体仍未达验收。

### 16.1 模型段（对话 / 记忆）

1. **摘要行**：`ModelRow` 两行——对话、记忆整理。值写 `{服务} · {模型}`，未选写「未选择」+ T2 提示；记忆未选写「跟随对话模型」+「继承 {对话模型}」；资源被删写 T34「原服务已删除，请重新选择」；状态点 bare（生效中 / 未设置 / 服务已停用 / 跟随对话模型 / 原服务已删除）。
2. **点击映射**：对话点值或协议 → 紧凑「对话 · 服务」；整行 / 编辑 → 完整「编辑对话模型」（服务 + 连接测试两组）；记忆整行 → 紧凑「记忆整理」（整份）。为避免按钮嵌套，摘要行改为 `div[role=button]`（Enter / Space 同步），额度行一并改。
3. **纸笺内容**：服务组为服务下拉（全局停用项 `disabled` + T33 后缀；一个可用服务都没有时给 T25「去设置添加 →」）+ `ModelNamePicker`（读取列表 / 测试 / 结果）；连接测试组提供「测试」与 T25「在设置中查看模型 →」，跳转先关纸笺再进设置。保存走既有 `saveBindings('models')`，脏时页脚 T8 + 取消 / 保存。
4. **保留**：生图 / 语音两行仍是 `config-model-row` 折叠面板（`ImagePanel` / `VoicePanel`），纸笺分组化随各自面板改造再做。

### 16.2 底栏角色切换（§7.9）

1. 页脚「切换角色 N」按钮替换为原生 `<select class="config-role-switch">`：选项为角色名，已停止的加「（已停止）」，末项「＋ 新建角色…」；选中后立即复位显示当前角色，由状态驱动。
2. **切换规则**：无脏改动直接切换（清空左页预览）；当前角色有未保存改动时先开 T37 确认纸笺「「{from}」有 {count} 处修改还没保存，切换到「{to}」会丢掉它们。」，确认「放弃并切换」后先关纸笺再切换，取消则留在原角色。
3. **新建入口**：`＋ 新建角色…` 打开「新建角色」纸笺（名字 + 角色设定），创建成功后刷新列表、写入草稿并切到新角色的「设定」分区。

### 16.3 自验证据（真实 Electron + 本地后端，探针未入库）

| 验证项 | 结果 |
| --- | --- |
| 两行摘要 | 对话「未选择 / 角色暂时无法开始对话 / 未设置」；记忆「跟随对话模型 / 继承 未选择 / 跟随对话模型」 |
| 紧凑「服务」 | 标题「对话 · 服务」、`data-shape=compact`、仅「服务」组，含 T1 提示与「去设置添加 →」 |
| 完整纸笺 | 标题「编辑对话模型」、`data-shape=full`、两组「服务 / 连接测试」、两个跳转链接、无改动时页脚为空 |
| 记忆整份 | 标题「记忆整理」、紧凑形态、仅「服务」组，含「跟随对话模型：运行时继承已绑定的对话模型。」 |
| 底栏下拉 | `SELECT`，选项「夏澄（已停止）/ 探针二号（已停止）/ ＋ 新建角色…」；选「探针二号」后页脚身份区变为「探针二号」 |
| T37 | 改显示名后切换 → 提问句与页脚「取消 / 放弃并切换」正确；确认后切到「探针二号」 |
| 门禁 | `renderer check`（24 CSS 零违规、`tsc`）✓、`build` ✓、桌面单测 **160／160** ✓、探针无页面异常 |

### 16.4 仍未完成（P2 余下）

1. 生图 / 语音的摘要行与纸笺分组化（`ImagePanel` / `VoicePanel` 仍在旧折叠行内）。
2. 删除 `config-dialog` 藏书票墙与 `config-dirty-prompt`（当前入口已改下拉，旧代码仍在，切换逻辑仍保留 `chooseRole` 供「新建」路径）。
3. 保存后纸笺收回与行内 M7/M8 反馈（§15.4 已记录，属写入反馈，建议并入 P5 与五类纸笺一起做）。
4. `settings-workspace-check.cjs` 等旧 E2E 选择器移植；V3「测试」播报随模型纸笺接入。

---

## 17. 模型段、底栏角色切换与 R10-1 补修独立复核（2026-11-19，基线 3a4ac9a：**主体通过；4 项缺陷 R11-1～R11-4**）

在 `3a4ac9a`（工作树干净）上独立复核，结论全部来自自建真机探针（真实 Electron + 假后端），不采信 §15／§16 自验。**模型段摘要行、点击映射、保存链路、底栏下拉与 T37、R10-1 切段收纸笺实测通过；同时发现 4 项缺陷，其中 R11-1／R11-2 影响功能与可访问性。**

### 17.1 通过项

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 门禁 | 实跑 `npm run check` + `build`、桌面单测、后端全量、`check-docs` | 24 CSS 零违规、`tsc` 通过、构建成功、**160／160**；后端 **21／21 步＋444／444**（`realServiceCalls=0`、`sourceUnchanged=true`）；巡检 0 错误 |
| 模型摘要行 | 假后端：对话绑定 m1／记忆未绑 | 对话「DeepSeek · deepseek-chat」+ 协议行、「生效中」；记忆「跟随对话模型」+「继承 deepseek-chat」、点「跟随对话模型」 |
| 点击映射 · 对话值 | 真机点值气泡 | 紧凑「对话 · 服务」、`data-shape=compact`、仅「服务」组、带 `data-sheet-group`、下拉预选 m1 |
| 点击映射 · 对话整行／编辑 | 分别点行名与「编辑」 | 均为完整「编辑对话模型」、`data-shape=full`、两组「服务／连接测试」、干净时页脚为空 |
| 点击映射 · 记忆整行 | 点行名 | 紧凑「记忆整理」、仅「服务」组、下拉为空（跟随）、"跟随对话模型：运行时继承已绑定的对话模型。" |
| 服务全停用 | 仅留 `enabled:false` 服务 | 选项「本地模型（已全局停用，不能选用）」且 `disabled`，纸笺给 T25「去设置添加 →」 |
| 模型保存 | 记忆选 m1 → 保存 | 后端落库 `chat_model` + `memory_model` 两条；脚注清空；`config-sheet-note` 播报「模型选择已保存。」；摘要行随后更新 |
| R10-1 无改动 | MutationObserver 记录 | t=**266ms** 同一帧内纸笺、双层压暗卸载且 `aria-current` 切到「05额度」 |
| R10-1 有改动 | 改模型名后点页签 | 先出 T9「1 处修改还没保存，关闭会丢掉它们。」+「继续编辑／放弃修改」，分区不切；「继续编辑」留原分区且焦点仍在纸笺内（Tab 不逃出）；「放弃修改」266ms 后切段 |
| 底栏下拉 | 读 DOM 与切换 | `SELECT`、三项「甲角色／乙角色／＋ 新建角色…」；干净态甲→乙→甲切换正常（两个 RoleEditor 常驻，`.config-prose` 10→16） |
| T37 | 改显示名后切角色 | 提问句「「甲角色」有 1 处修改还没保存，切换到「乙角色」会丢掉它们。」+「取消／放弃并切换」；取消留原角色，确认切到乙角色 |
| 新建角色 | 选「＋ 新建角色…」 | 完整纸笺「新建角色」、字段「名字／角色设定」、焦点落在 `[data-sheet-focus]` 名字框 |

### 17.2 R11-1 · P2 · 访问过多个角色后同一纸笺被重复渲染

**复现**：底栏先切到乙角色再切回甲（`visited` 变两个角色），在额度段点摘要行。实测 `.config-sheet` **2 个**、位置完全重合（642,190 600×184）；`.config-scrim` **2 层**同位置（444,68 806×649）；`role=dialog[aria-modal=true]` **2 个**。两层压暗各 `rgba(48,56,77,.28)` 叠加，视觉明显更暗，读屏重复朗读同一对话框。

**根因**：[Sheet.tsx](../../../apps/desktop/renderer/src/components/config/sheet/Sheet.tsx#L24) 与 [scrims.tsx](../../../apps/desktop/renderer/src/components/config/sheet/scrims.tsx#L27) 只用 `idPrefix` 认领纸笺，不看所属角色；`visited` 里每个 `RoleEditor` 都常驻并各自挂一份宿主，且共用同一个 `.config-leaf`，于是同一 `sheet.id` 被渲染 N 次。§14 的「纸笺归属修复」只覆盖「同一角色的不同分区」，不覆盖「多角色实例」——§14.1「归属修复生效」的结论仅在单角色场景成立。

**修法建议**：只让激活的 `RoleEditor` 渲染纸笺宿主（在 `RoleEditor` 内用 `active && <ExtSheetHosts/>` 之类），或给 `SheetState` 带上 `roleId` 让 `owned` 同时比对角色；切角色时按 §7.9 先收纸笺再切。

### 17.3 R11-2 · P2 · 「放弃修改／取消」不回滚草稿

**复现**：模型段把对话模型名改成「已放弃的文字」→ 点 × → T9 → 点「放弃修改」。纸笺关闭，但摘要行仍显示「DeepSeek · 已放弃的文字」，模型页签仍带脏点，重新打开输入框仍是该值，随后切角色还会再弹 T37 要求放弃。

**根因**：`closeNow` 只清纸笺状态，各宿主未把 `draft` 重置为已保存值；模型草稿由 `RoleEditor` 持有且仅在挂载/刷新时从 `bindings` 初始化。`QuotaSheetHost`／`ExtSheetHosts` 同构，属既有机制问题，本轮模型段新接入。demo 的 `discardSheet` 会 `discardItem` 回滚，与此不一致。

**修法建议**：`closeNow` 时广播一次丢弃信号（provider 暴露 `discardToken`／回调），各宿主 effect 依据最新 saved 重同步草稿；或在各 `open`/close 处显式重置。

### 17.4 R11-3 · 展示 · 工作区级纸笺缺少双层压暗与右页承载

**复现**：「切换角色」（T37）与「新建角色」两张纸笺实测 `scrims=0`、`books=0`，不在 `.config-leaf` 内（parent 为 `.config-workspace`，rect 672,6 600×177）。正文虽已 `inert`，但没有压暗层、无法点外部关闭，与规范 §7.1「双层压暗 + 点右页关闭」不符。

**根因**：`WorkspaceSheets` 挂在工作区层，`SheetScrims` 用 `probe.closest('.config-leaf')`／`closest('.config-book')` 取容器，取不到即不渲染压暗层；`Sheet` 亦因 `host` 为空而原位渲染。

**修法建议**：把两张工作区纸笺也挂进 `.config-leaf`（或让 `SheetScrims` 在无 leaf 时回落到 `.config-workspace` 并补全屏压暗层）。

### 17.5 R11-4 · 反馈 · 模型保存被拒的原因不在纸笺内显示

**复现**：所选服务有值但模型 ID 为空时点「保存」。纸笺内脚注只剩「1 处改动未保存」，失败原因「已选择的模型服务需要填写模型 ID。」渲染在纸笺之外的正文（实测 `[role=alert]`，`inSheet:false`），纸笺打开且正文 inert 时用户看不到，表现成按钮没反应。

**修法建议**：把 `bindingError` 也接入 `ModelSheetHost` 的提示位（与 `notice` 并列），或在纸笺内保存前做同样的必填校验。

### 17.6 观察项（不阻塞）

1. **记忆行值区为死区**：值气泡是 `disabled` 的 `config-chip-v`，真机点击（`elementFromPoint` 命中该按钮）不产生事件，点「跟随对话模型」文字无反应，须点行名或「编辑」。
2. **协议展示与 demo 有出入**：记忆行在有服务时第二行显示协议，demo 的 `memory` 摘要 `keys` 为空；对话行的协议缺「协议」键名（demo 是带键名的 chip）。
3. **继续编辑后的焦点**：落在 `.config-sheet-x`（关闭按钮），demo 是回到第一个字段。
4. **保存后纸笺不收回**：与 §15.4 一致，属 P5 写入反馈。

### 17.7 范围与环境

仅覆盖桌面端与离线假后端；未覆盖真实后端／模型联调、生图与语音摘要化、旧 E2E 选择器移植。证据：`apps/backend/test-results/400-v6-verify-20261119-3a4ac9a/`（`probe-*.cjs` + `report-*.json`，本地未入库）。

## 18. R11-1～R11-4 与 §17.6 观察项补修（2026-11-19，自验通过，待独立复核）

按 §17.2–§17.5 逐项收口，另处理 §17.6 的前三项观察项（第 4 项属 P5 写入反馈，未动）。本轮只改渲染器与测试脚本，不触后端接口与数据。

### 18.1 R11-1 · 多角色实例重复渲染同一纸笺

- 根因确认：`Sheet`／`SheetScrims` 只按 `idPrefix` 认领纸笺，不看所属角色；`visited` 里每个 `RoleEditor` 都常驻并各挂一份宿主、共用同一个 `.config-leaf`，于是同一 `sheet.id` 被渲染 N 次。
- 改法：[Sheet.tsx](../../../apps/desktop/renderer/src/components/config/sheet/Sheet.tsx) 与 [scrims.tsx](../../../apps/desktop/renderer/src/components/config/sheet/scrims.tsx) 增加 `enabled`（默认 `true`）：非激活角色一律不认领。各宿主传 `enabled={active}`——`ModelSheetHost`／`ExtSheetHosts`／`QuotaSheetHost`，以及 [AppearancePanel](../../../apps/desktop/renderer/src/components/appearance/AppearancePanel.tsx)（新增 `active` 属性，覆盖服饰纸笺）。`RoleSheetHost` 本轮未改：它在非激活时 `if (!active) return null` 整块不渲染，效果等价，无需 `enabled`（2026-11-19 按 §19.2 R12-2 校订，原文误列为「已传 `enabled`」）。`RoleEditor` 常驻保留草稿的行为不变。
- 切角色补一道保险：[Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx) 的 `switchRole` 在「无改动但纸笺开着」时先按关闭规则收纸笺再切，避免纸笺被新角色的宿主接走。
- 证据（复用 §17 同一支探针）：底栏先切乙再切回甲后点额度摘要行，`.config-sheet` **1**、`.config-scrim` **1**、`.config-book-scrim` **1**、`role=dialog[aria-modal]` **1**（复核时为 2／2／2／2）。

### 18.2 R11-2 · 「放弃修改／取消」不回滚草稿

- 改法：[sheet-context.tsx](../../../apps/desktop/renderer/src/components/config/sheet/sheet-context.tsx) 暴露 `discardToken`：`closeNow` 在**退出动画结束**后递增（减少动效时为 0，立即递增），并用关闭序号作废旧广播，避免「淡出中的纸笺先回滚」与「关掉后立刻重开被误清」两种竞态。
- 各宿主按最新已保存值重同步自己的草稿：模型（`bindings` 的 chat／memory）、扩展（mcp／skill 开关）、额度（`budget`）；`WorkspaceSheets` 清空新建角色的名字／设定／错误；`RoleEditor` 同时清掉上次保存失败留下的 `bindingError`／`budgetError`。只重置「该纸笺对应的草稿」，不碰设定分区等其它未保存内容。
- 证据：模型名改成「已放弃的文字」→ × →「放弃修改」后，摘要行回到 `DeepSeek · deepseek-chat`、页签脏点清零、重开输入框为 `deepseek-chat`；期间（确认条出现时）脏点与行文仍为改动值。

### 18.3 R11-3 · 工作区级纸笺缺双层压暗与右页承载

- 改法：把 `WorkspaceSheets`（T37 切换角色、＋新建角色）从工作区层移入 `.config-leaf`（footer 之后、正文之外）——`closest('.config-leaf')`／`closest('.config-book')` 均可取到，直接复用既有双层压暗、图片框挖空、点外部关闭与 `aria-modal`。新建角色的成功回调抽成 `createFromSheet`。
- 证据：T37 纸笺 `scrims=1`、`books=1`、`inLeaf=true`、`parent=config-leaf`、`bodyInert=true`；「＋新建角色…」同样 `scrims=1`、`books=1`、`inLeaf=true`。

### 18.4 R11-4 · 保存被拒的原因不在纸笺内

- 改法：`ModelSheetHost`／`ExtSheetHosts` 增加 `error` 属性，绑定错误以 `.config-sheet-error` + `role="alert"` 渲染在组内（与 `notice` 并列）。正文的同名提示保留，但纸笺打开时正文 `inert`，读屏只读到纸笺内这一条。
- 证据：所选服务有值、模型 ID 为空时点保存，`[role=alert]` 中出现 `inSheet:true`、`cls=config-sheet-error` 的「已选择的模型服务需要填写模型 ID。」。

### 18.5 §17.6 观察项

1. **记忆行值区死区**：值气泡去掉 `disabled`，点击打开「记忆整理」紧凑纸笺（对话仍打开紧凑「服务」）。实测 `disabled=false`、标题「记忆整理」、只含「服务」组。
2. **协议展示与 demo 出入**：摘要第二行补键名——对话「协议 · 值」、记忆跟随「运行时 · 继承 …」，记忆自带服务时按 demo 不再重复显示协议；新增 `.config-sum-keys i` 弱化键名样式（24 个 CSS 仍零违规）。
3. **继续编辑后的焦点**：「继续编辑」后回到第一个字段（`[data-sheet-focus]`，没有则取第一个非关闭按钮的可聚焦控件）。实测 `activeElement` 为 `SELECT.ui-select`，改动值保留。
4. **保存后纸笺不收回**：仍属 P5（与 §15.4 一致），本轮未动。

### 18.6 门禁与 E2E 现状

- 渲染器 `npm run check`（24 CSS 零违规、`tsc` 通过）与 `vite build` 通过；桌面单测 **160／160**。
- 后端 `accept-offline.mjs` **21／21 步**、正式测试 **444／444**、`sourceUnchanged=true`、`realServiceCalls=0`（`apps/backend/test-results/p5-2026-11-19T12-07-28-815Z-ef9e3527/summary.json`）；`check-docs` 0 错误 0 警告。
- 复核探针（§17 同一批，证据目录 `apps/backend/test-results/400-v6-fix-r11-20261119/`）：`probe-clean`、`probe-final`、`probe-save blocked`、新增 `probe-observe` 全部输出上述结论。
- Electron E2E：`theme-transition-check`、`pack3-entry-check`、`relations-desktop-check` 通过；**其余 7 条仍红**。原因是 `3a4ac9a` 把底栏角色切换改成原生 `<select>`、模型段改成「摘要行 + 纸笺」、外观段改成 `.config-outfit-card`，旧脚本选择器未随之迁移（§17.7 已注明「旧 E2E 选择器移植」不在该轮范围）。本轮已把 `.config-switch-role` 统一迁移为 `pickRole()`（原生 select + 原型 setter 绕过 React 的 value tracker）、补上 `__new` 经纸笺创建新角色的流程、把 T37 的脏确认从旧 `.config-dirty-prompt` 改到纸笺按钮，但模型段（`保存模型选择`／`在设置中查看模型`）与外观段（`.nd-outfit-card`）的断言仍待 P5 一并移植；`settings-workspace` 另有 `.config-dirty-ribbon` 等早已失效的选择器。迁移日志见同目录 `e2e/*.log`。
- `dialogue-layout-check` 本轮亦为红，失败点是舞台／对话面板的布局断言，与本轮改动无关（本轮未触及对话页）。

**性质说明**：本轮为实施者自验，R11 是否收口以独立复核实跑为准；E2E 选择器迁移与「保存后收回纸笺」仍待 P5。

---

## 19. R11-1～R11-4 与观察项补修独立复核（2026-11-19，工作树未提交，基线 3a4ac9a＋补修：**4 项缺陷全部收口；3 项遗留**）

在 §18 的工作树上独立复核（真实 Electron＋假后端，探针与 §17 同一批，另加切角色/组合路径两支），不采信 §18 自验。**R11-1～R11-4 与 §17.6 前三项观察项实测收口；另发现 3 项遗留。**

### 19.1 通过项

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 门禁 | 实跑 `npm run check` + `build`、桌面单测 | 24 CSS 零违规、`tsc` 通过、构建成功、**160／160** |
| R11-1 重复渲染 | 已访问两角色后打开额度纸笺 | `.config-sheet` **1**、`.config-scrim` **1**、`.config-book-scrim` **1**、`aria-modal` **1**（复核前为 2／2／2／2）；位置单份 642,190 |
| R11-1 切角色 | 纸笺开着切角色（无改动） | 先收纸笺再切：`sheets=0`、`scrims=0`、角色变乙；在新角色重开额度读到**乙的 90 点**（非甲的 200），无旧宿主接管 |
| R11-2 放弃回滚 | 模型名改「已放弃的文字」→ × → 放弃修改 | 摘要行回到 `DeepSeek · deepseek-chat`、页签脏点清零、标题 aria 去掉「有未保存的改动」、重开输入框为 `deepseek-chat`；确认条出现期间仍显示改动值（未提前回滚） |
| R11-2 切角色不误报 | 放弃后再切角色 | 直接切换，不再弹 T37 |
| R11-3 工作区纸笺 | T37／新建角色 | `scrims=1`、`books=1`、`inLeaf=true`、`parent=config-leaf`、`bodyInert=true`，rect 642,74（复核前在 `.config-workspace`、无压暗） |
| R11-4 保存被拒提示 | 缺模型 ID 时点保存 | `[role=alert]` 出现 `inSheet:true`、`cls=config-sheet-error` 的「已选择的模型服务需要填写模型 ID。」 |
| 观察 1 · 记忆行死区 | 真机点值气泡 | `disabled=false`，点击直接开「记忆整理」紧凑纸笺 |
| 观察 2 · 协议键名 | 读摘要第二行 | 对话「协议 openai」、记忆跟随「运行时 继承 deepseek-chat」；记忆自带服务时不显示协议（demo 对齐） |
| 观察 3 · 继续编辑焦点 | T9 点「继续编辑」 | 焦点落纸笺内 `SELECT.ui-select`（首个非关闭可聚焦控件），改动值保留 |
| 组合路径 | 脏纸笺＋点页签 → T9 放弃 | 切到目标分区、纸笺与压暗清零、脏点清零、重开为已保存值（先回滚后切段，顺序正确） |
| 脏纸笺切角色 | 额度改 37 后切角色 | 走 T37「放弃并切换」，确认后切角色、草稿回滚（重开为 200） |

### 19.2 遗留

1. **R12-1（可访问性）**：经分区页签关闭纸笺后焦点落 `BODY`。v6 demo 的 `closeSheet` 会 `setTimeout` 聚焦目标分区 `h2`，仓库 `changeSection` 的 `apply()` 只切状态与播动画、不接管焦点。建议在 `apply()` 末尾（或 `closeNow` 的 `then` 分支）聚焦 `contentRef` 内当前分区 `h2`。
2. **R12-2（文档表述）**：§18.1 称「各宿主传 `enabled={active}`——…`RoleSheetHost`」，但 `RoleSheetHost.tsx` 本轮未改；它靠 `if (!active) return null` 天然只渲染激活角色，效果等价。表述需修正，避免后续按「已传 enabled」误判。
3. **R12-3（测试债务）**：E2E 脚本本轮净删 3 条 `assert.equal`（`.config-poster-dirty` 两处、`.config-create-form` 不重开一处），新增 0 条。旧「藏书票墙」仍在（设置 → 角色），属覆盖丢失而非断言过时，建议 P5 迁移选择器时补回等价断言。

### 19.3 范围与环境

桌面端＋离线假后端；本轮未改后端，故未重复跑 `accept-offline`（沿用 §18.6 的记录）。旧「藏书票墙」的 `chooseRole` 切角色路径（设置 → 角色）未覆盖：该入口本轮未改，若纸笺开着从此处切角色，仍可能被新角色的宿主接走，属 P5 删除旧墙时一并收口。E2E 仍有 7 条红（选择器未迁移），属 §18.6 已声明的 P5 范围，不作为本轮结论。证据：`apps/backend/test-results/400-v6-verify-20261119-r11fix/`（`probe-*.cjs` + `report-*.json`，本地未入库）。

## 20. R12-1～R12-3 补修（2026-11-19，自验通过，待独立复核）

按 §19.2 三项遗留逐条处理；本轮只改渲染器与新增一条 Electron 检查，不触后端接口与数据。§19.2 的 R12-2 已就地校订在 §18.1。

### 20.1 R12-1 · 页签关纸笺后焦点落 body

- 根因：[sheet-context.tsx](../../../apps/desktop/renderer/src/components/config/sheet/sheet-context.tsx) 的 `closeNow` 在带 `then`（切分区／切角色）时把收尾交给接管方、不再走 `focusAfterClose`，而 [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx) 的 `changeSection` 只在 `apply()` 里切状态与播动效，没人接管焦点；纸笺关闭时原焦点节点被卸载，落到 `body`。
- 改法：`changeSection` 的 `apply(takeFocus)` 只在**由纸笺关闭触发**时传 `true`，双帧后在 `contentRef` 内聚焦当前可见的 `h2`（角色分区 `.config-sec-head`、设置分区 `ConfigHeading`，后者补 `tabIndex={-1}`）。直接点页签（无纸笺）不夺焦点，页签按钮保持键盘焦点。
- 同类补口：切角色也走 `then` 分支（无改动收纸笺后切、T37「放弃并切换」），焦点同样会落 `body`；新增 `applyRoleAndFocus` 把焦点交回底栏 `.config-role-switch`。
- 证据（新增检查 `apps/desktop/tests/settings-sheet-focus-check.cjs`，真实 Electron + 假后端）：脏纸笺 + 点「外观」→ T9 → 放弃修改后 `activeElement` 为 `H2`「衣柜」、`inLeaf=true`、当前分区 `02外观`；无改动点「完成」后为 `H2`「完成度」；纸笺开着切角色后为 `SELECT`（角色选择器）。三例的 `sheets`／`scrims`／`books` 均为 0。

### 20.2 R12-2 · §18.1 表述

- 已就地校订：`RoleSheetHost` 本轮未传 `enabled`，靠 `if (!active) return null` 天然只渲染激活角色；原文把它列入「已传 `enabled`」是表述错误，行为无缺口。

### 20.3 R12-3 · E2E 断言覆盖

- 复核指出的两条 `.config-poster-dirty` 断言属于**旧藏书票墙的「保留草稿／放弃改动」流程**（`.config-dirty-prompt`）。`3a4ac9a` 之后从底栏切换只走 T37「取消／放弃并切换」，确认即回滚草稿，因此「非当前角色仍带未保存草稿」从底栏路径已不可达；旧墙仅剩工作区「新建角色」请求可临时到达（属 P5 删除范围，本轮未改）。原样搬回断言会挂在等待 `.config-dirty-prompt` 上——`settings-workspace-check.cjs` 现正中断在此处，属 §18.6 已声明的 P5 迁移范围。
- 改为按现行交互重述同等覆盖，落在新增的 `settings-sheet-focus-check.cjs`：
  1. 脏草稿时当前分区页签出现 `.tab-dot`，`aria-label` 含「有未保存的改动」（替代旧 `.config-poster-dirty` 的可见脏标记）；
  2. 放弃修改后重开纸笺为已保存值 `deepseek-chat`，脏点与 aria 文案同时清除（替代旧「放弃后标记消失」）；
  3. 多角色实例下纸笺只渲染一份，切回原角色既不继承他人草稿，也不继承脏点（R11-1 回归）。
- 第三条「`.config-create-form` 不重开」在 §18 已改写为等价的 `.config-sheet` 断言（创建成功后纸笺不再存在）——**此说法不成立**（2026-11-19 按 §21.2 R13-1 更正）：该段断言位于 `settings-workspace-check.cjs` 尾部，而脚本在旧 `.config-dirty-prompt` 处即中断，断言从未执行，实际覆盖为零。补齐见 §22.1。

### 20.4 门禁与证据

- 渲染器 `npm run check`（24 CSS 零违规、`tsc` 通过）与 `vite build` 通过；桌面单测 **160／160**；`check-docs` 0 错误 0 警告。
- 新检查实跑通过，结果落在 `test-results/settings-sheet-focus/result.json`（本地未入库）。本轮未改后端，未重复跑 `accept-offline`（沿用 §18.6 记录）。
- 仍未完成（不在本轮）：E2E 选择器迁移与「保存后收回纸笺」（P5）、生图／语音摘要化、V3 播报、P3a。

**性质说明**：本轮为实施者自验，R12 是否收口以独立复核实跑为准。

---

## 21. R12-1～R12-3 补修独立复核（2026-11-19，工作树未提交：**R12-1／R12-2 收口；R12-3 部分收口，余 1 项**）

在 §20 的工作树上独立复核（真实 Electron＋假后端；用自建探针复跑焦点路径，另实跑实施者新增的检查），不采信 §20 自验。**R12-1 五条路径全部收口、R12-2 表述已校订；R12-3 的脏点/aria/回滚等效断言成立，但「创建后不残留」仍无等价断言，且旧 E2E 尾部整段不执行。**

### 21.1 通过项

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 门禁 | 实跑 `check`＋`build`、桌面单测、`check-docs` | 24 CSS 零违规、`tsc` 通过、构建成功、**160／160**、巡检 0 错误 0 警告 |
| R12-1 脏纸笺＋页签 | 自建探针：改模型名→点「额度」→T9「放弃修改」 | 切到 05额度、纸笺/压暗全卸载、**焦点 `H2`**（复核前为 `BODY`） |
| R12-1 无改动纸笺＋页签 | 自建探针：额度纸笺→点「外观」 | 切到 02外观、`sheets/scrims/books=0`、焦点 `H2`「衣柜」、`inLeaf=true` |
| R12-1 纸笺开着切角色 | 自建探针：额度纸笺→底栏选乙 | 收纸笺后切到乙、焦点 `SELECT.config-role-switch` |
| R12-1 T37 确认 | 自建探针：脏额度→切角色→「放弃并切换」 | 切角色、草稿回滚（重开 200）、焦点 `SELECT.config-role-switch` |
| R12-1 直接点页签不夺焦 | 自建探针：真实鼠标点「模型」页签（无纸笺） | 焦点留在页签按钮 `BUTTON 03模型`，未被拉到 h2 |
| R12-2 表述校订 | 读 §18.1 | 已明确 `RoleSheetHost` 未传 `enabled`、靠 `if (!active) return null` 等价，并注明校订来源 |
| R12-3 等效断言 | 实跑新增 `settings-sheet-focus-check.cjs` | 通过：脏点 `.tab-dot`＋`aria-label`「有未保存的改动」、放弃后重开为 `deepseek-chat` 且脏点与 aria 清除、多角色下仅 1 份纸笺 |
| 说明登记 | 读 `docs/specs/role-config-and-activity.md` | 新检查已登记到桌面验证命令与「纸笺与分区交接」条目 |

### 21.2 R13-1 · 测试债务 · 「创建后纸笺不残留」仍无等价断言

§20.3 第 3 条称「`.config-create-form` 不重开已在 §18 改写为等价的 `.config-sheet` 断言」，实际 [settings-workspace-check.cjs](../../../apps/desktop/tests/e2e/settings-workspace.e2e.cjs) 的新建流程（第 723～729 行）只断言「创建后编辑对象切到丙角色」，没有校验纸笺是否关闭；而该脚本当前仍在旧 `.config-dirty-prompt` 处中断（实跑：第 358 行 `until` 超时），**其后的新建／删除角色断言整段不执行**，这段覆盖实际为零。

**建议**：P5 迁移该脚本时，把「创建成功后 `.config-sheet` 数量为 0」补成显式断言（或并入 `settings-sheet-focus-check.cjs`），并让脚本跑到尾部；在此之前不要把「创建后不残留」计入已覆盖。

### 21.3 范围与环境

桌面端＋离线假后端；本轮未改后端，故未重复跑 `accept-offline`（沿用 §18.6）。设置分区（`ConfigHeading`）的焦点落点未单独覆盖：自建探针与新增检查都走在角色分区，二者共用同一 `focusSectionHeading`，风险低但未实测。证据：`apps/backend/test-results/400-v6-verify-20261119-r11fix/`（`probe-clean-tab.cjs`、`probe-tab-drop.cjs`、`probe-switch-sheet.cjs` 及 `report-*.json`）。

## 22. R13-1 与 §21.3 观察项补修（2026-11-19，自验通过，待独立复核）

### 22.1 R13-1 · 「创建后纸笺不残留」补上可执行断言

- 复核结论属实：§18 改写的 `.config-sheet` 断言落在 `settings-workspace-check.cjs` 尾部，脚本在旧 `.config-dirty-prompt` 处中断，断言从未执行。§20.3 的「等价」表述已在原处更正，不再计入已覆盖。
- 现行覆盖（可执行）：[settings-sheet-focus-check.cjs](../../../apps/desktop/tests/e2e/settings-sheet-focus.e2e.cjs) 新增第 6 段——底栏选「＋ 新建角色…」→ 填写名字／设定 → 「创建角色」，随后断言 `.config-sheet` **0**、`.config-scrim`＋`.config-book-scrim` **0**、编辑对象切到「丙角色」、分区落到 `01设定`、焦点回到触发纸笺的底栏选择器，且新角色出现在选择器选项里。
- 另在 [settings-workspace-check.cjs](../../../apps/desktop/tests/e2e/settings-workspace.e2e.cjs) 的新建段补了显式断言（`.config-sheet` 为 0、双层压暗为 0），供 P5 迁移后执行；在该脚本跑到尾部之前，覆盖以新增检查为准。
- 假后端同时补了 `POST /v1/roles`，让「创建 → 列表刷新 → 切换编辑对象」走真实接口形状。

### 22.2 §21.3 · 设置分区（`ConfigHeading`）的焦点落点

- 先确认可达性：纸笺宿主全部挂在角色编辑器内（`ModelSheetHost`／`ExtSheetHosts`／`QuotaSheetHost`／`RoleSheetHost`／`WorkspaceSheets`），设置页没有任何 `<Sheet>`；因此 `changeSection` 的 `takeFocus` 分支在设置页不会触发，`ConfigHeading` 的 `tabIndex` 只是防御性的。
- 但同一类缺口在**跨页跳转**上真实存在：`openSettings()`（「去角色状态」「在设置中查看模型」「完成度 → 查看」以及纸笺内 T25 链接）切到设置页后，原按钮随角色页面卸载，焦点会落回 `body`。
- 改法：把 `focusSectionHeading`／`focusSectionHeadingSoon` 提到 `contentRef` 旁，`changeSection` 的纸笺路径与 `openSettings` 的跨页路径共用同一个落点（设置页因此走 `ConfigHeading`）。
- 证据（同一支检查第 7 段）：角色配置 → 完成度 → 「角色状态 · 查看」后，`dataset.page=settings`、当前分区 `04角色`、`activeElement` 为 `H2`「角色状态」、`inLeaf=true`。

### 22.3 门禁与证据

- 渲染器 `npm run check`（24 CSS 零违规、`tsc` 通过）与 `vite build` 通过；桌面单测 **160／160**；`check-docs` 0 错误 0 警告。
- 新检查连续两次通过（含第 6／7 段），结果落在 `test-results/settings-sheet-focus/result.json`（本地未入库）。本轮未改后端，未重复跑 `accept-offline`（沿用 §18.6）。
- 仍未完成（不在本轮）：`settings-workspace-check.cjs` 尾部整段迁移（旧墙提示 → T37 纸笺、模型段与外观段选择器）与「保存后收回纸笺」（P5）、生图／语音摘要化、V3 播报、P3a。

**性质说明**：本轮为实施者自验，R13-1 是否收口以独立复核实跑为准。

## 23. 主进程独立复核（2026-11-19，§22 通过；v6 展示基线仍有差异）

### 23.1 §22 独立复跑

- 在后续 P2 改动前构建 Electron 渲染器，独立复跑 `settings-sheet-focus-check.cjs`。新建角色成功后，纸笺、右页压暗、书本压暗均为 0；当前编辑对象切到丙角色，打开「设定」，焦点回到底栏 `SELECT`。R13-1 收口。
- 从角色配置的完成度点「角色状态」后，成功进入设置页，焦点落到右页内的 `H2`「角色状态」。同轮检查还通过了有／无草稿关闭纸笺、切角、单纸笺和草稿回滚。证据 `test-results/400-v6-main-review/section22-baseline.json`。

### 23.2 后续 P2 完成前的 demo 对照基线

使用 §11.4 权威目录的 v6 demo 与桌面 Electron 构建，两边均为白昼，在 1440×840、1280×800、720×540 量测。应用用本机 HTTP 替身，未连接真实外部服务。角色页书本及右页盒子在三种尺寸均对齐；以下差异留作后续复验入口。

| 项 | demo | 应用基线 | 收口范围 |
| --- | --- | --- | --- |
| 角色模型分区对话／记忆行高 | 75／75／89px | 88.33／88.33／102.33px | 共用摘要几何，验收 16～18 |
| 角色模型分区状态点左缘 | 1296.67／1136.67／598.67px | 1285.78／1125.67／597.67px | 统一状态点与编辑槽位，两页同坐标，验收 16～17；规范参考绝对坐标按 1296／1136／598px 记录 |
| 角色右页页头 | 44／44／38px | 48／48px，720 下隐藏 | 验收 24 |
| 对话「服务」紧凑纸笺 | 桌面 `y=176、h=284`；720 `y≈259.67、h≈280.33` | 桌面 `y=206、h≈358.4`；720 `y≈185.27、h≈354.73` | 顶边锚点、纸笺内边距和分组字段布局，验收 19～22 |
| 设置目录、干净态页脚 | 左页用独立目录列宽；页脚隐藏 | 仍用角色立绘列宽；页脚为 52／52／42px | P3b，验收 4、24 |
| M9／M14（代码比对） | 正文先淡出 90ms，新正文从下方 4px 淡入 220ms；编辑按钮淡入并横移 4px | 正文仅从右侧 8px 入场；编辑按钮只淡入 | P4 动效逐项对照，验收 34 |

截图和矩形数据见 `test-results/400-v6-main-review/baseline/`。本节展示基线复核未覆盖晚风、动效过程逐帧、读屏实机或后续已修改的代码。

### 23.3 生图／语音与旧入口迁移切片独立复核

- 角色模型分区已有对话、记忆整理、生图、语音四行。实跑媒体 E2E 覆盖生图分组、T9 放弃回滚、语音两服务会话草稿往返、语音连接结果播报及纸笺关闭后丢弃迟到探测。既有纸笺焦点脚本也通过。冷启动选角页「创建角色」独立实跑进入共用纸笺，提交后选中新角色，纸笺与压暗清零。
- 在权威 demo 与 Electron 晚风主题下，同一引擎得到四行圆点同列且跨三视口一致：1296.67／1136.67／598.67px；页头 44／44／38px，行高 75／75／89px；完整生图纸笺外框三种尺寸对齐。独立探针确认媒体紧凑／完整纸笺首控件焦点、模态与 inert、Shift+Tab 循环、Esc 关闭后焦点回触发按钮。
- 桌面立绘挖空补修复验通过。晚风 1440×840 的画框内部抽测区域共 198,600 像素，打开语音表现纸笺前后改动为 **0**。系统减少动效的三种尺寸探针中，纸笺和压暗进出均未创建 Web Animation。正常模式已捕获纸笺进入 360ms、退出 260ms 与压暗进入 220ms、退出 260ms。
- 本切片独立运行渲染器检查、桌面单测 160／160、媒体 E2E、焦点 E2E。证据在 `test-results/400-v6-main-review/p2-candidate/`（几何、时长、键盘探针、晚风截图）、`p2-external-create/`、`p2-reduced-first/`。测试均为 Electron 与本机 HTTP 替身。
- 补跑白昼三尺寸和 1440 强制色探针。四行实心／空心状态点在强制色下与 demo 计算值一致。旧 E2E 复跑三条仍失败：`settings-workspace-check` 等旧脏条，`startup-flow-fixes-check` 等旧服饰卡，`settings-review-fixes-check` 未进入预期编辑角色。对应日志保留在同一证据目录，待 P5 迁移后复跑。
- **整页展示未验收。** 语音表现纸笺仍有尺寸差（桌面 `y=411、h=270` 对 demo `y=401、h=262`；720 高 `325.33` 对 `316.33`），对话纸笺字段布局和底栏仍需对齐。设置页迁移、V3 服务操作播报、P4 动效逐条与逐帧像素核对、P5 保存反馈和 E2E 迁移、P6 实测仍待推进。另按规范 §7.9 复核切角顺序：当前纸笺的 T9 先于仅针对设定草稿的 T37；后续需同步修订原以脏额度触发 T37 为预期的测试，并验证页面与窗口的离开确认。

### 23.4 昼夜 veil 复跑抽测

角色模型分区 1440×840 白昼切晚风。demo 与 Electron 的副本动画均为 `400ms`、`cubic-bezier(0.4, 0, 0.2, 1)`；从点击到切换标记移除分别约 `564ms`、`579ms`，均在 650ms 门禁内。立绘框内 198,600 个像素在切换中帧和结束帧与起始帧均相同。系统减少动效下两者直接换色、无副本，均播报「已切换到夜间」。证据见 `test-results/400-v6-main-review/p4-theme-motion/`、`p4-theme-reduced/`。打开纸笺、设置页和完整 M1–M36 仍留 P4 逐项复验。

## 24. P3a 后端依赖维护（2026-11-20，独立复核通过）

- 语音／生图服务 PATCH 移出全停守卫。改连接、改凭据或全局停用时，只暂停目标服务的活动依赖角色，等待已领取的合成、试听或生图调用并复验依赖；改名称、默认项、等价地址或重新启用可直接提交。成功和失败均保留本次实际暂停名单，已停止角色和无关角色不进入恢复名单。
- DELETE 检测非 `stopped` 依赖和在途调用，返回 `MEDIA_SERVICE_IN_USE` 及角色信息。维护期阻止并发改写、相关改绑和恢复。已接收的手动过场图请求可按原幂等键复用；生成器忽略中止时，任务先按原超时语义结算，维护继续等待真实调用结束，且等待有界。
- 主进程以 HTTP 独立探针验证两类服务的无关角色持续活动、默认项与等价输入不暂停、活动依赖删除冲突、已停止依赖的在途调用阻止提交、并发维护／恢复被拒以及密钥预校验。正式门禁 **21／21，后端测试 450／450，0 跳过，`realServiceCalls=0`，`sourceUnchanged=true`**。报告位于 `apps/backend/test-results/p5-2026-11-20T01-12-19-991Z-3c3eb508/summary.json`。
- 首轮正式验收复现了跨站凭据旧用例的维护等待超时。补修保留旧任务请求旧站且仅用旧密钥、维护后新任务只向新站发送新密钥的断言，并覆盖维护中的重复提交和生成超时场景。现行契约见 [角色配置与活动守卫规范 §3.2.1](../../specs/role-config-and-activity.md#321-语音生图服务维护窗口)。
- **桌面设置页采用 P3a 新契约的工作在 P3b**。对照基线已保存于 `test-results/400-v6-main-review/p3b-before/`。1440px 时应用目录列宽 400.2px，demo 为 276px；应用五类服务详情仍为旧长表单，页头、页脚和角色卡仍待迁移。

## 25. P3b 全局设置页迁移（2026-11-20，阶段对照）

### 25.1 外壳和角色状态首轮独立对照

- 1440×840 复核中，目录列宽从 400.2px 调整为 276px，与 demo 一致。页头 44px、只保留返回角色配置、干净态页脚折起。
- 晚风主题用 Electron 和本机 HTTP 替身操作同一位有立绘的角色。`stopping` 时画框图片 `filter:none`，后端确认 `stopped` 后 `grayscale(1)`，恢复时按 220ms `ease-out` 去灰，回到 `active` 后 `filter:none`。无图卡显示「还没有立绘」。画框 192×288 与 demo 一致。
- 本轮首个角色卡宽相同（212px），应用 y=198、高约 424px，demo y=188、高约 410px，需继续对齐。五类服务摘要与纸笺、设置页写入反馈及三视口验收待后续切片。证据 `test-results/400-v6-main-review/p3b-shell-night/`。

### 25.2 设置写入、整页展示及连续切换复核

- 在 `index-DQZbUYCV.js` 构建中，主进程通过真实 Electron 操作语音管理开关。停用只发一次 PATCH，写入中禁用开关，仅恢复本次实际暂停的角色。右页页脚出现「继续活动」，模拟写入失败后开关回滚且提示「已恢复原状」，再次启用时无角色被暂停。五类服务均可从目录打开新建纸笺。证据 `test-results/400-v6-main-review/sol-start-settings/`。
- 两边三尺寸的正常模型连接行圆点 x 均为 1296.67／1136.67／598.67px。桌面应用首行 y=215.82px，demo 为 186px；模型连接紧凑纸笺在 1440 下为 y=206、高 257px，demo 为 y=176、高 330px。截图显示应用将协议与地址并排、测试按钮铺满行，目录额外显示了「已启用」，管理开关外形和纸笺页脚操作也需对齐。
- 角色卡在两个桌面尺寸的顶边已对齐，高度还多 6px；720 下顶边多 22px、高度多 14px。晚风下实测停止卡姓名和状态文字的对比度为 4.66:1，状态点轮廓为 3.57:1，名字切换前后为 2.12:1；无图提示两轴居中偏移均为 0。白昼旧轮廓为 2.82:1，G9 要求至少 3:1。
- 长名称角色夹具暴露截断问题。1440、1280、720 下六个分区的书本内容分别超宽 100–124、213–237、552–576px；demo 均为 0。页头长名挤宽右页，底栏名字换行覆盖状态。独立截图和测量在 `whole-role-sol-start/`、`whole-settings-sol-start/`。
- P4 连点基线在 `p4-rapid-theme-baseline/`。首次请求晚风、动画期间改选白昼时，demo 立即更新选中按钮，待第一个 veil 结束才应用排队的白昼并播报；应用在约 210ms 的反选采样已切回白昼并播报。§23.4 的单次切换通过，连续反选仍待修复。

### 25.3 中期构建复验

- `index-i7Bj1FFC.js` 中，五类服务在 1440、1280、720 均可通过分组、页头和「＋ 添加」分别进入紧凑、完整、新建纸笺，共检查 45 个入口。语音管理失败回滚和按名单恢复复跑通过。与 demo 对照，各服务桌面首行仍低 10px，720 低 16.33px；五类首组紧凑纸笺差 6–14.67px，未判整页通过。证据 `test-results/400-v6-main-review/sol-mid-settings/`。
- 连续昼夜切换复跑通过。点击晚风后两个界面均未立即播报，中途改点白昼时两边均保持晚风配色、按钮立即选白昼，待前一段完成后才处理白昼，最终播报「已切换到日间」。证据 `sol-mid-rapid/report.json`。
- 在活动角色的额度纸笺内输入 0、1.5、空、1000001，四次均标为无效且禁止保存。改为 241 后，按钮显示「暂停并保存 1」，后端确认停止后写入，页脚按角色显示 T30。退出动画为 260ms；独立动画记录确认纸笺已卸载后才播放旧值淡出 360ms、新值淡入 360ms（延迟 90ms）及扫光 600ms。证据 `sol-mid-rapid/quota-write.json`。

## 26. 主进程复核与系统适配（2026-11-20）

复核使用权威 demo 与项目的 Electron 渲染器，同一 Windows 环境，1440×840、1280×800、720×540 各测白昼及晚风。真实下游服务由回环地址夹具提供，涉及持久化和依赖维护的流程另跑项目自己的后端。下列桌面证据目录均相对于 `test-results/400-v6-main-review/`。

### 26.1 展示、动效和异常写入复验

- 工作区包含角色设定、外观、模型、扩展、额度与完成度。设置页包括模型、语音、生图、MCP、Skill 的服务目录、紧凑、完整和新建纸笺，以及角色状态和本机分区。两页复用关闭确认、焦点交接、暂停写入和恢复名单。预置角色不可删除、新建角色须满足系统校验，服务凭据沿用后端只写契约。
- B4 构建的六组合对照留在 `b4-geometry-summary.json`。主进程复现对话紧凑纸笺矮 10px、720 语音表现纸笺矮 6px、三类连接纸笺与角色卡高 6px。另以截图定位压暗层过深。随后按字段行高、结果区间距和实际生效的按钮规则修正，书本及右页遮罩基于现有 backdrop 令牌分别按主题调节强度。
- 单次与连续反向切换均取样。主题副本淡出 400ms，两次请求按序结算。书脊分区和页面切换先出 90ms、再从下方 4px 进入 220ms，摘要行鼠标进入 120ms、离开 90ms，值及状态点位置保持。系统减少动效下实测分区、页面、服务分类、纸笺与遮罩均无残余动画。见 `cym-motion/`、`cym-motion-reduced/`、`sol-mid-rapid/`。
- 带透明区域的状态卡立绘在白昼／晚风切换时曾出现网格底色变化。修正后，活动、已停止两种状态的画框内部各取 51,520 个像素，demo 与实现的中间帧、结束帧相对起始帧的变色像素均为 0。角色停止等后端确认后才置灰，恢复按 220ms 去灰。无图卡两轴偏移 0。白昼停止文字／圆点轮廓对比度为 5.18:1／3.13:1，晚风 4.66:1／3.57:1。见 `b4-card-theme/pixel-counts.json` 及 `settings-v6-behavior-check.cjs` 的六组合报告。
- 五类服务分别注入读取中、请求失败与空目录，验明骨架、带重试按钮的错误和带添加入口的空态。保存额度时连续注入一次暂停失败和一次写入失败，两次均保留原输入 387。第一次角色继续活动，第二次角色保持停止并可从页脚恢复，再次重试正常收回纸笺并显示 387。见 `ch-catalog-loading/`、`ch-catalog-loaderror/`、`ch-catalog-empty/`、`b3-quota-failures/failures.json`。

### 26.2 业务边界和后端门禁

- 角色原有语音或生图服务被全局停用时，可在保留原绑定的前提下保存其他参数。后端继续阻止新增停用绑定、使用停用服务或跨角色复用该授权。语音按服务切换保留会话草稿，重新启动恢复后端已保存的当前服务。占用及恢复以实际角色、任务和响应中的暂停名单为准。
- 模型、MCP 与 Skill 删除保留原系统引用守卫。设置页展示后端不可删除的原因。生图密钥支持在输入期间显隐，读取设置时服务只返回凭据状态。角色／服饰等资源的系统保护规则与真实依赖一并保留。
- 在当前后端代码上，主进程用 Node 24 运行正式离线门禁，21／21 步和 452／452 项测试通过，0 跳过。报告标记 `realServiceCalls=0`、`sourceUnchanged=true`。文件为 `apps/backend/test-results/p5-2026-11-20T05-29-34-888Z-e7baab61/summary.json`。

### 26.3 六组合几何、切换时序和真读屏

- 主进程在 `index-BsrpxMNP.js` 上逐一打开五类设置服务的首组／完整／新建纸笺，以及角色对话／生图／语音纸笺。共 90 次设置纸笺、18 次角色纸笺。对比书本、目录、页头、摘要行、圆点横坐标、纸笺外框及角色卡与画框，六组合中这些测点超出 2px 的项目为 0。角色页三尺寸对话纸笺高 284／284／280.33px，语音表现高 262／262／316.33px。桌面昼间在同一纸面区域取样，遮罩开启后 demo 和实现的 RGB 通道均值之差小于 1，晚风小于 2。证据 `bsr-geometry-summary.json`、`bsr-settings-{day,night}/`、`bsr-role-{day,night}/`。
- 用超长角色名跑遍六个角色分区，三种尺寸下书本横向溢出均为 0，底栏原生选角器仍可见。720×540 时选择器位于 x=508、宽 200px。对服务长名称／长地址另检六组合单行省略、完整 title 和强制色下停止卡虚线、实心与空心点。语音／生图只有读取目录、探测服务得到结果后才显示真实候选个数，摘要行的第二行按数据出现。
- 以图片专项 §6.3、G2／G4 及 demo 为准。角色进入 `resuming` 即逐渐恢复色彩，“活动中”在后端确认后显示。第三章状态表对恢复去灰时点的措辞与图片专项有出入。角色配置页立绘始终保留原色。
- B4 负载复核发现双计时器可让保存扫光先于纸笺 DOM 卸载，或让刚关闭后的下一次点击失效。共用纸笺现等待 M2／M6 的三个实际动画结束，一次卸载纸笺和两层压暗、解除 inert，随后触发保存反馈和导航。正式回归在卸载的同一提交中点击另一张纸笺，并断言拿到初始焦点、旧回调不会夺焦。减少动效下直接交接。
- 真实业务链揭示，添加首个全局语音／生图服务会把未编辑的角色标成有草稿，从而在 T37 放弃设定后多弹离开确认。目录填入系统默认值时现同步比较基线，用户手填和在途编辑的草稿继续保留；长链断言导航时无额外确认。
- 用 Windows 便携 NVDA 2026.3.1 操作隔离的 Electron 窗口，仅采集测试窗口的语音队列。首次发现模型连接结果重复播报，补修后的记录包含各一次「已切换到夜间」「已切换到日间」「连接正常」「已恢复活动」、删除备用语音服务及「已保存自主额度」。这是读屏器实际收到的语音事件。系统 Skill 选择目录在真实 Windows 对话框取消后返回同一张添加纸笺、原路径保持、没有写入。见 `nvda-b3/screen-reader.json` 和 `test-results/settings-sol/native-picker-result.json`。
- 最终补测 M16／M18／M25／M26 时，发现额度输入框沿用旧琥珀光晕，纸笺「取消」按下有位移但缺少色彩过渡。修复后，浏览器实测聚焦边框为白昼焦点色、外圈光晕 4px、键盘轮廓 2px，过渡 160ms。改动徽标从 0 到 40px、透明度从 0 到 1，时长 220ms。未选书脊悬停从 8 到 3px，选中后为 0px；「取消」按下时下移 1px，背景和边框过渡 120ms。见 `b5-field/field-motion.json`。

### 26.4 最终门禁与覆盖范围

最终集成为 `index-DvGX0CR3.js`／`index-BGZZSwut.css`。主进程独立执行渲染器令牌、样式和类型检查，25 个 CSS 文件零违规；生产构建包含 149 个模块。Node 24 桌面单测 160／160，0 跳过。14 条 Electron 脚本在同一构建上串行执行，14／14 退出 0；运行前后的构建指纹及脚本入口哈希均保持一致。逐项结果在 `release-14/gates.json`。

交付构建按 1440、1280、720px 三种宽度分别复测昼夜主题。90 次设置纸笺和 18 次角色纸笺对照中，实测区域的坐标与尺寸偏差均在 2px 以内。测点明细见 `release-geometry-summary.json`，实际页面与 demo 的并排截图见 `release-demo-comparison.png`。

交付前再次核对输入框常态和键盘焦点。白昼常态实测边框 RGB(144,121,133)、底色 RGB(255,252,247)、圆角 12px。聚焦时边框 RGB(57,65,88)、4px 光晕以及内移 1px 的 2px 实线轮廓均与配置书令牌和规范一致。证据 `release-field/field-motion.json`。

本机由项目原有的 Electron 解析器选中 `repo-root-fallback` 可执行文件。渲染器来自本次桌面构建，后端测试由 Node 24 及 `apps/backend/` 自身依赖执行。可在真实后端长链结果中核对启动来源。

| 验收范围 | 运行证据与判定 |
| --- | --- |
| 页面展示、两种主题与三种尺寸 | 设置页五类服务各从摘要分组、页头和添加入口打开。角色页分别覆盖服务组、完整表单和表现组。比对外框与关键区域坐标，字段另测桌面与窄屏，包含模型输入宽度、T14 单行省略、无图居中及长文本。 |
| 动效 M1–M36 与角色状态 G1–G9 | 依据实际输入事件、动画关键帧、浏览器计算样式及截图区域像素共同判定。重点复现纸笺收回后的扫光、快速反选昼夜、新立绘延迟解码、停止及恢复、按下与聚焦。相同属性在共用组件上的重复分支以源码核对，未给每种角色／服务数据组合逐帧截图。 |
| 条件文案、键盘及辅助技术 | 验证脏态、无效字段、暂停或保存失败、删除保护、失效绑定、加载及重试。实测 T9／T37 顺序、真实改动计数、禁用原因、焦点交接和减少动效。T18 按规范删除。交付构建在前台运行时，NVDA 对昼夜切换、连接成功、恢复活动、删除服务和保存额度的六条提示各播报一次，见 `release-reader-foreground/screen-reader.json`。首轮窗口失焦时未捕获日间提示，原始记录见 `release-reader/screen-reader.json`。 |
| 真实本机后端与服务替身 | 从配置到模型改站、密钥维护、服务占用、语音引用音频原子保存、对话点播与过场图均在业务长链内执行。外部模型、TTS 与 ComfyUI 使用本机替身。真实供应商联调与 Windows 安装包交付仍按项目 STATUS 的独立事项跟踪。 |

曾在多个 Electron 测试窗口同时执行时观察到前台轮询和动画等待超时，历史并发日志保留在 `final-14/`。最终门禁使用单窗口顺序运行；对卸载时马上打开下一张纸笺的竞态另做并发压力复验。各探针的 DOM、像素、读屏队列和后端请求各自留档，便于按失败现象重新核验。
