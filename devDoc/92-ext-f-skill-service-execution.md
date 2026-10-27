# EXT-F Skill 服务执行记录

日期：2026-10-27。状态：EXT-F 后端与自动化证据完成；主进程复核（[93](93-ext-e-f-independent-review.md)）追加 R1/R2，修复与回归见[94](94-ext-ef-review-fixes.md)。未提交、未打包、未替换 EXE，也未调用真实 QQ 或付费模型。

依据：[79 Agent 主体、统一工具与扩展作用域方案](79-agent-extension-execution-plan.md) §7、[80 验收标准](80-agent-extension-acceptance.md) S01–S06。

## 1. 本包交付

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 多来源目录与覆盖关系 | [catalog.ts:56](file:///D:/app/nowadays/accompany/src/extensions/catalog.ts#L56)、[catalog.ts:142](file:///D:/app/nowadays/accompany/src/extensions/catalog.ts#L142) | 公用、账号私有、插件声明三来源；私有同 id 覆盖公用时标记 `overrides: 'public'`；插件 Skill 使用 `source/plugin/<id>/skill/<id>` 完整命名空间，用户定义 id 不含 `/`，结构上不能互相遮蔽 |
| 统一提示词预算选择 | [skill-selection.ts:8](file:///D:/app/nowadays/accompany/src/extensions/skill-selection.ts#L8)、[skill-selection.ts:72](file:///D:/app/nowadays/accompany/src/extensions/skill-selection.ts#L72) | 名称 200 字符、正文 8000 字符、8 工具/定义、8 项/scope、累计 16000 字符；累计预算按 `### 名称 + 正文` 的实际渲染长度计，私有→公用→插件、来源内完整 id 升序；超限项带原因排除，不截断正文；预算耗尽后不再让后续短项插队 |
| 统一上下文注入 | [engine.ts:605](file:///D:/app/nowadays/accompany/src/agent/engine.ts#L605)、[extension-tool-service.ts:44](file:///D:/app/nowadays/accompany/src/application/extensions/extension-tool-service.ts#L44) | 快照提供带来源与工具引用的候选 Skill；engine 用同一选择函数，预留工具定义与固定包装开销；若 JSON 转义等实际序列化开销仍超限，从尾部逐项回退，保证工具协议优先 |
| 公用定义 CRUD/CAS | [config-store.ts:184](file:///D:/app/nowadays/accompany/src/providers/config-store.ts#L184)、[skill-service.ts:57](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L57) | 只替换 `skills` 子树；revision 由定义内容摘要计算，配合 ConfigStore 版本 CAS；过期保存返回 `skill_conflict` |
| 私有定义 CRUD/复制 | [skill-service.ts:92](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L92)、[skill-service.ts:100](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L100)、[skill-service.ts:110](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L110) | 私有定义写入账号策略子树，保留其他字段；可同 id 覆盖或从公用复制；复制同样校验上限；私有定义不保存 `enabled`，启停统一走作用域开关 |
| 影响分析与只读预览 | [skill-service.ts:82](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L82)、[skill-service.ts:132](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L132) | 删除前列出私有覆盖与 defaults/kind/conversation 显式开关，并用 `defaultScopesAffected` 标明默认启用范围也受影响；预览使用与运行时相同的有效解析器和选择函数，返回来源、覆盖、依赖原因、开关来源、预算排除原因及 `runtimeMayTrim`，不调用模型、不执行工具、不写入配置 |
| 统一有效能力视图 | [core.ts:795](file:///D:/app/nowadays/accompany/src/core/core.ts#L795) | `/accounts/:id/effective` 的 Skill 部分改为扩展解析器结果（含插件 Skill/工具与私有覆盖），并带出 `selected`、`selectionReason`，区分 scope 可用与进入提示词；预览失败时回退旧视图并记录警告，不拖垮能力诊断 |
| HTTP 接口 | [skills.ts:11](file:///D:/app/nowadays/accompany/src/service/routes/skills.ts#L11)、[contracts/skills.ts](file:///D:/app/nowadays/accompany/src/contracts/skills.ts) | 公用 `/skills`、`/skills/:id`、`/skills/:id/impact`；私有 `/accounts/:id/skills/private`；预览 `/accounts/:id/skills/effective`（必须带 kind 与 peerId）；复用鉴权、请求体限制、审计与错误映射 |

## 2. 选择语义

候选只包含有效解析结果中 `enabled` 的 Skill；`enabled` 已经同时满足插件安装/运行开关、账号工具授权、handler 就绪、能力依赖、定义 `kinds`/`peers` 与账号作用域开关的交集。随后按以下顺序处理：

1. 私有定义（账号策略）→ 公用定义（ConfigStore）→ 插件声明；
2. 同一来源内按完整 id 的码点升序；
3. 名称超过 200 字符 → `name_too_long`；正文超过 8000 字符 → `instructions_too_long`；引用工具超过 8 个 → `too_many_tools`；
4. 已选满 8 项 → 后续标记 `skill_limit`；
5. 累计渲染长度将超过 16000 字符 → 当前及后续全部标记 `instructions_budget`；预算耗尽后不再继续挑选更短的后续项，保证更小预算下运行时结果始终是预览的前缀。

选择结果只影响提示词，不改变定义、授权或作用域。运行时在 16000 之外再用 `min(16000, 当轮可用上下文 − 工具定义预留 − 64)` 收紧总量，再按实际序列化大小从尾部回退；预览展示标准上限下的结果，并通过 `runtimeMayTrim` 明示具体模型可能进一步裁剪。

预算未注入项由预览逐项给出 `selected=false` 与 `selectionReason`；engine 同时写一条 debug 日志（id:reason，运行时回退标记为 `context_budget`），不会静默改写 Skill 正文。

## 3. CAS、影响与 guard 范围

- 公用 revision 覆盖整个 `skills` 数组；保存/删除先比对 revision，再以读取时的 ConfigStore 版本提交。Skill 写入路径上的并发修改使版本变化时返回 `skill_conflict`。
- 私有 revision 覆盖该账号 `skills.definitions`；提交走 `updateAccountPolicy` 的同一 mutation 链与版本 CAS，只替换 definitions，保留 `allowedProviders`、绑定、Agent/能力开关等字段。
- 旧的整策略保存（`PUT /accounts/:id/policy` 与页面草稿）不再能清空私有定义：`ConfigStore.setAccountPolicy` 始终保留当前存储的 `skills` 子树。Skill 定义只由 Skill 服务写入；EXT-G 再把页面切到专用策略/定义接口。
- 删除公用定义前 `impact` 返回仍存在的私有覆盖、显式启停引用与 `defaultScopesAffected`；删除后运行开关与私有定义原样保留，私有版本继续生效，公用回退关系消失。
- 会话扩展快照的 token 已包含实际进入 scope 的 Skill id/名称/正文；公用定义修改使启用该 Skill 的账号/会话 guard 变化，未启用的账号与无关会话 token 不变。

## 4. S01–S06 映射

| 验收 | 证据 |
| --- | --- |
| S01 公用/私有新增、编辑、复制、删除、重启 | `skill-service`：公用 CRUD + 重新加载配置文件；私有保存/编辑/删除；复制与再次复制 `replaced`、复制超限定义被拒绝；`skill-api`：HTTP CRUD、点号 id、409/404 |
| S02 同 id 私有覆盖、插件命名空间 | `skill-service`：私有 `source=private`、`overrides=public`，插件 Skill 独立 id/来源；公用列表不受私有影响 |
| S03 未授权/无 handler/停用插件工具 | `skill-service`：引用未授权工具与缺失能力时 `enabled=false`，原因为 `skill_tool_unavailable`、`requires_unavailable`；预览不改变账号硬授权。EXT-A/D 的 `extension-policy` 用例继续覆盖插件停用与 handler 未就绪 |
| S04 群/私聊/指定对象启停 | `skill-service`：定义 `kinds/peers` 与 defaults/byKind/byConversation 开关取交集；仅允许的会话进入 `included`；预览返回 `switchSource`，`/effective` 对范围不符项保留 `scope_mismatch` 原因 |
| S05 超过 8 项/总量/上下文剩余预算 | `skill-service`：8 项上限、16000 渲染总量、单项超长与超长名称、预算耗尽后单调排除；`agent-tool-loop`：超过 8 项只注入 8 项，上下文变小时按剩余预算继续裁剪且仍保留工具协议 |
| S06 只读预览、影响分析 | `skill-service`：预览前后配置文件字节与 ConfigStore 版本不变；影响包含显式引用与默认范围标记；`skill-api`：impact 路由只读返回，预览必须给出真实 scope |

## 5. 独立复核与修复

独立复核首轮结论为不通过，提出 2 项 P1 与 5 项 P2；修复后原复核者复验为“全部关闭、无新增 P0/P1”。

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| P1-1 | Skill `name` 无上限，只统计正文会被超长名称绕过预算 | 保存/复制限制 200 字符；选择器计入名称与标题渲染长度；engine 先预留工具定义与包装，再按实际序列化大小从尾部回退；新增超长名称与上下文裁剪测试 |
| P1-2 | 旧整策略 PUT 可无 CAS 覆盖并清空私有定义 | `setAccountPolicy` 保留当前 `skills` 子树；`skill-api` 增加旧页面草稿保存后私有定义仍在的回归 |
| P2-3 | 含点号的 Skill id 可创建但不能删除/复制/分析 | Core 使用与 schema 一致的 `assertSkillId`；HTTP 用例覆盖点号 id 全路径 |
| P2-4 | 预算超额后继续挑选短项，预览与运行时不是前缀关系 | 预算耗尽后剩余项统一标记 `instructions_budget`；单元测试确认单调性 |
| P2-5 | `/effective` 仍展示旧解析器，看不到插件 Skill/工具 | Core 用扩展预览替换 Skill 部分并保留旧形状；原因词表映射；预览失败回退旧视图 |
| P2-6 | 预览路由默认伪造 scope，且缺少开关来源与裁剪提示 | preview 必须带 kind+peerId；返回 `switchSource`、`runtimeMayTrim` |
| P2-7 | 影响不说明默认启用范围；复制绕过保存上限 | 增加 `defaultScopesAffected`；复制走与保存相同的上限校验 |

首轮前作者自检还发现并修复：私有定义不能保存 `enabled=false`（账号策略解析拒绝），复制默认停用定义会失败；列表/预览返回的 `source`/`overrides` 若被前端回传会被严格字段解析拒绝。现在复制剥离该字段、直接保存 `enabled=false` 给出明确错误，保存入口剥离只读元数据。

主进程复核追加的非工具模型预算（R1）与能力视图选择状态（R2）已在[94](94-ext-ef-review-fixes.md)修复：Skill 回退不再以“是否提供工具”为前提，任何请求都会按实际序列化大小从尾部移除 Skill；`/effective` 同时表达 scope 可用与 `selected`/`selectionReason`。仍保留的低风险：

- `/effective` 的模型能力与 Skill 预览仍是两次独立读取，极端并发下可能短暂混合；Skill 预览失败已回退旧视图。
- 对从未有过 `skills` 字段的账号，第一次旧整策略保存仍可能导入超限的 legacy 定义；运行时选择会排除这些定义，不会进入提示词。
- 历史消息或原始输入本身造成的超限仍按既有语义保留；本包只保证新增 Skill 不会撑破请求。

## 6. 未完成与边界

- 页面与扩展策略写入路由不在本包：Skill 的启用/停用、群/私聊与具体对象覆盖由 `ExtensionPolicyService` 的扩展作用域开关承载（EXT-A/D 已实现读写与校验），但尚未暴露 HTTP 路由；EXT-G 负责“插件与Skill”页面、有效策略展示、草稿保护，并把旧策略页从整包 PUT 切到专用接口。
- `ProviderRouter.effective` 的旧 `SkillRuntime` 视图仍被直接诊断测试与 engine 无工具回退使用；生产 `/effective` 已改走扩展解析器，EXT-H 再清理旧视图与重复字段。
- 预览选择使用标准上限；具体模型的上下文可能更小，运行时按同一前缀继续裁剪，页面需展示 `runtimeMayTrim`，不能承诺预览等于任意模型的最终注入。
- 删除公用定义不会自动清理账号里遗留的开关键；当前解析器会忽略不存在的 id，后续可在删除影响界面提供显式清理。
- 未实现 Skill 版本历史、导入导出、插件 Skill 复制为私有（按方案插件 Skill 不复制）。
- 未进行原生界面交互、真实 QQ、真实模型或发布包验证。

## 7. 运行证据

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.test.json --noEmit` | 通过 |
| `npx vitest run test/skill-service.test.ts test/skill-api.test.ts` | 19/19 通过 |
| 复核修复后 6 文件定向（skill-service、skill-api、agent-tool-loop、host、agent-media-tools、extension-policy） | 67/67 通过 |
| `npx vitest run` | 95/96 复验后连续两次 113 文件通过；1078 项通过、1 项既有跳过 |
| 主进程复核与修复 | 首轮 2×P1、5×P2 修复复验通过；93 追加 R1/R2 已由 94 关闭；全量与桌面构建通过 |

实现文件：`src/extensions/skill-selection.ts`、`src/application/extensions/skill-service.ts`、`src/contracts/skills.ts`、`src/service/routes/skills.ts`，以及 catalog/engine/tool-service/config-store/Core/路由装配的接线改动。测试文件：`test/skill-service.test.ts`（15）、`test/skill-api.test.ts`（4）、`test/agent-tool-loop.test.ts`（新增 2 项）。
