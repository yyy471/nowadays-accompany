# WB03 会话来源与Agent运行链路执行记录

日期：2026-10-26。依据：[46 实现方案](46-independent-worldbook-implementation-plan.md)、[47 验收标准](47-independent-worldbook-acceptance.md)、[49 剩余任务](49-independent-worldbook-remediation-plan.md)。资源服务前置见[51 WB02](51-worldbook-resource-service-execution.md)。

## 1. 已实现

独立世界书现在可以通过会话设置API选用固定版本，实际Agent与只读预览共用该来源。来源与参数一次CAS保存，不修改角色卡引用。仍然只支持“内置书或一本独立书”二选一，不自动合并多书、不跟随最新版本。

本轮完成后，49号临时“带source一律拒绝”已移除，替换为正式校验/保存。旧客户端省略source时保留已存来源，旧文件缺worldbookSource时仍视为内置；未知来源明确报错，不能静默回退。

没有增加页面编辑器或来源选择控件；用户可见的完整交互由WB04/WB05继续接入。当前前端设置仍主要操作开关与参数，但不会因为省略source而清除已保存独立来源。未宣称47号所有页面及实机项目已验收。

## 2. 数据与应用职责

ConversationRoleBinding增加可选worldbookSource。磁盘读取使用共享来源schema，固定public id/revision均校验。Store在role-bindings.json既有串行域中检查expectedRevision，再一次写入来源、参数、新revision及稳定contextRevision。提交失败不产生成功结果。

新增src/application/worldbooks/effective-worldbook.ts，统一返回：

- view：来源、固定revision、名称、条目/启用数、ready/empty/missing/invalid及安全错误摘要。
- book：当前解析的规范化书；缺失或无书时不提供。
- guard：来源、状态与规范化书正文的SHA-256摘要。

AccountService的列表、设置校验、预览和运行时共用此用例。LocalArtifactStore固定解析补充资源外层名称，不在世界书路径不匹配诊断中输出完整本地目录。

设置时，新选的独立来源必须存在且可解析；启用时至少有条目。全部条目禁用仍可选用，状态empty且不注入。已经缺失/损坏的来源允许明确关闭并保留引用，即使请求显式带回同一来源，也不要求先修好文件才能关闭；新的无效来源仍拒绝。

## 3. 本轮快照、历史与发送校验

每条消息捕获worldbookSnapshot，书与配置随角色绑定传入宿主，Agent使用该快照装配上下文。明确存在但不含book的快照表示无书/关闭，不能再退回card.manifest.worldbook。旧宿主上下文没有快照字段时保留原内置书兼容路径。

本轮resolved binding revision包含世界书guard，因此以下情况均改变发送校验结果：改来源、切revision、调整参数、同revision被外部修改、文件缺失或损坏。现有automaticAllowed在发送前重验guard，并拒绝worldbookUnavailable的绑定；不会将新书拼接到已经生成的旧回复。

历史contextEpoch继续由contextRevision与角色卡来源/版本组成，**不含世界书guard**。换书、调参数不会隐式使同角色历史不可见；重绑角色仍按原规则重置来源、开关及历史边界。

启用书不可用时，仍捕获角色与历史epoch，入站消息正常保存；发出可恢复worldbook_unavailable诊断，该会话不自动调用模型/发送回复。其他会话与手动发送沿用原规则。关闭后恢复角色回复，不静默使用内置书。

禁用状态下的运行时解析不调用resolveWorldbook，不因悬空独立引用阻止回复；列表为了展示可恢复状态仍会检查资源。关闭不等于删除引用。

## 4. 正式接口

PUT /accounts/:account/role-bindings/:kind/:peer/worldbook沿用鉴权与审计：

```json
{
  "expectedRevision": "从会话绑定列表读取的当前revision",
  "worldbook": { "enabled": true, "scanDepth": 4, "budgetChars": 2000 },
  "source": {
    "kind": "artifact",
    "ref": { "source": "public", "id": "garden", "revision": "r1" }
  }
}
```

source可省略以保留现有值；显式{kind:"role-card"}切回内置。source:null、private、缺revision或未知字段拒绝。来源字段和参数经parseWorldbookSettings验证，expectedRevision由路由单独验证，不误传给领域schema。

返回binding包含worldbookSource（已显式设置时）。GET绑定列表增加effectiveWorldbook及有效来源的worldbookEntryCount/worldbookDefaults。来源不可用不会伪装角色卡本身缺失。

同绑定旧expectedRevision返回409；选不存在的新独立版本404；结构/来源非法400。POST同路径/preview只使用已保存来源与给定文本；不可用的启用书返回409 worldbook_unavailable，无模型/QQ调用，不读真实会话历史。

## 5. 自动验收证据

test/worldbook-integration.test.ts由6项扩展到15项。原“来源暂不支持”的断言已更新为非法来源拒绝，并保留文件不变/版本不变断言。

| 覆盖 | 证据 |
| --- | --- |
| 来源实际保存与重读 | 鉴权HTTP保存，返回/列表/新Store实例均读到固定来源 |
| 兼容与原子性 | 省略source保留独立书，切回内置恢复原预览，重绑清除；模拟rename失败文件逐字不变 |
| 严格来源 | 磁盘未知kind明确拒绝；不存在来源404、null拒绝，不改变文件 |
| CAS与并发 | 同绑定两个来源竞争一成一败；同账号不同会话并发更新无丢失 |
| 实际提示词 | FakeChannel→Instance→Agent→FakeProvider→发送，独立正文生效且不叠加内置书 |
| 固定版本 | 保存r2后r1会话不自动变化；明确切r2后实际提示词使用r2 |
| 历史和隔离 | 切书后同角色历史仍可触发；其他账号及群聊历史不参与 |
| 旧轮回复 | 模型生成门控期间分别切版本、外部改写、删除、破坏JSON，旧轮均不发送 |
| 缺失恢复 | 状态missing，预览409，入站保存但不调用模型；手动发送及其他群聊正常；明确关闭恢复 |
| 禁用不读书 | spy确认disabled运行时不调用独立资源解析，历史epoch保持 |

命令结果：

- npm test：82文件通过，726项通过、1项既有跳过，总计727项。
- npm run typecheck：通过。
- npm run desktop:build：通过（核心、renderer、main/preload）。
- git diff --check：通过。

既有跳过仍为Windows链接权限EPERM分支，本轮没有新增skip。自动测试使用隔离临时目录、FakeChannel/FakeProvider，没有真实QQ或付费模型调用。

发送链路复用既有最后发送前校验；本轮新增测试在模型生成处门控，既有回归还覆盖限速队列等待后的重验。没有另外声称执行跨进程恶意篡改、原生QQ或Electron人工验收。

## 6. 下一任务

下一步按49号推进WB04：资源库世界书列表/版本查看、新建/复制/条目编辑、保存新版本、草稿只读试算、统一dirty/busy保护与浏览器验收。接着WB05在会话弹窗中提供来源/固定版本选择、状态恢复与建议参数按钮；最终WB06按47号逐项填写完整验收。

保留工作区已有改动；未Git提交，未更新release EXE。长期记忆、情绪和遗忘曲线仍在世界书整阶段验收之后。
