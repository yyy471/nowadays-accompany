# EXT-E/F 最终修复独立复验

日期：2026-10-27。依据：[95 独立复验](95-ext-e-f-fixes-independent-recheck.md)、[96 修复记录](96-ext-ef-recheck-fixes.md)。复核对象为当前未提交工作树。

## 结论

**95-R3、95-R4 已关闭，原 93 的 R1/R2 修复仍有效。EXT-E 补证与 EXT-F 后端服务在本地自动化验收范围内可收口。** 本轮未发现新的可复现阻断项。

此次由主进程独立检查源码、复跑原失败探针，并实际执行全量、完整类型检查、桌面构建与新增文件空白检查。没有修改生产或正式测试代码，未提交、推送、打包或替换 EXE。

## 逐项复验

| 项目 | 源码与独立证据 | 结论 |
| --- | --- | --- |
| 95-R3 异步等待提前返回 | `host.test.ts` 已使用 `if (await predicate()) return`；同步和异步条件走同一等待流程，持久化门控与最终 `[in,out]` 断言均保留 | 关闭 |
| 95-R3 原失败反向探针 | 从当前正式测试重新复制 helper，使用上一轮同一反向探针；异步条件保持 false 时，输出 `ready=false, settled=false, checks=1`；随后置 true 才结算，并确认实际重新检查 | 通过；上一轮同探针是 `settled=true` |
| 95-R4 两种合法超时原因竞争 | 用例同时接受 `plugin_timeout` / `plugin_handler_timeout`，仍明确要求 failed；没有删除耗时上限、空 runtime snapshot、晚状态不提交和 before/after 共享预算断言 | 关闭 |
| 95-R4 生产行为核对 | `plugin-worker.ts` 本轮只增加原因码契约注释，没有更改超时执行、终止或状态提交逻辑。Worker 内部超时响应仍在接收路径终止代际；宿主 deadline 仍走原终止路径 | 没有为让测试通过而放松执行边界 |
| 原 R1 非工具模型 Skill 预算 | 同一真实 Core/Provider 探针，通过正常保存接口写入 8000 个双引号正文。实际请求仍为 254 字符、工具数 0，低于 12000；正式回归覆盖无工具授权和超长原文保留 | 保持关闭 |
| 原 R2 标准选择状态 | 独立结果仍为 available=9、selected=8，第 9 项保留 `skill_limit`；保留配置可用和标准选择两种含义 | 保持关闭 |
| 私有复制 CAS 对照 | 原独立探针继续确认过期 revision 不能覆盖新建私有定义 | 通过 |

独立探针没有把 available 强制改成 8，而是按 93 允许的修复语义检查选择字段，避免把正确的 DTO 扩展误判成失败。

## 主进程实际运行结果

| 验证 | 实际结果 | 本地忽略输出 |
| --- | --- | --- |
| `npm test` | **113 文件全部通过；1078 项通过、1 项既有跳过，无失败** | `test-results/ext-ef-final-recheck-parent-full.log` |
| 原独立探针复验 | 4/4 通过，包含异步等待反向检查、Skill 预算、标准选择状态、复制 CAS | `test-results/review97/probes.log` |
| `npm run typecheck` | 通过，含测试源码与 renderer | `test-results/review97/typecheck.log` |
| `npm run desktop:build` | Core、renderer、Electron main/preload 构建通过 | `test-results/review97/build.log` |
| `git diff --check` | 已跟踪修改通过 | 命令无输出 |
| 新增文件检查 | 在新增本报告之前，逐个检查 13 个未跟踪文本文件，未发现尾随空白或多余 EOF 空行 | 工具输出 |

本轮主进程独立全量运行一次且首次通过；96 所述连续两次是作者的证据，没有将其混写为主进程执行。探针里的 25 个 skip 来自 `-t` 过滤复制 fixture 的其他测试，不是项目新增 skip。

93、95 的失败日志和结论保留为历史证据；此次收口不覆盖或删除此前失败。

## 放行范围与后续

本次确认的是 EXT-E 的本地媒体补证、EXT-F 的后端定义/预览/选择服务及复核修复。下一阶段可按 [79](79-agent-extension-execution-plan.md) / [80](80-agent-extension-acceptance.md) 进入 **EXT-G：扩展策略 HTTP 路由与插件/Skill 页面闭环**，页面需正确使用 `selected`、`selectionReason`、`runtimeMayTrim`，并继续复用统一组件、后端有效策略和草稿保护。

EXT-H 的整体独立验收仍未完成；真实 QQ、付费模型、原生界面交互和发行包未在本次验收范围。当前代码不因此变为稳定发行版本。
