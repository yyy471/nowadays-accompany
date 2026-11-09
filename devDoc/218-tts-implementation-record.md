# TTS 与角色音色首轮实施记录

2026-11-09，`dev-front` 工作树，基线 `8d6dd08`。按 [213](213-conversation-performance-backend-plan.md) 的第二部分实现角色音色、试听与按句合成，首个真实适配为 IndexTTS 本地 HTTP。工作树未提交、未推送；未调用真实 TTS 服务，离线验证使用本机假 IndexTTS 服务。

## 1. 范围与引擎决定

- 用户确认首个 TTS 引擎为 IndexTTS 本地 HTTP，沿用参考项目 AnimaVN 的小服务契约：`GET /health` 返回就绪状态，`POST /tts` 接收合成参数并直接返回 `audio/wav`。
- 本轮完成后端契约、存储和离线验证；桌面播放入口、角色配置页试听和情绪控制未包含。
- 参考音频导入为 Nowadays 受管文件；合成请求把该文件的绝对路径作为 `spk_audio_path` 传给语音服务，因此本轮要求语音服务能读取本机路径。跨机共享目录或上传参考音频到远端服务未实现。

## 2. 数据与存储

业务库升级到 v9，新增两张表：

| 表 | 用途 |
| --- | --- |
| `voice_assets` | 角色参考音频的受管记录：素材编号、文件名、媒体类型、相对路径、创建时间 |
| `role_voice_settings` | 每角色一行音色配置：引擎、服务地址、当前参考音频、语言、语速、情绪强度、创建与更新时间 |

- 参考音频写入 `<app-data>/roles/<roleId>/voice/<assetId>.<ext>`，轮换参考音频时新增素材记录，不覆盖旧文件；本轮不提供删除接口。
- 接受 WAV、MP3、FLAC、OGG，按文件头识别；单个文件上限 32 MiB，空文件和不支持的格式返回 400。
- `RolePaths` 增加 `voiceDir`，新角色初始化时创建；旧角色在首次导入时按需创建，不改变既有目录校验。
- 数据结构变更遵循既有迁移链：v8 → v9 只新增表和索引，历史消息、句段、事件编号和负载不变。

## 3. HTTP 契约

| 路由 | 行为 |
| --- | --- |
| `GET /v1/roles/:roleId/voice` | 返回 `{voice}`，未配置时为 `null`；包含引擎、服务地址、参考素材元数据、语言、语速与情绪强度 |
| `PUT /v1/roles/:roleId/voice` | 保存服务地址、参考素材、语言、语速和情绪强度；省略参考素材时保留原绑定，传 `null` 清空 |
| `POST /v1/roles/:roleId/voice/reference` | `multipart/form-data` 字段 `file` 导入参考音频，返回 `{reference}` 和 201 |
| `POST /v1/roles/:roleId/voice/preview` | 传入试听文本，可用 `baseUrl`／`referenceAssetId`／`language`／`speed`／`emoAlpha` 临时覆盖已保存配置；直接返回音频字节 |
| `POST /v1/roles/:roleId/windows/:windowId/segments/:segmentId/speech` | 按句段合成；句段必须属于该角色窗口且类型为台词，旁白返回 400 `VOICE_SEGMENT_NOT_SPEAKABLE` |

- 试听与按句合成共用同一个适配器和参考音色，试听不落库。
- 未配置服务返回 400 `VOICE_NOT_CONFIGURED`；没有参考音色返回 400 `VOICE_REFERENCE_REQUIRED`；参考素材或文件缺失返回 404。
- 句段不存在返回 404 `MESSAGE_SEGMENT_NOT_FOUND`；语言、语速（0.5～2）和情绪强度（0～1）在服务层校验。
- 音频响应带 `Cache-Control: no-store`，本轮不做合成缓存。

## 4. IndexTTS 适配

- 请求 `POST {baseUrl}/tts`，JSON 字段为 `text`、`lang`、`spk_audio_path`、`emo_audio_path: null`、`emo_vector: null`、`emo_alpha` 和 `duration_factor`。
- `duration_factor = clamp(1 / speed, 0.5, 2.0)`，保留三位小数；`lang` 使用配置的语言代码。
- 本轮不传情绪参考或情绪向量，音色语气由参考音频决定；表情与 TTS 的联动留待后续工作包。
- 服务返回非 2xx 时读取 `{detail}`，映射为 502 `TTS_SYNTHESIS_FAILED`；连接失败为 503 `TTS_SERVICE_UNAVAILABLE`；超时为 504 `TTS_TIMEOUT`；调用方取消为 499 `TTS_CANCELED`。非音频响应和空音频按 502 处理。
- 单次合成默认超时 90 秒，可通过服务选项缩短，用于测试冷启动。
- 试听与按句合成把 HTTP 请求的中断信号传给适配器；客户端断开时终止在途合成，避免继续占用本地推理服务。

## 5. 验证

- 新增 `backend/tests/p8-voice.test.ts` 7 项正式测试，使用本机假 IndexTTS HTTP 服务：
  - v9 表、音色配置与参考音频持久化，参考文件落在 `voiceDir`；
  - 试听使用候选配置，请求体包含受管绝对路径、`lang`、`emo_alpha` 和语速换算；
  - 台词句段合成成功，旁白和未知句段分别返回 400／404；
  - 未配置服务和缺少参考音色的错误；
  - 参考音频格式与空文件校验；
  - 服务 500、非音频、连不上、超时和取消的错误映射；
  - 语速换算边界与音频文件头识别。
- 类型检查通过；全量正式测试 237 项通过，交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T02-30-29-370Z-1e2725cd/`。
- v9 迁移由现有 v1→当前版本与新建库用例覆盖；AnimaVN 的 v7 样例库需在独立复验时按新版本重跑。

## 6. 限制与后续

- 未调用真实 IndexTTS 服务，未验证真实音色质量、冷启动时延和参考音频解码失败的上游报错。
- 参考音频路径按后端本机绝对路径传递，跨机器部署需要共享路径或后续增加上传接口。
- 未接入情绪参考／八维向量，未做音频缓存，未做流式返回。
- 桌面尚未播放语音，角色配置页尚未提供音色导入与试听。
- 下一步先做独立复核；通过后按 [213](213-conversation-performance-backend-plan.md) 接生成过场图，再接桌面对话的逐段气泡、语音播放和过场图呈现。

## 7. 219 独立复核 R01～R03 修复

[219 首轮独立复核](219-indextts-integration-spec.md#首轮独立复核)确认现有回归、v7→v9 迁移和基本接口通过，同时提出三处缺口。本轮只修这三项，不改变已验证的配置、存储和按句合成行为。

### 7.1 R01 合成成功校验

- 成功响应必须声明 `audio/wav`、`audio/x-wav` 或 `audio/wave`；其他媒体类型按 502 `TTS_SYNTHESIS_FAILED` 拒绝。
- 响应体按流读取并限制为 16 MiB，超过上限时取消读取并报错，不再先完整缓冲再判断。
- 新增 PCM WAV 校验：RIFF/WAVE 头、RIFF 长度、`fmt ` 块（PCM、单/多声道、有效采样率、8／16／24／32 位）、非空 `data` 块，且所有块范围不越界；伪造媒体类型、普通文本、截断 WAV 和空 data 均拒绝。
- [响应校验](../backend/src/tts/indextts-client.ts#L80) · [WAV 校验](../backend/src/application/audio-inspect.ts#L31)

### 7.2 R02 错误响应体的超时和取消

- 错误响应体改为先按大小上限读取再解析 JSON，不再让 `response.json()` 的读取错误落入通用解析兜底。
- 读取错误体时，调用方取消仍返回 `TTS_CANCELED`，总超时仍返回 `TTS_TIMEOUT`；只有完整读到 JSON 或非 JSON 错误体时才用 HTTP 状态兜底生成 `TTS_SYNTHESIS_FAILED`。
- 成功响应体读到一半发生超时的路径保持 `TTS_TIMEOUT`，取消保持 `TTS_CANCELED`。
- [错误体读取](../backend/src/tts/indextts-client.ts#L122)

### 7.3 R03 服务根地址拼接

- 保存 `baseUrl` 时拒绝查询串、片段和 URL 内嵌账号信息；路径前缀允许保留，末尾斜杠归一化。
- 适配器直接按 `baseUrl` 的 `pathname` 拼接 `/tts`，不再依赖相对 URL 解析，`/bridge` 会请求 `/bridge/tts`，不会被查询串吞掉路径。
- [地址校验](../backend/src/application/voice-service.ts#L316) · [路径拼接](../backend/src/tts/indextts-client.ts#L113)

### 7.4 验证

- `p8-voice.test.ts` 增至 10 项：新增非 WAV／伪造媒体类型、截断 WAV、超限响应、错误体超时与取消、路径前缀与查询串／片段拒绝；成功体半读超时并入错误语义用例。
- 类型检查通过；全量正式测试 240 项、交付回归 2 项通过。
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T03-07-27-917Z-ac87b9c6/`。
- 本轮仍未连接真实 IndexTTS 桥接，未实现 `/health` 能力探测和桌面配置页；[220 统一接入说明](220-tts-unified-integration.md) 属于后续 DL-140 工作包，尚未实施。三处修复待独立复验，复核通过前不提交。

### 7.5 219 补充缺口修复

[219 复验与补修](219-indextts-integration-spec.md#218-第-7-节修复复验及补修)确认 R01～R03 原复现路径通过，同时提出三处边界缺口，本轮补齐：

- **WAV 帧与格式字段**：`isPcmWav` 校验 RIFF 块边界、`fmt ` 的 PCM 格式、声道、采样率、位深、`byteRate` 与 `blockAlign` 的一致性，以及 `data` 长度按完整音频帧对齐。16 位单声道仅 3 个数据字节、错误字节率和错误帧宽均拒绝；奇数长度的元数据块按 RIFF 填充规则仍可读取。[WAV 校验](../backend/src/application/audio-inspect.ts#L31)
- **错误媒体类型的连接收尾**：成功状态但媒体类型不是 WAV 时，客户端先中止上游请求再抛出 502，假服务能观察到连接关闭，不再等客户端超时。[媒体类型拒绝](../backend/src/tts/indextts-client.ts#L81)
- **空查询串和空片段**：`baseUrl` 以 `?` 或 `#` 结尾时 URL 的 `search`／`hash` 为空字符串，原校验会放行；现改为检查序列化地址中的分隔符，空查询串和空片段同样按 `VOICE_BASE_URL_INVALID` 拒绝。[地址校验](../backend/src/application/voice-service.ts#L333)

验证：`p8-voice.test.ts` 11 项通过，覆盖媒体类型拒绝后的连接关闭、空 `?`／`#` 和带奇数长度填充元数据块的有效 WAV；类型检查通过；全量正式测试 241 项、交付回归 2 项通过；统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0，运行目录为 `backend/test-results/p5-2026-11-09T03-20-24-682Z-0d76318a/`。补修仍待独立复验，复核通过前不提交。
