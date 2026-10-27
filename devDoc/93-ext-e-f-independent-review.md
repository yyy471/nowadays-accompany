# EXT-E / EXT-F 主进程独立复核与修复要求

日期：2026-10-27。复核基线：`a9dca89` 之后的当前未提交工作树，包含 [91 媒体补证](91-ext-e-builtin-media-execution.md) 和 [92 Skill 服务执行记录](92-ext-f-skill-service-execution.md)。

**结论：EXT-E 媒体补证在本地自动化范围内成立；EXT-F 暂不放行，发现 1 项 P1、2 项 P2。** 92 中“无剩余 P0/P1”及“仅无工具测试装配可能超预算”的结论需要以本次独立复核为准。没有发现本轮新增的跨账号数据访问或工具授权绕过，但不能以现有测试通过替代下列边界。

本轮只复核并写入记录，没有修改生产或正式测试代码，没有提交、推送、打包或替换 EXE。独立探针和完整输出保留在被忽略的 `test-results/review93/`。

## R1 / P1：普通文本模型仍能被 Skill 绕过实际上下文预算

位置：[engine.ts:624](../src/agent/engine.ts#L624)、[engine.ts:656](../src/agent/engine.ts#L656)。

现在实际 JSON 开销的尾部回退只在 `toolsCouldBeOffered` 为真时执行。生产中使用不支持 tools 的对话模型，或者账号没有开放任何工具时，该条件同样为假，并非仅测试装配才会进入。后面没有插件补充数据、没有工具预留时又直接使用 `rawBase`。

独立复现使用真实 Core、账号与角色绑定，通过正常的 `savePublicSkill` 保存合法定义：正文是 8000 个双引号，未超过保存上限；模型不支持 tools；用户输入为短文本 `hello`。

实际 ProviderAdapter 收到的请求：

```json
{"size":16299,"tools":0}
```

配置上限为 12000。字符估算允许该 Skill，JSON 转义后超额，但此路径没有执行实际预算回退。由此可能超出模型上下文或显著增加请求开销；92 §5 将其称为仅测试路径的低风险残余不准确。

修复要求：

1. 无论本轮是否提供工具，都按最终序列化请求裁剪新增的 Skill；工具定义及协议预留只影响保留量，不决定是否检查。
2. 保留原有超长原始用户输入的行为，不得为修这个问题直接截断原始消息。应从选中的 Skill 尾部逐项移除，并给出 `context_budget` 等明确原因。
3. 保持共享选择器的稳定顺序及前缀关系，不截成无标记的半份 Skill 正文。

验收：增加真实 Core → Provider 回归，分别覆盖 `supportsTools=false`、支持 tools 但授权清单为空、合法的双引号/反斜杠/控制字符正文，以及原始用户输入超过 12000 字符的对照。前两种短原文场景实际请求不超过配置上限；长原文不丢失。

## R2 / P2：统一能力接口丢失标准选择与排除原因

位置：[core.ts:1417](../src/core/core.ts#L1417)。

`skillResolutionFromPreview` 仅按 `enabled` 划分 available/unavailable，没有保留 `selected`、`selectionReason` 或预览的预算排除列表。独立创建 9 个短 Skill 后得到：

```json
{"selected":8,"available":9,"excluded":[{"id":"skill-8","reason":"skill_limit"}]}
```

专用预览与实际 Agent 都限制到 8 项，但 `/accounts/:id/effective` 仍把 9 项全部报告为 available，没有说明第 9 项因标准数量限制未选用。对于即将接入的 EXT-G 页面，仅凭该字段无法区分“作用域允许”与“选入提示词”。

这不意味着必须把所有预算遗漏都改成权限不可用；可保持 `available` 的配置语义，但需带出标准选择状态和排除原因，或明确让页面以专用 Skill 预览作为唯一来源。不得把 `enabled` 当成实际已注入。具体轮次仍可通过 `runtimeMayTrim` 说明会进一步收紧。

验收：超过 8 项和超过 16000 累计预算时，页面最终消费的 DTO 能同时表达 scope enabled 与 selected，且有 `skill_limit` / `instructions_budget`。不能只把超量项静默扔掉，也不能同时显示为“已注入”。

独立探针中对 available 数量的断言用于暴露信息丢失；修复可以扩充状态表达，而不强制修改现有 available 的含义。

## R3 / P2：已有 host 测试把已发送误当成已持久化，导致全量偶发失败

位置：[host.test.ts:85](../test/host.test.ts#L85)、[host.test.ts:95](../test/host.test.ts#L95)。此测试不是本轮新增代码。

本次独立全量首次执行真实失败：`host.test.ts` 期望历史方向为 `[in,out]`，实际读取到 `[in]`。不能将该结果删除或用后续定向通过覆盖。

代码顺序本来就是先调用通道发送，再 `await store.append(out)`；FakeChannel 在发送阶段就增加 sent 数。测试只等待 `channel.sent.length===1`，随即读文件，尚不能证明 append 已结束。

主进程用真实 Core、自定义宿主、FakeChannel 和门控出站 append 做确定性对照：

```json
{"case":"sent-is-not-persisted","sent":1,"before":["in"],"after":["in","out"]}
```

放开门后记录正常落盘，未复现永久丢失。因此此项是已确认的测试等待边界缺陷，而不是凭空归因于运行环境。

修复要求：测试等待可证明出站 append 完成的边界，例如带 seq 的 `channel:outbound` 事件或持久化读取条件；保留对实际文件 `[in,out]` 的最终断言。不得用固定 sleep 或改成只验证发送来掩盖问题。

验收：门控 append 未释放时测试不能提前宣告历史完整；释放后正常通过。修复后重新执行定向和全量，并保留本次首跑失败日志。

## 已确认的实现与结构

- `SkillService` 负责公用/私有定义、复制、影响与预览；写入复用 ConfigStore mutation 链和 CAS，没有另建一套文件存储。
- 私有同 id 覆盖公用；插件 Skill 使用完整命名空间；有效性仍由 ExtensionPolicyService 的统一目录与依赖判定提供。
- 预览与 Agent 共享 `selectSkillsForPrompt`，保留私有 → 公用 → 插件顺序、单项上限和前缀选择。问题集中在其后实际请求的最终预算和 DTO 状态转换，不需要重新设计后端分层。
- 私有定义的过期 revision 被拒绝，独立并发复制对照确认新创建的私有定义不会被旧 revision 覆盖。
- EXT-E 新增的 4 项媒体测试实际检查任务、回执、Provider 次数、语音交付和暂停后图像不交付。其生产变动仅 FakeChannel 的语音能力选项，默认仍为 supported；媒体执行继续复用原任务与交付链。
- Skill 启停/作用域 HTTP 写路由和页面确实尚在 EXT-G；本轮服务与管理 CRUD 不能被描述为整个插件/Skill 用户界面已闭环。

## 独立验证原始结果

| 项目 | 结果 | 日志 |
| --- | --- | --- |
| 首次 `npm test` | 113 文件中 112 通过、1 失败；1070 项通过、1 失败、1 既有跳过；失败为 R3 | `test-results/ext-ef-review-parent-initial.log` |
| `npm run typecheck` | 通过，含 renderer 和测试 | `test-results/review93/typecheck.log` |
| Skill service/API、媒体、工具循环、host 五文件定向 | 46/46 通过；不覆盖 R1 的非工具模型转义边界 | `test-results/review93/targeted.log` |
| `npm run desktop:build` | Core、renderer、main/preload 构建通过 | `test-results/review93/build.log` |
| 独立 Skill 探针 | 1 通过、2 个诊断断言失败：R1 实际请求超限；R2 标准选择与能力视图差异；过期复制 CAS 对照通过 | `test-results/review93/probes.log` |
| 独立 host 持久化门控 | 通过，确定性复现 R3 的提前读取窗口并确认释放后正常落盘 | `test-results/review93/host-persistence.log` |
| `git diff --check` | 通过（当前已跟踪改动）；新文件未纳入该 Git diff 范围 | 命令无输出 |

独立 Skill 诊断通过复制现有真实装配 fixture 并在忽略目录执行定向用例取得；输出中的 20 项 skip 来自探针 `-t` 过滤，不是项目新增 skip，项目全量仍只有原有 1 项。

## 修复顺序与复验门槛

1. 先修 R1，并加入正式的非工具模型预算回归，更新 92 中有关该路径的风险范围。
2. 修正 R3 的测试完成边界，再次记录真实全量结果。
3. 在 EXT-G 页面绑定之前解决 R2 的 DTO/消费语义，保留预算排除原因。若本轮暂缓，必须列为下一阶段前置项，不得宣称统一视图完全一致。
4. 重新运行类型检查、定向、全量、桌面构建及包含新增文件的空白检查；只在 R1 关闭、全量真实结果可解释后重评 EXT-F 放行。

以上为本次复核发现及建议，不代表已经执行修复。
