# 211 外观复核 R01～R03 修复记录（含 R01 二次修复）

2026-11-08，`dev-front` 工作树，基准提交 `a7a9cd4` 加 [210](210-appearance-implementation-record.md) 未提交变更。按 [211](211-appearance-independent-review.md) 修复图片格式误判、旧状态覆盖和缺图归属三项，并复跑定向探针、统一离线验收与 Electron 100%／125%。工作树未提交、未推送，无真实模型或付费调用。

## 1. 修复内容

### R01 图片格式误判

- [inspectImage](../backend/src/application/image-inspect.ts#L17) 先按文件签名限定 PNG／JPEG／WebP，再由 `sharp` 0.35.5（libvips）读取元数据并完整解码像素。缺少或损坏的像素数据、非法 PNG 行过滤类型、不可解码的 VP8L 码流统一返回 `IMAGE_DECODE_FAILED`，附文件名。首轮按块／段／RIFF 的结构校验已被完整解码取代。
- 图片检查和写入改为异步：[RoleAccess.withStoreAsync](../backend/src/application/role-access.ts#L53) 保持角色就绪检查、重名检查和失败文件清理的原有顺序，[appearance-routes.ts](../backend/src/http/appearance-routes.ts#L36) 的两个上传入口等待完成后再响应。
- [p6-appearance.test.ts](../backend/tests/p6-appearance.test.ts) 使用 Pillow 12.3.0 实际编码的 48×64 PNG、JPEG、渐进 JPEG、有损 WebP 和无损 WebP，并加入缺像素 PNG、损坏 IDAT、仅段头 JPEG、非法过滤 PNG 与损坏 VP8L；整套导入和单张补图都覆盖正例与反例。

### R02 旧状态覆盖新状态

- 新增 [state-version.js](../desktop/desk-preview/renderer/src/state-version.js#L1)，按角色保存已应用的最大 `stateVersion`。角色不匹配、版本更旧或版本号无效时丢弃；同版本允许刷新。
- [App.tsx](../desktop/desk-preview/renderer/src/App.tsx#L29) 的初始请求和每 5 秒轮询统一走 `applySnapshot`；角色切换时重新激活当前角色，旧请求由请求编号和角色门共同拦截。断线期间不降低已见版本，恢复后更高版本正常应用。
- [state-version.test.cjs](../desktop/desk-preview/tests/state-version.test.cjs) 覆盖同角色乱序、切角色、切回、断线恢复和无效版本。

### R03 缺图时图片与服饰名不一致

- 新增 [outfit-display.js](../desktop/desk-preview/renderer/src/outfit-display.js#L1)，把实际显示的图片 URL 与服饰名作为一组状态，仅在解码成功后一起替换；新图解码失败保留旧组，快速换装时旧解码完成也不能覆盖新组。
- [HomeScene.tsx](../desktop/desk-preview/renderer/src/components/home/HomeScene.tsx#L82) 使用该分组状态生成图片、图注、`alt` 和 `aria-label`。图片渲染失败只清除同一 URL 的展示，不回退到新服饰名。
- [outfit-display.test.cjs](../desktop/desk-preview/tests/outfit-display.test.cjs) 覆盖加载中、解码失败、快速换装、清空和同一 URL 改名。

## 2. 复验证据

统一离线验收目录：`backend/test-results/p5-2026-11-08T14-56-01-310Z-f26ea6fc/`。

| 检查 | 结果 |
| --- | --- |
| 后端类型检查／严格复核脚本类型检查 | 退出码 0 |
| 正式后端测试 | 212／212，失败／取消／跳过均为 0 |
| 交付入口回归／进程冒烟 | 2／2、1／1 |
| 统一离线验收 | 21 个步骤全部通过，`sourceUnchanged=true`，`realServiceCalls=0` |
| 渲染器类型检查／Vite 构建 | 退出码 0，构建成功 |
| 桌面测试 | 30／30（原 21 项加新增 9 项） |

定向复核在 `backend/test-results/p6-appearance-fixes/`：

| 场景 | 结果 |
| --- | --- |
| 211 复核样本 | Pillow 可解码的 `real.jpg`、`real.webp`、`real.png` 均返回 201；`no-image-data.png` 返回 400 `IMAGE_DECODE_FAILED` |
| 千叶原图整套导入 | 黑白长裙 129,016,520 字节、白色针织裙 108,046,905 字节，均返回 201 并登记 1 张主页图和 19 张差分；耗时 2,616／2,139 ms |
| 自主选衣、中断与重启 | 自主活动提交本地日期且主对话无消息；换装补丁提出后发送新消息，原回复中断且保留原服饰；重启读回状态、两张主页图和 38 条差分 |
| 渲染器源码探针 | 初始版本 1 晚于轮询版本 2 完成时，主页保持白色针织裙；新图 404 时图片、`alt`、图注和 `aria` 均保持「白色针织裙」 |
| Electron 100% | 提交指向缺图外套的状态后素材返回 404，画面、图注、`alt` 与 `aria` 均保持白色针织裙 |
| Electron 125% | `devicePixelRatio=1.25`，窗口 1442×842，无水平溢出，主页与外观弹窗正常 |

截图与报告位于 `backend/test-results/desktop-appearance-fixes/`：`fix-check-result.json`、`01-home-before-fix-check.png`、`02-home-missing-new-outfit.png`、`scale-fix-result.json`、`03-home-125.png`、`04-appearance-125.png`。

## 3. 未覆盖

- R02 在真实 Electron 网络中的乱序注入未执行；本轮用与 211 相同的渲染器源码受控环境和桌面纯逻辑测试复验。
- Electron 代理仍整体缓冲请求，后端 multipart 请求体仍累积读取；上传内存峰值和异常退出后的无引用暂存文件回收仍未验证。
- 对话立绘演出、SSE 完成事件即时刷新、历史跳转和一次性动效仍属后续工作包。
- 本记录为实现方自验，不替代独立复核；复核通过前不提交。

## 4. R01 二次修复

[211 第 5 节](211-appearance-independent-review.md#212-修复后的独立复验)确认 R02、R03 关闭，但 R01 仍有两个反例通过：PNG 的扫描线长度与 CRC 正确、行过滤类型却是非法的 5；WebP 有合法 RIFF 与 VP8L 头，码流却无法解码。两者都能被 Pillow 12.3.0 拒绝，却仍被首轮结构校验接受。

### 修复

- [inspectImage](../backend/src/application/image-inspect.ts#L17) 改为签名识别后调用 `sharp` 0.35.5：先读元数据核对格式和宽高，再完整解码像素。PNG 非法行过滤、损坏 VP8L、缺失像素数据和截断文件都返回 `IMAGE_DECODE_FAILED`，保留文件名。
- `sharp` 以精确版本加入后端依赖，`package-lock.json` 同步更新。图片校验和文件写入改为异步，[RoleAccess.withStoreAsync](../backend/src/application/role-access.ts#L53) 保留角色检查、重名检查和失败清理顺序；两个 HTTP 上传入口都等待写入完成后再响应。
- [p6-appearance.test.ts](../backend/tests/p6-appearance.test.ts) 加入复核反例 `bad-filter.png` 与 `bad-stream.webp`，并在整套导入和单张补图两个入口断言 400 与文件名；原有真实样本、缺像素 PNG、损坏 IDAT 和仅段头 JPEG 用例继续保留。

### 复验

定向探针在 `backend/test-results/p6-appearance-recheck-fixes/`，使用 211 的原始样本和完整 Agent 链路：

| 场景 | 结果 |
| --- | --- |
| 整套导入 | `real.jpg`、`real.webp`、`real.png` 201；`no-image-data.png`、`bad-filter.png`、`bad-stream.webp` 均 400 `IMAGE_DECODE_FAILED` |
| 单张补图 | 同上，两个反例均 400 并带文件名 |
| 千叶原图整套导入 | 黑白长裙 129,016,520 字节、白色针织裙 108,046,905 字节，均 201 并登记 1 张主页图和 19 张差分；完整解码后耗时 8,024／10,040 ms |
| 自主选衣、中断与重启 | 自主提交本地日期、主对话无消息；中断保留原服饰；重启读回状态、主页图和 38 条差分 |
| 统一离线验收 | 21／21 步通过，正式测试 212／212，交付回归 2／2，`sourceUnchanged=true`，真实服务调用 0 |

验收目录为 `backend/test-results/p5-2026-11-08T15-18-13-079Z-03319c5e/`；Pillow 对两个反例的解码失败记录仍保留在 `backend/test-results/p6-appearance-recheck/pillow-negative.jsonl`。

### 边界

- 解码由 libvips 完成，与 Pillow 的容错边界可能不完全相同；现已覆盖两轮复核的实际反例和真实原图。
- 千叶整套导入因逐张完整解码，比结构校验慢约 4～5 倍，仍在单次导入可接受范围。
- 本记录仍为实现方自验，R01 的关闭需由独立复核重跑上述两个入口和反例确定。

## 5. 动画 WebP 后续帧修复

[211 第 6 节](211-appearance-independent-review.md#r01-二次修复后的独立复验)确认静态图两个入口已符合要求，但追加的两帧 WebP 反例仍能登记：损坏版保留第一帧、清零第二帧 VP8L 码流，Pillow 读取第一帧成功、第二帧失败。`sharp` 默认模式只解码首帧，因此没有暴露后续帧错误。

### 修复

- [inspectImage](../backend/src/application/image-inspect.ts#L36) 的元数据读取和像素解码都启用 `animated: true`，多帧 WebP 会解码全部帧；任一帧失败即返回 `IMAGE_DECODE_FAILED` 并保留文件名。
- 多帧图片的 `metadata.height` 是全部帧总高度，登记宽高改用单帧画布 `pageHeight`，避免把 48×64 的两帧动画记成 48×128。
- [p6-appearance.test.ts](../backend/tests/p6-appearance.test.ts) 增加正常两帧 WebP 与第二帧损坏版本，新增整套导入和单张补图两个入口的独立用例，并断言失败后衣柜和受管文件均未增加。

### 复验

使用 211 第三轮的原始样本与完整 Agent 探针，结果位于 `backend/test-results/p6-appearance-independent-round3-fixes/`：

| 场景 | 结果 |
| --- | --- |
| 两个上传入口 | 正常动画 WebP 均 201；第二帧损坏版均 400 `IMAGE_DECODE_FAILED`，带原文件名 |
| 静态图回归 | 正常 PNG／JPEG／WebP 201；缺像素 PNG、非法过滤 PNG、损坏 VP8L、截断 JPEG 均 400 |
| 失败回滚与并发重名 | 主页图写入后差分失败，无残留受管文件或衣柜记录；并发同名返回 201 与 409，只新增一套 |
| 千叶原图与 Agent 链路 | 两套原图各 19 张差分仍导入成功；自主换装、中断保留和重启读回通过 |
| 统一离线验收 | 21／21 步通过，正式测试 213／213，交付回归 2／2，`sourceUnchanged=true`，真实服务调用 0 |

验收目录为 `backend/test-results/p5-2026-11-08T15-29-28-418Z-6b302070/`。千叶两套原图完整解码耗时 9,842／11,187 ms，全部帧解码仍在单次导入可接受范围。

### 边界

- 多帧图片现在验证全部帧；静图行为不变。原生 Electron 交互和上传内存峰值仍未在本轮独立复验范围。
- 本记录仍为实现方自验，R01 的最终关闭需由独立复核重跑静态与动画正反例后确定。
