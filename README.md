# Nowadays

Nowadays 是承载独立数字生命的桌面应用。每个角色实例拥有持续的身份、经历、记忆和自主活动，以 LangGraph TypeScript 编排，支持 MCP 工具与通用 Agent Skills。

首轮后端实施基线已确认。P0 技术小样及后续修正已在本地分支 `codex/p0-runtime-spike` 通过独立复核；P1 开发准备稿已建立，尚未编码。第一版面向单用户桌面端，先后端、后前端；QQ／SnowLuma 接入后置。

## 文档入口

下一步从[P1 开发文档：角色、存储与资源配置](devDoc/169-p1-role-storage-development-guide.md)的 P1-01 开始落实契约；当前只交付开发准备文档，尚未开始 P1 编码。

- [持续决策记录](devDoc/161-digital-life-direction-decisions.md)：用户逐项确认的需求与修订，当前设计的依据。
- [首轮后端原型实施方案](devDoc/162-backend-prototype-implementation-plan.md)：已确认的首轮范围、阶段及验收安排，工程契约按阶段细化验证。
- [设计与方案一致性核对](devDoc/163-design-consistency-review.md)：已修正文档问题、需求覆盖与待讨论事项。
- [首轮后端原型执行清单](devDoc/164-backend-prototype-execution-checklist.md)：已确认的实施入口，列出阶段范围、P0 起步证据及尚需细化／讨论的事项。
- [后端开发文档：P0 技术小样](devDoc/165-backend-development-guide.md)：首个开发阶段的工作包、验收用例及自验／独立复核记录方式。
- [P0 技术小样实施记录](devDoc/166-p0-implementation-record.md)：P0-01～P0-04 的实际依赖、运行证据、自验结论与限制，含 R01～R04 及 168 的 L01／L03／L06 修正复验。
- [P0 独立复核记录](devDoc/167-p0-independent-review.md)：R01～R04 已关闭；独立重跑 37 项检查、5 个原边界场景及 4 个真实强杀场景通过。
- [P0 复验遗留修复清单](devDoc/168-p0-followup-fix-list.md)：另一次独立重跑登记的 P0-L01～P0-L09；L01 报告归属、L03 版本语义、L06 结果适配已修正并通过独立复核，其余按核对不修改实现或留待 P1／P4。
- [参考底稿](devDoc/design/digital-life/langgraph-roleplay-engine-v2.reference.md)：用户提供的原始资料，未整体采纳。
- [协作指南](AGENTS.md)：后续协作与文档维护约定。

## 分支

| 分支 | 用途 |
| --- | --- |
| `master` | 数字生命新主线，独立历史起点；当前保存设计与方案文档 |
| `codex/p0-runtime-spike` | P0 技术小样实现与自验；位于 `prototypes/p0/`，本轮本地提交，尚未合并 master |
| `dev` | 原 QQ 编排项目的完整代码和历史，附本次方向讨论的文档归档 |

首轮实施基线已按 DL-129 确认，设计与方案文档按 DL-62 同步远程。P0 当前在本地分支上通过修正后的独立复验，168 的后续修改已完成实现方及独立复验；本轮本地提交，尚未合并 master，后续阶段未开始；小样通过不代表完整后端已完成，旧项目的构建结果、测试计数和既有缓存不代表新主线的实现状态。
