# Nowadays 仓库治理与架构优化锚点方案（P0 → P1 → P2 + P3）

> **定位**：本项目目录结构重组、命名标准化、磁盘清理与测试提速专项的**唯一根锚点文件**（v2 复核定稿）。  
> **当前状态**：**已全量实施完成（P0 → P1 → P2 Wave 1～6 + P3）并归档**至 [docs/archive/07-documentation/repo-optimization-plan.md](./repo-optimization-plan.md)，各波次与冷热终验实测见 [405 执行记录](./405-repo-optimization-execution-record.md)。

---

## 0. 已确认决策总表与进度追踪

### 0.1 已确认决策边界

| 阶段 | 决策项 | 已确认方案 |
| --- | --- | --- |
| **P0** | 历史残留清理范围 | **A + B + C 全清**：A 档根残留（~4.7 GB）+ B 档 `test-results` 瘦身清理（~94.5 GB，保留 `STATUS.md` 引用报告的 JSON/日志）+ C 档 `.git/` 瘦身（~234 MB） |
| **P0** | C 档 `.git/` 瘦身方式 | **零历史重写方案**：实测 4 条分支均无 `.nowadays-review` 提交，234.4 MB 对象仅由 10 条本地 `refs/codex/turn-diffs/*` 持有；仅删本地快照引用 + `git gc`（0 SHA 变更，不触及远端） |
| **P0** | Node 24 开发运行时解耦 | **方案 2A**：从 `prototypes/p0/.runtime/node-v24.22.2-win-x64/` 迁至根忽略目录 `.tools/node-v24/`，更新 5 处引用 |
| **P0** | 测试与验收止血 | **全部确认**：`p2-05-fixture.ts` 默认关闭预置拷贝 + 修补 `finally` 漏删 + `process-smoke.ts` 迁入 `os.tmpdir()` 并在 `finally` 清理 + `accept-offline.mjs` 父进程清 `run/tmp` 与自动轮转 + `scripts/clean-artifacts.mjs` + `scripts/repo-paths.mjs` |
| **P0** | `test-results/` 路径收口时机 | **方案 4A**：P0 暂保持 `backend/test-results/`（常量化），P2 Wave 6 统一迁至根 `test-results/backend-acceptance/` |
| **P1** | 统一入口与验证分层 | **同意（含三层门禁）**：根 `package.json` + `scripts/verify.mjs` 编排 `verify:fast`（10–25s）/ `verify:unit`（40–60s）/ `verify:gate`（90–130s），采用确定性领域映射 + 底层改动自动升级 |
| **P1** | `accept-offline.mjs` 并行化 | **方案 2A**：零覆盖损失；Stage A 并发 + Stage C（16 个 `reviews/` + `process-smoke`）默认 4 并发池 + 持久化 `NODE_COMPILE_CACHE` + `--only` 显式标记 `partial: true` |
| **P1** | 桌面 Electron E2E 提速 | **同意**：新增 `run-e2e.cjs`（默认 3 并发 + `--filter` + 进程树超时清理 + 轮转）；6 条不验预置图的实后端 E2E 传空 `--preset-assets-dir` |
| **P1** | 编译缓存与慢单测优化 | **方案 4A**：后端与渲染器开启增量 `tsc`（`.tools/tsbuildinfo/`）+ 持久化 `NODE_COMPILE_CACHE`（`.tools/compile-cache/`）+ 仅对 P0 后仍 >3s 的极少数慢单测收紧测试注入超时 |
| **P2** | 顶层目录架构 | **方案 1B（标准 Monorepo）**：`apps/backend/`、`apps/desktop/`、`docs/`（原 `devDoc/`）、`tools/`、`scripts/`、全局唯一 `test-results/` |
| **P2** | 桌面扁平化与 `tokens.json` | **2.1 + 2.2 + 2.3b**：消除 `desk-preview/` 嵌套并删 8 个旧书桌死文件 + 2 条旧单测；生图脚本迁至 `tools/art-pipeline/`；`tokens.json` 留在文档侧 `docs/design/character-studio/tokens.json` |
| **P2** | 前端 TS 一致性与测试分层 | **同意（含 ESM/CJS 分治）**：消灭 `renderer/src/` 中 24 组 `.js/.d.ts` 合并回 `.ts`；其单测归 `apps/desktop/renderer/tests/`（ESM+`tsx`），壳单测留 `apps/desktop/tests/unit/`（CJS），跨端 `feed-integration.test.ts` 归 `apps/desktop/tests/integration/`；`Relations.tsx` 入 `pages/`；理顺 CSS 分界 |
| **P2** | 后端内部整理力度 | **方案 4A**：`src/application/`（42 文件）与 `src/storage/`（23 文件）按业务域二级分包；`tests/` 分 `unit/integration/acceptance/fixtures` 并淘汰 `p1~p27` 撞号前缀；`reviews/` 16 个去日期入 `acceptance/`、9 个核验移除；`scripts/` 分 `verify/` 与 `eval/` |
| **P2** | 历史遗留目录去留 | **方案 5A**：从主开发分支移除 `prototypes/` 与 `.archify/`（`/.archify/` 整体加入 `.gitignore`） |
| **P2** | 归档文档 890 处代码链接策略 | **复核方案 B**：保留 `check-docs.mjs` 全树链接硬校验；新增 `scripts/rewrite-doc-links.mjs` 按每波精确映射表重写全部 ~1,045 处文档链接（含 890 处 `archive/`），已删死文件显式登记 `LEGACY_REMOVED_TARGETS` |
| **P3** | 工程防反弹护栏 | 新增 `scripts/check-repo-hygiene.mjs`（6 条规则）接入 `verify:*` |

### 0.2 实施进度 Checklist

- [x] **P0-Step 1**：迁出 `.tools/node-v24/` + 更新 `.gitignore` + 新建 `scripts/repo-paths.mjs` + 更新 5 处运行时引用
- [x] **P0-Step 2**：`p2-05-fixture.ts` 止血 + 修补 `finally` 漏删 + `process-smoke.ts` 清理 + `accept-offline.mjs` 清 `tmp`/轮转 + `scripts/clean-artifacts.mjs`
- [x] **P0-Step 3**：P0 回归自验（含 Electron `allowRootFallback: false` 前置校验 & 新 `p5-*` 体积 < 5 MB）
- [x] **P0-Step 4**：清理 A 档 + B 档历史残留（释放 ~98.5 GB）
- [x] **P0-Step 5**：清理本地 10 条 `refs/codex/turn-diffs/*` + `git gc`（瘦身 ~234 MB，核验 0 SHA 变更）
- [x] **P1-Step 1**：新建根 `package.json` + `scripts/verify.mjs`（三层门禁与确定性域映射）
- [x] **P1-Step 2**：`accept-offline.mjs` Stage A/C 并发池 + 持久化 `NODE_COMPILE_CACHE` + `--only` 部分标记
- [x] **P1-Step 3**：新建 `run-e2e.cjs` 并发调度器 + 6 条实后端 E2E 空 `--preset-assets-dir` 提速
- [x] **P1-Step 4**：后端与渲染器开启增量 `tsc` + 复测后收紧仍 >3s 的极少数慢单测 + P1 三连跑验收
- [x] **P2-Wave 1**：新增 `scripts/rewrite-doc-links.mjs`；清理 `prototypes/`、`.archify/`、8 个旧书桌死文件 + 2 条旧单测
- [x] **P2-Wave 2**：顶层骨架迁移 `backend/` → `apps/backend/`、`devDoc/` → `docs/`、`desktop/desk-preview/tools/` → `tools/art-pipeline/` + 全树文档链接重写
- [x] **P2-Wave 3**：`desktop/desk-preview/` 扁平迁入 `apps/desktop/` + 5 处硬编码路径修复 + `paths.cjs` + 重跑 `npm run tokens` + 文档链接重写
- [x] **P2-Wave 4**：合并 23 组 `.js/.d.ts` + 1 份无配对 `.js` → `.ts` + `renderer/tests/`（ESM）与 `desktop/tests/unit/`（CJS）与 `tests/integration/`（跨端）分治 + `Relations.tsx` 与 CSS 收敛 + 文档链接重写
- [x] **P2-Wave 5**：`apps/backend/src/application/` 与 `storage/` 按业务域二级分包 + 文档链接重写
- [x] **P2-Wave 6**：`apps/backend/tests/` 分层重命名 + `reviews/` 归并清理 + `scripts/` 拆 `verify/eval` + 递归测试发现与最低文件/用例数守卫 + `test-results/backend-acceptance/` 收口 + 文档链接重写
- [x] **P3**：落地 `scripts/check-repo-hygiene.mjs`（6 条护栏规则）并完成冷热全链路终验

---

## 1. P0 阶段：磁盘清理、运行时解耦与测试止血

> **基线实测**：当前仓库总计 ~100.7 GB，其中 `backend/test-results/` 91.81 GB（240 次 `p5-*` 占 90.28 GB，单次 1.64 GB）、`.cache/` 3.35 GB、根 `test-results/` 3.09 GB、根旧 `node_modules/` 501 MB、`.git/` 430 MB、旧 `release/` 351 MB、`prototypes/` 264 MB、`.nowadays-review/` 236 MB。  
> **前置红线**：必须先完成 Step 1 才可删 `prototypes/p0/.runtime/`；必须先校验 Electron `allowRootFallback: false` 才可删根 `node_modules/`；加载了 `backend/scripts/fs-guard.mjs` 的子进程只能递归删 `P1_REVIEW_TMP_ROOT` 内部目录。

### 1.1 Step 1：Node 24 运行时迁出与路径注册表
1. 移动 `prototypes/p0/.runtime/node-v24.22.2-win-x64/` → `.tools/node-v24/`，在根 `.gitignore` 增加 `/.tools/`。
2. 新建 `scripts/repo-paths.mjs`，集中导出 `repoRoot`、`backendDir`、`desktopDir`、`rendererDir`、`docsDir`、`toolsDir`、`backendTestResultsDir`、`rootTestResultsDir`、`localNode24Exe`，供 P0/P1/P2 全部工程脚本统一引用。
3. 更新 5 处引用：
   - `desktop/desk-preview/backend-paths.cjs`（L17）：开发态 `runtimeDir` 指向 `.tools/node-v24`；`resolveNodeExecutable` 优先级为打包态 `resources/node-runtime → NOWADAYS_NODE_PATH → node`、开发态 `NOWADAYS_NODE_PATH → .tools/node-v24 → node`；
   - `desktop/desk-preview/tests/pack3-packaging.test.cjs`：同步更新开发态 `layout.nodeRuntime` 与优先级断言；
   - `desktop/desk-preview/tests/settings-auto-reload-check.cjs`（L12）与 `settings-binding-recovery-check.cjs`（L12）：改为复用 `../backend-paths.cjs`；
   - `backend/README.md`（L20–L26）：路径示例更新为 `..\.tools\node-v24`。

### 1.2 Step 2：测试与验收止血改造
1. **`backend/tests/p2-05-fixture.ts`（L84–L98）**：默认传入 `disablePresetAssistant: true`（位于 `...options` 之前，允许覆盖）。试跑全量后，若个别用例隐式断言总角色数为 2，不改业务断言，改为显式传 `{ disablePresetAssistant: false }` 并配空目录或最小 1×1 PNG 预置夹具。
2. **修补 `finally` 漏删临时目录**：仅将**用例末尾 `finally`** 中误写 `fixture.app.close()` 改为 `await fixture.close()`（**严禁改动用例中段模拟进程重启的 `fixture.app.close()`**）。重点清单：
   - `backend/reviews/`：`20261104-p4-acceptance.ts`（L142/175/253/277）、`20261105-p4-remaining-acceptance.ts`（L270）、`20261106-p5-task-decisions.ts`（L222/288）；
   - `backend/tests/`：`p2-03-memory-query.test.ts`（17 建 5 关，补全 `try/finally`）、`p10-auto-scene.test.ts`、`p11-scene-image-planning.test.ts`、`p12-role-settings.test.ts`（15 处收尾）、`p14-role-activity.test.ts`、`p15-resource-management.test.ts`、`p16-role-deletion.test.ts`、`p18-278-review-fixes.test.ts`（8 处）、`p4-*.test.ts`、`p5-task-decisions.test.ts`、`p6-*.test.ts` 的最终 `finally`。
3. **`backend/scripts/process-smoke.ts`（L14–L168）**：保持预置助手开启（L110 断言 `activityItems.length === 2`），将 `appRoot` 改为 `fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-process-smoke-"))`（自动落入 `P1_REVIEW_TMP_ROOT = run/tmp/`，满足 `fs-guard.mjs` 约束），在 `finally` 写出报告后通过时清理 `appRoot`（失败时保留排障）。
4. **`backend/scripts/accept-offline.mjs` + `acceptance-lib.mjs` + `acceptance.test.mjs`**：
   - 新增 `--keep-tmp` 参数；
   - **由未加载 `fs-guard.mjs` 的父进程**在 `finally` 保存 `summary.json` 后：通过且未指定 `--keep-tmp` 时删 `run/tmp/`；并按 `ACCEPT_KEEP_RUNS`（默认 `5`，`0`/`all` 禁用）自动轮转清理更早的 `p5-*` 目录；
   - 在 `acceptance.test.mjs` 补齐轮转纯函数单测；输出根暂保留 `backend/test-results/`（方案 4A，常量化）。
5. **新增 `scripts/clean-artifacts.mjs`**：消费 `scripts/repo-paths.mjs`，默认 `--dry-run` 仅预览，显式 `--apply` 才执行；支持 `--legacy`、`--test-results`、`--keep-runs <N>`、`--protect-status-refs`（默认开启：保护 `STATUS.md` 引用的报告目录，仅删其内部 `tmp/` 与大图/临时库，保留 JSON 与 `.log`）；硬编码禁止删除任何 `git ls-files` 跟踪文件及 `.tools/node-v24/`。

### 1.3 Step 3–5：验证与三档清理
- **Step 3 回归门禁**：后端 `tsc` + 全量单测（551/551）+ `accept-offline.mjs`（21/21 且新 `p5-*` 体积 **< 5 MB**）+ 桌面单测 + `resolveElectronExecutableInfo({ allowRootFallback: false })` 确认为 `desktop-local` + 实跑 `settings-auto-reload-check.cjs` 与 `settings-binding-recovery-check.cjs` + `node scripts/check-docs.mjs`（0 错误）。
- **Step 4 清理 A+B 档**：
  - A 档（0 跟踪文件）：`.cache/`、根 `node_modules/`、`release/`、`.nowadays-review/`、`prototypes/p0/.runtime/`、`prototypes/p0/node_modules/`、`desktop/renderer/`、`desktop-dist/`、`dist/`、`release-build/`、`.packaging/`、`.packaging-28948/`；
  - B 档：`node scripts/clean-artifacts.mjs --test-results --protect-status-refs --dry-run` 预览确认后 `--apply`。
- **Step 5 清理 C 档（零历史重写）**：
  ```powershell
  git show-ref > D:\app\nowadays\accompany-refs-backup.txt
  git for-each-ref --format="%(refname)" refs/codex/turn-diffs/ | ForEach-Object { git update-ref -d $_ }
  git reflog expire --expire=now --all
  git gc --prune=now --aggressive
  git fsck --full
  git count-objects -vH
  ```
  核验 4 条分支 `git rev-parse` 与备份 **100% 一致（0 SHA 变更）**，`.git/` 从 ~430 MB 降至 ~180–200 MB。

---

## 2. P1 阶段：测试与验证流水线提速

> **基线实测**：完整一轮验证约 **460s（~7.7 分钟）**（前置重复 `tsc`+`npm test` 82.5s + `accept-offline.mjs` 219.6s [其中 16 个 `reviews/` 串行 128.8s] + 桌面单测与检查 ~15s + 14 条 Electron E2E 串行 142.6s）。  
> **提速目标**：`verify:fast` **≤ 25s**、`verify:unit` **≤ 60s**、`accept-offline` **≤ 95s**、`run-e2e` **≤ 65s**、`verify:gate` 端到端 **≤ 140s**（0 用例删减）。

### 2.1 Step 1：根 `package.json` 与 `scripts/verify.mjs`（三层门禁）
1. 新建根 `package.json`（`private: true`，不装根 `node_modules`），暴露 `verify:fast`、`verify:unit`、`verify:gate`、`verify:e2e`、`check:docs`、`clean:artifacts`。
2. 新建 `scripts/verify.mjs`（消费 `scripts/repo-paths.mjs`）：
   - 自动定位 Node 24（`NOWADAYS_NODE_PATH → .tools/node-v24/node.exe → PATH node`）；
   - 预创建并全局注入持久化缓存目录 `NODE_COMPILE_CACHE=<repo>/.tools/compile-cache` 与 `.tools/tsbuildinfo/`；
   - **Tier 1 `verify:fast`**（支持 `-- <keyword...>`）：并发增量 `tsc` + 确定性域映射单测（仅改文档仅跑 `check-docs`；仅改前端跳过后端单测；改具体业务域跑对应单测组；**改 `bootstrap/`、`storage/schema`、`storage/core/`、`http/routes`、`http/server`、`domain/errors`、`package.json` 自动升级为全量后端单测**，杜绝虚假绿灯）+ 渲染器 `tokens:check`/`lint:styles` + 桌面单测 + `check-docs`；
   - **Tier 2 `verify:unit`**：并发增量 `tsc` + 后端全量单测 + 渲染器 `check` & `build` + 桌面单测 + `check-docs`；
   - **Tier 3 `verify:gate`**：并行化 `accept-offline.mjs`（21 步，不再前置重复跑 `tsc` 与 `npm test`）+ 渲染器 `check` & `build` + 桌面单测 + 并发 E2E 全量门禁 + `check-docs`。

### 2.2 Step 2：`accept-offline.mjs` DAG 并发化
- **Stage A（并发）**：`typecheck` + `review-typecheck` + `delivery-tests`；
- **Stage B**：全量 `tests`（保持 `ACCEPT_TEST_CONCURRENCY=8` 防时序抖动）；
- **Stage C（有界并发池）**：`process-smoke` + 16 个 `reviews/*.ts` 默认 `ACCEPT_REVIEW_CONCURRENCY=4`（已核实全部使用端口 `0` 与独立临时目录）；`summary.json` 中 `steps` 按固定顺序写入；
- 显式透传 `NODE_COMPILE_CACHE=<repo>/.tools/compile-cache`（不触发 `fs-guard.mjs`）；
- 支持 `--only <steps>` 调试过滤，使用时 `summary.json` 必须写入 `"partial": true` 与 `"selectedSteps"`；补齐 `acceptance.test.mjs` 单测。

### 2.3 Step 3：桌面 Electron E2E 并发调度器与空预置目录提速
1. 新建 `desktop/desk-preview/tests/run-e2e.cjs`：纳管全部 15 条 `*-check.cjs`（已核实全部使用 `--remote-debugging-port=0` 与独立 `--user-data-dir`）；默认 `E2E_CONCURRENCY=3`、支持 `--filter`/`--list`、校验 `renderer/dist` 入口哈希、单条超时 120s 用 `taskkill /PID <pid> /T /F` 杀进程树、统一写 `test-results/desktop-e2e/<run-id>/gates.json` 并轮转保留 5 次。
2. 对 6 条不验证「夏澄」官方图片的实后端 E2E（`settings-auto-reload`、`settings-binding-recovery`、`settings-real-backend`、`settings-review-fixes`、`startup-flow-fixes`、`token-usage`）传入空临时 `--preset-assets-dir` 跳过 353 MB PNG 拷贝（`pack3-entry-check` 与 `workflow-real-backend-chain-check` 保持完整预置目录），并统一复用 `backend-paths.cjs`。

### 2.4 Step 4：增量 `tsc`、持久化编译缓存与慢单测定向优化
1. `backend/tsconfig.json` 与 `desktop/desk-preview/renderer/tsconfig.json` 开启 `"incremental": true`，`tsBuildInfoFile` 指向 `.tools/tsbuildinfo/{backend,renderer}.tsbuildinfo`（位于 `backend/` 源码清单外，不破坏 `sourceUnchanged`）。
2. P0 + 缓存落地后实测后端单用例耗时，仅对仍 >3s 的极少数慢用例（候选：`p13-comfyui.test.ts` L1103、`p5-task-decisions.test.ts` L178、`p2-05-mcp.test.ts` L408、`p1-05-api-cli.test.ts`）调小测试注入超时/轮询参数，绝不改生产默认值与断言。
3. **P1 验收**：清空 `.tools/{tsbuildinfo,compile-cache}` 冷跑 1 次 + 热跑 2 次 `verify:gate`，连续 3 次 21/21 步 + 551/551 单测 + 15 条并发 E2E 全绿，0 孤儿进程；同步更新 `AGENTS.md` 与 `README.md`。

---

## 3. P2 + P3 阶段：标准 Monorepo 重组、命名标准化与工程护栏

### 3.1 最终目标目录结构

```text
nowadays/
├── package.json / .gitignore / AGENTS.md / README.md
├── apps/
│   ├── backend/                          # @nowadays/backend（原 backend/）
│   │   ├── src/
│   │   │   ├── main.ts / cli.ts / bootstrap/ / cli/ / domain/ / http/ / model/ / mcp/ / scene/ / skills/ / security/ / tts/
│   │   │   ├── application/              # conversation/(9) memory/(4) role/(6) transfer/(7) media/(9) resources/(6)
│   │   │   └── storage/                  # core/(7) conversation/(4) memory/(2) role/(3) media/(7)
│   │   ├── tests/                        # fixtures/ unit/ integration/ acceptance/(16)
│   │   ├── scripts/                      # verify/(5) eval/(18)
│   │   └── assets/ examples/
│   └── desktop/                          # @nowadays/desktop（原 desktop/desk-preview/ 扁平上提，CJS 壳）
│       ├── electron/                     # main.cjs、settings-preload.cjs、backend-paths.cjs
│       ├── renderer/                     # @nowadays/desktop-renderer（ESM）
│       │   ├── src/                      # pages/(含 Relations.tsx)、components/、conversation/、relations/、feed/、entry/、lib/、ui/、styles/、assets/（0 组 .js/.d.ts）
│       │   └── tests/                    # 18 条前端纯逻辑单测（ESM + tsx）
│       ├── scripts/                      # generate-character-theme.mjs、check-design-tokens.mjs
│       ├── tests/
│       │   ├── helpers/                  # paths.cjs、electron-executable.cjs、config-page-controls.cjs、run-e2e.cjs
│       │   ├── unit/                     # Electron 壳/打包/令牌单测（CJS）
│       │   ├── integration/              # feed-integration.test.ts（后端依赖上下文 + tsx）
│       │   ├── e2e/                      # 15 条离线 Electron E2E（*.e2e.cjs）
│       │   └── live/                     # 4 条实机脚本（*.live.mjs）
│       └── assets/ package.json ART-GENERATION-GUIDE.md
├── docs/                                 # 原 devDoc/（含 docs/design/character-studio/tokens.json）
├── tools/art-pipeline/                   # 原 desktop/desk-preview/tools/（5 个生图 Python 脚本）
├── scripts/                              # repo-paths.mjs、verify.mjs、clean-artifacts.mjs、check-docs.mjs、rewrite-doc-links.mjs、check-repo-hygiene.mjs
├── .tools/                               # gitignore：node-v24/、compile-cache/、tsbuildinfo/
└── test-results/                         # gitignore：全局唯一测试产物根（backend-acceptance/、desktop-e2e/）
```

### 3.2 六个原子迁移波次（每波独立提交 + `check-docs.mjs` 0 错误）

> **全树文档链接重写机制（复核方案 B）**：Wave 1 前先建 `scripts/rewrite-doc-links.mjs`（输入每波精确 `[{ from, to }]` 映射表，解析 Markdown 相对链接并按文件所在目录重算相对路径，保留 `#锚点` 与 `:行号`，跳过代码块与外链）。每波 `git mv` 后即刻重写 `AGENTS.md`、`README.md` 与 `docs/` 全树（含 `docs/archive/` 890 处历史代码链接），并以 `node scripts/check-docs.mjs` 0 错误放行；仅对**有意删除**的文件在 `LEGACY_REMOVED_TARGETS` 中分组登记原因。

- **Wave 1（清理退役目录与死代码）**：
  - `git rm -r prototypes/ .archify/`；根 `.gitignore` 将 `.archify/*` 规则收敛为 `/.archify/`；
  - `git rm` 移除 `desktop/desk-preview/` 根下 8 个旧书桌死文件（`app.js`、`index.html`、`home.css`、`style.css`、`environment.js`、`role-visual.js`、`weather-provider.js`、`window-effects.js`）及 2 条旧单测（`environment.test.cjs`、`role-visual.test.cjs`）；核验并清理/转写 `conversation-review-regression.py`；
  - 更新 `scripts/check-docs.mjs` 移除 `prototypes/p0/README.md` 检查并在 `LEGACY_REMOVED_TARGETS` 登记上述已删历史文件。
- **Wave 2（顶层骨架迁移）**：
  - `git mv backend apps/backend`、`git mv devDoc docs`、`git mv desktop/desk-preview/tools tools/art-pipeline`；
  - 单点更新 `scripts/repo-paths.mjs`；更新 `apps/backend/tsconfig.json`、`desktop/desk-preview/package.json`、`backend-paths.cjs`、`generate-character-theme.mjs`（`sourcePath` → `docs/design/character-studio/tokens.json`）、`scripts/check-docs.mjs`；运行 `rewrite-doc-links.mjs` 全树更新链接。
- **Wave 3（桌面端扁平化入 `apps/desktop/` + 5 处硬编码补漏）**：
  - `git mv` 组装 `apps/desktop/{electron,renderer,scripts,tests/{helpers,unit,integration,e2e,live},assets}`，删空 `desktop/`；
  - 同步更新 `apps/desktop/package.json`（`@nowadays/desktop`、`main: electron/main.cjs`、`build.files`、`extraResources`）、`electron/main.cjs` 与 `backend-paths.cjs` 层级与日志前缀 `[desktop]`；
  - **补漏项**：修正 `tests/helpers/electron-executable.cjs`（`desktopDir = path.resolve(__dirname, '../..')`）与 `electron-executable.test.cjs`；修正 `tests/unit/design-tokens.test.cjs` 与 `apps/desktop/scripts/{generate-character-theme,check-design-tokens}.mjs` 路径与生成头注释并**立即重跑 `npm run tokens`**；新建 `tests/helpers/paths.cjs` 替换 15 条 E2E + 4 条 live 中全部 `'desktop/desk-preview'` 与 `character.png` 硬编码；
  - 更新 `scripts/repo-paths.mjs` + 运行 `rewrite-doc-links.mjs`。
- **Wave 4（前端 TS 统一、ESM/CJS 分治与样式收敛）**：
  - 合并 `apps/desktop/renderer/src/` 下全部 **24 组 `.js + .d.ts`** 为标准 `.ts`（根/工具 6 组 + `components/` 8 组 + `conversation/` 7 组 + `entry/` 1 组 + `relations/` 2 组）；
  - 18 条前端纯逻辑单测迁至 `apps/desktop/renderer/tests/*.test.ts`（ESM + `tsx`）；壳/打包/令牌单测留 `apps/desktop/tests/unit/`（CJS）；跨端 `feed-integration.test.ts` 留 `apps/desktop/tests/integration/` 并接入 `verify.mjs`；
  - `Relations.tsx` 移入 `renderer/src/pages/` 并同步更新 `relations-dossier.test.ts`（原 L87 源码读取路径）；按原层叠顺序将 `ui/relationship-journal*.css`、`relations/memory-correction.css`、`studio-overrides.css` 收敛至 `styles/`（保持 `lint:styles` 0 违规且豁免不增）；运行 `rewrite-doc-links.mjs`。
- **Wave 5（后端 `src/` 二级分包）**：
  - 按 §3.1 蓝图对 `application/`（42 文件 → 6 子域）与 `storage/`（23 文件 → 5 子域）执行纯 `git mv` + 相对 `import` 更新（不做业务改动）+ 运行 `rewrite-doc-links.mjs` 更新 695 处 `backend/src/` 文档链接。
- **Wave 6（后端 `tests/`、`reviews/`、`scripts/` 规范化 + 产物收口）**：
  - 夹具迁入 `tests/fixtures/`（`conversation-fixture.ts` 等），**必改原 `p18-278-review-fixes.test.ts`（L3418）动态脚本模板里的 `"tests/p2-05-fixture.ts"` 硬编码**；
  - 70 个 `*.test.ts` 按 `tests/unit/` + `tests/integration/` 领域重命名（产出精确 70→70 映射表）；`package.json` 的 `test` 与 `accept-offline.mjs` 改为**递归扫描**并在 `acceptance-lib.mjs` 加**最低用例数守卫（`>= 550`）**防静默漏跑；
  - `reviews/` 16 个受门禁脚本去日期迁入 `tests/acceptance/`，9 个未纳入脚本核验覆盖后移除（或将真实诊断脚本迁 `scripts/eval/`）并登记 `LEGACY_REMOVED_TARGETS`；
  - `scripts/` 拆为 `scripts/verify/` 与 `scripts/eval/`；`accept-offline.mjs` 输出正式迁至根 `test-results/backend-acceptance/`；更新 `scripts/repo-paths.mjs` + 运行 `rewrite-doc-links.mjs`。

### 3.3 P3 长期工程护栏：`scripts/check-repo-hygiene.mjs`

接入 `scripts/verify.mjs`，随 `verify:fast` / `verify:unit` / `verify:gate` 自动执行：
1. `hygiene/root-allowlist`（Error）：根目录已跟踪顶层目录仅允许 `apps`、`docs`、`scripts`、`tools`；
2. `hygiene/no-js-dts-pairs`（Error）：`apps/desktop/renderer/src/` 禁止新增 `.js` + 同名 `.d.ts` 配对；
3. `hygiene/test-naming`（Error）：`apps/backend/tests/` 禁止再出现 `p\d+-` 流水号前缀或 `202\d{5}-` 日期前缀；
4. `hygiene/no-legacy-refs`（Error）：代码与脚本禁止残留 `prototypes/p0/.runtime`、`desk-preview`、`devDoc/` 硬编码；
5. `hygiene/no-large-tracked-blobs`（Error）：禁止跟踪非资产白名单目录的 > 2 MB 文件；
6. `hygiene/file-size-budget`（Warning）：超大源码单文件（> 100 KB）温和告警。

---

## 4. 全链路终验指标

| 指标 | 优化前基线 | 终验目标 |
| --- | ---: | ---: |
| 仓库磁盘总占用 | ~100.7 GB | **≤ 1.2 GB**（`.git/` ≤ 200 MB） |
| 单次 `accept-offline.mjs` 产物残留 | 1,638 MB | **< 5 MB**（自动清 `tmp` + 5 次轮转） |
| 日常单域自检 `verify:fast` | ~82.5s+（全量） | **≤ 25s** |
| 提交前全量单测 `verify:unit` | ~95s+ | **≤ 60s** |
| 全量离线门禁 `verify:gate`（21 步 + 15 E2E） | ~460s（~7.7 分钟） | **≤ 140s**（0 用例删减） |
| 门禁零误差 | — | 后端 551/551 + 21/21 + 渲染器/壳/跨端单测 + 15 E2E + `check-docs` 0 错 + `check-repo-hygiene` 0 错 |
