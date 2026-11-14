# TTS 统一接入说明

> **现行规范入口**：`nowadays-tts-v1` 协议契约、参考／预置双音源与参数确认规则的现行权威版本已并入 [TTS 与生图服务接入规范](../../specs/tts-and-image-services.md)；下文保留接入背景与示例说明。

2026-11-09。面向 Nowadays 开发者和语音服务接入方，覆盖 [DL-140](../../161-digital-life-direction-decisions.md#dl-140-tts-统一接入音色克隆与预置音色) 的两种音色来源。协议字段、默认值和迁移步骤是待实施的工程约定；2026-11-09 已按 [221](221-tts-unified-implementation.md) 完成首轮后端实施，真实服务联调待验收。首轮后端的已有能力和独立复核结论分别见 [218](218-tts-implementation-record.md)、[219](219-indextts-integration-spec.md)。

## 1. 用户怎样接入

统一流程为 **填写服务地址 → 绑定音色 → 输入文本试听 → 保存给角色使用**。地址填写服务根地址，例如 `http://127.0.0.1:9890`。一个服务可以提供任一模式，也可以同时提供两种。配置页按服务声明的能力显示选项。

| 模式 | 配置时需要提供 | 正式合成时系统传递 |
| --- | --- | --- |
| 音色克隆 | 上传参考音频。所选模式要求参考原文时，填写音频中实际说的话 | 台词、已绑定的参考音频、按需附带参考原文，以及服务支持的语言和语速 |
| 预置音色 | 从服务返回的列表选择一个音色 | 台词、所选音色 ID，以及服务支持的语言和语速 |

试听文本是这次想听到的话，参考原文是参考录音中已经说过的话。试听用配置草稿，保存后按句段合成用角色已保存的配置。两条路径共用同一个音色解析和合成入口，直接返回音频。旁白默认跳过，语音失败时台词仍可阅读。

## 2. 责任划分

| 组件 | 职责 |
| --- | --- |
| Nowadays | 保存角色绑定和受管参考音频，从句段读取台词，传入本次合成参数，处理超时、取消和播放归属 |
| TTS 服务或桥接 | 声明支持的能力、列出预置音色，把统一请求转换为实际推理参数，将结果封装成可播放的 WAV |
| 推理模型 | 根据传入参数生成音频。权重、模型目录和设备属于服务部署配置 |

服务已实现下述协议时，Nowadays 可直接配置地址。已有服务使用其他接口时，在其前面加一层桥接即可。单机与跨机均使用相同请求格式，参考音频通过请求上传。现有按本机绝对路径读取文件的接法作为旧协议兼容路径保留。

## 3. 服务方适配规范

### 3.1 地址和能力发现

- `baseUrl` 可以包含路径前缀，例如 `https://speech.example.com/local-tts`，此时健康地址为 `/local-tts/health`。保存时拒绝查询串、片段和 URL 内嵌的账号信息。服务凭据如有需要，通过受管连接配置或桥接部署提供。
- `GET /health` 返回 HTTP 200 与以下 JSON。`ready=false` 表示服务可达但还在加载，配置页可据此提示等待。`protocol` 用于确认接入契约，服务和模型名称用于诊断。

```json
{
  "protocol": "nowadays-tts-v1",
  "service": "Local speech",
  "model": "deployment-name",
  "ready": true,
  "capabilities": {
    "referenceModes": [
      { "id": "clone", "label": "参考音频", "requiresReferenceText": false }
    ],
    "presetVoices": true,
    "languages": ["zh", "en"],
    "speed": { "min": 0.5, "max": 2.0 }
  }
}
```

- `referenceModes` 为空时表示没有音色克隆入口。每个参考模式的 `id` 在该部署内稳定，`requiresReferenceText` 决定是否显示和校验参考原文。只有一个参考模式时，首次配置或同一服务内可以快捷选择；切换服务后需要用户明确确认新模式，不能自动沿用或补选。未确认状态会随配置保存保留，直到用户显式选择模式。
- `presetVoices=true` 时提供 `GET /voices`，返回 `{"voices":[{"id":"speaker-01","label":"示例音色"}]}`。`id` 是该服务内稳定且可用于合成的标识。列表只包含当前部署实际能合成的音色。
- `languages=[]` 表示语言由服务处理，界面隐藏语言选择。语言代码为 2–8 位主标签加可选子标签（如 `zh`、`en`、`ko`、`en-US`），Nowadays 按声明保存和传递。`speed=null` 表示服务使用自然语速，界面隐藏语速控件。语速范围由 `capabilities.speed` 声明，必须落在 0.1–10 且包含默认语速 `1.0`，越界或不含 `1.0` 视为协议错误。旧 IndexTTS 路径继续限制语言为 `zh`、`en`、`ja`、`es`、`ar`，语速为 0.5–2。

### 3.2 合成请求

`POST /tts` 接收 `multipart/form-data`。两种模式共用一个入口，每次请求只使用一种音色来源。表单文本采用 UTF-8。

| 字段 | 约定 |
| --- | --- |
| `text` | 两种模式必填。去除首尾空白后须有内容，首版上限 1000 个 Unicode 码点 |
| `mode` | 两种模式必填。`reference` 为音色克隆，`preset` 为预置音色 |
| `reference_mode` | 克隆必填，必须是健康接口声明的参考模式 ID |
| `reference_audio` | 克隆必填。一个参考音频文件，上限 32 MiB。桥接至少支持 PCM WAV；额外格式以服务的实际解码能力为准 |
| `reference_text` | 所选克隆模式要求原文时必填。其他情况省略 |
| `voice_id` | 预置必填，值来自同一个服务的 `/voices` |
| `language` | 可选。提供时必须在声明列表内，省略时由服务决定 |
| `speed` | 可选。用户语速倍数，`1.25` 表示更快。省略时按自然语速，提供时必须在声明范围内 |
| `emotion` | 可选。桥接支持时接收 UTF-8 情绪指令。省略时由服务自行处理，本地桥接会根据台词自动判断 |

```powershell
# 音色克隆。若该模式要求原文，再添加 -F "reference_text=录音中实际说的话"
curl.exe -f -X POST http://127.0.0.1:9890/tts -F "mode=reference" -F "reference_mode=clone" -F "text=今天过得怎么样？" -F "reference_audio=@reference.wav;type=audio/wav" -o preview.wav

# 预置音色。将 speaker-01 替换为当前服务返回的 ID
curl.exe -f -X POST http://127.0.0.1:9890/tts -F "mode=preset" -F "voice_id=speaker-01" -F "text=今天过得怎么样？" -o preview.wav
```

### 3.3 返回与异常

- 成功返回 `200`、`Content-Type: audio/wav` 和单个完整的 PCM WAV。采样率写入 WAV 头，输出须含有效音频数据。首版响应体上限拟定为 16 MiB，客户端即使收不到长度头也应按实际读取量限制。
- 失败返回 JSON `{"code":"REFERENCE_TEXT_REQUIRED","detail":"当前参考模式需要录音原文"}`。参数或模式不匹配返回 400，预置 ID 不存在返回 404，音频过大返回 413，服务忙返回 429，加载中或暂不可用返回 503，推理失败返回 500。认证失败使用 401 或 403。
- Nowadays 默认合成总超时拟定为 90 秒，覆盖排队、推理和完整响应体读取。窗口切换或主动取消时停止本次等待，服务方应跳过尚未开始的排队任务。运行中推理是否能提前结束，以服务实测为准。取消和超时在读取错误响应体时也保持各自语义。

## 4. Nowadays 开发与迁移

### 4.1 应用侧接口

以下路径均以 `/v1/roles/:roleId` 开头，服务侧的 `/health`、`/voices`、`/tts` 只由 Nowadays 后端调用。

| 接口 | 计划行为 |
| --- | --- |
| `POST /voice/probe` | 用候选 `baseUrl` 读取能力和就绪状态，有预置能力且已就绪时取音色列表。探测结果用于设置页，保存另走配置接口 |
| `GET /voice`、`PUT /voice` | 读取和保存服务地址、协议、音色分支及该服务支持的参数 |
| `POST /voice/reference` | 沿用当前的 `multipart/form-data` 单文件导入。应用端保存 `referenceAssetId`，实际合成时后端读取并上传参考文件 |
| `POST /voice/preview` | 用 `text` 和可选的候选 `config` 试听。省略候选配置时用已保存音色，直接返回 WAV |
| `POST /windows/:windowId/segments/:segmentId/speech` | 复用现有路径。后端检查角色与窗口归属、读取台词和已保存音色、直接返回 WAV |

试听请求的候选配置使用 `config` 对象，包含 `baseUrl`、`protocol`、`voiceSource`、`capabilities`、`language`、`speed`、`emoAlpha` 和旧字段 `referenceAssetId`。兼容既有调用时也可把同一组字段平铺在顶层，但两种形状不能同时使用。试听不保存角色配置。

使用统一协议时，试听可在请求顶层传 `emotion`，按段合成可选传 JSON `{"emotion":"温柔"}`。原无请求体调用继续有效。服务按自身支持的风格解释该值，旧直连 IndexTTS 协议沿用 `emoAlpha`。本地桥接 `/health` 可附带 `capabilities.engines` 和 `capabilities.defaultEngine`，通用音色配置只保存公共能力。

```json
{
  "text": "今天过得怎么样？",
  "config": {
    "baseUrl": "http://127.0.0.1:9890",
    "protocol": "nowadays-tts-v1",
    "voiceSource": { "kind": "reference", "referenceAssetId": "asset-01", "referenceMode": "clone" },
    "capabilities": { "referenceModes": [{ "id": "clone", "label": "参考音频", "requiresReferenceText": false }], "presetVoices": false, "languages": [], "speed": null }
  }
}
```

新配置用带类型的 `voiceSource` 区分两类音色。克隆保存 `{"kind":"reference","referenceAssetId":"asset-01","referenceMode":"clone"}`，需要原文时增加 `referenceText`。预置保存 `{"kind":"preset","voiceId":"speaker-01"}`。切换服务时重新确认服务内的预置 ID 和参考模式。角色已导入的参考文件仍可重新选择。

### 4.2 实施顺序

1. 修复 [219 独立复核](219-indextts-integration-spec.md#首轮独立复核) 的 WAV 响应校验、错误体读取的超时／取消、服务地址拼接问题。共用这些处理逻辑。
2. 在 `VoiceService` 的合成边界增加统一协议客户端。保留现有角色权限、受管音频和句段查询，配置页依据服务能力决定显示哪一类输入。
3. 在 v9 后续迁移中扩展角色音色配置，保留旧服务地址、受管素材和引用，将已有配置识别为旧协议的参考音色，已有未绑定草稿也可继续读取。老请求中的 `referenceAssetId` 兼容现有含义，新请求使用 `voiceSource`。迁移应验证历史消息、句段和 SSE 游标可读。
4. 先用本机假服务分别验收两种模式，再各选一个已安装服务联调。已有服务的协议差异放在桥接层。完成后端验收后接角色配置页和桌面对话播放。

### 4.3 最小验收用例

| 用例 | 通过条件 |
| --- | --- |
| 克隆且无需原文 | 上传参考音频后可直接试听。保存后同一角色按句段使用同一个参考素材 |
| 克隆且需要原文 | 缺原文时给出可识别错误。补齐后试听和按段合成均传同一份参考原文与音频 |
| 预置音色 | 只显示服务实际列出的音色。选定后可试听并按段合成。音色下架后提示重新选择 |
| 共同约束 | 试听草稿不改角色已保存配置。旁白跳过，跨角色素材或跨窗口句段被拒绝，晚到音频只交给原窗口的播放上下文 |
| 服务异常 | 覆盖未就绪、坏 WAV、超限、超时、取消以及服务不可达，且原台词仍可读取 |
| 兼容和真实联调 | 旧角色配置及参考文件可继续使用。两种模式各有至少一次可播放 WAV 的真实验收记录，记录服务地址类型、协议和实际支持的参数 |
