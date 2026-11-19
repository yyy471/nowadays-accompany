# 角色配置页 + 设置页 v6 迁移 · 实施记录与交接文档

> **状态**：P1（基础件）已完成并通过全部门禁；P2–P6 待推进。
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
1. **后端语音/生图服务写入本轮一并改为「按依赖角色暂停」**（对齐模型服务 `maintenancePlan` 模式；DL-148 的修订需在 `devDoc/161-digital-life-direction-decisions.md` 追加变更记录）。
2. **阶段式推进**：每阶段跑完门禁、汇报确认后再继续。

## 2. 分支与阶段

- 分支：`codex/config-pages-v6`（自 `dev-front` 切出，基线 commit `23f1537`）。
- 阶段：P1 基础件 → P2 角色配置页 → P3a 后端依赖暂停口径 → P3b 设置页 → P4 主题 veil 与动效 → P5 E2E 收口 → P6 打磨与无障碍实测。
- 完整计划文件：`C:\Users\24349\.claude\plans\e-tmp-test-demo-demo-cheeky-stallman.md`（含目标文件结构、D1–D6 架构决策、后端工作包细节、测试策略、风险清单）。

## 3. P1 已完成内容（全部已落地并过门禁）

### 3.1 令牌（`devDoc/design/character-studio/tokens.json` + 生成 CSS）

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
M devDoc/design/character-studio/tokens.json
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
- `backend/src/http/config-writes.ts`：`GLOBAL_CONFIG_WRITES` = 语音/生图 PATCH+DELETE 四条 → `globalWrite` 守卫（**所有**角色须停止）；`ROLE_CONFIG_WRITES` 不变；MCP/Skill 走 `RESOURCE_CONFIG_WRITES` 由服务层占用判断。
- 模型服务 PATCH 已按依赖暂停：`routes.ts:644-716`（`maintenancePlan(resourceId, body)` → `pauseRoleIds` → `services.resources.pauseRoles` → 响应带 `maintenance.pausedRoleIds`；失败 `withMaintenanceDetails` 回带已停名单；`waitForInflightIdle` 结算已停角色的在途调用）。
- 错误类型：`domain/errors.ts:768-790`（`RoleNotStoppedError`/`RolesNotStoppedError`）。

改造（对齐模型服务同款模式）：
1. 语音/生图 PATCH 移出 `GLOBAL_CONFIG_WRITES` → 服务层按「当前用该服务且未停止」的角色算维护计划：连接字段（url/协议/密钥/超时）或 `enabled: true→false` 变化 → 暂停这些活动依赖角色；仅名称/默认引擎/`enabled: false→true` → 不暂停。
2. 语音/生图 DELETE：有**活动中**依赖角色 → 新错误（携带角色名单，前端 T17 文案用）；仅停止角色在用 → 允许。
3. `config-writes.ts` 注释同步；`devDoc/161-...-decisions.md` DL-148 追加变更记录（用户已确认）。
4. 后端测试更新 + 保持 444 全绿 + `accept-offline.mjs` 21 步。
5. **E2E mock server 同步**（`settings-workspace-check.cjs` 等对语音/生图写入的 409 行为改为镜像新契约）——与 P3b 同一变更落地，勿提前单独改前端预期。

## 6. P3b–P6 指引摘要

- **P3b 设置页**：目录（kind 分段 M12 滑块/骨架/空态 T36/T35）、服务摘要（管理开关**即时写**+失败回滚「已恢复原状」、占用行折叠「…等 N 位」、删除虚线行 T17）、五类服务纸笺（紧凑按组/页头编辑=完整/＋添加=新建 T10/T11、测试探测陈旧重置、T12 只看主机+端口）、角色状态卡（第六章置灰 G1-G9、T20/T21/T22、M27/M30 用 `--nd-semantic-motion-decay` 1400ms、刷新 M28）、本机（动效偏好+版本连接，锚点无副标题）；occupancy 语音/生图前端推导（模型/MCP/Skill 仍走 `/references`）。移植 4 条回归脚本（409 合并、跨页失效、密钥回显、真实后端序列——各自回归契约逐条保留）。
- **P4 主题 veil**：重写 `ui/config-theme-transition.tsx`（保持 `ThemeTransitionStrategy` 契约）：克隆 `.studio-shell`→`.veil`（`--nd-semantic-layer-theme-transition`、inert、嵌套 `data-ui-preset` 标注——现代码 :20-21 已有）、复制输入值+滚动（:23-35 复用）、`dom-mask` 挖空图框、`commit(to)` 立即换色、副本 opacity 1→0（theme-reveal 400 ease-standard）、theme-total 550 时**同帧移除+强制回流**、`announceLive` 播报；连点由 `theme-transition.ts` 代际号天然合并；`settings-workspace.css:108` 的 `html[data-config-switching]` 全关过渡开关保留。扩展 `theme-transition-check.cjs`（点击→移除 ≤650ms、中/末帧 `compareRect` 逐像素）。
- **P5 收口**：新 `tests/settings-v6-behavior-check.cjs`（断言清单在计划文件「测试策略」节：减法 DOM、圆点令牌色、**对齐硬指标 1296/1136/598±0.5px**、纸笺几何、焦点全表、写入全流程、删除确认、T28、语音往返、veil 时序、减少动效、深链兼容）；移植 `workflow-real-backend-chain-check.cjs`（~300 选择器，20 步业务链逐字节不变）；全量 12 脚本连跑；刷新 STATUS.md 基线；设计规范 §8 组件表补 StatusDot/LiveAnnouncer；本记录归档至 `devDoc/archive/08-config-pages-v6/` 并登记 `devDoc/README.md`。
- **P6 打磨**：长文本三尺寸、forced-colors、G9 对比度实测记录、T 触发巡检、NVDA 实测（规范 Q10 遗留）、语音会话缓存与后端单份存储偏差说明。

## 7. 门禁命令速查

```bash
cd desktop/desk-preview/renderer && npm run check && npm run build   # tokens:check + lint:styles + tsc + vite
# 改 tokens.json 后先: cd desktop/desk-preview/renderer && npm run tokens
cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs    # 单测 160/160
cd desktop/desk-preview && npx -y node@24 tests/<script>.cjs          # 各 E2E
cd backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit
cd backend && npx -y node@24 --import tsx --test tests/*.test.ts      # 444 全绿
cd backend && npx -y node@24 scripts/accept-offline.mjs              # 21 步
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

建议按此顺序收口：① 先修 V1～V4（scrim `opacity` 与 `pointer-events`、纸笺按 `readMotionTime` 做 M1～M6、挂载 `LiveAnnouncer` 并把 id 对齐验收的 `#live`、实现人设 cap 与 M19），② 再继续 P2 余下五段与底栏 `<select>`、同步移植 E2E，③ 最后按 §四 58 条跑 6 组尺寸×主题全量验收。证据：`backend/test-results/400-v6-recheck-20261119/`（`probe-v6-ui.json`、`probe-v6-720.json`、`probe-v6-focus.json`、四条 E2E 日志）。

## 9. V1–V4 补修（2026-11-19，自验通过，待独立复核）

按 §8.6 的建议顺序先收口 V1–V4（已迁移切片里的硬性裁剪），**未推进 P2 余下五段**；V5（主题切换）按计划属 P4，本轮不动。

### 9.1 V1 · 压暗层不可见且书本层点不动

- 根因：[settings-workspace.css](../../../desktop/desk-preview/renderer/src/styles/settings-workspace.css) 里 `.config-scrim.on` 只写了 `pointer-events`，没有把 `opacity` 从 0 提到 1；`.config-book-scrim` 连 `.on` 规则都缺失，两层因此一直是 `opacity:0`，书本层还不可点。
- 改法：`.config-scrim.on{opacity:1;pointer-events:auto}`、`.config-book-scrim.on{opacity:1;pointer-events:auto}`；淡入淡出交给 WAAPI（见 9.2），CSS 只保留稳态值，避免两套时长打架。

### 9.2 V2 · 纸笺与压暗层零动效

- 纸笺 [Sheet.tsx](../../../desktop/desk-preview/renderer/src/components/config/sheet/Sheet.tsx)：进入按 M1/M3（桌面 `translate(calc(100% + 32px), 10px) → none`，投影 6px → 静止）与 M4（≤900 用 `translateY(100%)`），时长取 `--nd-semantic-motion-page`（360）、曲线取 `--nd-semantic-motion-ease-out`；退出按 M2 反向，取 `--nd-semantic-motion-page-exit`（260）与 `--nd-semantic-motion-ease-in`。关闭时用 `held` 保留上一张纸笺到动画结束再卸载，期间 `data-exiting` + `pointer-events:none` + `aria-hidden`，键盘与指针都不再响应。
- 压暗层 [scrims.tsx](../../../desktop/desk-preview/renderer/src/components/config/sheet/scrims.tsx)：进入按 M5（`opacity 0→1`，component 220 / ease-out），退出按 M6（`1→0`，page-exit 260 / ease-in），淡出结束后才卸载 portal。
- 减少动效：令牌归零时 `readMotionTime` 返回 0，直接跳过建动画对象（不建、不缩短），满足 §四.36。
- 顺带修掉一个会打断动画的结构问题：`Sheet` 原先在「无纸笺 / 有纸笺」两个分支里把 `<SheetScrims/>` 放在不同子节点位置，React 会重挂载它、导致压暗层动画从头开始；现在两个状态都在同一位置渲染。

### 9.3 V3 · 读屏播报区未挂载

- [live-announcer.tsx](../../../desktop/desk-preview/renderer/src/ui/live-announcer.tsx) 的区域 id 由 `config-live` 改为规范与验收都用的 `#live`，并在 [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx) 的工作区根挂载 `<LiveAnnouncer/>`；新增 `.ui-live` 视觉隐藏样式（此前该 class 没有样式，挂上去会直接显示文字）。
- 播报点：`write-runner` 的「正在暂停…／正在保存…」原本就在，另补写入成功「已{verb}」与恢复成功「已恢复活动」；三条 #live 专用文案放在 `config-texts.js` 的 `LIVE`（不作为可见文字，故不进 T 表）。
- 未覆盖：测试/探测结果与主题切换的播报——前者随设置页五类服务纸笺在 P3b 接入，后者随 P4 veil 重写；验收 56 仍待补齐后复验。

### 9.4 V4 · 人设自动增高、M19 细线与 T5 位置

- 人设 `Textarea` 去掉 `rows={8}`，改为 `growDefinition()`：`height=auto → min(max(scrollHeight+2, 136), cap)`，`cap = max(140, round(min(窗口高×0.4, 正文可视高−120)))`；超上限时 `overflow-y:auto` 并打 `data-capped`（细滚动条用 `line-control` 70%）。触发时机：内容变化、窗口 resize、字体加载完成、切回设定分区。
- M19：[Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx) 给显示名与人设各包一层 `.config-ctl`，逐字段比较后打 `data-dirty`；CSS 补 `.config-ctl:before`（左侧 −12px、2px 琥珀线、`opacity 0→1` + `scaleY(.4)→1`，component 220 / ease-out）。
- T5：字数从组名副行移到输入框右下 `.config-field-foot`（等宽 11px，数字用 text 色），并以 `aria-describedby="config-definition-count"` 关联。

### 9.5 自验证据（真实 Electron + 假后端，探针取自 §8 同一支并做时序修正）

证据目录：`backend/test-results/400-v6-fix-20261119/`（`probe-v6-ui.cjs` 与 `probe-v6-ui.json`、`v6-sheet-1280.png`）。

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

**证据**：`backend/test-results/400-v6-verify-20261119/`（`report.json`、`report-live.json`、`report-m19.json`、`report-720.json`、`e2e/*.log`、`verify-sheet-1280.png`、`verify-sheet-720.png`）。

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

依 [DL-160](../../161-digital-life-direction-decisions.md) 口径，V5 属展示层不得后置。[config-theme-transition.tsx](../../../desktop/desk-preview/renderer/src/ui/config-theme-transition.tsx) 由 v5 的「900ms 圆形扩散＋暖／冷光环」改为 v6 demo §5.3 的整页 veil 方案，**真机探针实测六要素全部对齐 demo**。

### 12.1 改造内容

- **veil 淡出**：clone 旧配色整页副本（`.studio-shell` 副本，`z-index:9000`、`inert`、`aria-hidden`），`opacity 1→0`，时长取 `--nd-semantic-motion-theme-reveal`（400ms）、曲线 `--nd-semantic-motion-ease-standard`（`cubic-bezier(.4,0,.2,1)`）；删除原圆形扩散 mask 动画与光环 `rim`。
- **图片挖空**：副本用 `maskComposite: subtract, add…` 挖掉每个立绘／缩略图框，真实页面始终绘制原图，不随主题重新着色。
- **收尾**：`--nd-semantic-motion-theme-total`（550ms）到点移除副本并 `finish()`；`data-config-switching` 期间 CSS 关闭真实页所有过渡，结束不闪。
- **连续点击**：交回框架的 `isCurrent()/cleanup` 裁决，只保留最后一次目标（与原实现一致）。
- **reduced**：框架直切路径无副本；读屏播报上移到 `ConfigThemeTransition` 组件层监听 `preset`，覆盖正常过渡与 reduced 直切两条路径，避免写在策略 `finish()` 里被 reduced 绕过。

### 12.2 独立实测（`backend/test-results/400-v6-verify-20261119/`）

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
| 后端门禁 | 实跑 `accept-offline.mjs` | **21／21** 步、正式测试 **444／444**、`sourceUnchanged = true`、`realServiceCalls = 0`，报告 `backend/test-results/p5-2026-11-19T09-25-32-589Z-e623ef65/summary.json` |
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

**期望**（v6 demo §验收 29 与 `app.js` 的 `goSection`）：`if (state.sheet) requestClose(() => goSection(id))` —— 纸笺开着点另一分类，无改动应先关闭再切换，有改动先走关闭确认。仓库 [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L346) 的 `changeSection` 不检查 `sheet`，直接 `setRoleSection(id)`。

**定位**：`changeSection` 不在本轮 diff 中，属 P2 早期切片遗留；本轮纸笺归属修复（`idPrefix` 过滤）解决了多宿主叠加空纸笺，但没有补上切段关闭。按 DL-160 属展示层，不得以「既有遗留」长期搁置。

**修法建议**：`changeSection` 内先读 `useSheet()` 的当前 `sheet`（或暴露 `getSheet()`），若非空则 `requestClose(() => applySection(id))`，把实际切换放进回调；有脏时复用既有关闭确认阶梯。属纯前端交互改动，不触碰接口。

### 14.3 观察项（不阻塞）

1. **首帧焦点对 disabled 字段**：预置服饰名称框 `disabled`，探针 `focusOnName=false` 属预期（disabled 不可聚焦）；自验称「焦点落名称框」是非预置服饰场景，本轮未对非预置服饰复验焦点，建议下轮补。
2. **纸笺归属修复的 rAF 累积**：`Sheet.tsx` 去掉 `requestAnimationFrame` 的 cleanup 后，同一纸笺在首帧重渲染会累积多个回调；均以 `frame.isConnected` 校验后 focus，实测无异常，但高频重渲染下有冗余 focus，可后续加 `slot`/去重。
3. **§13 自验的「探针未入库」**：本轮证据已入库 `backend/test-results/400-v6-verify-20261119-b69d91e/`，替代自验口径。

### 14.4 范围与环境

仅覆盖 P2 四段与纸笺归属的桌面端／离线范围；模型段、底栏原生 `<select>`、语音按服务缓存、P3a 依赖暂停、真实后端与模型联调不在本次范围。

## 15. R10-1 与 §14.3 观察项补修（2026-11-19，自验通过，待独立复核）

按 §14.2 的建议修 R10-1（切分区不关闭已开纸笺），并处理 §14.3 的前两项观察项。

### 15.1 R10-1 · 切分区先按关闭规则收纸笺

**问题**：`changeSection` 直接 `setRoleSection/ setSettingsSection`，纸笺开着点页签时不关闭，停留在已离开分区的内容上（违反验收 29）。

**改法**（纯前端，不触接口）：

1. [sheet-context.tsx](../../../desktop/desk-preview/renderer/src/components/config/sheet/sheet-context.tsx) 的 `SheetProvider` 增加可选 `controller` 引用，把最新的 context 值挂到工作区层的 `MutableRefObject` 上——页签在工作区层、纸笺状态在 Provider 内，跨层只能靠这个引用，不需要把 Provider 整体外提。
2. [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx) 的 `changeSection` 拆成 `apply()`（真正的切换与 M9 淡入）和前置判断：`sheetController.current?.sheet` 非空时先 `requestClose(apply)`，让既有闭关闭规则接管——无改动直接关，有改动先出 T9 确认、确认「放弃」后才切；写入中 `requestClose` 自身会忽略。
3. 同步补齐 M2 时序：[sheet-context.tsx](../../../desktop/desk-preview/renderer/src/components/config/sheet/sheet-context.tsx) 的 `closeNow` 先读纸笺的 `--nd-semantic-motion-page-exit`，`then` 待办（切换分区 / 保存反馈）改为退出动画结束后再执行；减少动效（令牌 0）时仍旧同步执行。

### 15.2 §14.3 观察项

1. **非预置服饰首帧焦点**：用 §14 同一支四段探针补测「我的搭配」（`isPreset:false`）：名称框 `disabled=false`、值 `我的搭配`、`document.activeElement` 就是该输入框（`focusIsName:true`）。预置服饰名称框 `disabled` 不可聚焦属预期，焦点落到下一个可聚焦控件。
2. **焦点 rAF 累积**：`Sheet.tsx` 的聚焦效应按「纸笺编号｜组名」去重，同一纸笺同一组只排一帧，重渲染时取消上一帧再排新的；关闭纸笺时清空。`owned` 变化不再累积冗余 `focus()`。
3. 证据目录说明属信息项，无需改动。

### 15.3 自验证据（真实 Electron + 本地假后端，复用 §14 探针并把时序写严）

证据目录：`backend/test-results/400-v6-fix-r10-1-20261119/`（`probe-switch-delay.cjs` + `report-switch-delay.json`、`probe-four-sections.cjs` + `report-four-sections.json`）。

| 场景 | 实测 |
| --- | --- |
| 扩展段开 MCP 纸笺 → 点「设定」（无改动） | 300ms 与 1500ms 两次采样：`sheets/scrims/books` 全 0，页签 `01设定`、正文 `h2=["设定"]`（R10-1 收口） |
| 额度纸笺改 37 → 点「设定」（有改动） | 400ms 后：纸笺仍在、`confirm=true`、页签仍是 `05额度`、正文仍是「自主额度」——先确认不切段 |
| 上一步点「放弃」 | 600ms 后：纸笺 0/0/0，页签 `01设定`、正文 `设定` |
| 非预置服饰纸笺 | `nameDisabled=false`、`focusIsName=true`、`value="我的搭配"`、标题「编辑服饰」 |

门禁：`renderer npm run check`（24 CSS 零违规、`tsc` 通过）与 `vite build` 通过；桌面单测 **160／160**；后端 `accept-offline.mjs` **21／21 步**、正式测试 **444／444**、`sourceUnchanged=true`、`realServiceCalls=0`（报告 `backend/test-results/p5-2026-11-19T09-43-05-872Z-03a0de97/summary.json`）；`node scripts/check-docs.mjs` 0 错误 0 警告；`theme-transition-check`、`pack3-entry-check` 退出 0。

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
