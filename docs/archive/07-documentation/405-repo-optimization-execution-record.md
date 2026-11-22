# 405 仓库结构重组与验证提速执行记录

- 日期：2026-11-22
- 分支：`codex/repo-cleanup-and-restructure`
- 依据：[仓库优化方案](./repo-optimization-plan.md)
- 范围：运行时与产物止血、分层验证与并发、Monorepo 目录迁移（Wave 1～6）、6 条仓库护栏与冷热终验
- 结论：**离线范围全量通过**（§1～§6 为实施方离线自验；§7 为只读独立复核结论及 B1～B4 补正与终验复跑）。完整门禁 `verify:gate` **9／9**（冷跑 **130.9 s**，热跑 **125.1 s / 125.8 s** ≤ 140 s）、`verify:unit` **9／9**（热跑 **40.5 s / 39.4 s** ≤ 60 s）、`verify:fast`（热跑 **1.3 s / 1.4 s**，单域 `fast model` **3.3 s / 3.0 s** ≤ 25 s）、后端 **551／551**（69 个测试文件）、离线验收 **21／21**（84.8 s / 85.1 s ≤ 95 s，`delivery-tests` 5／5，`sourceUnchanged=true`，`realServiceCalls=0`，单次运行目录 **1.00 MiB** < 5 MB）、渲染器单测 **132／132**、桌面壳单测 **13／13**、跨端集成 **3／3**、Electron E2E **15／15**（40.3 s / 40.7 s ≤ 65 s，孤儿进程 0）、文档巡检 0 错误 0 警告、仓库卫生 6 条规则 0 错误、仓库总占用 **1.081 GiB（1.161 GB）**（`.git/` **181.58 MiB**）。

## 1. 与方案的差异与修正

执行前复核发现方案中的部分事实与操作假设不成立，按下述方式修正，未按原文机械照做：

1. **验收轮转的误删风险**：`p5-*` 不能按通配符整体轮转，`p5-gap-audit` 等审计目录会被误删。改为严格匹配 `^p5-\d{4}-…-[0-9a-f]{8}$`，并扫描 `docs/**/*.md`、根 `README.md`、`AGENTS.md` 中全部 run 引用做保护，不只看 `STATUS.md`。
2. **Git 瘦身备份**：仅备份 ref 文本无法恢复已 prune 的对象。改为先创建并 `git bundle verify` 全引用备份，再删除本地 `refs/codex/turn-diffs/*` 并 `gc`；不动正常分支 reflog。
3. **测试收尾不能盲改**：多处 `app.close()` 是重启用例的中段动作。只修真实的最终收尾泄漏，并为 `p2-03-memory-query` 补 `try/finally`；未确认处保持原样。
4. **E2E 提速顺序**：渲染器构建必须先于 E2E；`--only` 不得输出全量通过结论；`verify.mjs fast` 遇到后端共享底层改动或根基础设施改动时自动升级为全量后端单测，仅改文档或非运行时文件则只执行 `docs` 与 `hygiene`。
5. **JS/声明配对实际为 23 组**（另有独立 `bridge.d.ts` 与无配对的 `conversation/fixtures.js`），不是方案中的 24 组。
6. **测试基线**：后端迁移前为 68 个测试文件、551 条用例；E2E 改为显式清单 + 数量守卫，不依赖 glob 推断覆盖面。

## 2. 实际落地

> *注：本节与[第 3 节](#3-验证结果)记录的是首轮 Wave 1～3 完成时的快照；Wave 4～6 与 P3 落成后的最终结构、护栏、commit 与冷热实测以[第 6 节](#6-首轮独立复核补修p2-wave-46-与-p3-完整收口2026-11-22实施方离线自验)与[第 7 节](#7-终验独立复核与-b1b4-补正记录2026-11-22)为准。*

### 2.1 运行时与产物

- 本地 Node 24 运行时迁至 `.tools/node-v24/`（忽略入库），`backend-paths.cjs` 开发态从仓库 `.tools` 解析，打包态仍用 `resources/node-runtime`。
- `scripts/repo-paths.mjs` 统一路径，验收脚本、清理脚本、验证入口均不再依赖 `cwd`。
- `process-smoke` 的 `appRoot` 改为系统临时目录，成功后才清理；失败保留现场并写入报告。
- `scripts/clean-artifacts.mjs`：默认 dry-run，`--apply` 才删除；保护 Git 跟踪文件与文档引用的 run，禁止越出仓库与触碰运行时目录。

### 2.2 分层验证（首轮 Wave 1～3 实测）

| 入口 | 内容 | 迁移后实测 |
| --- | --- | --- |
| `node scripts/verify.mjs fast` | 按改动域映射的定向检查 | 约 14 s |
| `node scripts/verify.mjs unit` | 文档 + 卫生 + 后端类型/全量单测 + 渲染器检查/构建 + 桌面单测 + 跨端集成 | 8／8，约 88 s |
| `node scripts/verify.mjs gate` | 渲染器检查/构建 → 离线验收／桌面单测／文档／卫生 → 全部 E2E | 8／8，196 s |
| `node scripts/verify.mjs e2e` | 构建 + 15 条 Electron E2E | 15／15，61 s |

- 离线验收按阶段并发：类型检查与交付回归、全量单测、进程冒烟与业务矩阵；`--only` 明确标记为部分运行，不触发轮转。
- 桌面 E2E 由 `tests/helpers/run-e2e.cjs` 调度：显式清单、独立临时目录、超时清进程树、共享会话与精确动画用例串行、其余并发。

### 2.3 目录结构（首轮 Wave 1～3 快照）

```text
apps/
  backend/            # 原 backend/：后端源码、测试、验收脚本、reviews/
  desktop/            # 原 desktop/desk-preview/ 扁平迁入
    electron/         # main / preload / backend-paths
    renderer/         # React + Vite
    tests/            # unit / e2e / integration / live / helpers
    scripts/          # 令牌生成与样式检查
docs/                 # 原 devDoc/
tools/art-pipeline/   # 原 desktop/desk-preview/tools/
scripts/              # 仓库级验证、清理、文档与卫生工具
```

- 退役并删除：`prototypes/`（含残留 p0 数据）、旧书桌 8 个死文件及 2 条对应单测、`.archify` 中已跟踪的生成页。
- `models-picker`、`feed-integration`、`live/*` 等跨端导入路径已按新层级修正；E2E 根目录多算一层的问题在首轮 E2E 全失败后定位并修复。
- 文档链接由 `scripts/rewrite-doc-links.mjs` 精确映射后重写；历史运行产物已轮转的 6 处报告链接改为代码路径并标注“历史运行产物已轮转”。

### 2.4 仓库护栏（首轮基础版；全量 6 条规则见 §6.5）

`scripts/check-repo-hygiene.mjs` 首轮接入 `verify` 时的基础规则：

- 退役根目录回流（`backend/`、`desktop/`、`devDoc/`、`prototypes/`）；
- 被跟踪的 `node_modules/`、`dist/`、`test-results/`、`release/`、日志与编译缓存；
- 新增 `renderer/src/**` 的 `.js + .d.ts` 配对（首轮登记 23 组基线，已于 §6.2 归零）；
- 代码、现行规范、`STATUS.md`、根说明中的旧路径硬编码（`docs/archive/` 保留历史路径）；
- `.packaging*` 本地残留只告警，不阻断。

## 3. 验证结果（首轮 Wave 1～3）

| 项目 | 结果 |
| --- | --- |
| `verify gate` | 8／8 通过，196.2 s |
| 后端类型检查 | 通过 |
| 后端正式单测 | 551／551，76.1 s |
| 离线验收 | 21／21，128.3 s |
| 桌面单测 | 145／145 |
| Electron E2E | 15／15，60.6 s |
| 渲染器检查 | 令牌最新、28 个 CSS 违规 0、`tsc --noEmit` 通过 |
| 文档巡检 | 错误 0、警告 0 |
| 仓库卫生 | 错误 0、警告 2（锁定的 `.packaging*` 残留） |

首轮迁移后单次验收产物已从 GB 级降到 MB 级，清理临时目录与旧轮转释放约 3.91 GiB；`apps/backend/test-results/` 当时暂留约 1.7 GiB，随后已在 Phase A 瘦身清理（再释约 4.67 GiB）并在 Wave 6 并入根目录 `test-results/backend-acceptance/`（另注：`STATUS.md` 早前记载的 2026-11-18～21 历史 `p5-2026-11-*` 批跑目录多已轮转清理，当前保留的主要为 `p1-*`～`p5-gap*`、`310-*`、`400-*`～`402-*`、`review-*` 等具名审查目录及 2026-11-22 最新 `p5-*` 批次）。

## 4. 首轮阶段暂缓项（前两项已于第 6 节完成，第 3 项仍保留为本地占用告警）

> 注：本节保留首轮阶段（Wave 1～3）时的暂缓说明；第 1、2 项已随用户确认在下方[第 6 节](#6-首轮独立复核补修p2-wave-46-与-p3-完整收口2026-11-22实施方离线自验)全量落地并清空基线，第 3 项 `.packaging/` 与 `.packaging-28948/` 因外部系统进程占用尚未删除，仍在卫生巡检中保留非阻断告警。

1. **23 组 `.js/.d.ts` + 1 份无配对 `.js` 合并为 `.ts`（P2-Wave 4）**：首轮暂缓，已于 §6.2 全部合并为 `.ts` 并将 `JS_DTS_BASELINE` 清零。
2. **`application/`、`storage/` 二级分包与 `tests/` 前缀重命名（P2-Wave 5／6）**：首轮暂缓，已于 §6.3～§6.4 按业务域完成二级分包与测试/脚本分层重命名。
3. **`.packaging/`、`.packaging-28948/` 删除**：`app.asar` 被外部系统进程占用，`clean-artifacts.mjs` 自动识别占用并跳过；已被 `.gitignore` 忽略（共约 3.8 MB），卫生巡检记为非阻断告警，可在重启或解除占用后手动删除。

## 5. 后续建议

- 每次改动先跑 `node scripts/verify.mjs fast`，提交前跑 `unit`，合并前跑 `gate`。
- `check-repo-hygiene.mjs` 的 `JS_DTS_BASELINE` 已归零，任何新增 `.js + .d.ts` 配对或 `p\d+-`/`202\d{5}-` 后端测试前缀均会直接阻断门禁。

---

## 6. 首轮独立复核补修、P2 Wave 4～6 与 P3 完整收口（2026-11-22，实施方离线自验）

经首轮独立复核并由用户确认，本分支继续按 Phase A → Phase E 一次性完成首轮复核问题补修、先前暂缓的 P2-Wave 4／5／6 以及 P3 全部 6 条卫生护栏。

### 6.1 Phase A：首轮独立复核问题补修（`bc42816`）

1. **磁盘残留与审查目录瘦身（`scripts/clean-artifacts.mjs`）**：
   - 在保护被文档引用的历史 `p5-*` 与审查目录 JSON/`.log` 证据的前提下，支持清理受保护目录内部的 `tmp/`、临时 SQLite 库、音频/大图与嵌套冗余产物，并清理无引用的 `test-results/*` 历史目录，额外释放约 **4.67 GiB**。
   - 对被系统进程锁定的 `.packaging*` 捕获 `EBUSY`/`EPERM` 明确打印跳过原因，不中断整体清理。
2. **E2E 稳定性、路径助手与门禁补漏**：
   - `apps/desktop/tests/e2e/settings-v6-behavior.e2e.cjs` 与 `tests/helpers/run-e2e.cjs`（默认 3 并发 + 用例通过后清理 `caseDir/tmp` + LPT 入池顺序）消除了并发截图与过渡耗时抖动。
   - 15 条 `apps/desktop/tests/e2e/*.e2e.cjs` 与 4 条 `tests/live/*` 全部接入 `tests/helpers/paths.cjs`。
   - `scripts/verify.mjs` 补齐 `fast` 关键字过滤（`-- <keyword...>`）、后端共享层（`bootstrap`/`storage`/`application`/`http`/`domain`/`security` 等）或根基础设施改动自动升级全量（纯文档等非运行时改动仅跑 `docs` + `hygiene`）及 `unit` 必跑 `feed-integration`。
   - `scripts/check-docs.mjs` 使用 `LEGACY_REMOVED_TARGETS` 精确路径白名单，并保留限定仅对 `docs/archive/` 生效的 `LEGACY_REMOVED_PREFIXES = ["prototypes/"]`；`scripts/rewrite-doc-links.mjs` 保证幂等重写。

### 6.2 Phase B（P2-Wave 4）：前端 TS 统一、ESM/CJS 单测分治与样式收敛（`2be894f`）

1. **消灭全部 `.js + .d.ts` 配对**：将 `apps/desktop/renderer/src/` 下全部 **23 组 `.js + .d.ts`** 及无配对的 `conversation/fixtures.js` 合并为严格 `.ts`（保留独立环境声明 `bridge.d.ts`；`lib/token-usage.ts` 保持纯可擦除 TS 类型且零外部运行时导入，兼容 Node 24 原生直跑），清理 32 处 `.js` 相对导入后缀，`check-repo-hygiene.mjs` 中 `JS_DTS_BASELINE` 归零。
2. **页面与样式目录收敛**：`Relations.tsx` 迁入 `apps/desktop/renderer/src/pages/Relations.tsx`；`ui/relationship-journal*.css`、`relations/memory-correction.css`、`studio-overrides.css` 共 5 份样式按 `main.tsx` 原层叠顺序迁入 `apps/desktop/renderer/src/styles/`（28 个 CSS 零违规，豁免保持 387）。
3. **ESM 与 CJS 单测分治**：18 个前端纯逻辑单测（132 条用例）迁入 `apps/desktop/renderer/tests/*.test.ts`（ESM + `tsx`），桌面壳/令牌/打包 3 个单测（13 条用例）保留在 `apps/desktop/tests/unit/*.test.cjs`（CJS），跨端 `feed-integration.test.ts`（3 条用例）位于 `apps/desktop/tests/integration/`，全部接入 `scripts/verify.mjs`。

### 6.3 Phase C（P2-Wave 5）：后端 `application/` 与 `storage/` 业务域二级分包（`f6b8190`）

1. **`apps/backend/src/application/`（42 文件 → 6 个子域）**：
   - `conversation/`（9）、`memory/`（4）、`role/`（7）、`transfer/`（7）、`media/`（9）、`resources/`（6）。
2. **`apps/backend/src/storage/`（23 文件 → 5 个子域）**：
   - `core/`（7）、`conversation/`（4）、`memory/`（2）、`role/`（3）、`media/`（7）。
3. 同步更新全部相对导入、动态内联脚本导入与全树文档链接，零业务语义改动。

### 6.4 Phase D（P2-Wave 6）：后端测试/验收/脚本规范化、LPT 调度与产物收口（`4a6e982`）

1. **`apps/backend/tests/` 分层与去前缀重命名**：
   - `tests/fixtures/`（**5 个文件**：`config-write.ts`、`conversation-fixture.ts`、`legacy-role-fixture.ts`、`web-reading-source.mjs`、`zh-memory.json`）；
   - `tests/unit/`（16 个单测文件）与 `tests/integration/`（53 个集成测试文件，含将原 133 KB 单文件 `workflow-simplification-fixes.test.ts` 在第 21/22 条测试边界无损拆分为 `workflow-simplification-fixes.test.ts` [21 条] 与 `workflow-recovery-fixes.test.ts` [12 条]，合计 **69 个正式测试文件、551 条用例**），彻底淘汰 `p1～p27` 流水号前缀；
   - `tests/acceptance/`：原 `reviews/` 下 16 个受门禁纳管脚本去掉 `202611xx-p*-` 日期与阶段前缀迁入 `tests/acceptance/*.acceptance.ts`；2 个真实模型诊断脚本迁入 `scripts/eval/{real-model-diagnostics,real-model-smoke}.ts`；7 个早期一次性探针（`20261103-p1-*`、`20261103-p2-04-*`、`20261104-p2-04-r01-review`、`20261104-p2-06-fix-review`，对应历史阶段验收结论均已纳入 P1/P2/P5 正式回归，未在本节单列逐条映射）移除并登记至 `check-docs.mjs` `LEGACY_REMOVED_TARGETS`，删除空的 `apps/backend/reviews/`。
2. **`apps/backend/scripts/` 拆分与 LPT 递归测试执行器**：
   - 拆分为 `scripts/verify/`（**6 个文件**：`accept-offline.mjs`、`acceptance-lib.mjs`、`acceptance.test.mjs`、`fs-guard.mjs`、`process-smoke.ts`、`run-tests.mjs`）与 `scripts/eval/`（**21 个文件**：19 个原 `scripts/` 脚本 + 2 个从 `reviews/` 迁入的真实模型诊断脚本）。
   - 新增 `run-tests.mjs` 与 `collectBackendTestFiles(..., { order: "lpt" })`：使用 Node 24 `node:test` 编程式 `run()` 按文件体积降序（LPT）调度进程池（规避 `node --test` CLI 内部按字母序重排导致的重文件长尾），并强制校验 `MIN_BACKEND_TEST_FILES = 69` 与 `MIN_BACKEND_TESTS = 551`。
   - `accept-offline.mjs` Stage C 非隔离验收池按历史耗时降序（LPT）入池（默认 6 并发，`p4-boundaries` 保持独立通道），输出统一收口至根 `test-results/backend-acceptance/`，原 `apps/backend/test-results/` 历史证据目录整体归并后移除。

### 6.5 Phase E（P3）：6 条仓库卫生护栏、方案归档与冷热三连跑终验（`941c968`，实施方离线自验）

1. **`scripts/check-repo-hygiene.mjs` 全量 6 条规则**：
   - `hygiene/root-allowlist`（Error）：已跟踪顶层目录仅允许 `apps`、`docs`、`scripts`、`tools`；
   - `hygiene/no-js-dts-pairs`（Error）：`apps/desktop/renderer/src/` 禁止 `.js + .d.ts` 配对（基线 0）；
   - `hygiene/test-naming`（Error）：`apps/backend/tests/` 禁止 `p\d+-` 或 `202\d{5}-` 文件名前缀；
   - `hygiene/no-legacy-refs`（Error）：代码、脚本与现行文档禁止残留 `prototypes/p0/.runtime`、`desk-preview`、`devDoc/`、`prototypes/` 硬编码（同步清理 `ART-GENERATION-GUIDE.md`、`electron/main.cjs` 与 `electron-executable.test.cjs` 中 4 处残留字面量）；
   - `hygiene/no-large-tracked-blobs`（Error）：禁止跟踪非资产白名单目录的 `> 2 MB` 文件；
   - `hygiene/file-size-budget`（Warning）：对 `> 100 KB` 的已跟踪源码单文件输出温和告警（当前 4 个文件告警，0 错误）。
2. **冷跑 1 次 + 热跑 2 次全链路实测（Node 24.22.2，离线模型与本地工具样例）**：
   > *说明：下述 3 轮门禁实测执行于 `gitHead = 4a6e982` + Phase E 文档/护栏未提交工作区改动（`apps/backend/` 源码与 `4a6e982` 完全一致；工作区改动随后提交为 `941c968`，提交后 `.git/` 实测 `181.58 MiB`）。*

| 验证轮次 / 指标 | 目标阈值 | 冷跑（清 `tsbuildinfo` + `compile-cache`） | 热跑第 1 轮 | 热跑第 2 轮 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| `npm run verify:fast`（当前工作区改动 / `-- model` 单域） | ≤ 25 s | — | **1.3 s**（4/4）／**3.3 s**（6/6） | **1.4 s**（4/4）／**3.0 s**（6/6） | 通过 |
| `npm run verify:unit`（9 项全量单测与构建） | ≤ 60 s | — | **40.5 s**（后端 37.9 s） | **39.4 s**（后端 36.7 s） | 通过（9／9） |
| `npm run verify:gate`（9 项全量门禁，含 21 步验收 + 15 E2E） | ≤ 140 s | **130.9 s** | **125.1 s** | **125.8 s** | 通过（9／9） |
| └─ `accept-offline.mjs`（21／21 步） | ≤ 95 s | **89.9 s** | **84.8 s** | **85.1 s** | 通过（21／21） |
| └─ `desktop-e2e`（`run-e2e.cjs`，15／15 条） | ≤ 65 s | **40.9 s** | **40.3 s** | **40.7 s** | 通过（15／15） |

3. **终验硬指标核对表（实施方自验，离线范围）**：

| 验收维度 | 目标要求 | 实测结果 | 证据位置 |
| --- | --- | --- | --- |
| 仓库磁盘总占用 | ≤ 1.2 GB | **1.081 GiB（1.161 GB）** | 根目录全树实测 |
| `.git/` 体积与对象完整性 | ≤ 200 MB，`git fsck --full` 0 错误 | **181.48 MiB**（`941c968` 提交前）／**181.58 MiB**（`941c968` 提交后），`git fsck --full` 退出码 0 | `.git/` |
| 单次 `accept-offline` 产物大小与纯净度 | < 5 MB，`sourceUnchanged: true`，`realServiceCalls: 0`，`tmpRemoved: true` | 每个 run 运行目录 **1.00 MiB**（3 次均 `sourceUnchanged: true`、`realServiceCalls: 0`、`tmpRemoved: true`） | `test-results/backend-acceptance/p5-2026-11-22T05-27-17-893Z-828049f8`、`p5-2026-11-22T05-37-59-894Z-83abe7a1`、`p5-2026-11-22T05-45-19-258Z-e913a791` |
| 后端正式测试与交付自检 | 551／551（0 跳过/删减），交付单测全过 | 69 个测试文件 **551／551** 通过；`delivery-tests` **5／5** 通过 | `apps/backend/scripts/verify/run-tests.mjs`、`acceptance.test.mjs` |
| 后端评测辅助单测（独立脚本） | 通过 | **8／8** 通过（需 `--import tsx`，初版未接入主链，已于 §7.3 正式接入 `verify.mjs`） | `apps/backend/scripts/eval/*.test.mjs` |
| 桌面渲染器、桌面壳与跨端集成单测 | 0 跳过/删减 | 渲染器 ESM 单测（18 文件）**132／132**、桌面壳 CJS 单测（3 文件）**13／13**、跨端 `feed-integration` **3／3** | `apps/desktop/renderer/tests/`、`apps/desktop/tests/{unit,integration}/` |
| 桌面 Electron E2E 与孤儿进程 | 15／15 全过，0 孤儿 `electron.exe` | 连续 3 轮 **15／15** 全部通过（`complete: true`、`entryStable: true`），跑后 `electron.exe` 进程数 **0** | `test-results/desktop-e2e/e2e-2026-11-22T05-46-44-330Z-dc49c13a/gates.json` |
| 样式门禁、文档巡检与仓库卫生护栏 | 0 违规 / 0 错误 | `lint:styles` 28 个 CSS **0 违规**（豁免 387 ≤ 387）；`check-docs.mjs` 核心 13 份 + 归档 156 份 **0 错误、0 警告**；`check-repo-hygiene.mjs` 706 个跟踪文件、0 组 JS/声明配对、**0 错误**（6 条温和告警） | `scripts/check-docs.mjs`、`scripts/check-repo-hygiene.mjs` |

---

## 7. 终验独立复核与 B1～B4 补正记录（2026-11-22）

### 7.1 只读独立复核结论（`2f4fdd04-91a6-419d-89ec-e2e209ca6b3c`，针对 `941c968`）

独立只读复核逐项核验了目录结构（Wave 1～6）、6 条卫生护栏、红线（`workflow-simplification-fixes` + `workflow-recovery-fixes` 33 条用例及 286 行 `assert` 零删减、0 `skip`/`todo`/`only`、`git diff bc42816..HEAD -- apps/backend/src` 仅 8 行类型路径变更且零业务/默认值改动、`background-tools.acceptance.ts` 仅调整测试注入 `WAIT_MS`/`delays`）、三轮 `summary.json` / `gates.json` 原始报告、真实 `eval/*.test.mjs` 8/8 与 `.git/` `git fsck --full`：

- **功能与结构红线**：**0 项阻塞缺陷**（目录、红线、护栏实现与三轮运行证据实质内容全部成立）。
- **文档与证据真实性待补正项（4 项：`B1～B4`）与非阻塞观察项（11 项：`O1～O11`）**：
  - `B1`：本文 §6.2／§6.4 误写了不存在的 commit 哈希 `655640f`／`3884965`（真实哈希为 `2be894f` 与 `4a6e982`）。
  - `B2`：[conversation-performance-and-scene-images.md](../../specs/conversation-performance-and-scene-images.md)、[role-config-and-activity.md](../../specs/role-config-and-activity.md)、[tts-and-image-services.md](../../specs/tts-and-image-services.md)（及 [frontend-design-system.md](../../specs/frontend-design-system.md) L280 `tests/unit/design-tokens.test.cjs`）代码块与链接标签仍保留旧测试/E2E 命令或 `.js`/`.test.cjs` 显示名。
  - `B3`：[STATUS.md](../../STATUS.md) 历史章节仍引用早已轮转清理且写着 `apps/backend/test-results/` 的 2026-11-18～21 `p5-*` 路径，且下文“保留约 1.7 GiB 全部为引用目录”的表述易引起误解。
  - `B4`：本文 §4 标题写了“已于第 6 节全部完成”，而第 3 项（锁定中的 `.packaging*` 目录）尚未删除，仍作为非阻断告警保留。
  - 主要非阻塞观察项：`O1`（`tokens.json` L9 `"devDoc/..."` 及 `SCAN_ROOTS` 缺 `tools/`/`tokens.json`/`package.json`）、`O2`（`verify:fast` 升级条件措辞）、`O3`（`MIN_DELIVERY_TESTS=3` 低于实际 5 条）、`O4`（`LEGACY_REMOVED_PREFIXES` 仍含针对 `docs/archive/` 的 `prototypes/`）、`O6`/`O7`/`O8`（脏工作区 `gitHead=4a6e982`、`.git/` `181.58 MiB`、`eval` 证据路径、§2.3 目录树重写伪影）、`O9`（`apps/desktop/tests/e2e/` 实有 16 个文件，`relations-review-234.e2e.cjs` 为手动多模式对照脚本，有意未列入 `run-e2e.cjs` 15 条全自动 `SUITE`）。

### 7.2 补正实施与终验复跑（离线范围）

1. **补正与护栏加固**：
   - 修复 `B1～B4` 与 `O1～O4`、`O6～O9`：`docs/design/character-studio/tokens.json` 改用 `docs/specs/frontend-design-system.md` 并重跑 `npm run tokens` 确认 `character-tokens.css` 零漂移；`scripts/check-repo-hygiene.mjs` `SCAN_ROOTS` 纳入 `tools/`、`tokens.json`、`package.json`；`accept-offline.mjs` `MIN_DELIVERY_TESTS` 从 `3` 收紧为 `5`；清理全部 4 份 `docs/specs/` 文件内的过时命令与链接标签；修正 `STATUS.md` 与本文 `405` 中的 commit 哈希、计数（`fixtures/` 5 文件、`scripts/eval/` 21 文件）、运行目录口径说明与历史轮转标注。
   - **明确说明 `O5`/`O9`/`O10`/`O11`**：`O9` 中的 `relations-review-234.e2e.cjs` 为需传参分场景人工对比截图的交互复核脚本（`base`/`many`/`inner`），有意不加入 `run-e2e.cjs` 的 15 条自动化门禁；`O10` 中的 `background-tools.acceptance.ts` `WAIT_MS=1_500` 在 0.3～0.7s 本机 MCP 握手上留有 2x+ 余量且连续全过；`O11` 归档方案 `repo-optimization-plan.md` §3.1 保留原定稿计数口径作为历史基准，实际最终文件数以本记录 §6.4 为准。
2. **补正后实测结果（Node 24.22.2，离线范围）**：
   - `npm run tokens` + `cd apps/desktop/renderer && npm run check`：通过（`character-tokens.css` 同步、28 个 CSS 零违规、豁免 387、`tsc --noEmit` 0 错误）。
   - `node scripts/check-docs.mjs`：核心 13 份 + 归档 156 份，**0 错误、0 警告**；`node scripts/check-repo-hygiene.mjs`（含扩展后的 `SCAN_ROOTS`）：跟踪文件 706 个、0 组 JS/声明配对、**0 错误**（6 条温和告警）。
   - 后端交付与评测单测：`acceptance.test.mjs` **5／5** 通过、`scripts/eval/*.test.mjs`（`--import tsx`）**8／8** 通过。
   - `npm run verify:fast`：因 `accept-offline.mjs` 属于 `apps/backend/scripts/` 改动触发全量后端单测升级，**7／7** 全部通过（墙钟 **49.9 s**，含 551／551 后端单测 49.8 s + 132／132 渲染器单测 0.3 s + 类型/样式/文档/卫生检查）。
   - `npm run verify:gate`：**9／9** 全部通过，总墙钟 **125.7 s**（≤ 140 s）：
     - `accept-offline.mjs`：**84.2 s**（报告内部起止 **83.87 s** ≤ 95 s），**21／21** 步全过（`delivery-tests` **5／5**、`tests` **551／551** / 69 个测试文件、`sourceUnchanged=true`、`realServiceCalls=0`、`tmpRemoved=true`，运行目录 `test-results/backend-acceptance/p5-2026-11-22T11-51-54-373Z-9bc9f8bf/` 体积 **1.00 MiB**）；
     - `desktop-e2e`：**41.6 s**（`gates.json` 起止 **41.49 s** ≤ 65 s），**15／15** 全过（`complete=true`、`entryStable=true`，报告 `test-results/desktop-e2e/e2e-2026-11-22T11-53-18-527Z-92069f61/gates.json`），跑后孤儿 `electron.exe` **0**；
     - 仓库总占用 **1.083 GiB（1.162 GB）**（≤ 1.2 GB），`.git/` **181.58 MiB**（≤ 200 MB），`git fsck --full` 退出码 0。

### 7.3 治理专项三项细节收口（2026-11-22）

针对全面复核指出的 3 项非阻断小尾巴完成收口（本机自验，离线范围）：

1. **散落测试残留与 `.packaging*` 清理（`scripts/clean-artifacts.mjs`）**：
   - 在 `collectReviewBloat()` 增加对 `test-results/` 根及子根下未被文档引用的散落单文件清理规则（保留文档提及的 `p2-02/03/04*.log` 与 `role-style-final-n20.log`）。
   - 执行 `node scripts/clean-artifacts.mjs --apply --keep-runs 5`：清理 **313 个目标**，释放 **16.04 MiB**（此前被占用的 `.packaging/` 与 `.packaging-28948/` 已解除占用并随本轮一并删除，卫生巡检警告由 6 条降至 4 条）。
   - 清理后排除用户本地调试生成的数据目录（`apps/backend/.nowadays-desktop/`，59.78 MiB）仓库占用为 **1.067 GiB（1.146 GB）**（二进制与十进制均 ≤ 1.20 GB；含该本地运行目录为 **1.125 GiB / 1.208 GB**）。
2. **评测脚本单测接入 `verify.mjs` 与头部用法注释修正**：
   - `scripts/verify.mjs` 新增 `backendEvalTests()`，将 `apps/backend/scripts/eval/*.test.mjs`（**8／8**）正式接入 `fast`（含关键字匹配）、`unit`（10/10）与 `gate` 预检并行池。
   - 修正 `apps/backend/scripts/eval/` 下 `role-prompt-ablation.mjs`、`role-world-http-summary.mjs`、`role-world-http.mjs`、`score-role-dialogue.mjs`、`summarize-world-dialogue.mjs`、`verify-role-life-http.mjs` 共 6 处头部注释的脚本/输出路径为新目录结构。
3. **补全本地配置忽略规则**：根 `.gitignore` 增加 `/.claude/`。
4. **验证结果（Node 24.22.2，离线范围）**：
   - `node scripts/check-docs.mjs`：核心 13 份 + 归档 156 份，**0 错误、0 警告**；
   - `node scripts/check-repo-hygiene.mjs`：706 个跟踪文件、0 组 JS/声明配对、**0 错误、4 警告**（仅余 `file-size-budget`）；
   - `npm run verify:fast -- role`：**6／6** 通过（墙钟 **28.3 s**，含 `backend-eval-tests` 8／8 耗时 2.7 s、`backend-tests:7` 54／54 耗时 28.1 s）；
   - `npm run verify:unit`：**10／10** 通过（墙钟 **54.6 s** ≤ 60 s，含 `backend-eval-tests` 8／8、`backend-tests` 551／551 耗时 39.9 s、`renderer-tests` 132／132、`desktop-tests` 13／13、`feed-integration` 3／3）。


