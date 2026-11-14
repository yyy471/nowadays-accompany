# 角色外观与每日穿搭首轮独立复核

2026-11-08，`dev-front` 工作树，基准提交 `a7a9cd4`。本轮独立复核 [210](210-appearance-implementation-record.md) 已交付的服饰导入、Agent 每日穿搭和主页立绘，按 [208](208-character-appearance-import-and-dialogue.md) 与 [209](209-agent-daily-outfit-development-guide.md) 核对。结论为**暂不通过**。图片格式校验、桌面状态版本顺序和缺图时的图文归属共三项问题待修。对话逐段演出与 SSE 即时刷新仍是后续工作包。

## 独立验收结果

| 检查 | 结果 |
| --- | --- |
| Node.js 24.22.2，实际 `npm run accept:offline` | 21／21 步通过，正式测试 211／211，交付回归 2／2，进程冒烟通过，`sourceUnchanged=true`，真实服务调用 0 |
| 桌面既有测试及渲染器 | 21／21 通过，渲染器类型检查与 Vite 构建通过 |
| 千叶原图 HTTP 整套导入 | 黑白长裙 129,016,520 字节，白色针织裙 108,046,905 字节，两套均返回 201。每套登记 1 张主页图和 19 张差分 |
| 自主选衣、中断与重启 | 离线自主唤醒提交黑白长裙和本地日期，主对话未产生消息。白色针织裙补丁已提出后发送新消息，原回复标记中断且保留黑白长裙。重启读回穿搭状态、两张主页图片文件和 38 条差分记录 |
| 独立图片样本 | Pillow 实际解码的 PNG 和 WebP 导入成功。普通 JPEG 和缺失图像数据的 PNG 复现 R01 |
| 渲染器状态顺序 | 用受控请求和解码结果运行当前 `App.tsx` 与 `HomeScene.tsx` 源码，复现 R02、R03 |

通过的离线验收目录为 `backend/test-results/p5-2026-11-08T14-29-39-235Z-c41e87f5/`。专项脚本、图片与输出在 `backend/test-results/p6-appearance-independent/`，其中 `probe-result.json` 记录 HTTP 与 Agent 证据，`renderer-order-result.json` 记录渲染器源码执行结果。默认沙箱内的首次运行受本机回环和 Vite 路径解析限制，后续通过获准的本机命令完成离线验收与构建。无界面浏览器回归的自动审批超时，渲染器专项改用 Node 受控环境执行源码。原生 Electron 文件选择和缩放仍沿用 210 的实现方证据。

## 待修问题

| 编号 | 复现和影响 | 复验条件 |
| --- | --- | --- |
| **R01 · 图片格式误判** | 48×64 的普通 JPEG 可由 Pillow 完整解码，上传却返回 400 `IMAGE_DECODE_FAILED`。JPEG 检查把扫描数据继续当段标记读。保留合法 PNG 签名、IHDR 和 IEND、移除图像数据后，图片无法解码，上传仍返回 201。现有 JPEG 测试样本只有段头，没有实际扫描数据。 [PNG 检查](../../../backend/src/application/image-inspect.ts#L39) · [JPEG 检查](../../../backend/src/application/image-inspect.ts#L59) · [现有测试样本](../../../backend/tests/p6-appearance.test.ts#L14) | 使用可实际解码的 PNG、JPEG、WebP 样本验证整套及单张导入。拒绝缺少像素数据或损坏的文件，返回具体文件名。校验范围遵循 DL-136 的文件格式约定 |
| **R02 · 旧状态覆盖新状态** | 同一角色初始请求取得版本 1，角色详情稍晚返回。轮询先取得版本 2，主页先显示白色针织裙。初始请求的并发读取随后完成，主页又切回版本 1 的黑白长裙。两条更新路径均直接写入状态。 [初始刷新](../../../desktop/desk-preview/renderer/src/App.tsx#L37) · [轮询刷新](../../../desktop/desk-preview/renderer/src/App.tsx#L59) | 所有刷新入口共享按角色和 `stateVersion` 判断新旧的逻辑。补验同角色乱序、切角色和断线恢复 |
| **R03 · 缺图时图片与服饰名不一致** | 白色针织裙已显示，再把当前服饰改为蓝色外套并令新图解码失败。画面持续显示白色针织裙，图注与替代文字却使用蓝色外套。图片状态只保留 URL，名称直接取新服饰属性。 [图片解码与图注](../../../desktop/desk-preview/renderer/src/components/home/HomeScene.tsx#L78) | 把实际显示的图片和它的服饰信息一起更新。测试新图加载中、加载失败及快速换装，验证回退归属一致 |

千叶原图此次通过真实 HTTP 导入。Electron 代理仍整体缓冲请求，后端也累积并复制 multipart 请求体。208 中的上传内存验证和异常退出后无引用暂存文件回收仍待验。 [Electron 请求转发](../../../desktop/desk-preview/main.cjs#L173) · [后端请求读取](../../../backend/src/http/body.ts#L17)

本轮保留 210 的实现方证据，未改被复核的业务源码和正式测试。R01～R03 修正后应重跑针对性复现，并在实际 Electron 上补验整套导入和主页换装。

## 212 修复后的独立复验

2026-11-08，复验 [212](212-appearance-review-fixes.md) 的修复。**R02、R03 在渲染器受控复验范围关闭，R01 仍未关闭。**

| 场景 | 独立结果 |
| --- | --- |
| R01 原始复现 | 正常 JPEG、WebP、PNG 的整套导入与单张补图均返回 201。缺少图像数据的 PNG 在两个入口均返回 400 `IMAGE_DECODE_FAILED` |
| R01 扩展反例 | PNG 带正确 CRC、可解压且长度正确的扫描线，但行过滤类型为 5。WebP 有有效 RIFF 容器和 VP8L 头，但码流不可解码。Pillow 12.3.0 完整读图均失败，两个真实上传入口却都返回 201 并登记素材 |
| R02 同角色乱序 | 受控执行当前 `App.tsx`，版本 2 的白色针织裙先显示，初始版本 1 晚到后仍保持白色针织裙。桌面单测同时覆盖切角色、切回与恢复后的版本比较 |
| R03 缺图回退 | 受控执行当前 `HomeScene.tsx`，新服饰图解码失败时，仍显示白色针织裙，图注、替代文字和无障碍名称均对应同一张旧图。桌面单测同时覆盖加载中及快速换装 |
| 千叶原图与 Agent 链路 | 黑白长裙 129,016,520 字节、白色针织裙 108,046,905 字节，均返回 201。两套各登记 19 张差分及 1 张主页图。离线自主换装、中断保留原服饰、重启读回再次通过 |
| 统一离线验收 | Node.js 24.22.2，实际 `npm run accept:offline` 21／21 步通过，正式测试 212／212，`sourceUnchanged=true`，真实服务调用 0 |
| 桌面回归 | 30／30，渲染器类型检查与 Vite 构建通过 |

PNG 当前以解压后长度相同为准，非法行过滤类型仍被接受。VP8L 以头部、版本和最小长度为准，损坏的图像码流仍被接受。R01 的关闭条件仍为两个上传入口接受可解码的支持格式、对实际无法解码的文件返回 `IMAGE_DECODE_FAILED`，同时保留文件名。补验应保留本节两种反例和真实的正例。 [PNG 检查](../../../backend/src/application/image-inspect.ts#L187) · [WebP 检查](../../../backend/src/application/image-inspect.ts#L438)

统一离线验收目录为 `backend/test-results/p5-2026-11-08T15-06-36-199Z-389ba586/`。专项证据位于 `backend/test-results/p6-appearance-recheck/`。其中 `pillow-negative.jsonl` 为坏图完整解码结果，`probe-result.json` 为两个 HTTP 入口及换装、恢复证据，`renderer-order-result.json` 为实际渲染器源码的受控结果。原生 Electron 文件选择、乱序注入与缩放本轮未独立重跑。实现方证据见 212。

## R01 二次修复后的独立复验

2026-11-08，复验 [212 第 4 节](212-appearance-review-fixes.md#4-r01-二次修复) 的 `sharp` 补修。**R01 的静态图反例已通过，动画 WebP 仍有无法解码的后续帧可以登记，R01 暂不关闭。** R02、R03 的受控渲染器结果保持通过。

| 场景 | 独立结果 |
| --- | --- |
| 两个上传入口的静态图 | 正常 PNG、JPEG、WebP 均返回 201。缺像素 PNG、非法行过滤 PNG、损坏 VP8L 及截断 JPEG 均返回 400 `IMAGE_DECODE_FAILED`，带原文件名 |
| 异步导入一致性 | 先写主页图再遇到损坏差分，返回 400，衣柜和受管文件均未增加。并发导入同名服饰返回 201 和 409 `OUTFIT_ALREADY_EXISTS`，最终只新增一套和一张受管图 |
| 千叶原图与 Agent 链路 | 两套原图 HTTP 导入均返回 201，每套登记 1 张主页图和 19 张差分。离线自主换装、中断保留原服饰、重启读回通过 |
| 统一离线验收 | Node.js 24.22.2，实际 `npm run accept:offline` 21／21，正式测试 212／212，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-08T15-23-41-200Z-3de7aa55/` |
| 桌面回归 | 桌面测试 30／30，复跑当前渲染器源码确认迟到旧状态被忽略，缺图时旧图与名称保持一致 |

追加反例是两帧 WebP。正常版两帧均可读，损坏版保留容器、帧头与第一帧，清零第二帧 VP8L 头之后的码流。Pillow 能读取损坏版的第一帧，第二帧读取失败。整套导入和单张补图都接受正常版和损坏版，均返回 201。独立调用当前安装的 `sharp` 0.35.5 复现了差异：默认模式 `stats()` 对两个文件都成功，启用 `animated: true` 后仍接受正常版，并对损坏版抛出解码错误。应用当前按默认模式校验，因而只验证了首帧。 [解码入口](../../../backend/src/application/image-inspect.ts#L36)

复验条件为在两个入口均保留可用的静态和动画 WebP，拒绝后续帧损坏的文件并返回 `IMAGE_DECODE_FAILED` 及原文件名。专项证据位于 `backend/test-results/p6-appearance-independent-round3/`，包括 `probe-result.json`、`pillow-additional.jsonl` 和 `decoder-frame-mode.json`。本轮未修改业务代码或正式测试，原生 Electron 交互和上传内存峰值未纳入本轮独立复验。

## R01 全帧校验补修独立复验

2026-11-08，独立复验 [212 第 5 节](212-appearance-review-fixes.md#5-动画-webp-后续帧修复)。**R01 在本轮已验证的导入范围关闭，R02／R03 原关闭结论维持。**

| 场景 | 独立结果 |
| --- | --- |
| 动画 WebP 整套导入和单张补图 | 上轮的正常两帧样本均返回 201，保存后按素材 ID 取回原始字节，响应类型为 `image/webp`。检查器返回单帧画布 48×64。第二帧损坏样本两个入口均返回 400 `IMAGE_DECODE_FAILED` 并带原文件名 |
| 静态图回归 | 两个入口均接受正常 PNG、JPEG、WebP，均拒绝缺像素 PNG、非法过滤 PNG、损坏静态 VP8L 和截断 JPEG |
| 导入一致性 | 先写主页图、后遇坏差分，失败后无新增衣柜记录和受管文件。并发新增同名服饰得到 201、409，最终只有一套服饰和一张受管图 |
| 千叶原图和 Agent | 两套原图均返回 201，每套登记 19 张差分和一张主页图。自主换装、发送新消息时保留已提交服饰、重启读回均通过 |
| 统一离线验收 | Node.js 24.22.2，实际 `npm run accept:offline` 21／21，正式测试 213／213，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-08T15-33-54-522Z-290005a4/` |
| 渲染器 | 桌面测试 30／30、渲染器类型检查通过。复跑受控源码探针，旧版本未覆盖新版本，缺图时旧图和图注、替代文字、无障碍名称一致 |

独立探针位于 `backend/test-results/p6-appearance-independent-round4/`，`probe-result.json` 保存两个 HTTP 入口、素材读回和 Agent 证据，`renderer-order-result.json` 保存受控渲染器证据。原生 Electron 文件选择、缩放、上传内存峰值和异常退出后的文件回收仍按先前记录单列。对话逐段演出和 SSE 即时刷新待实施。
