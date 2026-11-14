# 首版 IndexTTS 接入规范与独立复核

> **现行规范入口**：IndexTTS 本机桥接兼容边界、TTS 统一协议与验证范围已整理至 [TTS 与生图服务接入规范](../../specs/tts-and-image-services.md)；下文保留首版接入与独立复核历史。

2026-11-09，`dev-front` 工作树。首个语音引擎为 IndexTTS，见 [DL-139](../../161-digital-life-direction-decisions.md#dl-139-首版-tts-采用-indextts)。以下以 IndexTTS 2.5 和本机 HTTP 桥接为工程建议，与 [218](218-tts-implementation-record.md) 当前字段兼容。推理版本和权重以实际联调验收记录为准。

## 部署与角色配置

| 层级 | 首版约定 |
| --- | --- |
| 推理服务 | 推荐在 Nowadays 同一台机器独立运行 Python 桥接，默认地址示例 `http://127.0.0.1:9890`。记录桥接版本、IndexTTS 源码版本、权重版本、模型目录和设备。桥接启动时加载一次模型，同一实例串行推理 |
| 服务地址 | 角色配置页可预填本机默认地址，保存字段沿用 `baseUrl`。填服务根地址，桥接的 `/health` 和 `/tts` 由客户端拼接；路径前缀如有需要显式支持，查询串和片段在保存时拒绝 |
| 参考音色 | 一名角色绑定一份参考音频。上传后由后端保存为受管文件，界面保存 `referenceAssetId` 并展示原文件名。优先使用清晰、单人、无背景音的 WAV，建议截取不超过 15 秒的代表性片段。当前后端还识别 MP3、FLAC、OGG 文件头，文件上限 32 MiB；可用格式以桥接实际解码结果为准。只需音频 |
| 语言与语速 | 中文默认 `zh`、语速默认 `1.0`，允许 `0.5–2.0`。桥接接收 `zh`、`en`、`ja`、`es`、`ar` 并转换为推理语言代码。`duration_factor` 取语速倒数，如语速 `1.25` 对应 `0.8` |
| 试听 | 设置页提供测试文本和试听按钮。试听使用未保存的候选参考音色、语言、语速和地址，直接返回音频，保存配置由单独操作完成。参考音频先导入，试听本身不写配置 |
| 情绪 | 首版沿用音色参考的语气。现有协议保留 `emoAlpha`，首版界面可隐藏该字段，等独立的情绪参考或向量接入再开放。IndexTTS 2.5 当前源码在无独立情绪参考和向量时使用说话人参考，内部将强度设为 1 |

建议选择 2.5 是为了与 AnimaVN 既有语言和语速参数对齐。官方 Python API 的 2.5 示例提供 `spk_audio_prompt`、`lang` 与 `duration_factor`。`/health` 和 `/tts` 来自 AnimaVN 的桥接约定。 [IndexTTS 官方 Python API](https://github.com/index-tts/index-tts#-python-api) · [官方 2.5 推理源码](https://github.com/index-tts/index-tts/blob/main/indextts/infer_v2_5.py) · [本地 AnimaVN 桥接规范](<E:/tmp/testWorkSpace/AnimaVN-main/docs/superpowers/specs/2026-09-24-indextts-engine-design.md>)

## 桥接与应用接口

- `GET /health` 返回 `{"model":"IndexTTS-2.5","ready":true}`，加载期间返回 `ready:false`。设置页用它区分连不上和还在加载，试听验证参考文件和实际推理。
- `POST /tts` 接收 JSON，必需字段为 `text`、`lang`、`spk_audio_path`、`duration_factor`。首版兼容发送 `emo_audio_path:null`、`emo_vector:null`、`emo_alpha:1`。桥接将 `spk_audio_path` 映射为 Python 的 `spk_audio_prompt`，校验路径落在约定的角色音色目录并可解码。由于传的是绝对路径，两个进程需要看到同一条路径。成功为 `200 audio/wav` 和可播放的 WAV 字节，失败返回 JSON `detail`。桥接处理排队请求的取消，已经进入推理的取消能力以实测为准。
- 客户端对同一桥接控制并发，避免多段和试听同时挤占单实例；关闭或切换窗口时停止本次等待和播放，语音失败时正文仍可读。当前后端默认总超时 90 秒，首轮验收应记录冷启动和热合成时间。

以下路径均以 `/v1/roles/:roleId` 开头，已在当前后端实现。

| 路径 | 用法 |
| --- | --- |
| `GET /voice`、`PUT /voice` | 读取与保存角色音色配置。`PUT` 省略 `referenceAssetId` 保留现有绑定，传 `null` 清空 |
| `POST /voice/reference` | 上传 `multipart/form-data` 的单个 `file`，返回受管素材 ID |
| `POST /voice/preview` | `text` 加候选配置覆盖已保存字段，直接返回音频 |
| `POST /windows/:windowId/segments/:segmentId/speech` | 后端自行读取该窗口的句段文本和已保存的音色。只合成 `speech`，直接返回音频 |

## 首轮独立复核

已实现角色音色、参考音频导入、候选试听、按段合成及 v9 存储。统一离线验收 21／21 步、237 项正式测试及 2 项交付回归通过，`sourceUnchanged=true`，真实服务调用 0。构造的 v7 样例库升级到 v9 后，历史正文、事件 ID 4 和 9 及负载保留，新事件 ID 为 10，两张音色表存在。现有工作树只有 TypeScript 客户端和假服务，真实桥接、`/health` 探测及桌面配置页未接入。现有回归通过，新增缺口和真实联调待验收，首轮 TTS 暂未通过独立复核。

| 项目 | 复现与验收条件 |
| --- | --- |
| R01 合成成功校验 | 上游返回 `200 audio/wav` 加普通文本，适配器将文本作为音频成功返回。应对照 WAV 契约校验有效响应并限制缓冲大小，拒绝伪造媒体类型或损坏内容。 [响应校验](../../../backend/src/tts/indextts-client.ts#L60) |
| R02 错误响应的超时和取消 | 上游先发出 HTTP 500 和半截 JSON 后停住，实际超时和主动取消都被错误归类为 `TTS_SYNTHESIS_FAILED`。成功响应体读到一半超时的对照用例能返回 `TTS_TIMEOUT`。应让读取错误响应体也保留 504 超时和取消语义。 [错误体解析](../../../backend/src/tts/indextts-client.ts#L99) |
| R03 服务根地址校验 | 当前保存校验接受查询串。`baseUrl` 形如 `/bridge?name=x` 时，适配器实际请求 `/tts`，丢掉 `/bridge`。首版根地址应拒绝查询串、片段，允许路径前缀时应验证 `/bridge/tts` 的拼接结果。 [根地址校验](../../../backend/src/application/voice-service.ts#L316) · [路径拼接](../../../backend/src/tts/indextts-client.ts#L95) |

独立样例与结果在 `backend/test-results/review-218-tts/`，统一离线报告在 `backend/test-results/p5-2026-11-09T02-35-13-984Z-0af668d9/summary.json`。真实接入的验收应使用可启动的桥接、同一份参考音频，依次验证健康状态、候选试听、保存后的按段语音、旁白跳过，以及切换窗口时取消等待。应记录服务版本、权重、实际语言与语速效果、冷启动时间和正常合成时间。本轮只更新文档，业务代码和正式测试未改，未提交或推送。

## 218 第 7 节修复复验及补修

2026-11-09，`dev-front` 工作树。用本机 HTTP 假服务复验 [218 第 7 节](218-tts-implementation-record.md#7-219-独立复核-r01r03-修复)。伪造 WAV 被拒绝，错误体读到一半的超时与主动取消分别返回 `TTS_TIMEOUT`、`TTS_CANCELED`，有路径前缀的服务实际收到 `/bridge/tts`。R01～R03 的原复现路径通过。

| 补充用例 | 补修前 | 补修和定向自验结果 |
| --- | --- | --- |
| WAV 音频帧与格式字段 | 对 16 位单声道输出构造含 3 个数据字节的 WAV，帧尾缺 1 个字节却合成成功；错误的字节率和帧宽字段也被接受 | 校验 RIFF 块边界、格式字段一致性及 `data` 帧对齐，异常 WAV 返回合成失败。带奇数长度且正确填充的元数据块仍可读取 |
| 错误媒体类型的连接收尾 | 上游发送 `200 text/plain` 和未结束的响应体，应用已拒绝合成，上游连接在客户端超时长度之后仍未关闭 | 拒绝时主动中止上游请求，假服务实际收到连接关闭事件 |
| 空查询串和空片段 | 地址使用尾随 `?` 或 `#` 时，URL 解析结果的查询串和片段属性为空，保存校验会放行 | 校验序列化地址中的分隔符，空查询串和空片段也按 `VOICE_BASE_URL_INVALID` 拒绝 |

独立样例位于 `backend/test-results/review-218-tts/probe-218-repair.mts`，前后结果分别为 `result-218-before.json` 和 `result-218-after.json`。专项测试 `p8-voice.test.ts` 的 11 项通过。统一离线验收 21／21 步、241 项正式测试及 2 项交付回归通过，`sourceUnchanged=true`，真实服务调用 0。报告位于 `backend/test-results/p5-2026-11-09T03-13-58-619Z-147c8b64/summary.json`。原复现路径的复验与本轮补修自验分别记录，补修仍待独立复验。真实桥接、预置音色和 [220 统一协议](220-tts-unified-integration.md) 未进入此次复验。

## 补修独立复验

2026-11-09，`dev-front` 工作树。相对上次补修验收的源码清单，复核基线的业务源码未变化，`p8-voice.test.ts` 增加了带填充的奇数长度元数据块用例。使用本机 HTTP 假服务重跑原复现与扩展样例。

| 项目 | 独立复验结果 |
| --- | --- |
| R01 WAV 响应和连接收尾 | 普通文本、残缺音频帧、错误字节率及帧宽均被拒绝。带正确填充的元数据块与 8／16／24／32 位 PCM 样例能完整返回，包含奇数长度 8 位数据和双声道 24 位样例。上游保持错误媒体类型的响应体开启时，实际观察到连接关闭 |
| R02 超时与取消 | 上游错误响应体只写出一部分时，等待超时返回 `TTS_TIMEOUT`，主动取消返回 `TTS_CANCELED` |
| R03 根地址 | 通过角色配置 HTTP 接口提交 `?`、`#`、`?q=x` 和 `#t`，均返回 400 `VOICE_BASE_URL_INVALID`。含编码字符的合法前缀可保存，实际合成请求保留 `/edge%23voice/tts` |

Node.js 24.22.2 下统一离线验收 21／21 步、241 项正式测试及 2 项交付回归通过，`sourceUnchanged=true`，真实服务调用 0。R01～R03 及补修在已验范围关闭。报告位于 `backend/test-results/p5-2026-11-09T03-24-38-724Z-a087592c/summary.json`。

样例和输出保存在 `backend/test-results/review-218-tts/` 下的 `probe-218-followup.mts`、`result-218-rerun.json` 与 `result-218-followup.json`。本轮仅补复验记录和导航，业务代码及正式测试未改，未提交或推送。真实桥接与 [220 统一协议](220-tts-unified-integration.md) 仍需对应工作包验证。
