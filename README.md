# Nowadays

最新阶段：[P5 整体独立复核](devDoc/195-p5-independent-review.md)通过，首轮本机后端源码原型收口。168 项正式测试、2 项交付回归、1 个进程冒烟、59 个业务场景及 4 项验收入口故障契约通过。启动与配置见[后端说明](backend/README.md)，统一离线命令为 backend 下的 npm run accept:offline。下一步远程 MCP 后端补充；未提交、未推送。

Nowadays 是承载独立数字生命的桌面应用。每个角色实例拥有持续的身份、经历、记忆和自主活动，以 LangGraph TypeScript 编排，支持 MCP 工具与通用 Agent Skills。

首轮后端实施基线已确认。P0、P1 已通过独立复验；P2 已在[184 第 7 节](devDoc/184-p2-06-acceptance-report.md)完成最终验收，R01～R09 关闭，105 项回归、20 个离线及 4 项真实 DeepSeek 复验通过。P3 自主安排、唤醒与额度已完成实现方自验，[188 独立复核](devDoc/188-p3-independent-review.md)后，[189 修复记录](devDoc/189-p3-independent-review-fix-record.md)已由[188 第 7 节](devDoc/188-p3-independent-review.md)独立复验通过：142 项回归、全部 11 个边界场景通过，P3 六项问题均关闭；可准备 P4，正式交付与其他真实范围另验。第一版面向单用户桌面端，先后端、后前端；QQ／SnowLuma 后置。

## 文档入口

P2-01 契约见[174 事件记忆与对话执行契约](devDoc/174-p2-01-memory-agent-contract.md)，P2-02 自验见[175 记忆形成与保存实施记录](devDoc/175-p2-02-memory-formation-record.md)，P2-03 自验见[176 检索、维护与主观记忆实施记录](devDoc/176-p2-03-memory-query-record.md)，P2-04 自验见[177 模型与本地扩展实施记录](devDoc/177-p2-04-model-extension-record.md)；P1 最新独立证据见[172 第 12 节](devDoc/172-p1-independent-review.md)。

- [持续决策记录](devDoc/161-digital-life-direction-decisions.md)：用户逐项确认的需求与修订，当前设计的依据。
- [首轮后端原型实施方案](devDoc/162-backend-prototype-implementation-plan.md)：已确认的首轮范围、阶段及验收安排，工程契约按阶段细化验证。
- [设计与方案一致性核对](devDoc/163-design-consistency-review.md)：已修正文档问题、需求覆盖与待讨论事项。
- [首轮后端原型执行清单](devDoc/164-backend-prototype-execution-checklist.md)：已确认的实施入口，列出阶段范围、P0 起步证据及尚需细化／讨论的事项。
- [后端开发文档：P0 技术小样](devDoc/165-backend-development-guide.md)：首个开发阶段的工作包、验收用例及自验／独立复核记录方式。
- [P0 技术小样实施记录](devDoc/166-p0-implementation-record.md)：P0-01～P0-04 的实际依赖、运行证据、自验结论与限制，含 R01～R04 及 168 的 L01／L03／L06 修正复验。
- [P0 独立复核记录](devDoc/167-p0-independent-review.md)：R01～R04 已关闭；独立重跑 37 项检查、5 个原边界场景及 4 个真实强杀场景通过。
- [P0 复验遗留修复清单](devDoc/168-p0-followup-fix-list.md)：另一次独立重跑登记的 P0-L01～P0-L09；L01 报告归属、L03 版本语义、L06 结果适配已修正并通过独立复核，其余按核对不修改实现或留待 P1／P4。
- [P1 开发文档：角色、存储与资源配置](devDoc/169-p1-role-storage-development-guide.md)：P1 范围、工作包与离线验收，契约与进度见 170、171。
- [P1-01 角色与存储工程契约](devDoc/170-p1-01-contract.md)：目录、appRoot、schema、初始化、HTTP／CLI、错误与凭据策略。
- [P1 实施记录](devDoc/171-p1-implementation-record.md)：P1-02～P1-05 的依赖、命令、自验证据与限制。
- [P1 独立开发复核](devDoc/172-p1-independent-review.md)：历次问题和修正证据保留，最新第 12 节确认 R01～R04 全部通过独立复验。
- [P2 开发文档](devDoc/173-p2-memory-agent-development-guide.md)：完整事件记忆、检索维护、Agent 对话与扩展的工作包和验收；P2-01 契约已固定。
- [P2-01 事件记忆与对话执行契约](devDoc/174-p2-01-memory-agent-contract.md)：业务库 v2／迁移、记忆批次、检索召回、SSE、模型端口、API／CLI 与验收设计。
- [P2-02 记忆形成与保存实施记录](devDoc/175-p2-02-memory-formation-record.md)：迁移、证据、触发、分批分段、离线整理、失败退避与 18 项用例；实现方自验，待独立复核。
- [P2-03 检索、维护与主观记忆实施记录](devDoc/176-p2-03-memory-query-record.md)：中文检索、证据追溯、召回、100 轮精炼、纠错、日记 Markdown、HTTP／CLI 与 11 项用例。
- [P2-04 模型与本地扩展实施记录](devDoc/177-p2-04-model-extension-record.md)：三类模型协议、绑定解析、模型列表／连接测试、Skill 库、本地 MCP 服务与客户端。
- [P2-04 及前置工作包独立复核](devDoc/178-p2-04-independent-review.md)：首轮失败证据保留，第 6 节最终独立复验通过，R01～R06 全部关闭。
- [P2-04 复核问题修复记录](devDoc/179-p2-04-review-fix-record.md)：原实施方修改、续轮材料复核补修与当前 58 项自验；最新复验见 178 第 6 节。
- [P2-05 Agent 对话联动实施记录](devDoc/180-p2-05-agent-conversation-record.md)：LangGraph 执行、输入与中断、自动召回与深查、工具循环、SSE／CLI、记忆运行时定时唤醒与启动恢复；77 项全量测试通过，待独立复核。
- [P2-06 全量验收自验矩阵（草案）](devDoc/181-p2-06-self-acceptance-matrix.md)：把 173 验收场景对应到测试与证据，列明真实模型、独立复核与 P3／P4／P5 未验证事项。
- [P2-05 独立开发复核](devDoc/182-p2-05-independent-review.md)：历次问题与复验记录，最终结论见 184 第 7 节。
- [P2-05 复核问题修复记录](devDoc/183-p2-05-review-fix-record.md)：R01～R08 修复与自验，R05／R09 后续修复见 185，最终复验见 184。
- [P2-06 阶段验收报告](devDoc/184-p2-06-acceptance-report.md)：第 7 节最终通过，105 项回归、20 个离线及 4 项真实 DeepSeek 复验，R01～R09 关闭。
- [P2-06 R05／R09 阻断修复记录](devDoc/185-p2-06-r05-r09-fix-record.md)：记忆标签协议与连接测试输出限额修复自验。
- [P3 自主推进开发文档](devDoc/186-p3-autonomy-development-guide.md)：自主安排、唤醒、额度、工具、CLI／API 工程契约与验收矩阵。
- [P3 自主安排、唤醒与额度实施记录](devDoc/187-p3-autonomy-implementation-record.md)：P3-01～P3-06 实现与 119 项回归、14 项专项自验。
- [P3 自主安排、唤醒与额度独立复核](devDoc/188-p3-independent-review.md)：首轮未通过，7 个边界场景复现 P3-R01～P3-R06。
- [P3 独立复核修复记录](devDoc/189-p3-independent-review-fix-record.md)：R01～R06 及第 5／6 节遗留补正；142 项回归、此前 9 场景及 2 个预留边界场景自验，待定向复验。
- [参考底稿](devDoc/design/digital-life/langgraph-roleplay-engine-v2.reference.md)：用户提供的原始资料，未整体采纳。
- [协作指南](AGENTS.md)：后续协作与文档维护约定。

## 分支

| 分支 | 用途 |
| --- | --- |
| `master` | 数字生命新主线，独立历史起点；当前保存设计与方案文档 |
| `codex/p0-runtime-spike` | P0 技术小样实现与自验；位于 `prototypes/p0/`，本轮本地提交，尚未合并 master |
| `codex/p1-role-storage` | P1 后端及修复复验，位于 `backend/`；P2、P3 源码与自验记录在同一工作树，尚未提交或合并 master |
| `dev` | 原 QQ 编排项目的完整代码和历史，附本次方向讨论的文档归档 |

首轮实施基线已按 DL-129 确认，设计文档已有历史远程同步。P0、P1 在本地开发分支通过独立复验，P2 已完成最终验收；P3 已完成复核修复自验，待独立复验。本轮不推送或合并，阶段完成不等于完整数字生命后端、真实模型或桌面已完成。
