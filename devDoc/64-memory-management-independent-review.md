# MEM01 管理存储独立复核与修复要求

日期：2026-10-26。依据：[61 设计](61-memory-foundation-implementation-plan.md)、[62 验收](62-memory-foundation-acceptance.md)、[63 执行记录](63-memory-foundation-execution.md)。

结论：**MEM01主体Store/服务/API已实现，但本轮未通过独立验收，发现3项P1边界问题。** 63号S01～S12的通过结论需收窄；修复前不进入MEM02运行时写入与guard集成。本次仅复核，未修改生产代码、未提交或打包。

## 1. 验证结果与范围

- 检查MemoryState/schema、Store原子事务、MemoryService设置与CRUD、作用域解析、路由鉴权/审计、Core准入和historyEpoch复用。
- npm test：87文件通过，776项通过、1项既有跳过，总计777项。
- npm run typecheck、npm run desktop:build、git diff --check均通过。
- 既有跳过为Windows链接权限EPERM分支，不影响以下独立复现。
- 本轮无真实QQ、模型调用或界面验收；MEM02～04尚未实施，不因缺少其能力扣减MEM01范围。

本地复现脚本test-results/review64/reproduce.ts已确认Git忽略。使用真实MemoryStore/MemoryService、独立临时目录和可控Store读取等待；结束后验证绝对路径前缀再清理，不接触用户数据。

## 2. R1 / P1：响应丢失后的原请求重试无法命中回执

位置：src/application/memory/memory-service.ts:125–127。

createRecord在查找requestId回执之前先校验expectedRevision。首次成功会改变state revision；如果客户端没有收到响应，只能携带原expectedRevision重试，代码先返回memory_conflict，根本不会检查已原子提交的回执。

实际复现：读取默认r0→新增成功→原样再次提交相同requestId、scope、r0和record，返回memory_conflict。现有`deduplicates stable request ids…`测试给重试换成了首次成功返回的新revision，无法证明响应丢失恢复。

修复要求：保持作用域校验，在同一Store串行事务中先检查有效回执。同requestId/负载、记录仍存在时按明确定义返回幂等结果，不重写/不增加generation；有回执但负载不同或记录已删除仍409。没有回执时才对新建执行expectedRevision CAS。不能通过放宽所有旧revision来修幂等。

正式回归：首次响应丢失原样重试；同请求并发；期间另有写操作后原样重试；换负载、删除/清空后重试、回执过期。对应62号S07及S05，63号回执通过结论暂未成立。

## 3. R2 / P1：写入可成功生成自身无法读取的状态文件

位置：src/memory/store.ts:68–77、98–103；src/memory/schema.ts:128–137。

读取强制8MiB上限，但写入仅校验条数、单条正文和总正文字符数，没有限制实际序列化UTF-8字节数。关键词/元数据及多字节字符会让合法字段组合突破文件上限。

实际复现：1000条，每条正文1048个中文字符（总1048000，未超过1048576），每条16个不同关键词（每个126/127字符，未超过128）。parseMemoryState通过、transact成功，生成9578222字节文件；随后read返回memory_io_error。没有超过现有领域限制，也无需外部篡改磁盘。

这会使合法操作写入后，后续所有设置/列表/CRUD因读文件过大而503；属于成功提交把数据推入不可管理状态，不是单纯容量提示缺失。现有ASCII数量边界测试覆盖不到字节组合上限。

修复要求：在原子替换前对**与实际写入完全相同的序列化字节**检查上限，超限以安全容量错误拒绝，原文件/revision/generation不变。复用公共序列化/原子写入机制，避免估算JSON长度或用紧凑JSON检查却缩进JSON落盘。必要时增加状态总体限制，但读写标准必须一致，不能只无限提高读取上限。

正式回归：中文/emoji/转义字符及关键词组合，文件字节边界，拒绝后原文件逐字不变、可再次读取/编辑，限制错误与真实I/O失败区分。对应62号S06/S08。

## 4. R3 / P1：等待中的事务未复验当前角色作用域

位置：src/application/memory/memory-service.ts的#scope/#assertToken和各#store.transact入口（如123–126、174–176）。

应用层在进入Store之前解析一次contextEpoch并比较expectedScope；之后读取、等待scope串行域和提交都使用捕获的旧scope，不再检查当前显式角色是否仍相同。Store只核对文件scope，无法发现账号服务中的角色已经改变。

实际复现：提交合法旧scope新增→在Store读取处等待→角色resolver切到epoch-b→恢复读取/事务；返回created=true，epoch-a文件记录由1条变2条。当前新角色没有被写入，**本次没有发现跨账号或写入新角色的串用**；问题是角色切换已完成后，未提交的旧角色管理操作仍成功落盘，与旧作用域失效边界不一致。

修复要求：为角色变更与记忆写入定义明确的提交线性化边界，并让提交前的当前scope复验处于该边界内，覆盖所有设置/新增/修改/删除/清空。不能只在HTTP入口再查一次，或仅重验文件内scope；避免引入角色Store与MemoryStore的交叉锁死。若允许已经提交的旧scope操作在角色变更后返回，须与“等待中尚未提交”明确区分。

正式回归：写入等待队列/读取/准备提交期间重绑、解绑、跟随角色版本变化，预期409或已在角色切换前明确提交；拒绝操作不得修改旧/新scope、generation或回执。至少一组通过真实Core/角色绑定服务的集成门控，不能只在调用前改epoch。对应62号S03/S05，以及MEM03未来复用的旧任务失效基础。

## 5. 修复任务与放行条件

| 包 | 工作 | 验收重点 |
| --- | --- | --- |
| MEM-FIX1 | 回执与CAS顺序 | 相同原请求可恢复，未知请求仍严格CAS，删除不复活 |
| MEM-FIX2 | 实际落盘字节上限 | 合法字段组合不能产生不可读状态，失败保持原文件 |
| MEM-FIX3 | 当前角色与提交协调 | 等待中角色变化拒绝旧写，无跨Store死锁 |
| MEM-RECHECK | 正式测试与完整回归 | 62号受影响条目重新填证据，修正文档“全部通过”结论 |

复现摘要输出：

```text
retry-original-request: memory_conflict
accepted-records: 1000 content-chars: 1048000 written-bytes: 9578222
read-written-state: memory_io_error
role-changed-during-transaction: true
old-scope-records-after-role-change: 2
```

以上是异常行为证据，不计为修复通过。修复测试进入test/源码；按实际结果更新63号或新增修复执行报告、README，重新执行全量测试、类型检查、桌面构建与diff检查。

原MEM02计划继续有效，但应先修复这些持久化和作用域问题，再增加检索/上下文/自动提取。当前776项测试通过不足以关闭本报告。
