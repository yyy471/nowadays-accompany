# 91 EXT-E 内置媒体迁移执行记录

范围：`devDoc/79-agent-extension-execution-plan.md` 第 9 节的 EXT-E 包（M01～M04），验收依据
`devDoc/80-agent-extension-acceptance.md`。内置媒体工具的执行迁移已在 EXT-D-C 落地（见 87 号），
本包补齐迁移后的独立验收证据，并补上测试假通道此前无法模拟的“语音交付能力未知”边界。
未访问真实 QQ、未调用付费模型、未提交、未打包。

## 1. 交付

| 子项 | 状态 | 说明 |
| --- | --- | --- |
| 生图/语音注册为执行器 handler | 已在 D-C 完成 | 模型工具调用不再有引擎硬编码分支；两个 handler 由 `#builtinToolHandlers` 按 turn 注入统一执行器 |
| 复用原 MediaJob / actionId / 交付链 | 已在 D-C 完成 | handler 只负责提交，生成、持久化、发送仍由 `MediaJobService` 与原交付回调完成 |
| submitted 状态与 jobId | 本包补证据 | 图像与语音都验证账本记录 `submitted` 且 jobId 等于真实任务 id，工具文本不声称已发送 |
| 宿主调用键幂等语义 | 本包补证据 | 同一宿主调用的重投不重复计费；不同消息或模型回合复用服务方 `call_1` 各自独立 |
| 通道与授权边界 | 本包补证据 | 语音通道能力未知时只发说明并把任务交付标记 `skipped`；生成中被暂停时不交付图像 |
| 识图、视频与显式命令路径 | 未改动 | M04 由既有回归继续覆盖，未改写为第二套媒体框架 |

## 2. 代码地图（行号在当前工作树核对）

| 位置 | 责任 |
| --- | --- |
| [src/agent/engine.ts:727](../src/agent/engine.ts#L727) | `#builtinToolHandlers`：按 turn 注入两个媒体 handler |
| [src/agent/engine.ts:745](../src/agent/engine.ts#L745)、:768 | 生图/语音 handler：校验参数、调用原提交函数、返回 `submitted` + jobId + duplicate 数据 |
| [src/agent/engine.ts:789](../src/agent/engine.ts#L789)、:853 | `#submitImageJob`/`#submitAudioJob`：授权、能力解析、`actionId`、job executor 内的撤权/角色复核 |
| [src/agent/engine.ts:804](../src/agent/engine.ts#L804)、:871 | `image:<accountId>:<actionKey>` / `audio:<accountId>:<actionKey>` 两层去重键 |
| [src/agent/engine.ts:899](../src/agent/engine.ts#L899)、:941 | 交付回调：角色/暂停/授权/通道能力复核，`markDelivery` 记录 sent/skipped/failed |
| [src/channels/fake.ts:11](../src/channels/fake.ts#L11) | 测试假通道新增 `voiceDeliverySupport` 选项（默认 supported），:54 返回该值 |
| [test/agent-media-tools.test.ts](../test/agent-media-tools.test.ts) | 本包新增的 4 项 M01/M02/M03 证据 |

## 3. 运行时语义

- 提交即返回：工具结果 `submitted` 只表示任务已受理，`jobId` 指向真实任务；生成与发送由任务链继续，
  工具文本固定为“正在生成…”，不出现“已发送”。
- 幂等：`actionKey` 使用执行器提供的宿主调用键（账号、会话、入站消息、模型回合、批内序号、工具、作用域）。
  同一宿主调用重投命中账本或任务去重；不同消息/回合即使服务方复用 `call_1` 也是不同动作，
  这是 D-D 复核后确定的语义（90 号第 5 条），本包用图像与语音各一组用例锁定。
- 交付边界保持原样：发送前重新检查角色/记忆 guard、Agent 暂停、工具授权与能力、语音通道支持；
  语音通道为 `unknown`/`unsupported` 时不发 `record`，只发一条说明并把任务标记 `skipped`。
- 生成后撤权、角色变化、排队中撤权、暂停：均不产生交付；这些路径分别由既有 `memory-tools`、
  `agent-plugin-composition` 用例与本包暂停用例覆盖。
- 显式 `/draw` 命令仍直接提交同一个生图任务；识图与视频续答没有经过工具执行器，保持原路径（M04）。

## 4. 验收映射

| ID | 结论 | 证据 |
| --- | --- | --- |
| M01 | 通过 | `agent-media-tools` 第 1 项：语音工具产出 1 个 `audio.generate` 任务，账本 `submitted` 且 jobId 匹配，文本不声称已发送；图像侧既有 `agent-tool-loop` 用例同构 |
| M02 | 通过 | 同一宿主调用的重投不新增任务/计费（第 2 项与 `agent-plugin-composition` 的同消息重投用例）；不同消息/回合复用 `call_1` 独立执行（`agent-plugin-composition`、`agent-tool-loop`、本包第 2 项） |
| M03 | 通过 | 生成后撤权（`agent-plugin-composition`）、角色变化与排队撤权（`memory-tools`）、语音通道未知（本包第 3 项）、生成中暂停（本包第 4 项）都不交付，任务交付状态与实际发送一致 |
| M04 | 通过（回归） | `phase1-agent` 的识图、视频异步续答、显式命令生图与未授权语音拒绝用例全部继续通过 |

## 5. 复核与边界

- 本包只新增测试与测试假通道的一个可选参数，未改生产媒体执行路径；因此性质上是验收补证，
  但仍需一次独立复核确认“用例断言的是实际行为，而不是放宽后的期望”。本轮由主进程自查，**独立复核未做**。
- `FakeChannel` 默认仍是 `supported`，既有用例行为不变；新增参数只影响显式传入的用例。
- 未验证：真实 QQ 语音通道、真实 TTS 服务的格式/时长、页面对工具与媒体状态的展示一致性（EXT-G）。
- `providers/router.availableTools` 仍只用于交付前的授权复核与 Skill 解析；页面与执行共用同一份有效状态
  解析在 EXT-F/G 收口，本包未改。

## 6. 验证证据

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.test.json --noEmit` | 通过，`test-results/ext-e-tc.log` |
| `npx vitest run test/agent-media-tools.test.ts` | 4 项通过，`test-results/ext-e-media2.log` |
| `npx vitest run` | 111 文件通过；1050 项通过、1 项既有跳过，`test-results/ext-e-full.log` |

未提交、未打包、未替换发布 EXE。
