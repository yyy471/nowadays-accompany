# 145 关系页原貌迁移独立复核

2026-10-28。复核方：独立审查代理。范围为 [143 方案](143-relationship-journal-migration-plan.md)对应的 React 关系页、控制器、共享预览/补丁和为浏览器共享解析器做的依赖拆分；不把工作区既有后端扩展开发归入本轮迁移。

## 结论

本轮发现的 R1～R9 已在代码、实际纯函数和定向回归范围内关闭；当前未保留未修复的 P1/P2。迁移可以进入本地桌面构建与后续原生体验验收。本文不确认真实 QQ、真实模型、原生退出协议或发行 EXE 已验收；全量结果以实现方最终执行记录为准。

## 第一轮发现与修正复核

| 编号 | 级别 | 发现及复现 | 当前复核状态 |
| --- | --- | --- | --- |
| R1 | P1 | `use-journal.ts` 总览预取 B 请求未完成时切到 B 并编辑；预取迟到会无条件替换 B 草稿。 | 已见修复：预取提交缓存时重新检查目标快照和草稿是否存在；控制器回归覆盖该时序，关闭。 |
| R2 | P2 | `journalRole` 对 follow 引用取第一个历史制品，且忽略服务端绑定的 missing 状态，可能显示错误版本或误报可用。 | 已保存绑定改用 `resolvedRevision`/`state`，公共草稿改用 current catalog；私有 follow 新草稿标记 pending，不猜 revision。角色保存后补读服务端视图；临时绑定只保留新响应并标 `needsRefresh`，不复制旧角色解析/世界书字段。关闭。 |
| R3 | P2 | policy 已保存暂停，但旧 `effective.agentEnabled=true` 优先级更高；会话仍可能显示“可回复”。 | 已见修复：回复策略由已保存 policy 解析；实际脚本和回归确认暂停理由保留，关闭。 |
| R4 | P2 | 账号通用页预览以 private 虚拟会话解析完整树；private 分类的关闭会错误显示为账号通用资源不可用。实际纯函数复现输出“会话开关关闭”。 | 已见修复：预览剪裁后代作用域；回归通过，关闭。 |
| R5 | P2 | 绑定启用的世界书丢失或损坏时，运行时会阻止回复，但 verdict 未检查 `worldbook.enabled` / `effectiveWorldbook.state`。 | 已见修复：加入不可用世界书原因并指向现有管理入口；回归通过，关闭。 |
| R6 | P2 | 清单中已缺失资源 ghost 恢复 inherit 后，补丁仅枚举 catalog 和 draft 键，未包含旧键，不能删除远端覆盖。 | 已见修复：`exactScope` 同时合并 previous 键，明确发送 `ghost:inherit`；回归通过，关闭。 |
| R7 | P2 | `/effective` 缓存键仅含扩展 revision、policy 和绑定 revision；全局 provider/凭据变化后重读这些值可保持相同，新诊断请求失败时旧 chatAvailable 仍可匹配。 | 已加入 readAt 读取代际，定向回归确认重读后诊断失败不再取旧 EF，关闭。 |
| R8 | P2 | 原 xray CSS 会隐藏卡片的 how/src/under 等普通内容，原型依靠 strata 显示继承链；新 JSX 尚无 strata，入口会隐藏信息却不提供来源层级。 | 已确认 `JournalLayers` 实际进入卡片 JSX，按真实三层开关/获胜来源及定义默认值生成 strata；关闭时 aria-hidden。复用原版展开 CSS；实际 `source-layers.png` 可见三层与当前来源，关闭。 |
| R9 | P2 | `usePoll` 失败时保留旧 slots.data，App 原先未把 slots.error 传给新关系页。曾在线的 QQ 可在新连接查询失败后继续被当成已连接。 | App 已传 slotsError；关系页连接、书脊及总览统一使用错误时失效的 connectionSlots，错误本身可见。静态链路核对通过，关闭。 |

## 私有 follow 引用的证据边界

`LocalArtifactStore.resolve` 优先读账号 catalog，fallback latest 会跳过仅导入而未部署的 revision。`GET /accounts/:id/artifacts` 仅返回制品清单，不返回账号 catalog。因此，对于尚未保存的新私有 follow 草稿，从清单取字典序最大 revision 不能保证等于真实解析结果。本轮修正已显示 pending/保存后核对，不再推断具体 revision。已保存绑定的 `resolvedRevision` 可作为依据。保存接口返回原始绑定，不含这些视图字段，保存后的显示也应遵守此边界。

## 已核对的契约

- 新页沿用 `api()` 的本地令牌处理；角色/策略 URL 始终携带目标账号，已见过滤候选会话和绑定的账号归属。
- 扩展保存携带 `expectedRevision` / `expectedProfileRevision`；冲突不自动覆盖；网络或服务端结果不明时阻止重提并提供只读核对。
- 角色批次逐项清除已确认草稿，未确认项目保留；现有角色 PUT/DELETE 不支持服务器端 CAS，前置读取只能减少冲突，不能承诺原子冲突保护。
- 回复开关用现有 `/agent` 作用域参数；加入会话先写暂停策略，不会自动安装插件、扩大工具授权或触发 QQ/模型调用。
- 昼夜选择只进入既有主题上下文，未见主题选择写业务配置；确认、Modal 和 DraftProtection 继续复用公共入口。
- 解析器依赖拆分保留旧 `pluginKey` 和 `conversationScopeKey` 公开导出与标识符校验；未引入浏览器 crypto polyfill。

## 非阻塞后续边界

- 原 P3 主项已处理：`JournalResource.accountPrivate` 覆盖私有插件、私有 Skill 及私有插件提供的 Skill；总览的 resourceId/roleId 对私有资源加入 accountId，筛选标签显示 QQ，避免不同账号同名私有资源合并。追加静态核对发现“引用已缺失”的占位分支尚无 accountPrivate，可保守按账号隔离未知引用；该细节无跨账号写入风险，已通知实现方，不重复全量测试。
- 总览自动预取当前最多前 32 个账号，页签模型每账号每类最多 500 个会话；本轮不把此范围称作无上限海量会话验收。
- 角色绑定接口无原子 CAS，仍保留该既有契约限制；实际角色内容、世界书、连接与模型状态可在外部变化，页面诊断是已读取快照，不等于已发出真实回复。

## 独立执行的检查

1. 阅读实际角色/策略路由、角色绑定存储、世界书解析及实例回复前置约束，对照本轮 DTO 与控制器。
2. 用实际纯函数脚本复现 R3、R4，并检查修正后的 R2 missing 状态保持。
3. 定向 Vitest：迁移模型/控制器及既有扩展编辑器，最近一次 3 文件 33 项通过；`npm run typecheck` 在最终 JournalLayers 写入后再次通过。独立脚本同时确认账号预览不受 private 子级关闭影响、已保存暂停覆盖旧 EF、新私有 follow 草稿为 pending。
4. 读取实现方实际浏览器截图 `test-results/relationship-journal/night-draft.png` 与 `source-layers.png`，检查材质与来源层实际可见；这是截图复核，不冒充复核方独立操作浏览器或原生应用。

实现方其他尺寸、全量测试及桌面构建证据以最终执行记录为准；本复核没有独立操作真实 QQ、付费模型或用户运行数据。
