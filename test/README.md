# 测试源码

- `*.test.ts`：由`npm test`运行的回归测试。
- `helpers.ts`、`phase1-helpers.ts`：测试数据与辅助函数。
- `diagnostics/*.mts`：历史复核的独立诊断脚本，使用假适配器与系统临时目录；不调用真实QQ或付费模型。

从仓库根目录运行：

```powershell
npm run typecheck
npm test
.\node_modules\.bin\tsx.cmd test/diagnostics/phase1-review-repro.mts
.\node_modules\.bin\tsx.cmd test/diagnostics/phase1-second-review-repro.mts
```

测试源码进入Git；报告、截图与运行产物放入根目录`test-results/`或`coverage/`，由`.gitignore`排除。测试使用的系统临时目录不属于源码。
