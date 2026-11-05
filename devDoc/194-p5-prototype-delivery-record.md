# P5 后端原型交付与自验记录

日期：2026-11-05。依据 [193 开发文档](193-p5-prototype-delivery-guide.md)、DL-114～DL-116 及用户“开始 p5”。本文记录实现方交付与自验；后续独立复核另记，不混用证据性质。

状态：**本记录的 P5-01～P5-04 交付自验通过；后续 P5-05 整体独立复核已由[195](195-p5-independent-review.md)通过，首轮本机后端源码原型收口。** 本文保留原自验证据，不替换为独立结论；无新增真实服务调用或 Git 提交／推送。

## 1. 交付内容

| 内容 | 入口 | 说明 |
| --- | --- | --- |
| 当前后端源码 | backend/src、package.json／package-lock.json | 独立 Node >=24 依赖；tsx 源码运行，非桌面安装包 |
| 启动及配置说明 | [backend/README.md](../backend/README.md) | app-root、数据布局、CLI、模型与绑定、本地 MCP、Skill、查询、备份及限制 |
| 无密钥样例 | [examples](../backend/examples) | 三种模型协议、角色设定、绑定、本地 MCP、通用 Skill；服务地址及路径占位符需按实际环境替换 |
| 统一离线验收 | [accept-offline.mjs](../backend/scripts/accept-offline.mjs) | 固定离线白名单、新建证据目录、逐步日志、退出码／报告／用例计数检查、源码哈希 |
| 真实进程冒烟 | [process-smoke.ts](../backend/scripts/process-smoke.ts) | 实际 main／CLI 进程、设定修订及重启；样例注册、本地工具及 Skill 核验 |
| 交付入口回归 | [acceptance.test.mjs](../backend/scripts/acceptance.test.mjs) | 缺报告、缺用例、重复编号、失败／错误字段、正式测试尾部及非全通过的拒绝 |

统一执行 `cd backend` 后 `npm run accept:offline`。独立 Node 路径仅是本工作区现成运行时，交付不要求固定绝对路径；完整准备方法见 README。

## 2. 业务覆盖及历史证据

| 能力 | 本次可重跑证据 | 历史结论／限制 |
| --- | --- | --- |
| 身份、设定修订、独立角色库与窗口 | 正式 P1 测试、process-smoke | [172 第 12 节](172-p1-independent-review.md)独立通过；当前进程冒烟额外核验交付入口 |
| 事件、日常摘要、索引、主观记忆、日记与证据 | 正式 P2 测试、P2 20 项矩阵 | [184 第 7 节](184-p2-06-acceptance-report.md)有独立及真实 DeepSeek 证据；本次离线重跑，不把预置事件当作全部记忆形成证据 |
| Agent 按需检索、回复／状态、输入中断与 SSE | 正式 P2 测试、P2 原 10＋扩展 5＋续行 1＋组合 4 | 既有完成状态、原文保留、旧输出隔离及后台整理不阻塞回复规则保持 |
| 模型、Skill、本地 MCP 及开关原链延续 | 正式 P2／P3／P4 测试、P2 矩阵、样例冒烟 | 仅 stdio；三个协议的样例注册不等于三个协议的真实生成已验证 |
| 自主安排、唤醒、成果、日记分享及额度 | 正式 P3 测试、P3 7＋2＋2 | [188 第 7 节](188-p3-independent-review.md)离线独立通过；本次无真实模型自主活动 |
| 重启、未知工具、检查点、内部步骤、预算日期及原链资源 | 正式 P4 测试、P4 8＋6＋14 | [190 第 13 节](190-p4-recovery-acceptance-report.md)用户接受收口；最后补修仍为自验，P5 独立复核另列 |
| 启动与交付文档中的配置样例 | process-smoke、交付入口回归 | 实际进程与本地工具可用，干净机器安装及其他 OS 尚未验证 |

P0 技术小样的独立证据仍见 [168 第 9 节](168-p0-followup-fix-list.md)，不将旧工作区缓存或旧根目录测试算入新后端。上述矩阵是现有决定的交付归集，没有新增 DL。

## 3. 实施与运行记录

统一入口初跑检出旧 P2 复核脚本的类型断言及新冒烟脚本读取更新返回值的问题。旧脚本改为先确认 ScriptedChatModel 再读取 requests；新脚本遵循 updateDefinition 实际只返回版本及时间的契约，再 GET 核验身份。两者属于验收脚本适配，不是业务契约变化。

初跑目录：`backend/test-results/p5-2026-11-05T03-41-56-118Z-b746aff3/`。工程类型检查、168 项测试、59 个业务场景均通过；验收脚本类型检查及进程冒烟失败，summary.passed=false，进程退出码 1。保留这份记录，证明交付错误没有被“业务测试通过”掩盖；不把它写成产品缺陷或最终通过。

修正后完整重跑目录：`backend/test-results/p5-2026-11-05T03-44-29-541Z-fb9ea81d/`。Windows x64、Node 24.22.2、现成独立 backend 依赖；分支 `codex/p1-role-storage`，HEAD `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` 加当前未提交工作树。开始及结束 UTC 分别为 03:44:29、03:46:05。

| 检查 | 最终结果 | 相对运行目录的证据 |
| --- | --- | --- |
| 工程类型检查 | 通过 | typecheck.log |
| 10 份矩阵脚本及新进程冒烟严格类型检查 | 通过 | review-typecheck.log |
| 交付汇总回归 | 2／2，失败／取消／跳过为 0 | delivery-tests.log |
| 正式测试 | 168／168，失败／取消／跳过为 0 | tests.log |
| 真实 main／CLI 进程与配置样例 | 1／1 | process-smoke/smoke-report.json、process-smoke.log |
| P2 原、扩展、原链续行、组合 | 10＋5＋1＋4 全通过 | p2-original/report.json、p2-extended/extended-report.json、p2-continuation/model-continuation-report.json、p2-combined/acceptance-report.json |
| P3 原、扩展、预留边界 | 7＋2＋2 全通过 | p3-original/p3-review-report.json、p3-extended/p3-extended-report.json、p3-reservation/reservation-boundary-report.json |
| P4 原、用户／自主／资源恢复、异常 | 8＋6＋14 全通过 | p4-original/p4-report.json、p4-continuation/p4-recovery-recheck-report.json、p4-boundaries/p4-remaining-report.json |
| 源码与证据归属 | 开始／结束哈希一致，15 步均通过、进程退出码 0 | summary.json、source-manifest.json |
| 本轮修改范围 | 无业务 src 修改；旧文件仅 package.json 与一份复核脚本，新增 scripts／examples 及两份文档 | delivery-scope.json |

进程冒烟实际创建角色、修订设定、注册三个协议的模型样例及 MCP／Skill 资源，写入并绑定四项角色资源；以实际 Node 和绝对 tsx loader 从角色 workspace 启动本地 MCP，发现工具并保存 `notes/p5.md`，读取通用 Skill 正文。退出后用同一目录重新启动，身份、默认窗口、设定版本 2、四项绑定、笔记及两份 SQLite 文件均保留。模型样例只注册不生成，没有真实模型调用。

最终 59 个业务场景包括 P4 最后两项内部启动结算及跨日／二次启动断言；这次统一重跑仍为本轮实现方自验，不冒充后续独立复核。另验证了 npm 的 `accept:offline -- --help` 脚本入口和 README 中 Windows loader 文件 URL 的生成形式；没有另做干净环境安装。

固定白名单排除所有真实服务脚本，过滤变量 NOWADAYS_REVIEW_CASE 被清除，各步骤隔离 NOWADAYS_REVIEW_OUTPUT。报告数量、唯一用例编号及通过字段和进程退出码共同参与结论；临时文件位于本轮 tmp，递归清理守卫核验绝对路径及实际父路径。测试／业务报告保留独立记录，不把 168、2、1、59 混成产品功能数量。

## 4. 真实服务与未验证范围

| 范围 | 状态 |
| --- | --- |
| DeepSeek Anthropic Messages 的 P2 首轮真实链路 | 历史独立实测通过，见 184 第 7 节；本次未重调 |
| OpenAI Chat／Responses 及其他厂商的真实生成 | 只有离线／本地模拟，不标为真实通过 |
| P3 自主活动、P4 恢复的真实模型链路 | 本次未验证 |
| Streamable HTTP MCP | 按 DL-115 在 P5 后首个后端补充工作包实施，尚未交付 |
| 完整多后端并发、更多数据库损坏情形 | 只覆盖已列局部并发及写入故障矩阵，不外推 |
| 干净机器安装、其他 Node／OS 组合 | 本次使用现成独立依赖，未做新环境安装 |
| 桌面前端、安装打包、浏览网页、视频、电脑控制、QQ | 后续工作包，未纳入当前源码原型交付 |

自动验收不使用用户真实密钥，不发出付费请求；脚本没有将真实联调混入离线白名单。P5 实现、自验、独立复核及 Git 提交分别记录，当前未提交、未推送。

## 5. 下一步

本记录保留 P5-01～P5-04 的实现方自验。后续用户要求整体复核，P5-05 已在 [195](195-p5-independent-review.md)通过，包含交付物、证据归属、真实／离线边界及最后恢复补修；由该独立记录确认首轮本机源码原型收口。下一步按 DL-115 开始远程 MCP 后端补充，再讨论正式桌面前端。
