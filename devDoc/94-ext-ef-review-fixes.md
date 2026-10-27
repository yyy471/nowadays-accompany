# EXT-E / EXT-F 复核修复记录（R1–R3）

日期：2026-10-27。依据：[93 主进程独立复核](93-ext-e-f-independent-review.md)。基线为当前未提交工作树。未提交、未打包、未替换 EXE；修复与验证均在本地隔离数据上完成。

结论：R1（P1）关闭；R2、R3（P2）关闭。类型检查、定向 67 项、全量 113 文件 1077 项通过/1 项既有跳过、桌面构建均通过。后续独立复验发现 host 异步等待仍需 await、超时原因存在双路径竞争，修复见[96](96-ext-ef-recheck-fixes.md)。首跑失败日志由复核者保留在忽略目录 `test-results/`，本记录不覆盖。

## R1：非工具模型仍可被 Skill 撑破实际上下文（P1）

**根因**：实际 JSON 序列化后的尾部回退只在 `toolsCouldBeOffered` 为真时执行。不支持 tools 的模型、或没有任何工具被授权时，该条件为假；字符估算通过但 JSON 转义后超额的 Skill 正文会原样进入请求（复核探针：上限 12000，实际请求 16299）。

**修复**：[engine.ts:624](../src/agent/engine.ts#L624)

- 回退循环不再以“是否提供工具”为前提。每次构建不含历史的最小上下文，用 `serializedMessagesChars + protocolOverhead` 与 `maxContextChars` 比较；超出时从已选 Skill 尾部逐项移除并记录 `context_budget`。
- `protocolOverhead` 只在工具与协议确实可能提供时包含工具定义 + 512 预留；没有工具时不占位，但仍执行同一回退检查。
- 保留原有超长原始输入路径：原始用户消息不截断；Skill 会先被全部移除，再接受输入本身超出预算的既有行为。
- 只要本轮曾选出 Skill，最终上下文走 `buildBudgetedContext`，其历史裁剪也按实际序列化大小计算；未选出 Skill 且无工具/补充数据时仍走原 `rawBase`。

**验收回归**：[agent-tool-loop.test.ts:480](../test/agent-tool-loop.test.ts#L480)

| 场景 | 断言 |
| --- | --- |
| `supportsTools=false`，8000 个双引号正文 | 实际 Provider 请求 JSON ≤ 12000；Skill 标题不再进入 system |
| 支持 tools、授权清单为空，正斜杠/引号/换行/制表符混合 8000 字符 | 请求 ≤ 12000；`tools` 未提供；Skill 被移除 |
| 原始输入 13000 字符 + Skill | 原始输入完整保留；Skill 被移除，不为修复而截断用户消息 |

## R2：统一能力接口缺少标准选择状态（P2）

**修复**：[types.ts:52](../src/extensions/types.ts#L52)、[core.ts:1426](../src/core/core.ts#L1426)

- `SkillStatus` 增加可选 `selected`、`selectionReason`；`/accounts/:id/effective` 的 available 项现在同时表达“scope 可用”与“是否进入标准提示词预算”。
- 预算排除的 Skill 仍保持 `available: true`（配置语义），但 `selected: false` 并带 `skill_limit` / `instructions_budget`；不把超量项静默丢弃，也不标为已注入。
- 专用预览仍为页面选择状态的完整来源（含顺序、排除列表、`runtimeMayTrim`）。

**验收回归**：[skill-api.test.ts:247](../test/skill-api.test.ts#L247)、[skill-api.test.ts:272](../test/skill-api.test.ts#L272)

- 9 个短 Skill：`available` 9 项、`selected` 8 项、第 9 项 `skill_limit`；专用预览 included 8、excluded 1，二者一致。
- 3 个 6000 字符 Skill：前两项 selected，第三项 `instructions_budget`。

## R3：host 测试把“已发送”当成“已持久化”（P2）

**根因**：测试只等待 `FakeChannel.sent.length === 1` 就读取历史文件。发送先于 `store.append(out)` 完成，文件读取存在提前窗口，导致全量偶发只看到 `[in]`。这是测试完成边界缺陷，不是产品丢失记录。

**修复**：[host.test.ts:92](../test/host.test.ts#L92)、[host.test.ts:119](../test/host.test.ts#L119)

- 原有测试改为等待 `channel:outbound` 事件携带 `seq`（持久化成功后才发出）再读取并断言 `[in,out]`，不使用固定 sleep。
- 新增确定性门控用例：`storeFactory` 包装 `JsonlStore`，在 `append(out)` 进入后阻塞。断言此时通道已发送、尚无 `channel:outbound` seq、历史读取只有 `[in]`；释放后才出现 out 事件并读到 `[in,out]`。门控未释放时测试无法提前通过。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.test.json --noEmit` | 通过 |
| 6 文件定向（skill-service、skill-api、agent-tool-loop、host、agent-media-tools、extension-policy） | 67/67 通过 |
| `npx vitest run` | 113 文件通过；1077 项通过、1 项既有跳过 |
| `npm run desktop:build` | Core、renderer、main/preload 构建通过 |
| `git diff --check` | 通过 |

## 残余风险

- `/accounts/:id/effective` 的模型能力与 Skill 预览仍是两次独立读取，极端并发下可能短暂混合；Skill 预览失败会回退旧视图并告警。
- 从未有过 `skills` 字段的账号，第一次旧整策略保存仍可能导入超限 legacy 定义；运行时选择会排除，不会进入提示词。
- 本轮修复保证“Skill 不会把实际请求撑破预算”；历史消息或原始输入本身造成的超限仍按既有语义保留，不在本包截断。
- 未进行真实 QQ、真实模型、浏览器交互与发布包验证。
