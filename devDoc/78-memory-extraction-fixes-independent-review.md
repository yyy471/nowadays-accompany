# MEM03 修复独立复验

日期：2026-10-26。依据：[76 独立复核](76-memory-extraction-independent-review.md)、[77 修复记录](77-memory-extraction-review-fixes.md)，并对照73/74号方案与验收标准。

结论：**76号R1/R2两项P1修复通过。本次未确认新增生产代码缺陷，但全量回归出现过两次端到端水位等待超时，尚未定位，应保留稳定性待查项，不以最终一次全绿抹除先前失败。**

## 1. R1：长消息停滞关闭

检查`src/application/memory/extraction/input.ts`和`coordinator.ts`：

- 六条准入使用`eligibleTexts`，与实际模型批次`messages`分离。
- 字符预算满后固定批次前缀，继续统计合格文本；未处理文本不推进成功水位。
- 未达门槛的续扫缓存按scopeToken/generation/throughSeq匹配，下一次合格通知从已检查seq之后继续；缓存容量有界，关闭时清空。
- 原调用间隔、配额、失败冷却及会话队列提交仍保留。

新增正式回归覆盖长文本、低扫描上限续扫、完整链路逐批推进。另复制76号独立脚本，仅修改预期为修复后的行为，在真实Core、内置Agent、JsonlStore、FakeChannel和FakeProvider下重复相同场景：

```json
{"name":"long-text-prefix","sent":12,"extractionCalls":6,"throughSeq":21,"status":"active","accountUsed":4}
```

六条13000字符文本后追加六条短文本，调用由原0次变为6次，水位由0推进到21。`accountUsed=4`是脚本每轮推进6分钟后跨整点窗口的当前计数，不是六次累计调用只记四次。正式回归还覆盖后续累计门槛和17条文本实际批次无遗漏。

## 2. R2：自动重试/回退关闭

检查`src/providers/router.ts`和Core提取适配器：

- 统一Router接受单次调用执行策略；提取明确传`{ fallback:false, retry:false }`。
- 不改用户的服务retry配置，不复制Provider客户端；原权限、凭据、限流、配置校验和executionGuard路径保留。
- 普通调用未传策略，既有重试/回退行为通过新增对照回归。
- 首次失败交回协调器记录冷却，水位不推进；冷却内新通知以及冷却到期但无新通知均不发起调用。

与76号相同的独立场景：服务允许两次尝试，Fake提取首次抛可重试错误、若再次调用则成功。

```json
{"name":"provider-retry","sent":6,"extractionCalls":1,"throughSeq":0,"status":"cooldown","accountUsed":1,"cooldown":1700002760000}
```

旧结果为调用2次、水位11且active；现在调用1次、水位0、进入冷却。正式`memory-extraction-provider-policy`回归同时验证配置fallback可成功但未被调用。

## 3. 待查观察 V1：端到端水位等待不稳定

本次确实观察到两次不同失败：

| 执行 | 结果 |
| --- | --- |
| 第一次原始`npm test`，与类型检查/构建并行 | 915通过、1失败、1既有跳过；O09在`test/memory-extraction-runtime.test.ts:208`等待水位11超时 |
| 单独运行`memory-extraction-runtime.test.ts` | 8项全部通过 |
| 第二次原始`npm test`，未并行构建 | 915通过、1失败、1既有跳过；E2E在同文件`:341`等待水位11超时，O09通过 |
| 隔离副本重复O09门控场景 | 12次全部通过，其他7项按名称筛选未运行 |
| 带诊断副本与原始全量同时运行，两次 | 每次103文件、935通过、1既有跳过，全部通过 |
| 最终原始`npm test` | 102文件、916通过、1既有跳过，退出码0 |

前两次失败都在等待提交水位，不能仅凭超时就断言数据已丢失，也不能仅凭后续通过就断言纯属机器负载。第一轮并行构建并非充分解释，因为第二轮未并行构建仍失败。原用例未输出超时时的实际水位、提取状态和失败原因，未取得能确定根因的现场；带诊断副本未再次触发失败。

### 建议验证任务 M3-VERIFY1

1. 在这两个正式用例的失败路径保留实际状态：scope/revision/generation、水位、运行状态、lastFailure/cooldown、Provider调用数、输入批次seq、通道发送数；只含测试标识和计数，不记录聊天正文或凭据。
2. 用门控固定完成通知、续扫缓存、Provider返回、提交排队和事务提交的顺序；区分尚未开始、被guard拒绝、提交失败、水位不等于预期等情况。
3. 在全量负载下复验；若确认生产竞态则修生产代码，若确认断言或测试同步问题则修测试。不要仅增加超时、放宽水位断言或重跑到绿来宣布关闭。
4. 更新77号验收证据，记录定位结果。当前仅确认V1是测试稳定性/可诊断性待查，未将它升级成已证实的生产数据错误。

原两项P1可独立关闭；建议完成这项验证后再宣称MEM03无保留收口。MEM04页面可以先做方案设计，但本次没有验证页面或真实模型服务。

## 4. 其他检查和交付

- `npm run typecheck`：退出码0。
- `npm run desktop:build`：退出码0，服务端、renderer和Electron main/preload构建通过。
- `git diff --check`：通过。
- 复现脚本与诊断副本、原始配置最后一次输出位于被Git忽略的`test-results/review78/`。其中`reproduce.ts`使用修复后断言，`baseline-recheck.log`记录最后一次原始全量通过；诊断副本的额外筛选不改变正式测试的skip数量。
- 本次只新增复验文档、更新导航和忽略目录内诊断资料，未修改生产代码或正式测试源码，未提交、打包或更新EXE。
- 既有范围仍限定自动fact；摘要、MEM04管理页面、真实QQ/付费服务、暂停后的远端取消或退款不由本次自动验证证明。
