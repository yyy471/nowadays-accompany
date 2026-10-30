# 模型配置开发文档独立复核

2026-10-29。复核方：`logo_review` 子代理；文档编写方为主代理。对象为[150开发方案](150-model-config-development-plan.md)和[151验收标准](151-model-config-acceptance.md)。本轮仅审读文档并对照当前仓库源码，没有修改正式实现、启动业务服务、运行项目测试或构建发行包。

## 结论与证据等级

修订后的文档在本次源码对照范围通过，可作为待实施工作包的开发与验收依据。**文档通过不等于用户采用候选设计，也不等于任何MC工作包实现或验收完成。** 148/149仅证明离线HTML候选，不能借其数字勾选151中的正式页面验收。

统一工作区、主路由默认账号视图、设置模型分类转为只读摘要与受控跳转、旧hash仍可达服务入口，均已明确写成未来设计决策。当前正式代码仍为设置挂载ModelsPage、model-config挂载PolicyPage；文档没有将此未来结构写成已实现。

## 实际对照范围

| 当前源码 | 核验内容 |
| --- | --- |
| `desktop/renderer/src/pages/Models.tsx` | 五类能力、resolveInitial与settingsModels标记、凭据origin校验、发现/草稿测试/简易保存分离、行级busy与settings草稿注册 |
| `desktop/renderer/src/components/ProviderManager.tsx` | 真实可编辑字段、凭据清除、删除impact与确认、已有服务草稿ID/owner、隐藏字段保留 |
| `desktop/renderer/src/lib/provider-management.ts` | ProviderEditDraft字段及完整baseline构造payload，limits/timeouts/retry/mediaTransports/options与模型参数保留 |
| `desktop/renderer/src/pages/Policy.tsx`与`types.ts` | accounts/slots身份集合、完整policy对象、账号generation与policy草稿准入、授权/开关/绑定、effective、已保存配置测试及费用确认 |
| `desktop/renderer/src/components/SettingsDialog.tsx`与`App.tsx` | 当前设置隐藏挂载、旧settings/models hash解析、统一导航与退出准入、模型主路由的当前职责 |
| `src/service/routes/models.ts`与`src/providers/setup.ts` | HTTP方法/路径/payload、测试result封装、SimpleModelSetup真实字段、凭据/服务维护分离 |
| `src/application/model-settings/model-settings-service.ts` | configureSimpleModel实际串行链、保存构建基于当前服务、凭据来源处理与测试/发现分离 |
| `src/policy/policy.ts` | 模型绑定/能力开关仅账号级；旧scope模型字段不生效；agentEnabled/visionMode作用域仍按现行解析；patchCapability拒绝kind/peerId |
| 公共UI与规范 | feedbackKey/resultLabel确实存在；方向、数值与规范依据关系，以及候选HTML与正式公共控件的边界 |

以上均为源码静态核验，不是浏览器、HTTP运行探针或真实服务验收。

## 发现与修订复核

1. **高级管理能力事实。** 初稿将限流/超时/媒体高级字段编辑及已保存provider测试表述为已有UI。实际ProviderManager只编辑URL、adapter、模型名及secret，另有密钥清除与服务删除。150/151已改为保留这些真实入口，隐藏高级数据往返不丢；后端已有provider测试路由不等于当前存在测试按钮，首包不要求凭空增加。
2. **旧模型作用域。** 初稿的“继承/逐会话覆盖”容易误导实现恢复已停用的会话模型绑定。已明确模型绑定和能力开关只在账号级生效，旧byKind/byConversation模型字段仅保留；agentEnabled/visionMode等现行scope语义另行保留。关闭精确映射为`policy.capabilities[capabilityId] = false`，不删除绑定。
3. **HTTP scope。** 已分开Agent的顶层`{enabled,kind?,peerId?}`与账号能力开关的`{enabled}`；后者不支持会话级scope。没有虚构嵌套scope DTO、新路由、服务revision或policy CAS。
4. **高级编辑草稿归属。** 已点明`settings:provider-manager`与其settings owner也必须随工作区迁移，连同内部按ID准入调用一并更新；不能只迁移简易模型表单。文档补充共享provider的高级/简易草稿与在途操作协调，避免两套陈旧编辑状态互相覆盖。
5. **规范依据。** 已将根DESIGN→正式规格→token的表述改为导航职责，明确数值依105及token处理，不让方向概述覆盖正式规格。
6. **删除服务与清除凭据。** 151 MC-S16已修订并复验为两种独立操作：服务删除先读取provider impact并确认；凭据清除保留其独立确认及已有共享凭据保护，不将provider impact宣称为现有凭据影响预览。

以上问题均先反馈编写方，修订由编写方完成；独立方未修改150/151或业务实现。

## 验收可执行性

151含53个唯一待验收ID：入口8、服务16、账号10、竞态9、视觉10。条目给出前置/操作与可观察结果，包含空/错/旧数据、共享provider保存、来源变化、响应丢失、隐藏策略往返、跨账号迟到、草稿/退出准入、双主题及原生证据分层。

已静态确认所列模型、provider管理/影响、策略、设置导航、退出、token与公共UI测试文件实际存在；本轮没有执行这些测试。两文档的本地Markdown链接经文件存在性检查，无缺失引用；新增152为本次独立复核记录。

正式实现仍须按151执行类型检查、必要定向回归、全量测试、完整桌面构建和真实React/生产dist页面检查，分别记录通过、失败、未执行及发行边界。原生缩放、真实QQ/付费服务和发行包不能由本次文档审读替代。
