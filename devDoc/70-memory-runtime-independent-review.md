# MEM02 独立复核与修复要求

日期：2026-10-26。依据：[67 实现方案](67-memory-retrieval-runtime-implementation-plan.md)、[68 验收标准](68-memory-retrieval-runtime-acceptance.md)、[69 执行记录](69-memory-retrieval-runtime-execution.md)。状态：R1/R2 已由[71 修复与复验](71-memory-runtime-review-fixes.md)关闭。

结论：**MEM02主体链路已接通，最终QQ发送保护有效，但发现1项P1与1项P2，本轮暂不完全通过。** 需要先修复再进入MEM03自动提取。本轮仅复核与记录，未修改生产代码，未提交/打包。

## 1. 已核验与实跑

纯选择器、预览、角色/记忆同epoch捕获、冻结快照、guard摘要、预算装配、入站保存与最终发送均有实现；未发现借本轮开启自动提取或新增页面。

| 检查 | 实际结果 |
| --- | --- |
| npm test | 92文件通过，826项通过、1项既有跳过，共827项 |
| npm run typecheck | 通过 |
| npm run desktop:build | 通过 |
| git diff --check | 通过 |

现有测试能证明普通回复、排队发送与延迟投递的保护，但没有覆盖下述“旧响应触发新的工具执行”和“OR先未知后缓存命中”路径。69号全项通过结论需按本记录收窄。

## 2. R1 / P1：工具执行前校验未携带本轮memory guard

位置：src/instances/instance.ts:684；调用方为src/agent/engine.ts中chat完成后、image/audio任务提交和Provider执行前的context.isRoleBindingCurrent检查。

实例已在context.send、deliver、普通回复及限速后的#send传递capturedMemory.guard，但向Agent暴露的isRoleBindingCurrent只传roleBinding.revision。#automaticAllowed支持expectedMemoryGuard；参数省略时仅判断当前记忆可用，不比较是否仍是本轮快照。

因此，删除记忆或关闭/修改配置后，旧模型响应仍能通过工具执行检查，创建并执行新的生图/语音任务。最终消息发送会被后续guard拒绝，但不能撤销已经执行的外部调用、费用与媒体落盘。

### 实际复现

使用真实Core/Instance/Agent/MediaJob链路与FakeProviderAdapter：

1. 启用记忆，新增pinned fact，配置有权限的生图工具与支持工具的文本模型。
2. 收到draw消息，门控等待文本模型返回；其提示词基于原记忆。
3. 通过记忆管理API删除该fact，generation/guard已变化。
4. 释放旧模型响应，返回generate_image工具调用。
5. Adapter调用记录为chat、image.generate，最终FakeChannel发送0条。

这证明最终投递拦截有效，**未发现该复现中旧结果发到QQ**；缺口是作废轮次仍执行新工具。本测试全为Fake，没有真实费用或外部网络调用。

### 修复要求

把本轮捕获的memory guard纳入Agent统一“本轮仍有效”回调，使Provider排队准入、chat后工具判断、任务提交、job execute及后续处理复用同一准入。不要只在最终发送增加已有检查，也不要把当前新guard替换进旧context来放行。

保留未配置记忆resolver的旧宿主兼容，以及手动发送不受自动轮次guard的语义。若需新增isTurnCurrent命名，所有旧调用方要统一迁移/代理，避免再出现两套部分保护。

### 必须补的正式回归

- 文本模型等待期间删除/关闭/清空/修改记忆，旧响应返回generate_image或generate_speech：不产生新的Provider生成调用，不能只断言sent=0。
- 生成任务已排队但尚未调用Provider时记忆变化：排队执行前拒绝。
- Provider调用已经开始后的变化不承诺撤销已发生费用，但旧结果不继续投递；新轮正常工作。
- 其他scope变化和同请求回执重放不误取消当前有效工具轮次。

对应67号5.3与68号G03/G05，以及工具后续轮必须共享本轮身份的要求。69号G05的“延迟投递拒绝”证据保留，但不能代表工具执行前保护已全覆盖。

## 3. R2 / P2：耗尽计算量后提前break，遗漏后续缓存命中

位置：src/memory/selector.ts matchRecords中exhausted与work+cost两个分支。

遍历一个记录的OR关键词时，遇到未缓存的key且工作量已耗尽，会unknown=true后break。后面即使还有早已缓存为true的key，也不再检查，记录被标为unscanned而不注入。

实际复现：1000条合法fact，第一条用needle缓存true，中间不同长关键词耗尽800万工作量，最后一条keys=['uncached-key','needle']。返回selectedIds只有first-cache，late-or却位于unscannedIds。交换最后两个关键词顺序会改变结果，虽已有足够缓存信息判定命中。

修复：遇未知键只标记unknown并继续查询该OR的其他键；达到计费上限后不新增includes工作，但允许遍历剩余有界键数读取缓存。任一缓存true则匹配，只有最终没有命中且仍有未知判断才列unscannedIds。新耗尽分支与已耗尽分支都要处理，不能仅改一个break。

补正式测试：缓存true位于未知键之后；首次超计费发生在本记录第一键；缓存false与未知混合；后续pinned正常；不突破800万计算限制，预算/数量跳过不混入未完成判断。

对应67号3.2与68号R06/R07。现有R07只覆盖缓存关键词位于首个/唯一位置，不能关闭本问题。

## 4. 可重复证据

本地脚本test-results/review70/reproduce.ts已确认Git忽略。命令：.\node_modules\.bin\tsx test-results/review70/reproduce.ts。

```text
cached-or-result: {"selected":["first-cache"],"lateUnscanned":true,"scanLimited":true}
stale-tools: [ 'chat', 'image.generate' ]
sent-count: 0
```

脚本使用隔离临时dataRoot、真实应用链路、Fake适配器；finally停止Core并检查绝对路径前缀后清理。没有用户账号数据、真实QQ或付费模型操作。上述输出是异常复现，不作为修复通过证据。

## 5. 修复顺序与放行

1. MEM2-FIX1：统一传递捕获memory guard到Agent准入回调，补实际工具执行与排队回归。
2. MEM2-FIX2：修复有界OR缓存遍历，补首键未知/后键缓存命中与计费测试。
3. MEM2-RECHECK：更新正式test/源码、执行全量/类型检查/桌面构建/diff检查，重新填写受影响验收项，保留实际Provider调用次数与发送次数两类证据。

修复后再进入MEM03；不必重做已经通过的Store/预览/普通发送保护。MEM04页面、真实QQ/付费服务和原生验收仍待后续，不能因本阶段后端测试通过就一并关闭。
