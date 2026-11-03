# Nowadays

Nowadays 是承载独立数字生命的桌面应用。每个角色实例拥有持续的身份、经历、记忆和自主活动，以 LangGraph TypeScript 编排，支持 MCP 工具与通用 Agent Skills。

首轮后端实施基线已确认，当前仅有设计与方案文档，尚未开始编码。第一版面向单用户桌面端，先后端、后前端；QQ／SnowLuma 接入后置。

## 文档入口

- [持续决策记录](devDoc/161-digital-life-direction-decisions.md)：用户逐项确认的需求与修订，当前设计的依据。
- [首轮后端原型实施方案](devDoc/162-backend-prototype-implementation-plan.md)：已确认的首轮范围、阶段及验收安排，工程契约按阶段细化验证。
- [设计与方案一致性核对](devDoc/163-design-consistency-review.md)：已修正文档问题、需求覆盖与待讨论事项。
- [首轮后端原型执行清单](devDoc/164-backend-prototype-execution-checklist.md)：已确认的实施入口，列出阶段范围、P0 起步证据及尚需细化／讨论的事项。
- [参考底稿](devDoc/design/digital-life/langgraph-roleplay-engine-v2.reference.md)：用户提供的原始资料，未整体采纳。
- [协作指南](AGENTS.md)：后续协作与文档维护约定。

## 分支

| 分支 | 用途 |
| --- | --- |
| `master` | 数字生命新主线，独立历史起点；当前仅保存文档及 Git 忽略配置 |
| `dev` | 原 QQ 编排项目的完整代码和历史，附本次方向讨论的文档归档 |

首轮实施基线已按 DL-129 确认，设计与方案文档按 DL-62 同步远程；编码启动另行安排。旧项目的构建结果、测试计数和既有缓存不代表新主线的实现状态。
