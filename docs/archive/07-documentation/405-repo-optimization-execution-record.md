# 405 仓库结构重组与验证提速执行记录

- 日期：2026-11-22
- 分支：`codex/repo-cleanup-and-restructure`
- 依据：[仓库优化方案](./repo-optimization-plan.md)
- 范围：运行时与产物止血、分层验证与并发、Monorepo 目录迁移（Wave 1～6）、6 条仓库护栏与冷热终验
- 结论：**离线范围全量通过**。首轮迁移（§1～§5）与后续补修及 Wave 4～6 + P3 全量收口（§6）均已完成：完整门禁 `verify:gate` **9／9**（冷跑 **130.9 s**，热跑 **125.1 s / 125.8 s** ≤ 140 s）、`verify:unit` **9／9**（热跑 **40.5 s / 39.4 s** ≤ 60 s）、`verify:fast`（热跑 **1.3 s / 1.4 s**，单域 `fast model` **3.3 s / 3.0 s** ≤ 25 s）、后端 **551／551**（69 个测试文件）、离线验收 **21／21**（84.8 s / 85.1 s ≤ 95 s，`delivery-tests` 5／5，`sourceUnchanged=true`，`realServiceCalls=0`，单次产物 **1.00 MiB** < 5 MB）、渲染器单测 **132／132**、桌面壳单测 **13／13**、跨端集成 **3／3**、Electron E2E **15／15**（40.3 s / 40.7 s ≤ 65 s，孤儿进程 0）、文档巡检 0 错误 0 警告、仓库卫生 6 条规则 0 错误、仓库总占用 **1.081 GiB（1.161 GB）**（`.git/` **181.48 MiB**）。

## 1. 与方案的差异与修正

执行前复核发现方案中的部分事实与操作假设不成立，按下述方式修正，未按原文机械照做：

1. **验收轮转的误删风险**：`p5-*` 不能按通配符整体轮转，`p5-gap-audit` 等审计目录会被误删。改为严格匹配 `^p5-\d{4}-…-[0-9a-f]{8}$`，并扫描 `docs/**/*.md`、根 `README.md`、`AGENTS.md` 中全部 run 引用做保护，不只看 `STATUS.md`。
2. **Git 瘦身备份**：仅备份 ref 文本无法恢复已 prune 的对象。改为先创建并 `git bundle verify` 全引用备份，再删除本地 `refs/codex/turn-diffs/*` 并 `gc`；不动正常分支 reflog。
3. **测试收尾不能盲改**：多处 `app.close()` 是重启用例的中段动作。只修真实的最终收尾泄漏，并为 `p2-03-memory-query` 补 `try/finally`；未确认处保持原样。
4. **E2E 提速顺序**：渲染器构建必须先于 E2E；`--only` 不得输出全量通过结论；`verify.mjs fast` 遇到未知改动或共享底层改动升级为全量。
5. **JS/声明配对实际为 23 组**（另有独立 `bridge.d.ts` 与无配对的 `conversation/fixtures.js`），不是方案中的 24 组。
6. **测试基线**：后端迁移前为 68 个测试文件、551 条用例；E2E 改为显式清单 + 数量守卫，不依赖 glob 推断覆盖面。

## 2. 实际落地

### 2.1 运行时与产物

- 本地 Node 24 运行时迁至 `.tools/node-v24/`（忽略入库），`backend-paths.cjs` 开发态从仓库 `.tools` 解析，打包态仍用 `resources/node-runtime`。
- `scripts/repo-paths.mjs` 统一路径，验收脚本、清理脚本、验证入口均不再依赖 `cwd`。
- `process-smoke` 的 `appRoot` 改为系统临时目录，成功后才清理；失败保留现场并写入报告。
- `scripts/clean-artifacts.mjs`：默认 dry-run，`--apply` 才删除；保护 Git 跟踪文件与文档引用的 run，禁止越出仓库与触碰运行时目录。

### 2.2 分层验证

| 入口 | 内容 | 迁移后实测 |
| --- | --- | --- |
| `node scripts/verify.mjs fast` | 按改动域映射的定向检查 | 约 14 s |
| `node scripts/verify.mjs unit` | 文档 + 卫生 + 后端类型/全量单测 + 渲染器检查/构建 + 桌面单测 + 跨端集成 | 8／8，约 88 s |
| `node scripts/verify.mjs gate` | 渲染器检查/构建 → 离线验收／桌面单测／文档／卫生 → 全部 E2E | 8／8，196 s |
| `node scripts/verify.mjs e2e` | 构建 + 15 条 Electron E2E | 15／15，61 s |

- 离线验收按阶段并发：类型检查与交付回归、全量单测、进程冒烟与业务矩阵；`--only` 明确标记为部分运行，不触发轮转。
- 桌面 E2E 由 `tests/helpers/run-e2e.cjs` 调度：显式清单、独立临时目录、超时清进程树、共享会话与精确动画用例串行、其余并发。

### 2.3 目录结构

```text
apps/
  apps/backend/            # 后端源码、测试、验收脚本、reviews
  desktop/
    electron/         # main / preload / backend-paths
    renderer/         # React + Vite
    tests/            # unit / e2e / integration / live / helpers
    scripts/          # 令牌生成与样式检查
docs/                 # 原 devDoc
tools/art-pipeline/   # 原 apps/desktop/tools
scripts/              # 仓库级验证、清理、文档与卫生工具
```

- 退役并删除：`prototypes/`（含残留 p0 数据）、旧书桌 8 个死文件及 2 条对应单测、`.archify` 中已跟踪的生成页。
- `models-picker`、`feed-integration`、`live/*` 等跨端导入路径已按新层级修正；E2E 根目录多算一层的问题在首轮 E2E 全失败后定位并修复。
- 文档链接由 `scripts/rewrite-doc-links.mjs` 精确映射后重写；历史运行产物已轮转的 6 处报告链接改为代码路径并标注“历史运行产物已轮转”。

### 2.4 仓库护栏

`scripts/check-repo-hygiene.mjs` 已接入 `verify`：

- 退役根目录回流（`apps/backend/`、`desktop/`、`docs/`、`prototypes/`）；
- 被跟踪的 `node_modules/`、`dist/`、`test-results/`、`release/`、日志与编译缓存；
- 新增 `renderer/src/**` 的 `.js + .d.ts` 配对（现有 23 组登记为基线，合并后应逐步删除基线项）；
- 代码、现行规范、`STATUS.md`、根说明中的旧路径硬编码（`docs/archive/` 保留历史路径）；
- `.packaging*` 本地残留只告警，不阻断。

## 3. 验证结果

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

单次验收产物已从 GB 级降到 MB 级；本轮清理临时目录与旧轮转释放约 3.91 GiB。`apps/backend/test-results/` 仍保留约 1.7 GiB，全部为文档引用的历史证据目录。

## 4. 首轮阶段暂缓项（已于第 6 节全部完成）

> 注：本节保留首轮阶段（Wave 1～3）当時の暂缓说明；第 1、2 项已随用户确认在下方[第 6 节](#6-首轮独立复核补修p2-wave-46-与-p3-完整收口2026-11-22实施方离线自验)全量落地并清空基线。

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
   - `scripts/verify.mjs` 补齐 `fast` 关键字过滤（`-- <keyword...>`）、未知/底层改动自动升级全量及 `unit` 必跑 `feed-integration`。
   - `scripts/check-docs.mjs` 收紧移除目标白名单，避免通配误放行；`scripts/rewrite-doc-links.mjs` 保证幂等重写。

### 6.2 Phase B（P2-Wave 4）：前端 TS 统一、ESM/CJS 单测分治与样式收敛（`655640f`）

1. **消灭全部 `.js + .d.ts` 配对**：将 `apps/desktop/renderer/src/` 下全部 **23 组 `.js + .d.ts`** 及无配对的 `conversation/fixtures.js` 合并为严格 `.ts`（保留独立环境声明 `bridge.d.ts`；`lib/token-usage.ts` 保持纯可擦除 TS 类型且零外部运行时导入，兼容 Node 24 原生直跑），清理 32 处 `.js` 相对导入后缀，`check-repo-hygiene.mjs` 中 `JS_DTS_BASELINE` 归零。
2. **页面与样式目录收敛**：`Relations.tsx` 迁入 `apps/desktop/renderer/src/pages/Relations.tsx`；`ui/relationship-journal*.css`、`relations/memory-correction.css`、`studio-overrides.css` 共 5 份样式按 `main.tsx` 原层叠顺序迁入 `apps/desktop/renderer/src/styles/`（28 个 CSS 零违规，豁免保持 387）。
3. **ESM 与 CJS 单测分治**：18 个前端纯逻辑单测（132 条用例）迁入 `apps/desktop/renderer/tests/*.test.ts`（ESM + `tsx`），桌面壳/令牌/打包 3 个单测（13 条用例）保留在 `apps/desktop/tests/unit/*.test.cjs`（CJS），跨端 `feed-integration.test.ts`（3 条用例）位于 `apps/desktop/tests/integration/`，全部接入 `scripts/verify.mjs`。

### 6.3 Phase C（P2-Wave 5）：后端 `application/` 与 `storage/` 业务域二级分包（`f6b8190`）

1. **`apps/backend/src/application/`（42 文件 → 6 个子域）**：
   - `conversation/`（9）、`memory/`（4）、`role/`（7）、`transfer/`（7）、`media/`（9）、`resources/`（6）。
2. **`apps/backend/src/storage/`（23 文件 → 5 个子域）**：
   - `core/`（7）、`conversation/`（4）、`memory/`（2）、`role/`（3）、`media/`（7）。
3. 同步更新全部相对导入、动态内联脚本导入与全树文档链接，零业务语义改动。

### 6.4 Phase D（P2-Wave 6）：后端测试/验收/脚本规范化、LPT 调度与产物收口（`3884965`）

1. **`apps/backend/tests/` 分层与去前缀重命名**：
   - `tests/fixtures/`（4 个夹具：`config-write.ts`、`conversation-fixture.ts`、`legacy-role-fixture.ts`、`zh-memory.json`）；
   - `tests/unit/`（16 个单测文件）与 `tests/integration/`（53 个集成测试文件，含将原 133 KB 单文件 `workflow-simplification-fixes.test.ts` 在第 21/22 条测试边界无损拆分为 `workflow-simplification-fixes.test.ts` [21 条] 与 `workflow-recovery-fixes.test.ts` [12 条]，合计 **69 个正式测试文件、551 条用例**），彻底淘汰 `p1～p27` 流水号前缀；
   - `tests/acceptance/`：原 `reviews/` 下 16 个受门禁纳管脚本去掉 `202611xx-p*-` 日期与阶段前缀迁入 `tests/acceptance/*.acceptance.ts`；2 个真实模型诊断脚本迁入 `scripts/eval/{real-model-diagnostics,real-model-smoke}.ts`；7 个早期一次性探针在确认被正式测试完整覆盖后移除并登记至 `check-docs.mjs` `LEGACY_REMOVED_TARGETS`，删除空的 `apps/backend/reviews/`。
2. **`apps/backend/scripts/` 拆分与 LPT 递归测试执行器**：
   - 拆分为 `scripts/verify/`（`accept-offline.mjs`、`acceptance-lib.mjs`、`acceptance.test.mjs`、`fs-guard.mjs`、`process-smoke.ts`、`run-tests.mjs`）与 `scripts/eval/`（19 个评测与诊断脚本）。
   - 新增 `run-tests.mjs` 与 `collectBackendTestFiles(..., { order: "lpt" })`：使用 Node 24 `node:test` 编程式 `run()` 按文件体积降序（LPT）调度进程池（规避 `node --test` CLI 内部按字母序重排导致的重文件长尾），并强制校验 `MIN_BACKEND_TEST_FILES = 69` 与 `MIN_BACKEND_TESTS = 551`。
   - `accept-offline.mjs` Stage C 非隔离验收池按历史耗时降序（LPT）入池（默认 6 并发，`p4-boundaries` 保持独立通道），输出统一收口至根 `test-results/backend-acceptance/`，原 `apps/backend/test-results/` 历史证据目录整体归并后移除。

### 6.5 Phase E（P3）：6 条仓库卫生护栏、方案归档与冷热三连跑终验（实施方离线自验）

1. **`scripts/check-repo-hygiene.mjs` 全量 6 条规则**：
   - `hygiene/root-allowlist`（Error）：已跟踪顶层目录仅允许 `apps`、`docs`、`scripts`、`tools`；
   - `hygiene/no-js-dts-pairs`（Error）：`apps/desktop/renderer/src/` 禁止 `.js + .d.ts` 配对（基线 0）；
   - `hygiene/test-naming`（Error）：`apps/backend/tests/` 禁止 `p\d+-` 或 `202\d{5}-` 文件名前缀；
   - `hygiene/no-legacy-refs`（Error）：代码、脚本与现行文档禁止残留 `prototypes/p0/.runtime`、`desk-preview`、`devDoc/`、`prototypes/` 硬编码（同步清理 `ART-GENERATION-GUIDE.md`、`electron/main.cjs` 与 `electron-executable.test.cjs` 中 4 处残留字面量）；
   - `hygiene/no-large-tracked-blobs`（Error）：禁止跟踪非资产白名单目录的 `> 2 MB` 文件；
   - `hygiene/file-size-budget`（Warning）：对 `> 100 KB` 的已跟踪源码单文件输出温和告警（当前 4 个文件告警，0 错误）。
2. **冷跑 1 次 + 热跑 2 次全链路实测（Node 24.22.2，离线模型与本地工具样例）**：

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
| `.git/` 体积与对象完整性 | ≤ 200 MB，`git fsck --full` 0 错误 | **181.48 MiB**，`git fsck --full` 退出码 0（零错误/悬空错误） | `.git/` |
| 单次 `accept-offline` 产物大小与纯净度 | < 5 MB，`sourceUnchanged: true`，`realServiceCalls: 0`，`tmpRemoved: true` | **1.00 MiB**（冷跑与两轮热跑均为 1.00 MiB），3 次均 `sourceUnchanged: true`、`realServiceCalls: 0`、`tmpRemoved: true` | `test-results/backend-acceptance/p5-2026-11-22T05-27-17-893Z-828049f8`、`p5-2026-11-22T05-37-59-894Z-83abe7a1`、`p5-2026-11-22T05-45-19-258Z-e913a791` |
| 后端正式测试与交付自检 | 551／551（0 跳过/删减），交付单测全过 | 69 个测试文件 **551／551** 通过；`delivery-tests` **5／5** 通过；`scripts/eval/*.test.mjs` **8／8** 通过 | `apps/backend/scripts/verify/run-tests.mjs`、`acceptance.test.mjs` |
| 桌面渲染器、桌面壳与跨端集成单测 | 0 跳过/删减 | 渲染器 ESM 单测（18 文件）**132／132**、桌面壳 CJS 单测（3 文件）**13／13**、跨端 `feed-integration` **3／3** | `apps/desktop/renderer/tests/`、`apps/desktop/tests/{unit,integration}/` |
| 桌面 Electron E2E 与孤儿进程 | 15／15 全过，0 孤儿 `electron.exe` | 连续 3 轮 **15／15** 全部通过（`complete: true`、`entryStable: true`），跑后 `electron.exe` 进程数 **0** | `test-results/desktop-e2e/e2e-2026-11-22T05-46-44-330Z-dc49c13a/gates.json` |
| 样式门禁、文档巡检与仓库卫生护栏 | 0 违规 / 0 错误 | `lint:styles` 28 个 CSS **0 违规**（豁免 387 ≤ 387）；`check-docs.mjs` 核心 13 份 + 归档 156 份 **0 错误、0 警告**；`check-repo-hygiene.mjs` 706 个跟踪文件、0 组 JS/声明配对、**0 错误**（6 条温和告警） | `scripts/check-docs.mjs`、`scripts/check-repo-hygiene.mjs` |

