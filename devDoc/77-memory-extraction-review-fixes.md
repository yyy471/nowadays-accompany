# MEM03 76号复核修复与复验

日期：2026-10-26。状态：76号R1/R2两项P1已修复并通过复验，MEM03自动提取可收口；MEM04管理页面、摘要、真实QQ/付费服务仍不在本轮范围。复核要求见[76](76-memory-extraction-independent-review.md)，原方案/验收/执行见[73](73-memory-extraction-implementation-plan.md)、[74](74-memory-extraction-acceptance.md)、[75](75-memory-extraction-execution.md)。

## 1. 修复结论

| 项 | 级别 | 结果 | 内容 |
| --- | --- | --- | --- |
| M3-FIX1 | P1 | 已修复 | 六条准入门槛改用“已扫描到的合格文本数”，与字符预算批次分离；扫描上限用有界进程内续扫进度跨触发继续，不再重复扫描同一前缀 |
| M3-FIX2 | P1 | 已修复 | `ProviderRouter`新增按调用的执行策略；自动提取固定单次调用、禁用自动重试与fallback，失败交回协调器进入10分钟冷却；普通Agent重试/回退保持原语义 |
| M3-RECHECK | - | 完成 | 新增7项正式回归；102个测试文件、916通过、1项既有跳过；类型检查、桌面构建与diff检查通过 |

修复未新增API、UI、依赖或配置项，未修改用户服务的retry配置，未调用真实QQ或付费模型，未提交、打包或更新发行包。

## 2. R1：准入统计与字符预算批次分离

### 2.1 根因

协调器原先用`batch.messages.length >= 6`判定准入，但`messages`是按24000字符截断后的模型输入。当前缀含长消息时，一批只能装1～5条，协调器直接返回且水位不前进；下一次触发仍从相同水位读取完全相同的前缀，形成永久停滞。扫描上限前只有1～5条合格文本、后面仍有积压时，旧逻辑推进到首条文本之前也会重复扫描同一窗口。

### 2.2 修复

`src/application/memory/extraction/input.ts`：

- 新增`eligibleTexts`：扫描时按触发seq正向统计合格文本数，最多到`admissionTexts`；该计数不再受字符预算或50条批次上限影响。
- 批次仍只选连续前缀，遇到第一条装不下的消息即闭合；`processedThroughSeq`只覆盖实际批次前缀（批次闭合后不再前进）。
- 新增`scanLimit`（默认10000条，生产由协调器传入）和有界续扫：
  - 未达门槛且已选到文本时，返回`scan.afterSeq`（最后检查seq）与`batchClosed`；
  - 协调器把批次前缀和扫描进度保存在进程内，下一次触发从`afterSeq`之后继续统计，不再读取旧前缀；
  - 已选文本/批次闭合状态随进度携带，达到六条后仍用原前缀发起一次调用；
  - 续扫记录按`scopeToken+generation+throughSeq`校验，scope/角色/水位变化即失效；容量受`maxPendingScopes`约束，`close()`清空。
- 页耗尽优先于记录上限判断：已读完的区间不再产生无效续扫。

`src/application/memory/extraction/coordinator.ts`：

- 准入判断改为`batch.eligibleTexts < minNewTexts`。
- 只有“没有任何合格文本”（`messages.length === 0`）时才通过`advanceExtraction`推进已检查的非文本前缀；有合格文本时绝不跳过、绝不推进到触发seq。
- 成功调用或状态推进后丢弃续扫前缀；Provider失败保留同一前缀，冷却后的下一次尝试可复用，不重新扫描长前缀。
- 新增`scanRecordsPerScan`协调器上限，默认10000，供完整链路回归使用较小上限复现扫描上限场景。

### 2.3 正式回归

| 用例 | 场景 | 观察结果 |
| --- | --- | --- |
| `memory-extraction-input` I04 | 6条13000字符文本，单批字符预算 | 首批`messages=[1]`、`eligibleTexts=6`、`processedThroughSeq=1`；从1续读仍有5条可统计 |
| `memory-extraction-input` I05 | 6条长文本 + `scanLimit=2` | 三次调用的读取起点`[0,2,4]`；批次始终`[1]`，`eligibleTexts` 2→4→6，水位前缀1，未重读已检查记录 |
| `memory-extraction-coordinator` I05 | 文本/出站交替 + `scanRecordsPerScan=2` | 每触发一次续扫，读取起点`[0,1,3,5,7,9]`；前五次调用0、水位推进0；第六次调用批次`[1,3,5,7,9,11]`、`processedThroughSeq=11` |
| `memory-extraction-runtime` R1 | 真实Core/FakeChannel/Agent，6条长文本后追加短文本 | 见下表；17条合格文本各处理一次，无跳过、无重复、无永久停滞 |

`memory-extraction-runtime` R1的实际调用记录：

| 阶段 | 调用 | 批次seq | 字符数 | 成功水位 |
| --- | --- | --- | --- | --- |
| 6条13000字符文本 | 1 | `[1]` | 13002 | 2 |
| 第1～4条短文本 | 4 | `[3]`、`[5]`、`[7]`、`[9]` | 各13002 | 4、6、8、10 |
| 第5条短文本 | 1 | `[11,13,15,17,19,21]` | 13037 | 21 |
| 第6～10条短文本（仅1～5条新增） | 0 | - | - | 21 |
| 第11条短文本 | 1 | `[23,25,27,29,31,33]` | 44 | 33 |

水位2包含长消息后的已检查出站记录，属于实际读取前缀；不是跳到触发seq。累计7次调用、配额按调用前占用，空facts不产生记录，`effectiveStatus=active`。

## 3. R2：提取专用单次Provider执行策略

### 3.1 根因

Core把提取请求直接交给普通`providers.chat`，Router仍按服务配置自动重试，必要时继续尝试fallback。协调器只有整段Router调用最终失败后才记录冷却，导致一次配额准入可能对应多次HTTP请求，不符合73号“网络/超时/鉴权失败不自动重试”的要求。

### 3.2 修复

`src/providers/router.ts`：

```ts
export interface ProviderExecutionPolicy {
  fallback?: boolean;
  retry?: boolean;
}
```

- `chat()`新增可选第8参数；不传时完全保留既有重试/fallback行为。
- `fallback:false`只执行绑定主目标，不构造fallback目标列表。
- `retry:false`每个目标只尝试一次；`attemptsFor(current)`在每次循环重取当前目标配置，普通调用的配置代际语义不变。
- 路由、权限、凭据读取、端点并发、超时、配置代际和`executionGuard`仍走原有路径。

`src/core/core.ts`的提取适配器调用：

```ts
this.providers.chat(..., input.isStillAllowed, { fallback: false, retry: false })
```

普通Agent调用不传该策略。一次提取调用失败后由协调器记录10分钟冷却、不推进水位；冷却内新完成通知不调用，冷却到期且出现新的合格完成通知后才再次尝试。

### 3.3 正式回归

| 用例 | 覆盖 |
| --- | --- |
| `phase1-router` | 普通调用可重试一次并成功（primary 2次、fallback 0）；显式策略下可重试错误只调用primary 1次、fallback 0并抛原错误；普通调用始终失败时仍按配置重试并fallback（primary 2次、fallback 1次） |
| `memory-extraction-provider-policy` | 真实Core+ProviderRouter+FakeAdapter；primary配置`maxAttempts=2`且始终抛可重试限流，fallback本可成功。提取：primary 1次、fallback 0、配额1、水位0、记录0、`cooldown`；冷却内新完成通知0调用；推进11分钟但无新通知0调用；冷却后新通知再次调用primary 1次、fallback仍0、配额2、水位仍0 |
| `memory-extraction-coordinator` Q03/Q05 | 配额在调用前占用、失败计数、10分钟冷却、水位不前进；原协调器回归继续通过 |

## 4. 边界与未承诺

- 续扫进度只在进程内保存，不写入`state.json`：重启后会从水位重新进行有界扫描，可能重复读取，但不会跳过合格文本或用新记录替代旧前缀；不存在仅靠重启才能解除的永久停滞。
- 续扫缓存最多`maxPendingScopes`条；超出时淘汰最旧项，最坏情况退化为按触发重新扫描，不改变正确性。
- 一次提取调用失败后，若HTTP请求已到达服务方，仍可能产生一次计费；本地只保证每次配额准入最多一次HTTP请求，不承诺退款或撤销。
- 76号及75号已披露的边界仍成立：暂停/删除不主动abort同scope在途Provider；配额文件损坏时snapshot显示0但acquire失败关闭；真实QQ、真实付费Provider和原生视觉未验收。
- 未实施summary、MEM04管理页面、语义合并/遗忘曲线、向量检索；未提交或打包。

## 5. 命令与结果

在`D:\app\nowadays\accompany`执行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 退出码0；102个测试文件，916通过、1项既有跳过（共917）；76号复核时909通过，本轮新增7项 |
| `npm run typecheck` | 退出码0（测试tsconfig + renderer tsconfig） |
| `npm run desktop:build` | 退出码0（服务端tsc、renderer Vite、Electron main/preload） |
| `git diff --check` | 退出码0，无空白错误 |

新增回归：`test/memory-extraction-provider-policy.test.ts`、`test/memory-extraction-runtime.test.ts`的R1、`test/memory-extraction-coordinator.test.ts`的扫描上限续扫、`test/memory-extraction-input.test.ts`的长文本与续扫；`test/phase1-router.test.ts`增加显式策略与普通行为对照。既有跳过仍为`test/artifact-import.test.ts`的权限相关用例，本轮未新增skip。

## 6. 结论

76号R1“长文本/扫描上限永久停滞”和R2“提取继承Provider自动重试/回退”已关闭。MEM03自动提取可按73/74号自动验收收口；管理页面、摘要与真实服务兼容仍需后续阶段单独验收。本轮未改生产启动/发布配置，未提交、打包或替换发行产物。
