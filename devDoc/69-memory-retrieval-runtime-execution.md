# MEM02 记忆检索、预览与Agent运行链路执行记录

日期：2026-10-26。状态：MEM02-A/B 已完成并通过68号验收；70号复核发现的R1/R2已由[71](71-memory-runtime-review-fixes.md)修复并复验（最终93文件833通过/1跳过）。MEM03 自动提取、MEM04 管理界面仍待实施。方案见[67](67-memory-retrieval-runtime-implementation-plan.md)，验收见[68](68-memory-retrieval-runtime-acceptance.md)，前置为[66](66-memory-management-fixes-independent-review.md)。

## 1. 包完成情况

| 包 | 结果 | 内容 |
| --- | --- | --- |
| M2-A1 | 完成 | 唯一纯选择器、共享 `MemoryEvaluation`、16000字符扫描尾部、800万比较工作上限、整条预算/条数/排序/缓存/unscanned |
| M2-A2 | 完成 | `POST /accounts/:account/memory/:kind/:peer/preview`、严格请求校验、只读预算、返回前作用域复验 |
| M2-B1 | 完成 | 按已捕获角色epoch读取记忆、不可变快照、稳定guard、缺少文件/损坏状态区分 |
| M2-B2 | 完成 | host快照、`buildChatContext`顺序与预算、最终发送/限速队列/延迟投递的重验 |
| M2-C | 完成 | 全量回归、类型检查、桌面构建、本记录 |

默认关闭、手工记忆可管理、角色必须逐会话显式绑定的MEM01语义保持不变。本轮没有新增自动提取、摘要、向量、记忆页面或新的存储文件。

## 2. API、类型与代码位置

### 2.1 只读预览

`POST /accounts/:accountId/memory/:kind/:peerId/preview`

```json
{ "text": "我想再去看银杏", "expectedScope": "settings返回的64位scopeToken" }
```

成功响应在 `{ ok: true }` 中包含：`scopeToken`、`revision`、`generation`、`evaluation`、`budgetBasis: "memory-only"` 和提示真实对话可能更少的 `notice`。`evaluation` 字段为：

```ts
interface MemoryEvaluation {
  content: string;
  selectedIds: string[];
  budgetSkippedIds: string[];
  countSkippedIds: string[];
  usedChars: number;
  scanLimited?: boolean;
  unscannedIds?: string[];
  ignoredSummaryCount?: number;
}
```

请求只接受 `text`/`expectedScope`，最多16000字符；未知字段、客户端records/history/预算覆盖、过期scope分别走既有400/409映射。未绑定角色404，坏文件/不可读503。预览不写state/回执/水位/历史，不调用模型，不产生审计正文。

### 2.2 代码位置

| 位置 | 内容 |
| --- | --- |
| `src/memory/selector.ts` | `selectMemory`、标题`## 长期记忆（会话数据）`、排序/预算/扫描/工作上限 |
| `src/memory/types.ts` | `MemorySnapshot`、`MemoryEvaluation`、扫描/工作量上限 |
| `src/memory/schema.ts` | `parseMemoryPreviewRequest` |
| `src/application/memory/memory-service.ts` | `preview`、`runtimeSnapshot`、快照深拷贝/冻结、guard摘要 |
| `src/application/memory/conversation-memory-context.ts` | 角色+记忆同epoch捕获（不反向解析角色） |
| `src/contracts/memory.ts` | 浏览器安全 `MemoryPreviewResult` 与 `MemoryEvaluation` 导出 |
| `src/service/routes/memory.ts` | `/preview`分支，沿用鉴权/体上限 |
| `src/core/core.ts` | `previewMemory`、`resolveConversationMemory` 装配 |
| `src/instances/instance.ts` | 捕获入站角色+记忆；host上下文携带快照；自动回复/队列/延迟投递重验 |
| `src/host/contract.ts` | `AgentMessageContext.memory` |
| `src/agent/context.ts` | 基础/当前消息→世界书→记忆→历史，真实增量计入历史预算 |
| `src/agent/engine.ts` | 把快照交给统一`buildChatContext`；不可用快照拒绝自动轮次 |

### 2.3 选择与预算约定

- 只选择 `type=fact` 且正文非空；`summary` 只计数，不注入、不删除历史。
- pinned直接候选；非pinned只做关键词字面OR、统一小写；无keys不自动注入。排序 pinned → `updatedAt`降序 → id码元序。
- 只扫描当前文本尾部16000个UTF-16字符；每次`includes`按“文本长度+规范化关键词长度”计入800万上限。完成的关键词bool可复用；耗尽后pinned和缓存命中仍生效，无法确定的记录进入`unscannedIds`并置`scanLimited`。
- 标题、`- [固定]`条目标签、条目换行和与已有system区块之间的`\n\n`都计入`usedChars`；整条选择，不截半句。预算不足的记录进入`budgetSkippedIds`，达到条数上限的进入`countSkippedIds`。
- 运行时记忆预算为 `min(settings.budgetChars, maxHistoryChars - 当前消息字符 - 已生成system字符)`；记忆实际`usedChars`再压缩剩余历史预算。基础已超预算时记忆增量为0。

### 2.4 快照与发送保护

`ConversationMemoryContextService.capture` 先解析基础角色/世界书，再按同一`contextEpoch`读取记忆；不会重新解析含世界书guard的角色后再读记忆，避免两个snapshot混epoch。快照深拷贝并冻结，包含settings、records、revision、generation、scopeToken、状态和guard；guard为上述字段与记录正文/关键词/pinned/source的SHA-256稳定摘要，无文件默认状态也带确定性`exists`标记。

`QqInstance`在入站持久化前捕获角色与记忆；记忆不可用时不调用宿主自动轮次。自动回复、宿主`send`、最终回复、限速队列发送和`deliver`都携带捕获时的role revision与memory guard；发送前重新读取当前角色/记忆，任一项变化或不可用即拒绝。手工`QqInstance.send`和显式关闭记忆后的管理操作不受影响。

## 3. 与方案的差异

1. `MemorySnapshot.records` 保留全部记录（含summary），选择器只注入fact。这样guard能发现同revision/generation下的任意正文改写，summary也参与外部变更检测；本轮仍不注入summary。
2. 条目使用`- [固定]`标签区分pinned；这是显示格式选择，`usedChars`按实际文本精确计算。
3. 运行时记忆读取失败不抛异常，而是返回`state: "unavailable"`快照；由`QqInstance`在入站自动轮次前失败关闭，引擎再保留防御性拒绝。入站消息仍按捕获角色epoch保存，手动发送和其他scope不受影响。
4. 预览文本在服务端`trim()`，与内置Agent的当前消息处理一致；预览仍只按记忆独立预算计算，不读取角色/世界书/历史。
5. Core增加运行时方法`resolveConversationMemory`，只供实例装配；没有加入控制API，也没有新增UI。

## 4. 验收结果

### 4.1 选择器 R01～R09

| ID | 结果 | 测试（`test/memory-selector.test.ts`） |
| --- | --- | --- |
| R01 | 通过 | pinned优先、字面OR、大小写、无keys不注入；点号/加号为字面量 |
| R02 | 通过 | pinned→updatedAt→id稳定顺序、重复关键词去重、缓存不影响结果 |
| R03 | 通过 | 超预算/超条数原因分离；长条跳过后短条仍加入；整条不裁剪 |
| R04 | 通过 | `usedChars`等于真实system文本前后差，包含标题/标签/分隔/join |
| R05 | 通过 | disabled/预算0/无fact不读取长文本getter，不产生标题或增量 |
| R06 | 通过 | 16000尾部边界、超尾不命中、800万上限、缓存命中、503条unscanned |
| R07 | 通过 | 耗尽后pinned与缓存仍处理；budgetSkipped与unscanned不混 |
| R08 | 通过 | 命中正文中的关键词/工具指令不递归、不执行；输入深比较不变 |
| R09 | 通过 | summary忽略并计数，不注入、不用于历史替换 |

### 4.2 只读预览 P01～P08

| ID | 结果 | 测试 |
| --- | --- | --- |
| P01 | 通过 | `memory-preview`跨账号/群私聊scope拒绝；`memory-api`真实鉴权HTTP隔离 |
| P02 | 通过 | 未知字段/覆盖/非法token/超长文本400；缺失角色404；坏文件503（服务层） |
| P03 | 通过 | 预览前后state内容、目录、回执、generation/revision、审计不变 |
| P04 | 通过 | records/history/预算覆盖字段严格拒绝 |
| P05 | 通过 | 关闭与零预算返回空evaluation，不注入标题 |
| P06 | 通过 | `fs.open`门控慢读期间角色切换，返回前复验409 |
| P07 | 通过 | 相同records/text/有效预算与运行时`selectMemory`结果深相等 |
| P08 | 通过 | 损坏/不可读状态安全503且不泄漏路径/正文；HTTP准入/退出排空 |

### 4.3 快照与上下文 C01～C09

| ID | 结果 | 测试 |
| --- | --- | --- |
| C01 | 通过 | `memory-runtime`两账号/群私聊/角色切换，实际FakeProvider请求只含当前scope |
| C02 | 通过 | 世界书配置变化不改记忆namespace/state/history；编辑后下一轮使用新正文 |
| C03 | 通过 | 慢记忆读期间切角色，旧轮不调用模型、入站按旧epoch保存；新轮用新scope |
| C04 | 通过 | 实际Agent世界书+记忆注入与保存预算；媒体观察/世界书/记忆同轮顺序（C04c） |
| C05 | 通过 | 基础超预算时记忆增量为0；group sender/当前消息去重/观察来源规则保留 |
| C06 | 通过 | disabled/未命中/无keys/unavailable时system与历史选择与无记忆基线一致 |
| C07 | 通过 | 损坏scope自动回复失败关闭；入站、手动发送、其他scope正常 |
| C08 | 通过 | 快照深冻结，插件式赋值抛错；Store与后续轮次快照不变 |
| C09 | 通过 | 同revision/generation外部改写正文，guard变化，旧回复拒绝；新轮用新正文 |

### 4.4 发送失效 G01～G07

| ID | 结果 | 测试 |
| --- | --- | --- |
| G01 | 通过 | 模型生成期间删除已选记忆：旧回复不发送；新轮不含该记录 |
| G02 | 通过 | 生成期间关闭；限速队列期间关闭/清空：旧回复均拒绝；新轮无记忆 |
| G03 | 通过 | 生成期间编辑正文：旧回复拒绝、新轮使用新正文；budget修改在队列期间同样拒绝 |
| G04 | 通过 | 生成期间换角色旧回复拒绝；解绑自动回复抑制；手动发送保持可用 |
| G05 | 通过 | 自定义host持有旧guard调用`deliver`拒绝；新轮上下文投递成功 |
| G06 | 通过 | 同requestId回执重试`created:false`且guard/generation/revision不变；新增/设置变更改变guard |
| G07 | 通过 | 私聊生成期间修改群聊记忆，不取消当前私聊回复，也不把群记忆带入 |

另验证`autoExtract=true`仍只调用chat，不启动提取、不改记忆；MEM01幂等/字节上限/角色提交点/错误映射回归继续通过。

## 5. 故障与竞态复现

- **R06/R07 工作上限**：16000字符文本 + 1000条唯一128字符关键词，前496次比较耗尽8,000,000额度；断言503条`unscannedIds`、缓存尾部命中仍选中，预算跳过与未扫描不混。
- **P06 返回前复验**：在`state.json`的`fs.open`处设门，读取未返回时改角色；预览以`memory_conflict`拒绝。没有使用固定sleep假设竞态。
- **C03 慢读换角色**：角色解析完成后在旧记忆文件读取处设门，期间重绑第二角色；入站保存为旧`contextEpoch`，自动轮次被抑制，之后新角色轮次正常。
- **C09 外部改写**：模型生成中把state文件正文改写但保留revision/generation；旧回复在最终发送点被guard拒绝，新轮读到新正文。
- **G02/G03 限速队列**：用`TokenBucket.prototype.acquire`门控第二条自动发送，确保回复已经生成并停在限速队列；期间删除/关闭/清空/改预算，放行后队列内复验失败，通道发送次数不增加。
- **G05 延迟投递**：自定义`AgentHost`保存上下文，修改记忆后调用`context.deliver`，以`auto_reply_paused`拒绝；新入站上下文投递正常。

## 6. 命令与结果

在`D:\app\nowadays\accompany`执行：

```powershell
npm test
npm run typecheck
npm run desktop:build
git diff --check
```

| 命令 | 结果 |
| --- | --- |
| `npm test` | 退出码0；92个测试文件，826通过、1既有跳过（共827）；基线781通过/1跳过，本轮新增45项 |
| `npm run typecheck` | 退出码0（测试tsconfig + renderer tsconfig） |
| `npm run desktop:build` | 退出码0（服务端tsc、renderer Vite、Electron main/preload） |
| `git diff --check` | 退出码0，无空白错误 |

既有跳过仍是`test/artifact-import.test.ts`的权限相关用例，本轮未新增skip。新增测试源码：

- `test/memory-selector.test.ts`
- `test/memory-preview.test.ts`
- `test/memory-snapshot.test.ts`
- `test/memory-context.test.ts`
- `test/memory-runtime.test.ts`
- `test/memory-api.test.ts` 新增preview/退出排空用例

## 7. 未完成项与发布状态

- **未实施**：MEM03自动提取、摘要生成、摘要替换历史；MEM04记忆管理页面/桌面UI；向量检索、情绪、遗忘曲线。`autoExtract=true`只作为保存字段，本轮不触发任何提取任务。
- **未验收**：真实QQ消息、真实付费模型、媒体真实服务矩阵、Electron原生视觉/缩放。本轮新增入口没有浏览器或原生页面，因此不提供截图，也不把HTTP/单元测试当作原生验收。
- **未承诺**：跨文件物理原子事务；已发送到QQ的消息不撤回。
- **Git/发行**：未提交、未打包、未更新发行包或EXE。工作区保留此前未提交改动；临时测试均使用系统临时目录并由测试清理。

可以声明：**手工fact已进入实际Agent上下文，并受最终发送guard保护；只读预览与场景隔离通过MEM02验收。** 不能声明自动记忆、摘要、记忆页面或完整长期记忆阶段已完成。
