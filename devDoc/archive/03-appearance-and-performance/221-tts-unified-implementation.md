# TTS 统一接入首轮实施记录

> **现行规范入口**：统一语音协议与状态规则已并入 [TTS 与生图服务接入规范](../../specs/tts-and-image-services.md)；下文保留首轮实施与迁移补修流水。

2026-11-09，`dev-front` 工作树，基线 `8d6dd08`。按 [DL-140](../../161-digital-life-direction-decisions.md#dl-140-tts-统一接入音色克隆与预置音色) 和 [220 统一接入说明](220-tts-unified-integration.md) 实现后端首轮：服务能力探测、预置音色列表、克隆／预置两种合成模式、v10 存储和旧 IndexTTS 配置兼容。工作树未提交、未推送；未调用真实 TTS 服务，离线验证使用本机假统一协议服务。

## 1. 范围

- 新增 `nowadays-tts-v1` 协议客户端：`GET /health`、`GET /voices`、`POST /tts`（`multipart/form-data`）。
- 新增 `POST /v1/roles/:roleId/voice/probe`，返回服务就绪状态、能力声明和预置音色列表；探测不落库。
- `GET/PUT /voice` 增加 `protocol`、`voiceSource` 和 `capabilities`；保留旧 `referenceAssetId` 含义。
- 试听与按句合成按角色已保存协议分流：旧 `indextts` 协议继续传本机绝对路径，统一协议上传受管参考音频。
- 业务库升级到 v10；旧行自动识别为 `indextts` 协议和参考音色来源。
- 未实现真实服务联调、桌面配置页和桌面播放；服务凭据仍由桥接或部署层提供。

## 2. 协议客户端

- `GET {baseUrl}/health` 校验 `protocol="nowadays-tts-v1"`、`service`、`model`、`ready` 和 `capabilities`。`capabilities` 包含参考模式、预置音色开关、语言列表和语速范围；重复模式 ID、重复语言和反向语速范围按协议错误拒绝。
- 仅当 `ready=true` 且 `presetVoices=true` 时请求 `GET /voices`；列表 ID 必须唯一。健康或列表格式不符返回 502 `TTS_PROTOCOL_INVALID`，HTTP 失败返回 502 `TTS_PROBE_FAILED`。
- 探测超时默认 10 秒；连接失败、超时和取消沿用 503／504／499 语义。
- `POST {baseUrl}/tts` 使用 `FormData`：`text`、`mode`、克隆的 `reference_mode`／`reference_audio`／可选 `reference_text`，或预置的 `voice_id`；语言和语速仅按服务声明附带。`baseUrl` 的路径前缀保留，例如 `/bridge` 请求 `/bridge/tts`。
- 成功响应必须是完整 PCM WAV，复用 16 MiB 流式上限、媒体类型校验和连接收尾；错误响应读取保留超时和取消语义。[统一客户端](../../../backend/src/tts/unified-tts-client.ts#L88) · [公共传输校验](../../../backend/src/tts/transport.ts#L64)

## 3. 存储 v10

`role_voice_settings` 新增列：

| 列 | 用途 |
| --- | --- |
| `protocol` | `indextts` 或 `nowadays-tts-v1`，旧行默认 `indextts` |
| `voice_source` | `reference` 或 `preset` |
| `reference_mode` | 服务声明的参考模式 ID |
| `reference_text` | 需要原文的克隆模式所用文本 |
| `preset_voice_id` | 预置音色 ID |
| `capabilities_json` | 保存时确认的能力声明快照 |

- v9 → v10 只对音色表执行 `ALTER TABLE ADD COLUMN`，历史消息、句段、事件和 SSE 游标不变。[迁移 SQL](../../../backend/src/storage/schema.ts#L1175)
- 旧行读取为 `protocol=indextts`、`voiceSource={kind:"reference",referenceMode:null,referenceText:null}`，原服务地址和 `referenceAssetId` 保留；未绑定参考素材的草稿仍可读取。
- 保存时 `engine` 与 `protocol` 一致；旧配置继续显示 `indextts`。旧请求只传 `referenceAssetId` 时按参考音色处理，新请求使用 `voiceSource`。

## 4. 应用接口与校验

| 接口 | 行为 |
| --- | --- |
| `POST /voice/probe` | 候选 `baseUrl` 的能力与就绪状态；就绪且有预置能力时返回 `voices`，否则为 `null` |
| `GET /voice` | 返回 `protocol`、`voiceSource`、参考素材、能力快照、语言、语速和情绪强度 |
| `PUT /voice` | 保存地址、协议、音色来源和能力快照；省略来源时保留原绑定，传部分参考字段时按已有值补齐 |
| `POST /voice/preview` | 试听文本 + 可选候选配置，试听不落库 |
| `POST /windows/:windowId/segments/:segmentId/speech` | 用已保存配置按句段合成；旁白、跨角色素材和跨窗口句段分别拒绝 |

- 服务切换或协议变化时，未显式传入能力快照会清空旧快照，避免把旧服务声明用于新地址。
- 只声明一个参考模式时自动选中；模式不在声明内返回 `VOICE_REFERENCE_MODE_INVALID`，无参考模式返回 `VOICE_REFERENCE_MODE_UNSUPPORTED`，缺少模式返回 `VOICE_REFERENCE_MODE_REQUIRED`。
- 声明需要录音原文的模式缺少文本时返回 400 `VOICE_REFERENCE_TEXT_REQUIRED`；不需要原文时不附带 `reference_text`。
- 显式语言／语速超出声明范围分别返回 `VOICE_LANGUAGE_UNSUPPORTED`、`VOICE_SPEED_OUT_OF_RANGE`；未显式提供时按声明收敛并夹取。
- 未声明语言列表或语速范围时不发送对应字段，由服务决定；统一协议台词上限 1000 个 Unicode 码点，超过返回 `VOICE_TEXT_TOO_LONG`。
- 旧协议只支持参考音色，传入预置来源返回 `VOICE_SOURCE_UNSUPPORTED`。[应用层](../../../backend/src/application/voice-service.ts#L137) · [路由](../../../backend/src/http/voice-routes.ts#L90)

## 5. 验证

- 新增 `backend/tests/p9-tts-unified.test.ts` 12 项正式测试，使用本机假统一协议服务：
  - 能力探测、路径前缀、未就绪不取音色列表和协议错误；
  - 克隆试听上传受管参考音频，校验 `mode`、`reference_mode`、文件字节、语言和语速；
  - 需要原文的模式缺文本返回 400，补齐后试听与按句合成携带同一原文；旁白跳过；
  - 预置音色试听与按句合成只传 `voice_id`，不要求参考音频；
  - 模式、语言、语速、预置能力声明校验和单模式自动选择；
  - 旧行读取、v9 → v10 迁移保留消息／句段／SSE 计数和游标，跨角色素材与跨窗口句段拒绝；
  - 试听草稿不改保存配置，参考文件缺失、服务错误、坏 WAV、超时、取消和不可达；
  - 未声明语言和语速时不发送对应字段。
- 类型检查通过；全量正式测试 253 项、交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T03-37-57-352Z-4f47494c/`。
- 既有 241 项测试未修改断言语义，只同步业务库版本 9 → 10；旧 IndexTTS 接口、WAV 校验和错误映射回归通过。

## 6. 限制与后续

- 未连接真实统一协议服务或 IndexTTS 桥接；两种模式的真实可播放 WAV、服务版本、权重和参数记录仍待联调。
- 预置音色列表只用于探测和界面展示，不写入配置；音色下架时由服务返回错误，桌面配置页尚未实现重新选择提示。
- 未实现服务凭据、音频缓存、流式返回和情绪控制。
- 桌面角色配置页的能力展示、试听上传和对话语音播放待推进；生成过场图尚未开始。
- 本轮为实现方自验，独立复核通过前不提交。

## 7. 222 独立复核 R01～R04 修复

[222 独立复核](222-tts-unified-independent-review.md)确认两种音色模式、v10 迁移和旧协议兼容通过，同时提出四处缺口。本轮只修这四项，并补正式测试。

### 7.1 R01 禁止跟随重定向

- 统一协议的 `/health`、`/voices` 和 `/tts` 请求统一使用 `redirect: "manual"`，不自动访问配置地址以外的目标。
- 合成遇到 3xx 返回 502 `TTS_SYNTHESIS_FAILED`，探测返回 502 `TTS_PROBE_FAILED`，说明为“语音服务返回了重定向，已拒绝跟随”，并主动中止上游连接。
- 测试用一个假服务返回 307 指向第二个假服务，分别覆盖克隆、预置和健康探测；第二个假服务没有收到任何路径、台词、参考音频或原文。[合成请求](../../../backend/src/tts/unified-tts-client.ts#L105) · [探测请求](../../../backend/src/tts/unified-tts-client.ts#L212)

### 7.2 R02 试听候选配置形状

- `POST /voice/preview` 接受 220 文档的 `{text, config}`，`config` 包含地址、协议、音色来源、能力、语言、语速、情绪强度和旧 `referenceAssetId`。
- 既有平铺字段继续可用；`config` 与平铺候选字段同时出现返回 400 `INVALID_REQUEST`。
- 测试覆盖文档形状试听、未保存配置保持 `null`、平铺调用回归和混用拒绝；220 已补充请求示例。[试听校验](../../../backend/src/http/voice-routes.ts#L44)

### 7.3 R03 服务切换和素材变更

- 服务地址或协议变化时，不再继承旧服务的预置 `voiceId` 或参考模式。仅保存新地址且原来源为预置音色时返回 400 `VOICE_SOURCE_REQUIRED`，要求重新选择；原来源为参考音色时保留素材和原文、清空参考模式。
- 参考原文只在参考素材未变时继承；换另一份录音时清空旧原文，模式仍要求原文时返回 400 `VOICE_REFERENCE_TEXT_REQUIRED`，补填后试听与保存使用新原文。
- 同一服务、同一素材的部分编辑仍继承已有模式和原文。保存与试听草稿共用该合并规则。[来源合并](../../../backend/src/application/voice-service.ts#L564) · [字段继承](../../../backend/src/application/voice-service.ts#L658)

### 7.4 R04 语言代码和语速范围

- 统一协议的语言改为服务声明的语言代码：2–8 位主标签加可选子标签，如 `ko`、`en-US`；不再限制在旧五项。空列表仍表示由服务决定且界面隐藏选择。
- 语速请求放宽到 0.1–10，实际保存和合成按 `capabilities.speed` 声明校验并夹取；探测、设置和合成使用同一组参数。
- 旧 IndexTTS 协议独立保留 `zh`、`en`、`ja`、`es`、`ar` 和 0.5–2 的限制；220 已明示两套规则。[语言声明](../../../backend/src/domain/voice-capabilities.ts#L4) · [参数校验](../../../backend/src/application/voice-service.ts#L773)

### 7.5 验证

- `p9-tts-unified.test.ts` 从 12 项增至 17 项，新增重定向、`config` 形状、服务切换重新选择、换素材清空原文和声明语言／语速用例。
- 类型检查通过；全量正式测试 258 项、交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T03-55-58-751Z-e5eb3ae6/`。
- 四处修复仍待独立复验，复核通过前不提交。

## 8. 222 补充复验 R03／R04 修复

[222 补充复验](222-tts-unified-independent-review.md#221-第-7-节修复独立复验)确认 R01、R02 关闭，R03、R04 各有一个扩展用例未通过。

### 8.1 R03 补充：切换服务不自动绑定单模式

- 保存时原先只要目标服务声明一个参考模式就自动补选；现在切换服务地址或协议时不再使用该快捷选择，保存的参考模式保持为空，需要用户明确提交新模式。
- 首次配置和同一服务内的单模式快捷选择保留；合成时也不再根据单模式静默补选，未确认模式的已保存配置在试听或按句合成时返回 400 `VOICE_REFERENCE_MODE_REQUIRED`。
- 测试覆盖：绑定服务 A 后只向 B 提交地址和单模式能力，保存返回 200 但 `referenceMode` 为空；随后保存配置试听返回 `VOICE_REFERENCE_MODE_REQUIRED`，B 未收到请求；显式选择 B 的模式后试听成功。[单模式快捷](../../../backend/src/application/voice-service.ts#L699) · [模式校验](../../../backend/src/application/voice-service.ts#L499)

### 8.2 R04 补充：语速声明下限统一为 0.1

- `capabilities.speed` 的 `min` 和 `max` 都限制在 0.1–10；声明 0.05 的低值按协议错误拒绝，0.1 边界可探测、保存并试听。
- 测试覆盖：`0.05–3` 的声明返回 502 `TTS_PROTOCOL_INVALID`，`0.1–3` 的声明返回 200，按 0.1 保存后试听请求携带 `speed=0.1`。[能力范围](../../../backend/src/domain/voice-capabilities.ts#L30)

### 8.3 验证

- `p9-tts-unified.test.ts` 增至 18 项；类型检查通过；全量正式测试 259 项、交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T05-33-57-788Z-e6226d55/`。
- 两项补充修复仍待独立复验，复核通过前不提交。

## 9. 222 再次补充复验 R03／R04 修复

[222 再次复验](222-tts-unified-independent-review.md#221-第-8-节补修独立复验)确认上一轮两个原用例通过，同时发现模式确认状态未持久化、语速范围未校验是否包含默认 1.0。

### 9.1 R03 补充：持久化参考模式确认状态

- 业务库升级到 v11，`role_voice_settings` 增加 `reference_mode_confirmed`，旧行默认已确认。
- 切换服务地址或协议时，未显式选择参考模式的保存写入未确认状态；后续只修改语速、语言等无关字段仍保持未确认，不会按单模式自动补选。
- 首次配置、已确认配置和同一服务内的单模式快捷选择继续可用；显式提交模式后恢复已确认。
- 试听和按句合成在模式未确认时均返回 400 `VOICE_REFERENCE_MODE_REQUIRED`，不向上游派发请求；显式选择后两者恢复正常。[确认状态解析](../../../backend/src/application/voice-service.ts#L711) · [快捷选择条件](../../../backend/src/application/voice-service.ts#L169) · [v11 迁移](../../../backend/src/storage/schema.ts#L1192)
- 测试覆盖：换到单模式服务后保存地址和能力，再单独保存 `speed`，模式仍为空；试听和按句合成均被拒绝且目标服务收到 0 次请求；显式保存模式后按句合成成功。

### 9.2 R04 补充：语速范围必须包含 1.0

- 能力声明的语速范围在 0.1–10 内且必须包含默认语速 1.0；`2.0–3.0` 等范围按协议错误拒绝，探测返回 502 `TTS_PROTOCOL_INVALID`。
- 测试覆盖：`0.05–3` 与 `2–3` 均被拒绝，`0.1–3` 可探测，0.1 和 2.5 均可保存并试听。[能力范围校验](../../../backend/src/domain/voice-capabilities.ts#L64)

### 9.3 验证

- `p9-tts-unified.test.ts` 扩展两项现有用例；类型检查通过；全量正式测试 259 项、交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T05-49-32-650Z-c5f58f6c/`。
- 两项补充修复仍待独立复验，复核通过前不提交。

## 10. 222 v11 迁移补充修复

[222 第 9 节复验](222-tts-unified-independent-review.md#221-第-9-节补修独立复验)确认 v11 正常保存路径和 R04 语速范围通过，同时发现 v10 升级会把待确认行视为已确认。

### 10.1 R03 补充：v10 待确认行保持未确认

- v11 迁移在新增列后按行状态回填：`protocol='nowadays-tts-v1'`、`voice_source='reference'` 且 `reference_mode IS NULL` 的行无法证明模式已确认，迁移后标记为未确认。
- 已绑定参考模式、旧 IndexTTS 协议和统一协议预置音色的行保持已确认。
- 迁移后的待确认配置只保存语速、语言等无关字段仍不会自动绑定单模式；试听和按句合成继续返回 400 `VOICE_REFERENCE_MODE_REQUIRED`，显式选择模式后恢复。[v11 迁移](../../../backend/src/storage/schema.ts#L1192) · [快捷选择条件](../../../backend/src/application/voice-service.ts#L169) · [确认状态解析](../../../backend/src/application/voice-service.ts#L711)
- 测试构造实际 v10 形态：待确认行与已绑定模式行分别降级到 v10 再打开，确认状态分别为 0 和 1；待确认行连续保存 `speed` 后模式和确认状态不变，试听被拒绝且目标服务收到 0 次请求，显式选择后恢复。v9 迁移用例同时确认旧协议行升级为已确认。

### 10.2 验证

- `p9-tts-unified.test.ts` 增至 19 项；类型检查通过；全量正式测试 260 项、交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T05-57-58-306Z-e6091440/`。
- 迁移修复仍待独立复验，复核通过前不提交。

## 11. 222 上一版 v11 迁移回填

[222 第 10 节复验](222-tts-unified-independent-review.md#221-第-10-节迁移补修独立复验)确认直接从 v10 升级的待确认行会保持未确认，同时发现已被上一版 v11 迁移过的库不会再次执行回填。

### 11.1 R03 补充：已升级到 v11 的待确认行重新回填

- 业务库升级到 v12。v11 只新增 `reference_mode_confirmed` 列并默认已确认；v12 把 `protocol='nowadays-tts-v1'`、`voice_source='reference'` 且 `reference_mode IS NULL` 的行统一改为未确认。
- 直接从 v10 升级会依次执行 v11、v12；上一版 v11 迁移过的库在下次打开时执行 v12 修复。已绑定参考模式、显式确认的行和旧 IndexTTS 行不受影响。[v12 迁移](../../../backend/src/storage/schema.ts#L1198) · [快捷选择条件](../../../backend/src/application/voice-service.ts#L169) · [确认状态解析](../../../backend/src/application/voice-service.ts#L711)
- 测试构造上一版 v11 形态：待确认行的 `reference_mode_confirmed=1`、`user_version=11`，重开库后确认状态变为 0。只保存 `speed:1.4` 后模式仍为空，试听返回 400 `VOICE_REFERENCE_MODE_REQUIRED`，目标服务收到 0 次请求；显式选择 `clone-b` 后恢复合成。已绑定模式行保持 `clone-b` 和已确认。

### 11.2 验证

- `p9-tts-unified.test.ts` 增至 20 项；类型检查通过；全量正式测试 261 项、交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T06-20-20-818Z-6f13967c/`。
- 迁移修复仍待独立复验，复核通过前不提交。
