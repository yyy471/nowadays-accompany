# 237 对话页明暗切换（关系页推进方案已回滚）

2026-11-10，`dev-front` 工作树。按用户要求重做明暗切换：对话页照 `dialogue-demo-v4` 的「日落刻度」实现，已确认正确；关系页第一版做成「旧页快照按暖光前沿裁开」的明暗推进，用户判定效果不对，已整块回滚到原来的折页刻度。工作树未提交；本次仍用隔离 Electron 与本地模拟接口，未调用真实模型，未改动用户数据。本文只记录实现方自验，独立复核另行执行。

## 1. 结论

| 页面 | 状态 | 代码 |
| --- | --- | --- |
| 对话 | 保留：舞台光线 + 纸面 14 档逐行推进 + 一次性收尾，1.2 秒内完成 | [dialogue-theme.ts](../desktop/desk-preview/renderer/src/conversation/dialogue-theme.ts) · [conversation.css](../desktop/desk-preview/renderer/src/styles/conversation.css) |
| 关系 | 回滚：恢复 `relationship-journal` 折页刻度（暖光掠过 + 横线收成刻度 + 520ms 提交），与 HEAD 一致 | [exlibris-theme.ts](../desktop/desk-preview/renderer/src/relations/exlibris-theme.ts) |

两页都通过 `useThemeTransitionStrategy` 接管，不再退回整页天气动画；减少动效、强制色、窗口隐藏、快速连点仍由 `createThemeTransition` 统一收束。

## 2. 对话页：日落刻度

时序照参考稿：`stage 40 / palette 360 / end 1200`，纸面推进占 820ms 共 14 档，收尾落在 1180ms，仍在换光保护期内。

- **舞台**：`ConversationStage` 里常驻一条 `1.5px` 斜向光线 `.dialogue-sun-beam`。`data-light-dir="dusk"` 走 `dialogue-beam-down`（上→下，暖→冷交叉），`dawn` 走 `dialogue-beam-up`。光线只作用在画布上，背景与立绘不做任何变色、压暗或滤镜。
- **纸面**：面板整体先用 `.dlg-pal` + `data-ui-theme` / `data-ui-preset` 钉在旧预置上，`:before` 用 `--sweep-paper` 画新纸色，按 `--band` 从顶部（dusk）或底部（dawn）推进。每一行在色带到达时才换成新预置并加 `.flipped`，所以每行要么「旧纸旧字」、要么「新纸新字」，没有灰字压灰纸的中间态。
- **换行判据**：只取此刻在面板里可见的行（行中点在面板高度上的比例），dusk 用 `ceil(f*14)`、dawn 用 `ceil((1-f)*14)`，与色带同一条时间轴。
- **收尾**：最后一档到达时给面板加 `.sweep-settle`，在关闭过渡的同一帧里解钉全部行、移除色带、清掉 `--band`，强制一次布局与取色后再摘掉 `.sweep-settle`；结束帧与过渡最后一帧一致，不会从旧预置再动画回去。
- **历史层**：历史层是整面板覆盖，推进期间改成推进它自己的分区，并把下面的聊天区 `visibility:hidden`，色带不会被两层内容叠住。
- **顶栏与舞台底色**：在 `data-lighting` 保护期内加 `.45s` / `.6s` 的颜色过渡，收尾前已经到位。

## 3. 关系页：回滚记录

第一版把整页换色改成跟着暖光前沿推进：旧页留在底层，新预置快照按 `beam-pass` 的同一条 `cubic-bezier(.25,.5,.3,1)` 采样 28 帧裁开（`cut = 书页左缘 + (-0.55 + 1.75e + 0.28) × 书页宽`），暖光带挂在顶层命名快照组上。用户看过后判定效果不对，未说明具体是哪一处，本次按要求整块回滚，不做二次尝试。

回滚范围：

- `relations/exlibris-theme.ts` 恢复为 HEAD 版本（折页刻度 + 520ms 提交 + 1780ms 收尾）；`Relations.tsx` 的注册行未动，仍指向同一个导出。
- `styles/relations-exlibris.css` 删除追加的 16 行（`exlibris-advance` 的裁剪与暖光组规则、`.exlibris-ripple` 载体）。
- 换光验收脚本里的关系页断言改为核对回滚结果：`mode=relationship-journal`、刻度 41 根、`ripple=0`、收尾无残留。
- 旧证据目录 `backend/test-results/theme-transition/` 已清空重跑，不再保留推进方案的截图。

保留这段记录的理由：方案本身能跑（快照裁剪动画确实在推进、降级链完整），只是视觉不对；若以后仍要做「光到哪纸面换到哪」，得先确认问题在硬边、整页冻结，还是暖光带在夜纸上的偏棕观感，避免原样重做一遍。

## 4. 验证

`npm --prefix renderer run typecheck` 与 `vite build` 通过（CSS 529.69 kB／JS 384.35 kB，比推进版少 16 行样式与快照代码）；离线测试 54／54 通过；`relations-desktop-check.cjs` 仍全绿（书页 1203.2，换人面板 441.6–585.6，`desktopNight` 为真，无页面异常）。

`tests/theme-transition-check.cjs`（隔离 Electron + 本地模拟接口，1280×820）本轮实拍并断言：

| 用例 | 结果 |
| --- | --- |
| 关系 夜切 | 160ms 时 `mode=relationship-journal`、刻度 41 根、暖光载体 0 个、页面仍为 `theme=day`（520ms 才提交） |
| 关系 夜 | 收尾后 `theme=night`、`data-theme-transition` 为空、`illuminating` 为假、无暖光载体残留 |
| 关系 昼 | 切回后 `theme=day`、过渡标记为空、无残留 |
| 对话 夜切 | 50ms 时 `data-lighting=true`、`data-light-dir=dusk`；光线 `animationName=dialogue-beam-down`，`top` 从 -70px 递增 |
| 对话 中间帧 | 面板 `sweeping`，`--band=35.71%`，`--sweep-paper=#202836`，已钉 3 行、已翻 3 行；截图上暗下亮、分界水平 |
| 对话 收尾 | `theme=night`、`lighting` 为空、`sweeping=false`、钉住 0 行、面板底色 `rgb(32, 40, 54)` |
| 对话 往返 | 昼→夜→昼后回到 `rgb(255, 252, 247)`，钉住 0 行 |
| 历史层 | 打开历史消息再换光：`sweeping=true`、`--band=14.29%`、已钉 1 行；收尾后停在夜、钉住 0 行 |
| 减少动效 | 模拟 `prefers-reduced-motion: reduce` 后点击，80ms 内已经到夜，`lighting` 为空、钉住 0 行、无过渡标记 |

证据目录 `backend/test-results/theme-transition/`（`relations-day/fold/night/dawn/day-again.png`、`dialogue-day/dusk-01..05/night/dawn/day-again/history-dusk/reduced-night.png`、`timeline.txt`）。

## 5. 已知边界

- 对话页只推进此刻可见的行；过渡期间滚动会让未钉住的行留在旧预置，收尾时统一落地，不产生闪烁。
- 对话页的历史层与聊天区不能同时推进，历史层打开时推进的是历史层自己的分区。
- 关系页已回到原状：暖光掠过与配色提交仍是两件事（520ms 一次性换色），本次不做改动。
- 两页都没有改动后端、接口或数据结构。
