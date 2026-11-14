# P2-06 全量验收自验矩阵（草案）

日期：2026-11-04。

状态：**历史实现方离线自验矩阵，最终独立验收见[184 第 7 节](184-p2-06-acceptance-report.md)。** R01～R09 关闭；105 项回归、20 个离线及 4 项真实复验通过，真实事件形成及重启后新窗口召回、原始证据、回复和状态保存已补齐，P2 首轮后端范围通过。本表原覆盖保留，不代替独立证据。

依据：[P2 开发文档 173](173-p2-memory-agent-development-guide.md) 第 7、8 节；[P2-01 契约 174](174-p2-01-memory-agent-contract.md)；[P2-05 实施记录 180](180-p2-05-agent-conversation-record.md)。

## 1. 自验证据

| 项目 | 值 |
| --- | --- |
| 源码基线 | Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` + 未提交工作树 |
| 运行环境 | win32-x64，Node.js 24.22.2，npm 11.19.1 |
| 类型检查 | `npm run typecheck` 退出码 0 |
| 全量测试 | `npm test` 共 77 项通过、0 失败，用时约 5.12 秒 |
| 分阶段计数 | P1 13 项、P2-02 18 项、P2-03 13 项、P2-04 14 项、P2-05 19 项 |
| 证据目录 | `backend/test-results/p2-05-self-20261104/`：`typecheck.log`、`tests.log`、`source-manifest.json`、`git-head.txt`、`git-status.txt` |
| 模型与外部服务 | 全部为脚本化离线模型；MCP 使用真实本地 stdio 子进程；未访问远程服务、真实 QQ 或付费模型 |

## 2. 验收矩阵

| 173 验收场景 | 当前证据 | 结果 |
| --- | --- | --- |
| 实际记忆闭环 | `conversation-formed memory is recalled with original evidence in the next turn`：先由对话证据形成事件，下一轮自动召回并用 `memory_event`＋`memory_evidence` 读取原始消息；`memory batch creates an event from actual messages and indexes it` | 离线通过 |
| 阈值与批次 | `message thresholds stay at 50 and idle stays at 60 seconds`、`message thresholds, idle trigger and task-end trigger are registered`、`no threshold trigger below the 50-message boundary`、`30 pending messages form memory after the idle interval without a manual call`、`batch input capacity splits evidence into consecutive batches` | 离线通过；真实 60 秒边界由注入时钟验证，运行时定时器用 80ms 注入间隔验证 |
| 失败与并发 | `invalid model output keeps evidence failed and retries without duplicates`、`failed batches retry after 30 seconds, 2 minutes, 10 minutes and then hourly`、`stale update version rejects the whole sub-batch without partial writes`、`a role only allows one running memory batch`、`restart fails an interrupted memory batch and retries the saved evidence`、`model failure keeps partial text, does not auto retry, and a new message retries` | 离线通过 |
| 精炼与召回 | `refine candidates respect the 100-round boundary and one-recall limit`、`refine candidates exclude events with more than one recall in 100 rounds`、`refinement turns a low-recall event into a searchable daily summary`、`refinement aggregates same-date events and supplements an existing summary`、`memory batches supply summary candidates for supplementing an existing summary`、`agent search records deliveries and recalls once per execution` | 离线通过 |
| 主观记录 | `event detail, evidence detail and correction preserve original messages`、`diary Markdown files are authoritative and refresh the search snapshot`、`saved tool results form events from their original evidence`、`tool result evidence updates its source status when unknown is reconciled` | 离线通过；日记定时书写归 P3 |
| 对话与流式 | `user message runs a LangGraph decision and commits reply, state and stream events`、`typing state delays the decision and multiple pending messages share one turn`、`duplicate submission neither interrupts nor starts a second decision`、`a real new message supersedes the running reply and preserves its partial text in order`、`state_update patches are merged only in the completion transaction`、`typing expiry automatically starts the decision at the fixed short test interval`、`decisions across windows stay serial in earliest-message order`、`SSE replays persisted events by cursor and rejects an invalid cursor` | 离线通过 |
| 调用真实性 | `tasks, executions, tool calls and continuations persist with version semantics`、`openai-responses`／`anthropic-messages` 续接、`agent tool loop calls a real local MCP tool and persists the external call`、`model tool loop stops at the configured round limit without committing state`、`disabling an MCP resource keeps the running chain but excludes the next task` | 离线通过；外部中断组合仍归 P4 |
| 断线与资源开关 | `SSE replays persisted events by cursor and rejects an invalid cursor`：断线清理输入状态、原执行继续、重连补读不新增模型调用；`disabling an MCP resource keeps the running chain but excludes the next task`；P2-04 `local MCP tools ...` 与 `workspace writes reject ...` | 离线通过；远程 MCP 归 P5 |
| 模型与扩展 | `three model protocols stream text, tool calls and usage`、`model list and connection tests use credentials and record results`、`model binding resolver selects chat and memory bindings with fallback`、`skill library loads metadata, body and referenced files on demand`、`enabled skills expose metadata and load body and referenced files on demand`、`agent tool loop calls a real local MCP tool ...` | 三类协议仅本地模拟服务验证；真实服务未验证 |
| 原有数据 | P1 13 项全部通过：迁移、拒绝异常 schema、角色／窗口／消息去重、资源绑定、任务与执行版本语义、独立 CLI 流程；P2 迁移 `v1 business database migrates to v2 and backfills evidence` | 离线通过 |

## 3. 尚待补充的证据

| 事项 | 当前状态 | 下一步 |
| --- | --- | --- |
| P2-05 独立复核 | 已通过，R01～R09 均关闭，见 184 第 7 节 | P2 按首轮后端范围收口，可进入 P3 |
| 真实模型联调 | 已按用户配置复验 DeepSeek Anthropic：连接、Skill／MCP、事件与索引、重启后新窗口检索／证据／回复和状态保存通过 | 覆盖范围见 184 第 7 节；其他真实厂商／协议另验 |
| 完整退出／强杀／重启组合 | 未执行 | 归 P4；当前只验证启动清理、部分文字重建与记忆批次重试 |
| 自主安排、定时唤醒、额度周期 | 未实现 | 归 P3 |
| 远程 MCP | 未实现 | 归 P5 |
| 前端与桌面打包 | 未实现 | 后端阶段完成后再讨论 |
| 其他平台与多进程并发 | 未验证 | 当前仅验证 win32-x64、Node 24、临时目录 |

## 4. 使用说明

- 本表用于把实施方自验对应到具体用例，不替代独立复核，也不把离线通过写成真实服务通过。
- 独立复核应使用同一源码快照重跑 `npm run typecheck`、`npm test`，并核对 `source-manifest.json`；发现问题后按既有流程追加修正记录，而不是直接改写本表结论。
- 真实模型联调须使用用户提供的配置单独记录；未提供配置时保持“未验证”，不以离线模型代替。
