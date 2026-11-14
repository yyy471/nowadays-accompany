# 角色外观导入与每日穿搭首轮实施记录

2026-11-08。依据 [DL-136](../../161-digital-life-direction-decisions.md#dl-136-角色自主选择服饰主页与对话共用导入素材)、[208](208-character-appearance-import-and-dialogue.md) 与 [209](209-agent-daily-outfit-development-guide.md)。本轮完成衣柜登记、图片导入与读图、Agent 每日穿搭状态、桌面导入入口和主页立绘接入；对话演出尚未实施。当前工作树未提交、未推送，无真实模型或付费调用。

[211](211-appearance-independent-review.md) 的 R01～R03 修复、定向复验与当前行为以 [212](212-appearance-review-fixes.md) 为准；本文保留首轮实施与自验记录。

## 1. 实现范围

### 外观存储与导入

- 业务库升至 v7：[schema.ts](../../../backend/src/storage/schema.ts#L12) 新增 `outfits` 与 `outfit_assets`，服饰名在同一角色内唯一，主页图每套最多一张，差分允许同名；[V7 迁移](../../../backend/src/storage/schema.ts#L1018) 随既有 v1～v6 链路执行。
- 角色目录新增 `appearance/`：[config.ts](../../../backend/src/bootstrap/config.ts#L14)、[role-storage.ts](../../../backend/src/storage/role-storage.ts#L19)。图片保存到受管理的角色目录，SQLite 只保存登记与相对路径。
- [AppearanceStore](../../../backend/src/storage/appearance-store.ts#L42) 负责衣柜、素材与同角色唯一约束；[AppearanceService](../../../backend/src/application/appearance-service.ts#L33) 负责整套导入、单张差分、读取素材。导入失败会清理本次已写文件，不发布残缺记录。
- 图片检查：[image-inspect.ts](../../../backend/src/application/image-inspect.ts#L17) 按文件签名限定 PNG／JPEG／WebP，再由 `sharp` 完整解码像素；多帧 WebP 校验全部帧。未知格式返回 `IMAGE_FORMAT_UNSUPPORTED`，无法解码返回 `IMAGE_DECODE_FAILED`，均附文件名。单图上限 32 MiB，多图请求上限 128 MiB。后续完整解码与异步导入流程见 [212](212-appearance-review-fixes.md)。
- HTTP：[appearance-routes.ts](../../../backend/src/http/appearance-routes.ts#L21) 提供 `GET /outfits`、`POST /outfits`、`POST /outfits/:outfitId/sprites`、`GET /assets/:assetId`；[body.ts](../../../backend/src/http/body.ts#L17) 使用 multipart 表单解析；[router.ts](../../../backend/src/http/router.ts) 与 [errors.ts](../../../backend/src/http/errors.ts) 增加二进制响应，图片按登记的 `media_type` 返回。

### Agent 每日穿搭

- 每轮开始按业务本地日期计算 `roundLocalDate`，作为工具上下文传入：[conversation-service.ts](../../../backend/src/application/conversation-service.ts#L1592)。
- [buildOutfitBrief](../../../backend/src/application/conversation-service.ts#L2136) 把本地日期、可用服饰 ID／名称／用途、当前服饰和当天是否已决定写入系统提示；衣柜为空时不增加提示。
- [state_update](../../../backend/src/application/agent-tools.ts#L833) 校验 `outfitId` 属于本人衣柜，由后端写入 `outfitReviewedOn`，模型提供的日期被忽略；无效 ID 返回可修正的 `OUTFIT_NOT_FOUND`。工具校验后的补丁通过 `statePatch` 进入本轮提交。
- [提交前复核](../../../backend/src/application/conversation-service.ts#L2173) 再次确认补丁引用的服饰仍属于该角色，状态版本仍由既有提交事务检查。

### 桌面

- [api.ts](../../../desktop/desk-preview/renderer/src/api.ts) 增加 FormData 上传；[App.tsx](../../../desktop/desk-preview/renderer/src/App.tsx#L79) 进入页面、恢复前台和每 5 秒读取角色状态与衣柜。R02 修复后初始请求与轮询共用按角色和 `stateVersion` 的新旧判断，见 [212](212-appearance-review-fixes.md)。读取不触发模型调用。
- [HomeScene](../../../desktop/desk-preview/renderer/src/components/home/HomeScene.tsx) 按当前服饰的主页图显示立绘，新图预解码成功后才切换。R03 修复后实际显示的图片与服饰名成组保留，加载失败不会把新服饰名配到旧图上，见 [212](212-appearance-review-fixes.md)。
- [AppearancePanel](../../../desktop/desk-preview/renderer/src/components/appearance/AppearancePanel.tsx#L24) 位于关系页外观弹窗，支持选择包含 `outfits` 的文件夹整套导入、按名字分组逐套提交、显示已登记差分、向已有服饰补单张差分；导入成功后刷新衣柜和主页。关系页立绘也读取当前服饰图并支持缺图回退。

## 2. 本机自验

运行目录：`backend/test-results/p5-2026-11-08T14-21-24-593Z-55109a24/`（Git 忽略）。使用项目独立 Node.js 24.22.2、离线模型与本地 SQLite。

| 检查 | 结果 |
| --- | --- |
| 后端类型检查／严格复核脚本类型检查 | 退出码 0 |
| 正式后端测试 | 211／211，失败／取消／跳过均为 0；新增外观 3 项、每日穿搭 6 项 |
| 交付入口回归 | 2／2 |
| 进程冒烟 | 1／1 |
| P2～P5 既有矩阵 | 全部通过 |
| 统一离线验收 | 21 个步骤全部通过，`sourceUnchanged=true`，`realServiceCalls=0` |
| 渲染器类型检查／Vite 构建 | 退出码 0，构建成功 |
| 桌面既有测试 | 21／21 |

隔离 Electron 自验使用 `NOWADAYS_APP_ROOT=backend/test-results/desktop-appearance/app-root`、本地 Electron 39.8.10 与临时测试角色，未连接真实模型。证据与截图位于 `backend/test-results/desktop-appearance/`：

| 场景 | 结果 |
| --- | --- |
| 主页读取当前服饰 | 显示「当前服饰 · 黑白长裙」，立绘来自后端素材路径 |
| 关系页外观入口 | 外观弹窗列出两套服饰、当前穿着标记、差分名与缩略图 |
| 后台换装刷新 | 直接提交 `outfitId` 为白色针织裙后，主页轮询刷新为「当前服饰 · 白色针织裙」 |
| 单张差分上传 | 通过界面选择图片上传后，差分从 2 张变为 3 张，列表出现「测试差分」 |
| 125% 缩放 | `devicePixelRatio=1.25`，窗口 1442×842，无水平溢出，外观弹窗正常打开 |
| 缺图回退 | 主页新图解码失败保留上一张并最终回退静态图；关系页立绘回退装饰图 |

## 3. 未覆盖与边界

- 对话立绘演出未实施：对话页仍是占位页，AnimaVN 式句段差分标注、SSE 播放、历史跳转和一次性动效均待下一工作包；本期只完成服饰登记、Agent 选择和主页展示。SSE 完成事件触发的即时刷新也未接入，当前由 5 秒轮询与前台恢复覆盖。
- 首轮未用千叶 38 张原图实测整套导入；[212](212-appearance-review-fixes.md) 已用两套真实原图（约 237 MB）补验整套导入与重启读取。Electron 代理整体缓冲请求、上传内存与异常退出后的暂存清理仍未验证。
- 图片“可解码”在首轮为文件头与结构校验；[212](212-appearance-review-fixes.md) 的 R01 二次修复已引入 `sharp` 完整像素解码，非法 PNG 过滤类型、损坏 VP8L 和动画 WebP 的损坏后续帧都会被拒绝。
- Electron 只在 100% 与 125% 缩放下查看，未覆盖打包产物、其他缩放、系统休眠恢复和真实千叶素材。
- 本记录为实现方自验，不替代独立复核；208 第 2～3 步与 209 第 3 步的桌面联调仍待完成。
