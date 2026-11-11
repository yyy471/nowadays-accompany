# 247 复核问题修复记录（角色语音启停）

2026-11-10。按 [247 独立复核](247-role-voice-toggle-independent-review.md) 的 VT-R01、VT-R02 修复，范围是 [246](246-role-voice-toggle.md) 的桌面端两处。后端启停与单份配置契约在 247 已通过，本轮未改后端。

## 1. 范围与结论

| 编号 | 问题 | 修法 |
| --- | --- | --- |
| VT-R01 | 旧角色或旧窗口的 `VOICE_DISABLED` 让当前范围停止自动播放 | `catch` 里先按代际丢弃过期响应，再处理当前范围的停用结果 |
| VT-R02 | 保存的旧快照覆盖已确认的停用状态 | 保存与启停共用一把引用锁双向互斥，另加启用状态的写序号兜底 |

两项都落在 `renderer/src`，后端 308 项与离线验收不受影响。

## 2. VT-R01 · 停用响应先按代际丢弃

- **问题成因。** `ensureAudio` 的成功分支会比对 `cacheGeneration`，`VOICE_DISABLED` 的 `catch` 分支没有比对就直接写共用的 `voiceDisabled`。角色甲挂起的 409 在切到角色乙之后返回，乙的页面被标成「已停用」，预取与自动播放一起静默跳过；同一角色换窗口也是同一条路径。
- **修法。** `catch` 里第一句先判代际：`if (cacheGeneration.current !== generation) return null;`，过期响应既不写标记也不提示，直接退出。代际由 `releaseAll` 在切换角色、切换窗口与卸载时递增，三条路径一次覆盖。[use-segment-voice.ts](../desktop/desk-preview/renderer/src/conversation/use-segment-voice.ts)
- **语义不变。** 停用是配置状态而非故障：当前范围命中后预取与自动播放静默跳过，手动点播提示一次「角色语音已停用」。手动点播仍先清标记再请求，保留显式重试的语义。

## 3. VT-R02 · 保存与启停双向互斥

- **问题成因。** 两处写入各自防重入（`busy`、`toggleBusy`），彼此不阻塞；保存回来又无条件 `setConfig(result.voice)`。于是「停用已确认 → 旧保存响应到达 → 勾选框被重新勾上」，而后端仍是停用，界面与真实状态分叉。
- **修法一：引用锁。** 新增 `inFlight = useRef<{ kind, seq } | null>(null)`，两个处理函数在第一个 `await` 之前同步取锁、在 `finally` 比对身份后释放。`useState` 的更新是异步的，同一帧内的两次点击拦不住；`ref` 的写入是同步的，第二次点击一定在第一次进入 `await` 之后才执行，此时锁已置位。锁带自增序号是为了配合切换角色：换角色时旧请求作废、锁直接清空，旧请求的 `finally` 因为序号不匹配不会放掉新角色已经取到的锁。[VoicePanel.tsx](../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx)
- **修法二：写序号。** 保存发起时记下 `configSeq = stateSeq.current`，响应回来只有序号未变才 `setConfig`；启停成功后 `stateSeq.current += 1`。锁负责「同一时刻只有一个写者」，序号负责「历史请求即使晚到也不落笔」，两者不是重复：将来若新增别的写入路径（自动刷新、批量操作），序号仍然有效。
- **修法三：控件同步。** 保存按钮与启用勾选框都改为 `disabled={busy || toggleBusy}`，视觉禁用与处理函数的拒绝一致，避免出现「按钮可点但点了没反应」。
- **校验顺序。** 表单校验放在取锁之前，失败直接返回、不占锁；校验是同步的，从入口到取锁之间没有 `await`，因此不会出现「校验通过但锁已被另一个点击拿走」的空档。

## 4. 验证

- **桌面端。** `node --test tests/*.test.cjs` 97／97 通过（用例数不变，本轮未新增纯逻辑模块）。
- **类型与构建。** `renderer` 下 `npx tsc --noEmit` 与 `npx vite build` 通过。
- **按 247 的复现路径核对修复后的行为。**
  - VT-R01：切到已启用的角色乙后再释放甲的 409，代际已变，乙不写停用标记，新句自动播放照常发出请求；同一角色换窗口同理。
  - VT-R02：启停在飞时点保存，处理函数直接返回且按钮已禁用；反向（保存在飞时点启停）同样被拒。即使两条响应乱序到达，序号也会拦下旧快照。
- **未做浏览器级复现。** 桌面渲染层没有可用的自动化宿主：`node --test` 只跑纯逻辑模块，Electron 端要完整拉起后端与窗口，本轮的竞态验证靠结构约束、类型检查与构建保证。浏览器复验留给 247 的复验轮，证据仍可沿用 `backend/test-results/review-246/`。

## 5. 变更清单

| 文件 | 改动 |
| --- | --- |
| `renderer/src/conversation/use-segment-voice.ts` | `VOICE_DISABLED` 分支先比对代际，过期响应直接退出 |
| `renderer/src/components/voice/VoicePanel.tsx` | 新增带身份的 `inFlight` 引用锁（换角色时清空、释放时比对序号）与 `stateSeq` 写序号；保存与启停双向互斥；按钮与勾选框同步禁用 |
| [246](246-role-voice-toggle.md) 第 4 节 | 「保存与启停互不阻塞」改为双向互斥，并指向本文档 |
