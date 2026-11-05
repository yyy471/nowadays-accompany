# P5 后端原型整体独立复核

日期：2026-11-05。用户要求“开始整体复核”。依据 [193 P5 开发文档](193-p5-prototype-delivery-guide.md)、[194 交付与自验记录](194-p5-prototype-delivery-record.md)、DL-114～DL-116 及 P4 用户接受范围。

**结论：P5-05 在首轮本机后端源码原型范围复核通过，P5-01～P5-05 可收口。** 未发现新的阻断项；没有修改业务源码、正式测试、交付脚本或样例，没有调用真实模型或付费服务。下一阶段按 DL-115 完成远程 Streamable HTTP MCP 后端补充，再讨论桌面前端。未提交、未合并、未推送。

## 1. 快照与复核方法

- 分支 `codex/p1-role-storage`，HEAD `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` 加当前未提交工作树，不能只用 HEAD 代表实际实现。
- Windows x64、独立 Node 24.22.2 与 backend 依赖。通过实际 npm 脚本运行 `npm run accept:offline`，工程及脚本均重新检查，不以 194 的自验结果直接替代本轮证据。
- 运行目录：`backend/test-results/p5-2026-11-05T03-56-14-440Z-3b4e048a/`。主体运行 UTC 03:56:14～03:57:43；补充验收入口故障试验于 UTC 03:58:50 完成。
- 独立阅读运行说明、模型／本地 MCP／Skill／绑定样例、验收白名单、失败汇总、删除守卫及业务矩阵。另核对已安装直接依赖版本、README 的 PowerShell 语法和最后恢复补修的实际业务记录。
- 统一入口自身输出的 kind 仍为 `implementation_self_validation`，没有修改脚本以更名；本轮后续复核性质由本文、独立补验脚本及 `independent-verification-summary.json` 记录，194 保留原实现方自验。

## 2. 重跑结果与证据

下表路径相对本轮运行目录，所有 15 个步骤退出码为 0，summary.passed=true，开始与结束源码清单一致。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 工程及 10 份矩阵／进程冒烟严格类型检查 | 通过 | typecheck.log、review-typecheck.log |
| 交付入口回归 | 2／2，失败／取消／跳过均为 0 | delivery-tests.log |
| 正式后端测试 | 168／168，失败／取消／跳过均为 0 | tests.log |
| 实际后端／CLI、配置样例与重启 | 1／1 | process-smoke/smoke-report.json、process-smoke.log |
| P2 原、扩展、资源原链、组合 | 10＋5＋1＋4 全通过 | p2-original/report.json、p2-extended/extended-report.json、p2-continuation/model-continuation-report.json、p2-combined/acceptance-report.json |
| P3 原、扩展、预留边界 | 7＋2＋2 全通过 | p3-original/p3-review-report.json、p3-extended/p3-extended-report.json、p3-reservation/reservation-boundary-report.json |
| P4 原、恢复资源组合、异常 | 8＋6＋14 全通过，无样例异常 | p4-original/p4-report.json、p4-continuation/p4-recovery-recheck-report.json、p4-boundaries/p4-remaining-report.json |
| 直接依赖版本 | npm ls 退出码 0，全部匹配 package.json 固定版本 | installed-dependencies.json |
| README PowerShell 命令语法 | 10 个代码块无语法错误 | readme-powershell-parse.json |
| 证据归属 | 15 步通过，源码哈希一致 | summary.json、source-manifest.json、independent-verification-summary.json |

进程冒烟实际启动 main.ts 和 CLI，创建角色、修订设定、注册三种模型协议样例和 MCP／Skill、保存四项绑定。由角色 workspace 启动本地工具并写入 Markdown，Skill 正文可读取；原目录重启后身份、默认窗口、设定版本、绑定、笔记与两份 SQLite 保留。模型样例仅注册，不将这项验证称为三个协议均有真实生成兼容性。

## 3. 验收入口的独立故障试验

除重跑正常矩阵外，在本轮 `negative-fixtures/` 下创建四份隔离环境，逐字复制交付入口及汇总模块，以轻量假业务报告替代耗时业务步骤；通过 junction 引用现成 node_modules，不改原目录，不删除用户数据。这些试验只验证验收入口的判定，不作为产品业务用例或真实服务证据。

执行脚本：本轮目录的 `delivery-negative.mjs`；结果：`delivery-negative-report.json`。四份副本的验收入口 SHA-256 均为 `1319e71f6060b2148021f61518cd4bec899bacc66d0f4db83b225256482ec01c`，与交付源码相同。

| 用例 | 注入 | 预期及实测 |
| --- | --- | --- |
| baseline | 所有模拟步骤正常 | 退出码 0，summary.passed=true，证明隔离环境本身可运行 |
| missing-report | 最后步骤退出 0，但不生成规定报告 | 最后步骤 ENOENT，汇总 false，整体验收退出 1 |
| nonzero-exit | 生成全通过报告后，最后子进程退出 7 | 最后步骤 STEP_EXIT_FAILED，汇总 false，整体验收退出 1 |
| source-drift | 步骤均通过，但执行期间修改副本的 src 文件 | sourceUnchanged=false，汇总 false，整体验收退出 1 |

四项契约判断均通过，缺报告、子进程失败和源码变化不会因其他步骤通过而被掩盖。原有两项交付回归继续覆盖缺用例、重复编号、失败字段和正式测试汇总不完整。

## 4. P4 最后补修的后续复验

本轮没有更改最后补修实现，重新执行真实本地日记、SQLite 故障、强杀及二次启动矩阵；三项实际结果如下。

| 场景 | 本轮结果 |
| --- | --- |
| internal-intent | 日记一篇；原任务延续完成，模型读到原步骤 unknown；使用三点、账本三笔。再次启动零模型，日记、账本及内部两条凭据不变 |
| internal-intent-crossday | 日记一篇；旧调用归原日，次日使用一点；总账本三笔。再次启动零模型，日记、账本及凭据数量不变 |
| internal-receipt-db-failure | 原任务仍 failed；重启无新模型，日记一篇，使用两点、账本两笔。再次启动零模型，记录数量不变 |

原检查点恢复、已提交后的收尾、额度预留、已结束任务不复活及关闭资源后的原链延续等既有矩阵也全部通过。190 第 12 节／191 第 10 节最后补修现已获得本轮后续独立复验证据；P4 的用户接受和历史失败／自验性质仍原样保留，不回写成历史已独立通过。

## 5. 收口及未验证范围

本次通过针对 193 规定的可运行源码、无密钥配置样例、说明、重复验收入口及业务证据，满足 DL-114 的首轮原型复核范围。P5 没有新增待修阻断，可按首轮后端源码原型收口，进入 DL-115 远程 MCP 补充工作包。

以下继续保留，不因 P5 收口标为已验证：干净机器安装及其他 Node／OS 组合；OpenAI Chat／Responses 和其他厂商的真实生成；P3／P4 真实模型恢复及提供方续传材料；完整多后端并发与更多数据库损坏；远程 MCP、桌面前端／安装包、网页浏览、视频、电脑控制和 QQ。历史 P2 DeepSeek Anthropic Messages 真实证据仍限定 184 第 7 节，本文没有重调真实服务。

本轮只新增复核证据及本文，并同步文档阶段状态；没有修改被验实现，没有进行 Git 提交、合并或推送。
