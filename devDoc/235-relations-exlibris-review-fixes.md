# 235 关系藏页复核修复记录

2026-11-09，`dev-front` 工作树。针对 [234 独立复核](234-relations-exlibris-independent-review.md) 的 EX-R01～EX-R03 修复并自验：资料分批到达即分批展示、多角色换人面板在可用高度内换行滚动、换人面板的焦点进入与归还。234 第 3 节追加的 EX-R04、EX-R05 见第 7 节。工作树未提交；本次仍用隔离 Electron 与本地模拟接口，未调用真实模型，未改动用户数据。复验由独立复核执行，本文只记录实现方自验。

## 1. 修复结论

| 编号 | 修复 | 证据 |
| --- | --- | --- |
| EX-R01 | 角色、近况、服饰先发布；经历、日常概况、日记各自返回即更新，日记按 8 篇一批发布；慢的一篇只延后自己 | [loadRelationPacket](../desktop/desk-preview/renderer/src/relations/load-dossier.ts#L27) · [分批发布](../desktop/desk-preview/renderer/src/relations/load-dossier.ts#L128) |
| EX-R02 | 角色选项改为自适应网格，单列不小于 104 像素，超出可用高度滚动；名字单行省略，不再挤压 | [person-options](../desktop/desk-preview/renderer/src/styles/relations-exlibris.css#L11) |
| EX-R03 | 打开即聚焦当前角色；Esc、× 与选中后焦点回到「换一位」 | [聚焦当前角色](../desktop/desk-preview/renderer/src/Relations.tsx#L70) · [关闭归还焦点](../desktop/desk-preview/renderer/src/Relations.tsx#L134) |

## 2. EX-R01 分批发布

原实现等经历、日常概况和全部日记详情一起结束才发布整份资料，第九篇日记挂起时首页仍显示「正在读取近况」，经历页也看不到已经返回的经历。

现改为：

- `loadRelationPacket(roleId, signal, onPartial)` 在角色、状态、服饰三项就绪后立即发布一份基础资料（经历、日记、概况为空，`pending` 三项为真），首页近况和人物票先落页。
- 经历、日常概况、日记三个分组各自独立等待与结算：谁先返回谁先更新，出错只写自己那一条错误，不牵连其他分组。
- 日记详情仍按 8 篇一批读取，但每批读完立即发布；第九篇挂起时前八篇已经可以翻，第九篇返回后补齐。
- 每次发布都带 `pending` 标记，界面据此区分「还在读」与「确实没有」：首页预览显示「正在读取」，经历页在没有内容时显示「正在整理经历。」、已有内容时显示「还有记录正在整理。」，日记页空列表显示「正在读取日记。」、已有日记时在列表下方显示「还有日记正在读取。」。
- 发布走同一个 `createRoleRequestGate` 票据；换角色后旧请求的中止与晚到结果都不会写回新角色页面。
- 依据（evidence）请求改为按「角色 + 依据 id」两个字符串触发，资料分批更新时不再重复请求或闪动。

## 3. EX-R02 多角色面板

原 `.person-options` 是单行 flex，`.person-option` 为 `flex:1;min-width:0`，20 位角色被压进一行，最窄按钮约 3.2 像素，名字与序号互相挤压。

现改为：

- `.person-options` 改为 `grid` + `repeat(auto-fill, minmax(104px, 1fr))`，按面板宽度自动换列；1024 像素窗口下为两列，单按钮约 115 像素。
- 列表高度限制为 `min(38vh, 300px)` 并可滚动（`overflow-y:auto`、`overscroll-behavior:contain`、细滚动条），面板整体仍留在书页内。
- 名字单行省略并留出序号位置（`padding-right:24px` + `text-overflow:ellipsis`），完整名字放在 `title` 上；选项加 8 像素上内边距，点击高度约 40 像素。

实测（本地假服务，20 位角色）：

| 窗口 | 面板纵向范围 | 书页纵向范围 | 最小按钮宽 | 列表可滚 | 横向溢出 | 末位可点 |
| --- | --- | --- | --- | --- | --- | --- |
| 1280×800 | 248.1～591.9 | 176.0～682.0 | — | — | — | — |
| 1024×700 | 268.8～547.2 | 176.0～640.0 | 114.7 | 是 | 无 | 是 |
| 390×844 | 475.0～851.0 | 219.0～957.0 | 108.3 | 是 | 无 | — |

窄屏的页面本身可纵向滚动（书页最小高度 800 像素，属既有行为），面板左右也在书页内（33.2～306.2，书页 12.0～369.3）。

## 4. EX-R03 换人面板焦点

原实现打开面板后焦点仍留在「换一位」，`Esc` 关闭后焦点落回文档主体。

现改为：

- 面板打开后聚焦当前角色（`aria-pressed="true"`），没有当前角色时聚焦第一位；焦点落在选项上即可用 Tab 或回车继续操作，长列表会自动滚动到该选项。
- `Esc`、标题栏 `×`、选中某位角色三条关闭路径都会把焦点还给「换一位」按钮；点击面板外侧关闭属于指针操作，不抢焦点。
- 关闭时 `aria-expanded` 同步为 `false`。

## 5. 测试与自验

- 渲染器类型检查、Vite 生产构建通过；构建仅保留既有的 `api.ts` 静态／动态混合导入提示。
- 桌面离线测试 53／53 通过；[233 基线脚本](../desktop/desk-preview/tests/relations-desktop-check.cjs) 复跑通过：书面 1203.2 像素，换人面板在书页内（441.6～585.6，书页 176.0～682.0），双角色切换、依据展开、九篇日记与 1 篇失败隔离、日记方向键、返回焦点、夜间标题与完整立绘均通过，页面异常 0。
- 新增 [relations-review-234.cjs](../desktop/desk-preview/tests/relations-review-234.cjs)，用隔离 Electron 与本地假服务覆盖五个场景，全部通过、页面异常 0：
  - `slow`：第九篇日记挂起时首页显示「甲角色的近况」，经历页显示「甲角色的经历」，日记页可读 8 篇并提示「还有日记正在读取。」；释放后补齐 9 篇。
  - `switch`：甲角色第九篇挂起时换到乙角色，乙角色 9 篇日记与近况正常；释放后仍是「乙角色的日记」，旧资料没有写回。
  - `many`：20 位角色在 1280×800、1024×700、390×844 下均换行可读、可滚动、不被书页裁切、无横向溢出。
  - `focus`：打开聚焦当前角色；`Esc` 与 `×` 关闭后焦点都在「换一位」，`aria-expanded=false`。
  - `base`：默认两位角色的基本读取与切换。
- 证据目录 `backend/test-results/review-234/`：`base.json`、`slow.json`、`switch.json`、`many.json`、`focus.json` 及截图 `slow-experience-before.png`、`slow-diary-before.png`、`switch-role.png`、`many-roles.png`、`many-roles-wide.png`、`many-roles-mobile.png`、`focus-open.png`、`base-day.png`；五个场景的标准错误输出均为空。
- 脚本运行时 Chromium 配置目录放在系统临时目录，退出后清理，证据目录不再残留 `profile-*`。

## 6. 未完成与后续

- EX-R01～EX-R03 是否关闭以独立复验结论为准；本文只记录实现方自验。
- 真实角色数据与真实后端联调仍未验证，上述场景全部使用本地模拟接口与隔离数据。
- 234 复核用的 `backend/test-results/review-233/probe.cjs` 把旧行为写成了断言（按钮宽 < 4 像素、打开后焦点仍在触发按钮、`Esc` 后焦点落在 `body`）；修复后这些断言按预期失败，复验请以 [relations-review-234.cjs](../desktop/desk-preview/tests/relations-review-234.cjs) 或等价检查为准。
- 换人面板背景沿用应用 `--surface`，打开瞬间有 0.3 秒淡入动画，属既有表现，未在本次调整。
- 234 第 2 节列出的既有通过项未改动：书面宽度、主题、立绘、日记方向键、返回焦点与窄屏布局。

## 7. 234 第 3 节补充修复（EX-R04／EX-R05）

2026-11-10。234 第 3 节确认 EX-R01～EX-R03 关闭，扩展检查复现 EX-R04、EX-R05。本轮补修如下，仍为本地模拟接口自验。

| 编号 | 修复 | 证据 |
| --- | --- | --- |
| EX-R04 | 日记详情改为固定并发 8 的滑动窗口，单篇返回即按列表顺序落位发布；补入靠前日记时按 id 保持当前选中 | [日记滑动窗口](../desktop/desk-preview/renderer/src/relations/load-dossier.ts#L125) · [选中保持](../desktop/desk-preview/renderer/src/relations/dossier.js#L48) |
| EX-R05 | 二级页弹层不再向上展开，改为贴书页内侧、按书页可用高度展开，选项在面板内滚动 | [in-rail 弹层](../desktop/desk-preview/renderer/src/styles/relations-exlibris.css#L81) |

### 7.1 EX-R04 同批慢日记

原实现按 8 篇一批 `Promise.allSettled`，整批结束才发布，且下一批要等上一批结束。第一篇挂起时，同批已返回的第二至第八篇不可读，第九篇也不会发出请求。

现改为：

- 日记详情用固定 8 个 worker 的滑动窗口读取：任一 worker 返回就补位读下一篇，不再有批次屏障；并发上限仍是 8，不会打满本机后端。
- 结果按接口返回顺序写入固定槽位，发布时过滤空槽，列表顺序与接口的 `experience_date DESC` 一致；靠前的日记晚到时落在正确位置，不会追加到末尾。
- 每篇返回即发布一次，`pending.diaries` 到全部 worker 结束才置假，列表下方继续提示「还有日记正在读取。」。
- `reduceRelation` 的 `loaded` 分支按日记 id 重新定位选中项：补入靠前日记导致下标整体后移时，用户正在读的那一篇保持不变；原选中项消失时退回原下标并夹在有效范围内。

实测（第一篇挂起，共 9 篇可读 + 1 篇 404）：释放前已显示 8 篇（11-08～11-01），第九篇请求已发出；选中 11-06 后释放第一篇，列表补齐 9 篇、首项变为 11-09，选中项仍是 11-06，正文日期一致。

### 7.2 EX-R05 二级页换人面板

原 `.plate-switch.in-rail` 为 `position:static`，弹层相对 `.inner-view` 向上定位，20 位角色时面板落在 y=-214～168，书页顶边 176，整个面板被裁掉，首个选项也无法命中。

现改为：

- `.plate-switch.in-rail .person-selector` 固定在书页内侧：`top:48px`、`left:14px`、`max-height:calc(100% - 62px)`，不再向上展开。`48px` 让开页眉「关系 / 经历」，该页眉 `z-index:6` 高于 `.view` 的层叠上下文，弹层无法盖住它。
- 面板改为 `display:flex` 纵向布局，`.person-options` 占满剩余高度并 `min-height:0`，选项在面板内滚动，面板本身始终完整落在书页里。
- 弹层仍在 `.plate-switch` 内，点外侧关闭、`Esc`、`×` 与焦点归还逻辑沿用第 4 节，不额外分支。

实测（1280×800、20 位角色、经历页）：面板 224.0～606.0，书页 176.0～682.0；横向 52.4～402.4，书页 38.4～1241.6。首项与末项都能命中，列表可滚动；滚动到「角色 12」后点击，左栏姓名与近况都切到「角色 12」，面板关闭，页面异常 0。

### 7.3 复验

- 渲染器类型检查、Vite 生产构建通过；桌面离线测试 54／54（第 5 节记录的 53 项之外，本次新增 1 项日记选中保持回归）；233 基线脚本复跑通过（书面 1203.2，面板 441.6～585.6，切换、依据、九篇日记与 1 篇失败隔离、方向键、返回焦点、夜间、移动端均正常）。
- `relations-review-234.cjs` 增至七个场景，全部通过、页面异常 0：原 `base`、`slow`、`switch`、`many`、`focus` 保持通过，新增 `batch`（EX-R04）与 `inner`（EX-R05）。
- 证据更新到 `backend/test-results/review-234/`：新增 `batch.json`、`inner.json` 与截图 `batch-before.png`、`batch-after.png`、`inner-picker-fixed.png`，标准错误输出为空。
- 234 第 3 节用的 `backend/test-results/independent-235/cases.cjs`（`batch` 场景）与 `inner.cjs` 把修复前行为写成了断言（释放前 0 个日期、面板底边在书页顶边之上、首项不可命中）；修复后这些断言按预期失败，复验请以 `relations-review-234.cjs` 的 `batch`、`inner` 场景或等价检查为准。
- EX-R04／EX-R05 是否关闭以独立复验结论为准；真实角色数据与真实后端联调仍未验证。
