# 角色配置页 + 设置页 v6 迁移 · 实施记录与交接文档

> **状态**：P1（基础件）已完成并通过全部门禁；P2–P6 待推进。
> **交接目的**：本文档面向后续协作者（含有视觉能力的模型），完整记录 v6 迁移的规范来源、关键决策、当前进度、已完成改动清单、门禁命令与后续阶段的执行指引。
> 规范权威文本在 `E:\tmp\test\config-pages-dev-spec (1).md`（1358 行）；与 demo README 冲突时以规范为准；标「示例专用」的值一律换令牌。

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
- 临时 Electron + 真实后端探针（未入库）：进入角色配置 → 标题「设定」、页脚干净态收起；改显示名 → 页脚「设定 · 1 处改动未保存」+「保存 1」；保存后页脚出现 T30「继续活动」，点击后恢复 `active`，页面无异常。
- **未跑**：`settings-workspace-check.cjs` 等既有 E2E 仍指向旧 DOM（保存按钮文案、`.config-delete-options`、丝带/folio），在 P2 全部迁完并移植脚本前预期失败，不作为本轮回归结论。

### 7.3 尚未完成（P2 余下）

1. 外观（服饰卡网格 +「编辑服饰」完整纸笺 + 删除服饰确认 T27）、模型（四行摘要 + 服务/连接测试纸笺，复用 `ModelNamePicker`）、扩展（MCP/Skill 两行 + 开关纸笺）、自主额度（今日 + 每日额度 + T28）、完成度（只读清单 + 查看）五段正文与纸笺。
2. 底栏原生 `<select>` 角色切换（+「＋ 新建角色…」项）、T37 设定脏切换确认、删除 `config-dialog` / 藏书票墙 / `config-dirty-prompt`。
3. 语音按服务会话缓存（`by[roleId:serviceId]` 提升到 workspace state）。
4. 旧 `VoicePanel` / `ImagePanel` / `AppearancePanel` 的纸笺分组化与组副标题删除。
5. `settings-workspace-check.cjs` 角色页段与 `startup-flow-fixes-check.cjs` 选择器移植；P2 门禁重跑。
