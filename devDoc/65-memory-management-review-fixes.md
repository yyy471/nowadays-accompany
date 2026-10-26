# MEM01 复核问题修复与复验（R1～R3）

日期：2026-10-26。依据：[64 独立复核](64-memory-management-independent-review.md)。本轮只修 R1～R3，不进入 MEM02，不新增界面或模型调用。未提交Git、未打包、未更新发行包。

结论：**64号 R1～R3 已修复，定向与全量自动回归通过；MEM01 管理存储可按 62号 S01～S12 重新收口。** 63号中受影响的 S03/S05/S06/S07/S08 证据以本记录为准；MEM02～MEM04 仍待实施。

## 1. R1：回执先于 CAS

位置：[memory-service.ts:126](../../src/application/memory/memory-service.ts#L126)。

- `createRecord` 在同一 Store 串行事务内先查 `requestId` 回执，再执行 `expectedRevision` 校验。
- 回执命中且负载相同、记录仍存在：返回 `created=false` 与原记录，不重写文件、不改变 revision/generation；调用方可以携带首次提交时的旧 revision（响应丢失恢复）。
- 回执命中但负载不同、记录已删除：仍返回409，不复活。
- 没有回执时才严格校验 revision；未知请求不能靠放宽旧版本绕过 CAS。
- 入口仍校验 `expectedScope`；角色变化时由 R3 的提交前复验拒绝。

新增正式回归：
- `recovers a lost create response from the committed receipt…`：原 revision 原样重试、期间另有设置写入后重试仍命中、换负载409、删除后原样/新 revision 重试均409。
- `treats concurrent identical creates as one commit…`：两个并发相同请求携带同一旧 revision，一成一幂等，只有一条记录。

## 2. R2：按实际落盘字节限制

位置：[store.ts:87](../../src/memory/store.ts#L87)、[atomic-write.ts:40](../../src/storage/atomic-write.ts#L40)。

- 公共原子写模块新增 `serializeJson`（与 `writeJsonAtomic` 相同的两空格缩进格式），Store 以同一字符串先计算 UTF-8 字节数，再调用 `writeFileAtomic` 写入；不是估算 JSON 长度，也不存在紧凑检查/缩进落盘差异。
- 读写共用同一上限：默认8MiB，可通过 `MemoryStore({ maxStateFileBytes })` 在测试中缩小；生产路径使用 `MEMORY_LIMITS.maxStateFileBytes`。
- 超限抛 `memory_capacity`（HTTP 413），在任何写入前失败；原文件、revision、generation 与回执不变。真实写入/rename 失败仍为 `memory_io_error`（503）。
- 合法字段组合（多字节中文、emoji、引号/反斜杠转义、满额关键词）不能生成自身无法读取的文件。

新增正式回归：
- `rejects a write whose exact serialized bytes exceed the store limit…`：较小字节上限下，中/emoji/转义字符与关键词组合被拒，文件逐字不变、仍可读取并编辑。
- `maps capacity limits to 413 while real I/O failures stay 503`。

## 3. R3：提交前的角色作用域复验

位置：[memory-service.ts:267](../../src/application/memory/memory-service.ts#L267)及各写用例的 `transact` 回调（设置80、新增164、修改195、删除219、清空246）。

- 每个写在 MemoryStore 的按状态文件串行域内、构造下一状态之后、写入之前，调用 `#assertScopeStillCurrent` 重新解析当前显式角色的 `historyEpoch`；与捕获的 `contextEpoch` 不同（或角色已解绑）即返回409，不写旧/新scope。
- 复验处于记忆状态文件的串行域内，覆盖“排队等待、读取、准备提交”期间的角色重绑/解绑/角色卡版本变化。
- 角色写使用自己的文件串行域，记忆写入只读角色绑定，不请求角色写锁；不存在 MemoryStore 与角色Store的交叉锁。
- 线性化约定：以提交前最后一次成功的角色作用域读取为界。若角色在该读取之后才改变，本次记忆写入视为发生在角色切换之前；尚未提交且读到新角色的写入一律拒绝。这与64号“已提交/等待中”区分一致。
- 回执幂等分支也执行同一复验，避免角色变化后仍从旧scope返回数据。

新增正式回归：
- 服务级 `refuses every management write when the role changes before commit`：设置/新增/修改/删除/清空五类写入在提交前角色切换时均409，旧文件逐字不变，新scope不产生文件。
- 真实Core/角色绑定集成 `rejects a write that was waiting when the role changed before commit`：在 MemoryStore 读取处阻塞，期间调用角色绑定服务重绑，恢复后写入409；旧scope无状态文件、新scope无记录。

## 4. 实跑结果

- npm test：87文件，781项通过、1项既有跳过，共782项；本轮净增5项（R1并发同请求1项、R2字节上限1项、R3服务级与真实Core集成各1项、错误映射1项；原回执测试扩展为响应丢失场景）。无新增skip。
- npm run typecheck：通过。
- npm run desktop:build：通过。
- git diff --check：通过。
- 既有跳过仍为Windows链接权限EPERM分支，与记忆无关。

## 5. 复验范围与剩余

- 62号 S03/S05/S06/S07/S08 的旧证据以本轮新增测试补充；S01/S02/S04/S09/S10/S11/S12 未受本轮改动影响，63号原证据仍有效。
- MEM01仍只是管理存储：没有检索、上下文注入、自动提取或界面；`POST /preview` 与运行时guard属于MEM02。
- 64号的本地复现脚本未计入修复证据；本轮以 `test/` 正式测试为准。
- 长期记忆整体未验收；原生/视觉/真实QQ与本轮无关。未提交Git、未打包、未替换发行EXE。
