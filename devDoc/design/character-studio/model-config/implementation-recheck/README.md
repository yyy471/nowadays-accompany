# 156独立复验证据

2026-10-29；当前工作树源码；开发版Vite真实App，Chromium headless、1440×900、白昼。全部HTTP业务数据为内存夹具，核心重放为隔离临时dataRoot + MemoryCredentialVault，无真实QQ/模型或运行态配置变更。

- `browser-review.json`：独立重跑155的六组原场景，均通过。
- `extended.json`：本次另写四组交错；旧列表和旧失败隔离通过，删除写入与缺失来源恢复有缺陷；`errors: []`只代表探针执行无异常，不代表产品通过。
- `core-delete-replay.json`：真实Core确认简易保存成功后可被迟到删除移除。
- `delete-versus-save.png`：删除完成后的实际页面；成功发生在删除返回前，顺序以JSON请求与状态记录为准。
- `deleted-dirty-source.png`：最后一个来源删除后草稿仍在，缺少来源选择/新建恢复入口。页脚主操作在业务滚动区内，其disabled以DOM记录为准。
- `typecheck.log`、`tests.log`、`build.log`、`tokens.log`：本次独立门控原日志。
- `source-snapshot.json`：复验源码与相关测试SHA-256；后续变更需重新复验。

临时诊断脚本及完整截图在仓库`test-results/model-config-recheck/`：`baseline.mjs`、`extended.mjs`、`core-delete-replay.mts`。六组基础场景复用了155的HTTP夹具和步骤，新增场景单独编写，并以真实Core校验关键后端后果。结论与修复要求见[156复验记录](../../../../156-model-config-fixes-independent-recheck.md)。
