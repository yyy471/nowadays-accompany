# 角色语音启用与停用（DL-149）

> **现行规范入口**：单份语音配置覆盖、启停开关、`VOICE_DISABLED` 隔离与未完成项边界的现行规则已并入 [TTS 与生图服务接入规范](../../specs/tts-and-image-services.md)；下文保留 DL-149 专题实施记录。

2026-11-10。按 [236 第 6.4 节](236-role-settings-backend-gap-review.md#64-增删改查与状态保护) TTS 行「缺启停单份配置」和 [DL-149](../../161-digital-life-direction-decisions.md#dl-149-角色语音只保留当前一份配置) 实现。声音配置页本身见 [243](243-voice-settings-desktop.md)，复核链见 [244](244-role-settings-independent-review.md)、[245](245-role-settings-review-fixes.md)。

## 1. 范围与结论

| 目标 | 结论 |
| --- | --- |
| 角色语音可停用、可再启用 | 后端新增 `PUT /v1/roles/:roleId/voice/enabled`，业务库升到 V14，声音页加开关 |
| 停用只保留一份配置 | 启停只写 `enabled`，不动地址、协议、密钥、音色与参数；再次启用读回同一份 |
| 停用只阻止新的对话语音合成 | `synthesizeSegment` 返回 409 `VOICE_DISABLED`；`preview` 试听不受影响 |
| 保存新配置不改变启用状态 | `saveSettings` 的 UPSERT 不写 `enabled` 列 |
| 没有配置时启停不静默成功 | 返回 400 `VOICE_NOT_CONFIGURED` |

未纳入本轮：DL-148 的「停止活动执行与恢复规则」仍待定；设置页模型／MCP／Skill 绑定仍只读；Dock 尚无独立角色配置入口。

## 2. 语义边界

- **停用是配置状态，不是故障。** 后端用 409 而不是 400，桌面端按错误码识别后静默跳过自动播放与预取，不再逐句弹提示。
- **试听仍可用。** 「生成试听」是保存前的配置验证手段，停用期间仍应能确认这份配置能不能用，因此只在句段合成路径拦截。
- **保存与启停互不覆盖。** 停用期间保存新配置，返回的 `enabled` 仍是 `false`；启用期间保存返回 `true`。两者都不需要额外字段来表达意图。
- **单份配置。** 没有「停用的配置」与「启用的配置」两份，也没有暂存草稿；停用就是把当前这份挂起。

## 3. 后端实现

- **迁移 V14。** `BUSINESS_SCHEMA_VERSION = 14`，`BUSINESS_V14_SQL` 给 `role_voice_settings` 加 `enabled INTEGER NOT NULL DEFAULT 1`，老库升级后默认启用；`BUSINESS_COLUMNS` 同步登记该列。[schema.ts](../../../backend/src/storage/schema.ts)
- **存储层。** `SettingsRow.enabled: number`，`mapSettings` 转成布尔；新增 `VoiceStore.setEnabled(enabled, now)`，按 `role_id` 更新并回读，没有记录时返回 `null`。[voice-store.ts](../../../backend/src/storage/voice-store.ts)
- **保存不动开关。** `saveSettings` 的 UPSERT 列表里没有 `enabled`，插入时用列默认值 1、更新时保持原值，天然满足「保存新配置不改变启用状态」。
- **服务层。** `VoiceService.setEnabled(roleId, enabled)` 复用 `roleAccess.withStore`；记录不存在时抛 400 `VOICE_NOT_CONFIGURED`。`synthesizeSegment` 在句段校验之后、解析配置之前读 `getSettings()?.enabled === false` 抛 409 `VOICE_DISABLED`，附带 `roleId`。[voice-service.ts](../../../backend/src/application/voice-service.ts)
- **路由。** `PUT /v1/roles/:roleId/voice/enabled`，请求体 `{ enabled: boolean }` 用 `.strict()` 拒绝多余字段，返回 `{ voice }`。[voice-routes.ts](../../../backend/src/http/voice-routes.ts)
- **视图。** `VoiceSettingsRecord.enabled` 与 `VoiceConfigView.enabled` 一路透传，`toView` 直接输出。

## 4. 桌面端实现

- **类型与摘要。** `VoiceConfigView` 加 `enabled: boolean`；`describeVoiceSummary` 在停用时加「已停用 · 」前缀，列表和页头一眼能看出状态。[voice-config.js](../../../desktop/desk-preview/renderer/src/voice-config.js)
- **开关。** 声音页在配置摘要下加「启用角色语音」勾选框：没有配置时禁用并提示「保存配置后可以启用或停用」，停用时提示「对话不再合成语音，这份配置保留」。保存中、启停中都禁用，避免并发。[VoicePanel.tsx](../../../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx)
- **令牌保护。** `toggleVoiceEnabled` 捕获 `roleToken`，晚到的响应不写当前角色状态；`toggleBusy` 与 `busy` 分别驱动两个控件的禁用态，保存与启停按 [249](249-role-voice-toggle-review-fixes.md) 改为双向互斥（同一时刻只允许一个写入），切换角色时随其他忙碌标记一起复位。
- **对话页静默跳过。** `use-segment-voice.ts` 新增 `SpeechRequestError`（带 `code`）与 `voiceDisabled` 标记：命中 `VOICE_DISABLED` 后预取与自动播放直接返回，不再发请求也不再弹提示；手动点播视为显式重试，先清标记再请求一次，仍被拒时提示「角色语音已停用，启用后才能播放对话语音」。切换角色、窗口或卸载时随 `releaseAll` 复位。[use-segment-voice.ts](../../../desktop/desk-preview/renderer/src/conversation/use-segment-voice.ts)
- **样式。** `.nd-voice-toggle` 复用外观页的勾选框样式，禁用态用 `:has(input:disabled)` 降透明度。[voice.css](../../../desktop/desk-preview/renderer/src/styles/voice.css)

## 5. 测试与验收

- **后端新增用例**「voice can be disabled and enabled without losing the saved config」：默认 `enabled` 为 `true`；停用后句段合成返回 409 `VOICE_DISABLED` 且不调用语音服务；停用期间试听仍 200；停用期间保存 preset 配置返回 `enabled: false` 且读回同一份音色；再启用后恢复合成。[p9-tts-unified.test.ts](../../../backend/tests/p9-tts-unified.test.ts)
- **迁移模拟补齐。** 回拨 `user_version` 到 V10、V11、V12 的三处模拟此前只改版本号，严格 ALTER 会撞上已存在的 `enabled` 列，统一补 `ALTER TABLE role_voice_settings DROP COLUMN enabled`；这与 [245](245-role-settings-review-fixes.md) 定下的「回拨版本必须同时删除该版本之后新增的列」一致。
- **版本断言。** `p1-02-storage`（两处）、`p2-02-memory`、`p8-voice`、`p9-tts-unified`（两处）、`p10-scene-image` 的 `schemaVersion` 全部改为 14；`p8-voice` 用例名去掉「schema v12 tables」，避免版本号写死在标题里。
- **后端全量。** 302／302 项通过。离线验收 `npx -y node@24 scripts/accept-offline.mjs` 21／21 步、302／302 项，`realServiceCalls=0`、`sourceUnchanged=true`，目录 `backend/test-results/p5-2026-11-10T08-47-52-755Z-cc614808/`。
- **桌面端。** 89／89 项通过，用例数不变；`renderer` 下 `npx tsc --noEmit` 与 `npx vite build` 通过（渲染器是独立包，`tsconfig.json` 与构建脚本都在这一层）。
- **复核问题。** [247](247-role-voice-toggle-independent-review.md) 提出的 VT-R01、VT-R02 已按 [249](249-role-voice-toggle-review-fixes.md) 修复，桌面端随后为 97／97 项（含生图配置页新增的 8 项）。

## 6. 未完成与后续

- **对话页不显示停用状态。** 停用后只是不再合成，页面上没有角标；用户从设置页返回对话页时不会看到「已停用」的提示。`voice` 配置读取结果已带 `enabled`，只是对话页还没有用它渲染标记。
- **启用后不自动刷新配置版本。** 对话页只在挂载与切角色时读一次 `voice` 配置，`revision` 不随启停变化。当前靠「手动点播即重试」兜底；若启用后希望自动播放立刻恢复，需要把启停事件接到对话页。
- **桌面端无自动化用例。** `use-segment-voice` 是 React hook，现有 `node --test` 只跑纯逻辑模块，本轮该文件的静默处理靠类型检查与构建保证，后端 409 契约由 p9 用例覆盖。
- **待定的后续块。** [236 第 6.3 节](236-role-settings-backend-gap-review.md#63-生图锚点输入能力和运行时选图) 真实生图需先确定首个服务商与输入能力契约；[第 6.4 节](236-role-settings-backend-gap-review.md#64-增删改查与状态保护) 的角色停止活动受 DL-148 未定项阻塞；删除按 DL-151 不做归档。
