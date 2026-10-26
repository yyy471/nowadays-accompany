# MEM02 独立复核修复与复验

日期：2026-10-26。状态：70号R1/R2 已修复并通过复验；MEM02 可收口，MEM03 自动提取仍待另行派发。复核依据见[70](70-memory-runtime-independent-review.md)，原执行记录见[69](69-memory-retrieval-runtime-execution.md)。

## 1. 修复结论

| 项 | 级别 | 结果 | 内容 |
| --- | --- | --- | --- |
| MEM2-FIX1 | P1 | 已修复 | 本轮捕获的memory guard 进入统一的 `isRoleBindingCurrent`，Provider准入、chat后工具判断、job提交、job执行与后续投递复用同一保护 |
| MEM2-FIX2 | P2 | 已修复 | 工作量耗尽后继续遍历该记录的剩余OR关键词，读取已缓存结果；不再因第一个未知键提前break |
| MEM2-RECHECK | - | 完成 | 新增7项正式回归；全量93文件833通过、1项既有跳过；类型检查、桌面构建、diff检查通过 |

## 2. R1 修复：工具执行前携带本轮memory guard

### 2.1 根因

`QqInstance` 在构造`AgentMessageContext`时，`isRoleBindingCurrent`只传入`roleBinding.revision`。`#automaticAllowed` 省略`expectedMemoryGuard`时只检查记忆“当前可用”，不比较是否仍是本轮捕获的快照。最终发送路径各自传了guard，但engine把模型响应交给工具前、Provider排队准入和媒体job执行使用的是这个弱化回调，因此删除/关闭记忆后旧响应仍可能创建并执行生图/语音任务。

### 2.2 修复

`src/instances/instance.ts` 的上下文回调改为：

```ts
isRoleBindingCurrent: () => this.#automaticAllowed(
  account,
  conversation,
  roleBinding?.revision,
  capturedMemory?.guard
)
```

没有把当前新guard替换进旧context，也没有新增第二套检查入口。未配置memory resolver的旧宿主仍走原有role逻辑；手工`QqInstance.send`仍不经过自动轮次guard。`src/host/contract.ts`同步把该回调注释收窄为“角色绑定与本轮记忆快照仍匹配”。

修复后以下路径共享同一准入：

- `AgentEngine` 的turn开始、chat返回后、生图/语音工具提交前；
- `ProviderRouter` 的请求前/请求后executionGuard；
- `MediaJobService` executor调用Provider前；
- 图像/语音任务完成后的`context.deliver`和`isRoleBindingCurrent`；
- 视频理解、图片理解及后续chat。

### 2.3 正式回归

新增`test/memory-tools.test.ts`，均使用真实 Core→Instance→Agent→MediaJob→FakeProviderAdapter→FakeChannel：

| 场景 | 断言 |
| --- | --- |
| 文本模型等待期间删除记忆，旧响应返回`generate_image` | 后续`image.generate` Provider调用为0；新轮正常生成并发送1张图片；旧轮没有额外job/发送 |
| 文本模型等待期间关闭记忆，旧响应返回`generate_speech` | `audio.generate`调用为0；新轮正常生成并发送录音；媒体索引只有1条音频 |
| job已提交但执行器尚未调用Provider时删除记忆 | job以failed结束、delivery=skipped；`image.generate`调用0；通道发送0 |
| Provider调用已开始后删除记忆 | Provider调用已发生1次，不承诺撤销；旧job failed且无媒体落盘/发送；新轮再次调用Provider并成功发送图片 |
| 其他scope修改记忆 + 同requestId回执重放 | 当前私聊工具轮次继续执行并成功投递；私聊memory revision/generation不被回执重放改变 |

## 3. R2 修复：耗尽计算量后继续读取OR缓存

### 3.1 根因

`src/memory/selector.ts` 的`matchRecords`在遍历单条记录的OR关键词时，遇到未缓存键且已耗尽工作量会`unknown=true; break`，不再检查后面的关键词。若后续关键词早已缓存为true，记录本可确定命中，却被标为`unscannedIds`；交换关键词顺序还会改变结果。

### 3.2 修复

两个耗尽分支（已耗尽、本次`work+cost`超限）都从`break`改为`continue`：

- 达到上限后不再新增`includes`计费；
- 继续遍历该记录剩余的有界关键词；
- `cached=true`立即命中；`cached=false`继续；未缓存键标记`unknown`；
- 最终无命中且仍有未知判断才进入`unscannedIds`。

### 3.3 正式回归

`test/memory-selector.test.ts`新增：

| 用例 | 覆盖 |
| --- | --- |
| R06b | 后键`needle`在未知长键之后仍命中；首键首次超800万额度、第二键缓存命中仍选中；不破坏`scanLimited`/unscanned数量 |
| R07b | 已缓存false + 未缓存未知混合记录进入unscanned；已缓存false的早期记录不被误列；达到maxSelected时缓存命中进入countSkipped而非unscanned；预算跳过不混入 |

## 4. 受影响验收项与回归

| 原ID | 70号结论 | 修复后 | 证据 |
| --- | --- | --- | --- |
| R06/R07 | 缓存命中路径不完整 | 通过 | `R06b`、`R07b`及原R06/R07 |
| G03 | 工具执行前可能用旧响应发起新任务 | 通过 | `memory-tools`删除/关闭/编辑、排队job、Provider已开始 |
| G05 | 延迟投递已有保护 | 通过 | 保留，并新增工具执行前保护 |
| C09 | 外部改写旧回复最终不发送 | 通过 | 旧轮在chat后即被本轮guard拒绝，新轮使用新正文 |
| G01/G02 | 删除/关闭/清空/预算变化 | 通过 | 生成期、限速队列、工具job三处均拒绝 |

普通Auto回复、限速队列、延迟投递、手动发送、角色/世界书、插件/Skill、媒体任务和退出排空的既有回归全部继续通过。

## 5. 命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | 退出码0；93个测试文件，833通过、1既有跳过（共834）；MEM02修复前826通过，本轮新增7项 |
| `npm run typecheck` | 退出码0 |
| `npm run desktop:build` | 退出码0 |
| `git diff --check` | 退出码0 |

既有跳过仍为`test/artifact-import.test.ts`的权限相关用例，本轮未新增skip。

## 6. 边界与状态

- 修复未新增API、UI、依赖或发行打包；未连接真实QQ或付费模型。
- Provider调用已发生后的外部费用不承诺撤销；本轮只保证旧结果不继续落媒体、不投递、不进入新工具执行。
- 已发出到QQ的消息不撤回；本轮保护发生在通道发送之前。
- MEM02可重新收口；MEM03自动提取、MEM04界面、真实QQ/付费服务与原生验收仍待后续。
- 未提交、未打包、未更新发行包或EXE。
