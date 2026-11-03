# Nowadays

Nowadays 是承载独立数字生命的桌面应用。每个角色实例拥有持续的身份、经历、记忆和自主活动，以 LangGraph TypeScript 编排，支持 MCP 工具与通用 Agent Skills。

首轮后端实施基线已确认。P0 技术小样和 P1 角色／配置／存储后端均通过独立复验；P2 开发准备稿已建立，尚未编码。第一版面向单用户桌面端，先后端、后前端；QQ／SnowLuma 后置。

## 文档入口

下一步从[P2 开发文档：完整事件记忆、Agent 对话与扩展](devDoc/173-p2-memory-agent-development-guide.md)的 P2-01 开始落实契约；P1 最新独立证据见[172 第 12 节](devDoc/172-p1-independent-review.md)，本次未开始 P2 编码。

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
- [P2 开发文档](devDoc/173-p2-memory-agent-development-guide.md)：完整事件记忆、检索维护、Agent 对话与扩展的工作包和验收；尚未编码。
- [参考底稿](devDoc/design/digital-life/langgraph-roleplay-engine-v2.reference.md)：用户提供的原始资料，未整体采纳。
- [协作指南](AGENTS.md)：后续协作与文档维护约定。

## 分支

| 分支 | 用途 |
| --- | --- |
| `master` | 数字生命新主线，独立历史起点；当前保存设计与方案文档 |
| `codex/p0-runtime-spike` | P0 技术小样实现与自验；位于 `prototypes/p0/`，本轮本地提交，尚未合并 master |
| `codex/p1-role-storage` | P1 后端及修复复验，位于 `backend/`；本轮纳入本地提交，含 P2 开发准备文档，尚未合并 master |
| `dev` | 原 QQ 编排项目的完整代码和历史，附本次方向讨论的文档归档 |

首轮实施基线已按 DL-129 确认，设计文档已有历史远程同步。P0、P1 在本地开发分支通过独立复验，本轮不推送或合并。P2 尚未编码；阶段完成不等于完整数字生命后端、真实模型或桌面已完成。
