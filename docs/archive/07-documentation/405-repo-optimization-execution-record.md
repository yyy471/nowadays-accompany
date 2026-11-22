# 405 仓库结构重组与验证提速执行记录

- 日期：2026-11-22
- 分支：`codex/repo-cleanup-and-restructure`
- 依据：[仓库优化方案](../../../REPO-OPTIMIZATION-PLAN.md)
- 范围：运行时与产物止血、分层验证与并发、Monorepo 目录迁移、仓库护栏
- 结论：**离线范围通过**。目录迁移后完整门禁 8／8、后端 551／551、桌面单测 145／145、Electron E2E 15／15、离线验收 21／21、文档与卫生巡检 0 错误。

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

## 4. 暂缓项与原因

1. **24 组 `.js/.d.ts` 合并为 `.ts`（P2-Wave 4）**：涉及约 3,600 行 JS 与 1,000 行声明，需要逐模块补类型并重跑全部单测与 E2E；一次性机械重命名会产生大量隐式 `any` 或直接类型失败，收益主要是可维护性，不影响当前功能与验证。护栏已冻结配对数量，后续按模块增量迁移。
2. **`application/`、`storage/` 二级分包与 `tests/` 前缀重命名（P2-Wave 5／6）**：纯路径 churn，需同步数百处相对导入与文档链接，回归面覆盖全部后端用例，收益低于风险；现有文件职责已清晰，暂不执行。
3. **`.packaging/`、`.packaging-28948/` 删除**：`app.asar` 被系统进程占用，两次 `rmdir` 均失败；已被 `.gitignore` 忽略，仅 2 MB，卫生巡检记为告警。可在重启或解除占用后手动删除。

## 5. 后续建议

- 每次改动先跑 `node scripts/verify.mjs fast`，提交前跑 `unit`，合并前跑 `gate`。
- 迁移 JS 模块时同步删除 `check-repo-hygiene.mjs` 中对应基线项，保持“不得新增配对”的约束有效。
- 若后续确需后端二级分包，应作为独立分支执行，先建立导入路径的自动化改写与回滚点，不与功能改动混合。
