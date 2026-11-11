# 角色语音启停独立复核

2026-11-10。复核 `57a7c04` 之后 [246](246-role-voice-toggle.md) 的工作区改动，范围为 [DL-149](161-digital-life-direction-decisions.md#dl-149-角色语音只保留当前一份配置)。后端启停与单份配置契约在已验范围通过。桌面端有两项问题，本轮未通过整体验收。

## 1. VT-R01 · P2 · 旧语音响应让新角色或窗口停止自动播放

在浏览器挂起角色甲的预取请求，切换到已启用语音的角色乙后释放甲的 `409 VOICE_DISABLED`。乙的新句自动播放没有发出请求，手动点播同一句才发出请求并恢复播放。在同一角色从旧窗口切到新窗口，旧窗口的停用响应也会让新窗口跳过预取。

切换角色或窗口时 `releaseAll` 会清状态并递增 `cacheGeneration`，成功响应会检查代际，但 `VOICE_DISABLED` 分支未检查就改写共用 `voiceDisabled`。旧请求应在代际失效时直接退出，再处理当前范围的停用结果。 [停用响应处理](../desktop/desk-preview/renderer/src/conversation/use-segment-voice.ts#L160)

## 2. VT-R02 · P2 · 保存旧响应覆盖已确认的停用状态

在声音设置页点击停用，挂起启停请求后点击仍可用的「保存声音配置」。让保存先写入并暂留返回的启用快照，再执行停用并返回，使勾选框取消。最后放行旧保存响应。页面重新勾选「启用角色语音」，后端状态仍为停用。SQLite 的两项写入互不覆盖，偏差发生在界面采用旧保存快照时。

建议让保存和启停双向互斥，同时约束按钮和处理函数。验收需覆盖启停未完成时点击保存，以及保存未完成时点击启停。 [保存状态更新](../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx#L255) · [保存按钮](../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx#L455)

## 3. 独立验证范围

浏览器使用模拟接口和音频。当前窗口收到 `VOICE_DISABLED` 后，后续自动播放静默跳过，手动点播提示一次停用原因。两项缺口均可复现，结果位于 `backend/test-results/review-246/review-246.json`。桌面 89 项测试、类型检查及生产构建通过。真实 TTS 服务与桌面实际声音输出待联调。

后端类型检查、302 项正式测试及 21 步离线验收通过。覆盖旧语音记录迁移、停用时拒绝新句段合成且不调用语音服务、仍可试听、保存新音色仍停用及启用后恢复合成。验收目录为 `backend/test-results/p5-2026-11-10T09-03-18-706Z-2d73bd72/`，`realServiceCalls=0`、`sourceUnchanged=true`。 [语音启停回归](../backend/tests/p9-tts-unified.test.ts#L566)

## 4. 249 补修独立复验

2026-11-10。VT-R01、VT-R02 在已验离线范围关闭。

| 编号 | 独立复验 |
| --- | --- |
| VT-R01 | 切角色和同角色切窗口后，再放行旧请求的 `409 VOICE_DISABLED`。新角色的自动播放和新窗口的预取各发出 1 个请求。真实停用的模拟响应仍会静默跳过后续自动请求，手动点播提示原因。 |
| VT-R02 | 挂起启停时保存按钮禁用且保存请求数为 0；挂起保存时启停按钮禁用且启停请求数为 0。操作结束后，界面和模拟存储均保持停用。 |

桌面 97 项测试、类型检查和生产构建通过。浏览器证据位于 `backend/test-results/review-249/review-249.json`，使用模拟接口及音频替身。真实 TTS 联调待验。
