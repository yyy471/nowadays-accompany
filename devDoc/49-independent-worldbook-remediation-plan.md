# 独立世界书：修复与剩余实现任务

日期：2026-10-23。状态：待执行。问题依据：[48 代码复核](48-independent-worldbook-code-review.md)。目标范围仍为[46 实现方案](46-independent-worldbook-implementation-plan.md)，最终验收仍按[47 标准](47-independent-worldbook-acceptance.md)，本文件明确下一轮实施顺序，不另起长期记忆开发。

## 1. 本轮优先级

先修“接口假成功”和“资源类型误展示”，再完成资源版本服务与运行时，最后接入编辑器。不能仅增加类型或单元测试就宣布完成。

### 批次1执行结果（2026-10-23，未提交）

FIX-WB1、FIX-WB2 已在同一工作区完成，48号 R1/R3/R4/R5 复现反转：

- R1（FIX-WB1a）：`routes/accounts.ts` 世界书 PUT 在检测到 `source` 键时返回 400 `worldbook_source_unsupported`，不再静默丢弃并返回 200；不带 source 仍按原 `worldbook`+`expectedRevision` 行为成功。这是临时拒绝，WB03 用正式实现替换。
- R3（FIX-WB1b）：renderer `types.ts` 的 `ArtifactManifest.kind` 加入 'worldbook'；`Artifacts.tsx` 用 `KIND_LABELS` 穷尽三类，worldbook 不显示“部署”、当前版本显示“不参与部署”、条目行提示“固定版本，需在会话中选择”；插件/角色卡部署与标签不变。
- R4（FIX-WB2b）：`import-adapter` 对 `kind:'worldbook'` 走严格 `parseArtifactManifest`，非法外层字段/缺 id/revision 被拒并给警告；裸 version:1 仍走 `parseWorldbook`。
- R5（FIX-WB2c）：`LocalArtifactStore` 新增 `resolveWorldbook`（要求 public+显式 revision，区分 ready/missing/invalid/error，不回退 catalog/latest），通用 `resolve` 与 `setPublicRevision` 对 worldbook 显式拒绝；插件/角色卡解析与部署保持。
- FIX-WB2a：段名规则抽到 `src/artifacts/segment.ts` 的无副作用 `isSafeArtifactSegment`，`manifest.ts` 与 `worldbook/schema.ts` 共用，manifest 保持原导出名。

新增测试：`worldbook-import`（含 R4 反转）、`worldbook-contract`、`worldbook-store`（固定解析与 catalog 封禁）。全量门禁：`npm run typecheck`、`npm test` 81 文件/698 通过 +1 既有权限跳过、`npm run desktop:build`、`git diff --check` 均通过。

WB02～WB06 仍待后续批次；本轮未接通生产来源链路，不改变“阶段B/世界书未整体验收、不进入长期记忆”的结论。

### FIX-WB1：封住来源假成功与类型误用

- 新source尚未全链路接入时，设置PUT出现source必须显式拒绝；随后由WB03用正式实现替代临时拒绝，不得长期保留两套协议。
- ArtifactItem、资源分组、标签、按钮穷尽处理worldbook；移除该类型部署入口，显示“固定版本，需在会话中选择”。插件/角色卡行为不变。
- parseWorldbookSettings接入生产时将expectedRevision按请求层单独验证，再把worldbook/source交给领域schema；不能将整个HTTP body直接传给只允许这两个键的schema导致expectedRevision误拒绝。

先验收：带source不能200后丢失；已有worldbook目录显示正确且无部署按钮；角色卡/插件仍可按旧方式部署。

### FIX-WB2：修正解析和导入边界

- 原生manifest经严格parseArtifactManifest校验，裸Worldbook仍经parseWorldbook；补缺ID/revision、未知外层字段与非法元数据用例。
- 新独立来源始终通过固定public revision解析；拒绝省略revision、private及catalog跟随，worldbook不得写catalog。通用角色/插件解析保持兼容。
- 新解析入口应区分missing、invalid及真实I/O故障；不要直接依赖吞掉所有异常的旧resolve结果来伪造四种状态。
- 来源校验与artifact段名规则尽量共用一个无副作用原语，避免新增的safeSegment与既有assertArtifactSegment今后分别修改；不要以此扩大为全仓重构。

先验收：48号R4/R5复现反转；固定引用成功，非法/损坏失败语义可区分；旧卡及导入回归通过。

## 2. 沿用原编号补齐

### WB02：独立资源服务与不可变版本

交付：WorldbookResourceService，公共书有界摘要列表、指定revision详情、创建/派生/幂等提交、受控独立JSON导入预览/提交。

实现约束：

1. 复用公共目录、schema、原子写入及退出排空；抽取最小资源发布原语，不能复制第三套临时目录/锁/rename逻辑。
2. 新版本保存不更新catalog、不部署、不改会话绑定。相同目标不同内容409，相同请求重试返回原版本。
3. baseRef/expectedBaseFingerprint检查基础文件变化；不同新revision可从同一基础派生，不冒充最新版本CAS。
4. 独立JSON有界读取、指纹复验、归档和取消语义；通用目录导入不替代这个功能。
5. Core/control-api/routes/桌面IPC统一接线，保留鉴权、请求体上限、安全错误和审计。

最低证据：S01～S12、A01～A04/A07/A08；至少覆盖写失败、同目标并发、响应丢失重试、源变化、成功后刷新失败和退出排空。仅成功路径不算完成。

### WB03：会话来源与实际Agent链路

交付：绑定字段worldbookSource、同文件CAS原子保存、有效书统一解析、运行时快照/guard、只读预览与可恢复状态。

实施顺序：

1. Store类型/磁盘解析/读改写/角色重绑重置同步修改；旧文件缺source仍是内置，不批量重写。
2. HTTP→Core→AccountService→Store一次提交source与options，旧客户端省略source保留原来源。
3. AccountService列表、已保存配置预览和Agent共同使用有效书解析用例，不能各自if/else读取不同来源。
4. 本轮book/options/guard来自同一快照，最终发送前复验绑定及书内容指纹；历史epoch继续沿用同角色contextRevision。
5. 启用书丢失或损坏停止该会话自动回复并显示恢复入口；禁用后不因旧引用妨碍普通角色回复。

最低证据：B01～B15、M01～M08、A05；必须有两个账号、群聊与私聊、r1/r2明确切换、排队旧回复、外部改写和历史仍可读的实际Fake运行链路。

### WB04：资源编辑器及草稿试算

交付：资源库世界书入口/筛选，创建导入、版本查看、条目增删复制、关键词/正文/开关/顺序配置、保存新revision及草稿测试。

界面复用公共组件、暖色token与草稿注册。保存新版本后明确旧会话不会跟随，失败保留草稿。草稿测试只计算入参，无文件/模型/QQ副作用。超长文本、空书、200条边界、隐藏Portal、退出锁必须覆盖。

最低证据：U01～U07、U11～U15、A06；真实浏览器完成一次新建→编辑→试算→保存→查看版本，包含取消离开与失败重试。

### WB05：会话配置界面

交付：角色卡内置/独立二选一，书与固定revision选择、状态/计数、建议参数按钮、来源与参数统一保存、已保存配置只读测试。

禁止选书自动启用；列表失败不清空旧引用；missing/invalid允许重新选或明确关闭；409与旧请求保留正确对象的草稿；隐藏回调不能发请求。共享契约从src/contracts统一导出，不在renderer再维护独立kind/source枚举。

最低证据：U05～U11及相关B类；真实浏览器验证账号切换、来源切换、固定版本、保存后测试与缺失恢复。

### WB06：完整复核与执行报告

依赖以上全部完成。运行npm test、npm run typecheck、npm run desktop:build、git diff --check，填写47号逐项结果并附测试名/截图或待执行原因。

执行报告使用下一可用编号，至少列出每包完成情况、48号R1～R5处理结果、自动测试、故障/并发/隔离测试、浏览器与原生结果、数据兼容/回退、Git提交和EXE状态。更新README的当前状态，不把待实施文字留作唯一入口。

## 3. 推荐派发批次

| 批次 | 工作 | 放行条件 |
| --- | --- | --- |
| 1 | FIX-WB1、FIX-WB2，明确WB01生产契约 | source不假成功、类型不误导、解析规则统一、旧测试通过 |
| 2 | WB02资源服务与受控导入 | 真API可创建/读取/重试版本，失败不留半成品，不改绑定 |
| 3 | WB03来源存储与运行时 | 真API→Agent独立书生效，版本/隔离/历史/旧回复测试通过 |
| 4 | WB04、WB05前端 | 编辑和选择可用、dirty/退出/失败恢复、浏览器验证完成 |
| 5 | WB06复核 | 47号P0/P1全通过，剩余人工项明示 |

若分配多名开发者，Core/control-api/routes、共享contracts与Store分别指定负责人；不要让每个包独立增加另一套同名服务和数据模型。

## 4. 下一阶段边界

本轮结束后先验证“独立书r1仍生效→保存r2不影响旧会话→手动切换r2→保留历史→旧回复拦截”这条完整用户链路。通过后才安排长期记忆方案：逐账号/群私聊隔离的摘要、记忆检索、写入与删除、上下文预算和审计；情绪与遗忘曲线继续后置。

此处只确定后续方向，不把记忆工作塞进世界书修复，也不授权自动提交、发行或真实QQ发消息。
