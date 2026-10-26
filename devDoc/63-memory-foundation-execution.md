# MEM01 长期记忆管理存储执行记录

日期：2026-10-26。依据：[61 MEM00设计与分阶段方案](61-memory-foundation-implementation-plan.md)、[62 验收标准](62-memory-foundation-acceptance.md)。本轮只实现 **MEM01-A/B（逐会话记忆 Store、管理服务与控制 API）**，不包含检索、上下文注入、自动提取和管理界面。未提交Git、未打包、未更新发行包。

结论：**MEM01 管理存储已完成，S01～S12 自动验收通过。** 按61号边界，这不等于长期记忆已在Agent上下文生效；运行时与提取仍待MEM02/MEM03。

> 2026-10-26 更新：64号复核发现R1～R3（回执顺序、落盘字节上限、提交前角色复验），已在[65 修复与复验](65-memory-management-review-fixes.md)中修复；本记录受影响的S03/S05/S06/S07/S08证据以65号为准，其余条目结论不变。

## 1. 交付范围

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 领域 | [src/memory/types.ts](../../src/memory/types.ts) | `MemoryScope`、设置、记录、提取水位、回执、状态与上限常量 |
| 校验 | [src/memory/schema.ts](../../src/memory/schema.ts) | namespace哈希、状态文件严格校验、API输入解析、回执摘要、默认关闭设置 |
| 存储 | [src/memory/store.ts](../../src/memory/store.ts) | 8MiB有界读取、损坏/作用域复核、按状态文件串行、整文件原子替换 |
| 应用 | [src/application/memory/memory-service.ts](../../src/application/memory/memory-service.ts) | 设置/列表/详情/新增/编辑/删除/清空；双expected与requestId回执 |
| 契约 | [src/contracts/memory.ts](../../src/contracts/memory.ts) | 浏览器安全的设置视图、摘要页、详情与变更结果 |
| 控制面 | [src/service/routes/memory.ts](../../src/service/routes/memory.ts)、[routes/index.ts](../../src/service/routes/index.ts) | `/accounts/:accountId/memory/:kind/:peerId/...` 路由与写操作审计 |
| 角色边界 | [account-service.ts:301](../../src/application/accounts/account-service.ts#L301) | `historyEpoch` 只取角色历史epoch；世界书guard不参与 |
| 门面 | [core.ts:194](../../src/core/core.ts#L194)、[core.ts:542](../../src/core/core.ts#L542) | MemoryService装配；所有记忆方法经`runPublicWork`准入/排空 |

## 2. 关键实现语义

- **作用域**：`{accountId, kind, peerId, contextEpoch}`；namespace为SHA-256(JSON数组)，目录`accounts/<accountId>/memory/<namespace>/state.json`。文件内保存完整scope；读取时复核scope与namespace，不只相信路径。
- **contextEpoch来源**：从`AccountService`抽出`historyEpoch`，与Agent现有`resolveRoleBinding.contextEpoch`共用同一公式；只含绑定revision/contextRevision与角色卡身份，不含世界书guard。换世界书不改变记忆目录；重绑角色进入新epoch，旧数据不迁移、不混入。
- **默认关闭**：新scope GET返回`enabled=false、autoExtract=false、budgetChars=1500、maxSelected=8`，revision为`r0`，不创建目录或文件。首次明确写入才落盘。
- **CAS**：设置、新增、编辑、删除、清空均要求`expectedScope`（namespace）与`expectedRevision`；编辑/删除另要求`recordRevision`。同scope以状态文件为串行域，读-校验-整文件原子替换；失败不推进revision/generation。
- **requestId回执**：只用于手工新增，回执与记录同次提交，保留最近128条。同请求同负载返回原记录且不重写；不同负载409；回执过期后的重试会再次创建（已在测试中明确）。删除/清空不删除回执，因此已被删除记录不会被旧请求复活，返回409。
- **清空**：写入空`records`，generation递增，保留设置（`enabled`不变）、回执、提取水位与状态文件；强制`autoExtract=false`。关闭（`enabled=false`）只影响未来运行时，不阻止手工维护。
- **limits**：1000条/scope、单条4000字符、总正文1048576字符、16个关键词×128字符、8MiB状态文件、分页默认50最多100。客户端只能提交正文/关键词/固定标记，id、revision、时间、origin、generation、水位与scope均由服务端生成。
- **错误**：角色未绑定`memory_scope_missing`→404；记录缺失`memory_record_not_found`→404；作用域/版本冲突`memory_conflict`→409；非法输入`invalid_spec`→400；请求体超限413；文件损坏/权限/超限`memory_io_error`→503，且不会当作空数据覆盖。
- **审计**：设置、新增、编辑、删除、清空经`runAudited`记录动作与`accountId/kind/peerId`，不记录正文、关键词、测试文本或磁盘路径。读接口不审计。

## 3. S01～S12 对照

测试分为应用/存储层[test/memory-service.test.ts](../../test/memory-service.test.ts)与真实HTTP集成[test/memory-api.test.ts](../../test/memory-api.test.ts)，后者经控制HTTP→Core→MemoryService→Store。

| ID | 结果 | 证据 |
| --- | --- | --- |
| S01 默认关闭、不建文件、不调模型 | 通过 | `returns closed defaults…`；GET后`accounts/<id>/memory`不存在；服务无模型依赖 |
| S02 账号/群私聊/角色隔离 | 通过 | `isolates accounts…`（服务与HTTP两份），三个scope token不同，列表互不可见；第二角色卡切换后旧页写入被拒 |
| S03 角色切换后旧页面提交 | 通过 | HTTP `isolates accounts…`：旧`expectedScope`新增返回409，新角色scope保持0条，旧作用域状态文件逐字节未变 |
| S04 重启与server身份 | 通过 | `persists settings and records across a Core restart`；重启后设置/正文/关键词一致；客户端伪造id/时间被400拒绝 |
| S05 同/跨scope并发 | 通过 | `serializes same-scope compare-and-set…`：同revision两写一成一败，跨scope两写均成功，失败方重读后可完成 |
| S06 写失败与坏文件 | 通过 | `does not report success…`（rename与临时写失败均不改状态，恢复后可重试）；`refuses corrupt…`（坏JSON、scope不符、8MiB+1均503，文件未被覆盖） |
| S07 requestId与回执 | 通过 | `deduplicates stable request ids…`、`keeps request receipts bounded…`：幂等/换负载409/删除后不复活/窗口128且过期语义明确 |
| S08 数量与长度边界 | 通过 | `enforces record, content, key and total limits`：4000接受、4001拒绝；16/17关键词；1000条可读、第1001条拒绝；总正文恰好/超出上限 |
| S09 清空/关闭/等待写 | 通过 | `clear keeps settings and the state file…`：清空与并发写一成一败；文件保留、generation递增、enabled保留、autoExtract关闭；关闭后仍可CRUD |
| S10 鉴权/非法ID/伪造来源 | 通过 | HTTP `serves closed defaults…`401与404；`keeps validation…`；服务`rejects forged identity…`；审计不含正文，错误不含磁盘路径 |
| S11 分页/详情/语义 | 通过 | HTTP `runs manual fact CRUD…`：limit/nextOffset、摘要无正文、详情有正文、404/409/400/413；服务`returns bounded summaries…` |
| S12 Core退出排空 | 通过 | `drains an accepted write and rejects new work during shutdown`：已准入写完成并落盘，停止期间新请求`core_stopped`，无退出后写盘 |

## 4. 实跑结果

- npm test：87文件，776项通过、1项既有跳过，共777项；新增18项无skip。
- npm run typecheck：通过。
- npm run desktop:build：通过。
- git diff --check：通过。
- 既有跳过仍为Windows链接权限EPERM分支，与记忆无关。

## 5. 设计差异与待确认

- 61号状态定义未包含回执数组；为实现S07，在`MemoryState`增加`receipts`（最多128，随记录原子提交）。格式仍为version 1，因为此前从未落盘。
- 列表排序采用`updatedAt`降序、`createdAt`降序、id升序，便于管理页看到最近修改；检索顺序留待MEM02选择器单独实现。
- 清空保留`extraction`水位：可避免重开自动提取后重新写回已清空的事实；是否需要在MEM03配合删除抑制策略仍按61号要求先定稿。
- 已删除记录但回执仍存在时，同requestId重试返回409而不是重新创建；过期回执（被挤出128窗口）不承诺永久幂等。
- `POST /preview`、`GET`作用域列表之外的检索与所有运行时行为未实现，属于MEM02；管理API通过不代表上下文已注入。

## 6. 后续

- MEM02-A：纯选择器、预算预览与只读测试，复用同一scope/default设置；仍不写记忆、不调用模型。
- MEM02-B：快照、发送guard与实际Agent链路，需FakeChannel→Instance→Agent→FakeProvider完整证据。
- MEM03：自动提取与可选summary；删除后再提取抑制策略须先定稿。
- MEM04：管理页面、草稿/旧请求/退出保护与真实浏览器闭环；当前无界面入口。

未提交Git、未打包、未替换发行EXE；长期记忆整体阶段仍未验收。
