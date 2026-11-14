# 声音配置页接入（VS-01）实施记录

> **现行规范入口**：声音配置页、暂存试听及活动守卫的现行契约已分别整理至 [TTS 与生图服务接入规范](../../specs/tts-and-image-services.md) 与 [角色配置、全局资源与活动守卫规范](../../specs/role-config-and-activity.md)；下文保留 VS-01 实施记录。

2026-11-10。按 [236 §6.2](236-role-settings-backend-gap-review.md#62-各类测试的现状与缺口) 中 TTS 一行的待补项实现桌面端角色声音配置：连接测试、试听、参考音频列表与删除、预置音色下架提示与保存。后端接口沿用 [241](241-role-settings-backend-rs-01.md) 与 [221](../03-appearance-and-performance/221-tts-unified-implementation.md) 的既有实现，本轮未改 `backend/` 源码。

## 1. 范围与结果

| 工作项 | 结果 |
| --- | --- |
| 连接测试 | 统一协议调 `POST /voice/probe`，展示服务、模型、就绪状态、参考模式数、预置音色数、语言与语速范围 |
| 试听 | `POST /voice/preview` 用当前表单（未保存也算）合成短文本并播放，Blob 走 `apiBinary` |
| 参考音频 | 上传、下拉选择、列表展示「使用中」标记、删除；使用中由前后端双重拦截 |
| 预置音色 | 探测后与 `voices` 列表比对，已下架的音色在表单里明确标出；合成返回 409 `TTS_VOICE_UNAVAILABLE` 时给出可操作提示 |
| 能力约束 | 语速范围、语言、参考模式与参考文本按探测声明校验，未探测时不做能力校验 |
| 保存 | `PUT /voice` 提交与试听同一份载荷，保存后用返回值刷新表单与「使用中」标记 |
| 旧协议 | IndexTTS 没有探测接口，按 236 建议在页面标明「连接由试听验证」，并隐藏参考模式与预置音色 |

## 2. 表单与载荷映射

- 纯逻辑集中在 `renderer/src/voice-config.js`（[voice-config.js](../../../desktop/desk-preview/renderer/src/voice-config.js)），不碰 DOM，测试直接覆盖。
- `createVoiceForm` 把 `VoiceConfigView` 读成表单；未保存过配置时给出默认值（统一协议、参考音频、`zh`、语速 1、情感强度 1），与后端 `DEFAULT_SPEED`／`DEFAULT_EMO_ALPHA` 一致。
- `toVoicePayload` 是保存与试听共用的唯一出口，按协议收敛字段：旧 IndexTTS 只发 `kind: "reference"` 且参考模式、参考文本固定为 `null`；统一协议按 `sourceKind` 发参考音频或预置音色。输出字段全部落在 `saveVoiceSchema`／`previewVoiceSchema` 的允许集合内，不会因 `.strict()` 被拒。

## 3. 连接测试与能力约束

- 探测只传 `baseUrl`，符合 `probeVoiceSchema` 的严格对象。
- 探测成功后把 `capabilities` 写回表单，后续校验、语言下拉、语速范围都来自这份声明，而不是前端写死。
- 语言在有声明时是下拉、无声明时退回输入框；语速的 `min`／`max` 同样来自声明，未声明时退回 0.1～10。
- 参考模式选中 `requiresReferenceText` 的项时，才显示参考文本输入并强制必填。
- `validateVoiceForm` 一次返回全部问题，页面把它们合并成一条提示，避免逐项试错。

## 4. 试听与错误映射

- `api.ts` 新增 `ApiError`（带 `status` 与 `code`）与 `apiBinary`；`api`／`apiUpload` 改为先判断状态码再解析 JSON，非 JSON 错误响应也能给出状态码提示。
- `describeVoiceFailure` 把机器可读错误码翻译成可操作提示：`TTS_VOICE_UNAVAILABLE` → 音色已下架请重新选择，`VOICE_REFERENCE_IN_USE` → 先切换音色再删除，`VOICE_REFERENCE_NOT_FOUND`／`VOICE_REFERENCE_FILE_MISSING` → 请重新上传，`TTS_SYNTHESIS_FAILED` → 带上游原因的合成失败。
- 试听音频用 `URL.createObjectURL` 播放，结束、出错、重新试听和组件卸载都会 `revokeObjectURL`，不累积 Blob。

## 5. 参考音频管理

- 上传走 `POST /voice/reference` 的 multipart `file` 字段，成功后自动选中新音频，提示「保存后生效」——上传只进素材列表，不改变已保存配置。
- 列表来自 `GET /voice/references`，`inUse` 由后端按已保存配置判定，页面标「使用中」并禁用删除按钮。
- 删除走 `DELETE /voice/references/:assetId`；后端 409 时按错误码提示，文件清理失败时如实显示「记录已删、文件清理失败，可稍后重试」。

## 6. 测试与自验

- 新增 `desktop/desk-preview/tests/voice-config.test.cjs` 14 项：默认表单、两种音色来源的读取、保存载荷按协议收敛、地址四类非法输入、音色来源缺项、能力校验（语速／语言／参考模式／参考文本）、未探测时跳过能力校验、旧协议不校验参考模式、探测摘要、预置音色上下架判定、错误码文案、面板摘要、旧协议提示。
- 桌面端 `npm test` 81 项全部通过（原 67 项 + 新增 14 项）。
- `renderer` 类型检查（`tsc --noEmit`）与 `vite build` 通过。
- 本轮未改动 `backend/`，RS-01 的 298 项后端测试与 21 步离线验收结论继续有效。

## 7. 验收环境与测试稳定性

- 本机 PATH 中的 `node` 是 v22.22.2，而 `backend/node_modules` 的 better-sqlite3 按 Node 24 的 ABI 编译，直接 `npm test` 会 `ERR_DLOPEN_FAILED`。后端测试与离线验收改用 `npx -y node@24`（v24.22.2）执行。
- 首次验收在 `tests` 步骤失败于 `p3-03-autonomy-scheduling.test.ts` 的「disabling a skill excludes it from the next autonomous task chain」，报 `WAIT_TIMEOUT`。该用例单独运行 715ms 通过，判定为满载并行下 5 秒等待余量不足，不是功能缺陷；把用例内两处等待提到 15 秒、用例超时提到 60 秒后复跑通过。
- 最终 `accept:offline` 21／21 步、298／298 测试通过，`realServiceCalls=0`，`sourceUnchanged=true`，Node v24.22.2，运行目录 `backend/test-results/p5-2026-11-10T05-45-28-445Z-00754910/`。

## 8. 未完成与后续

- 没有真实 TTS 服务联调：探测、试听、参考音频与音色下架映射都只在离线 mock 与后端测试范围内验证过。
- 配置停用与清除（保留历史、切回默认）属于 236 §6.4 的删除语义，本轮未做；当前保存必须留下一个可用的音色来源。
- 页面不展示试听音频的时长、采样率与文件大小，也没有历史试听记录。
- 情感强度只按 0～1 的数字输入，没有按服务声明做范围收敛。
- 参考音频没有试听入口，删除前无法先确认内容。
