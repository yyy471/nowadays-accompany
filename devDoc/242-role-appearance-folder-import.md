# 角色外观目录导入（AI-01）实施记录

2026-11-10。按 [236 第 5 节](236-role-settings-backend-gap-review.md#5-角色外观导入修补工作) 和 [208 目录规范](208-character-appearance-import-and-dialogue.md#角色素材源目录) 实现角色素材文件夹的目录识别、导入预览与批量导入。本轮只改桌面端；后端 `home`／`sprite` 两类用途与导入接口沿用 RS-01 之前的实现，未改动 `backend/` 源码。

## 1. 范围与结果

| 工作项 | 结果 |
| --- | --- |
| 识别目录 | 新增 `standees/<服饰标识>/` → `home`、`expressions/<服饰标识>/` → `sprite` 的识别，保留旧 `outfits/<服饰名>/home.*` 与 `outfits/<服饰名>/sprites/` |
| 导入预览 | 按套显示主页缩略图、差分数量、立绘／差分目录来源、缺项与重名；支持改名、跨目录手动归并、多主页图候选指定 |
| 导入结果 | 逐套提交后汇总「已导入／跳过重名／缺项待补／失败」，缺项不阻塞导入 |
| 跳过规则 | `outfits/` 锚点目录、`manifest.md`／`表情清单.md` 等说明文件、隐藏文件、非图片 |
| 页面取图 | 主页沿用 `outfit.home` → `appearanceAssetUrl`；对话沿用后端按句段返回的 `spriteAssetId`，两条链路本轮未改 |

## 2. 目录识别与布局判定

- 扫描入口 `scanAppearanceFolder`（[appearance-import.js](../desktop/desk-preview/renderer/src/appearance-import.js)）只读路径字符串，不读文件内容、不碰 DOM，可在 `node:test` 里直接构造目录树。
- 布局按优先级判定：只要出现 `standees` 或 `expressions` 段，就按新素材库处理，`outfits/` 下的文件一律记为 `OUTFITS_SKIPPED`；两者都没有时才回退旧格式，按 `outfits/<服饰名>/home.<ext>` 与 `outfits/<服饰名>/sprites/**` 识别。
- 这样处理是因为 §5 要求「跳过 `outfits` 锚点图」，而 208 又要求「旧格式 `outfits/<服饰名>/home.*` 继续兼容」。同一个目录名在两种素材库里含义不同，用「是否存在 `standees`／`expressions`」区分，比检查 `outfits` 内部结构更稳定。
- 角色根取 `standees`／`expressions` 所在路径的前缀。一次选到多个角色目录时给出 `MULTIPLE_ROOTS`，仍按第一个角色识别，避免把两个角色的服饰混进同一个衣柜。
- 只有目录、没有服饰标识段的条目（如 `千叶诗织/standees/`）不算素材目录，避免空目录被识别成一套服饰。

## 3. 归并与预览

- 默认按完全一致的服饰标识配对：`standees/02_classic` 与 `expressions/02_classic` 合成一套。
- 名称不同的两侧保留为两个条目，由用户在预览里用「归并到…」指定目标。千叶的 `06_white_knit_barelegs`（立绘）与 `06_white_knit`（差分）即此路径，归并后主页图取目标条目，差分为两侧并集，来源记入 `mergedFrom` 并显示「撤销归并」。
- 同一服饰有多张主页立绘候选时默认按文件名排序取第一张，并在预览里提供下拉指定，同时记录 `MULTIPLE_HOME_CANDIDATES` 供页面提示。
- 缩略图用 `URL.createObjectURL` 生成，只跟随扫描结果重建；改名和归并不重新解码图片，离开或重新选择时统一 `revokeObjectURL`。
- 预览只计算、不落库：`planOutfitImport` 输出 `ready`／`duplicate` 与 `missingHome`／`missingSprites`，`summarizeOutfitPlan` 汇总套数与差分总数。

## 4. 导入与结果汇总

- 「确认导入 N 套」只提交 `status === "ready"` 的条目，逐套调用现有 `POST /v1/roles/:roleId/appearance/outfits`，复用后端的格式校验、可解码性校验与 32 MiB 上限。
- 重名条目在预览阶段已按已保存衣柜判定，默认跳过并在结果里列出，不依赖后端 409 才发现。
- 缺主页图或缺差分都允许导入：樱的两套服饰只有立绘，导入后可用「上传差分图片」单张补齐，符合 §5「缺少某一类素材时显示缺项并允许稍后补齐」。
- 单套失败不影响其余条目，失败原因逐条回显；导入完成后统一刷新衣柜并触发 `onChanged`。

## 5. 跳过的文件

| 原因 | 说明 |
| --- | --- |
| `OUTFITS_SKIPPED` | 新素材库里的 `outfits/` 是用户自行生图用的锚点，不进入预览也不进素材库 |
| `DOCUMENT` | `manifest.md`、`表情清单.md` 等说明文件 |
| `NOT_IMAGE` | 扩展名不是 png／jpeg／webp |
| `HIDDEN` | `.DS_Store`、`.gitkeep` 等隐藏文件 |
| `OUTSIDE_SOURCE` | 不在 `standees`／`expressions`／`outfits` 下的文件 |
| `UNRECOGNIZED` | 目录深度或命名不符合约定，如 `outfits/<名>/` 下既不是 `home.*` 也不是 `sprites/` 的图片 |

跳过项按原因计数后显示在预览顶部，不逐条铺开，避免 19 张差分加若干说明文件时预览过长。

## 6. 测试与自验

- 新增 `desktop/desk-preview/tests/appearance-import.test.cjs` 13 项：千叶三套识别与 `outfits` 跳过、白色针织裙跨目录归并、多主页候选排序与保留目标主页图、樱两套仅立绘且说明文件跳过、旧格式兼容、新旧并存按新格式、多候选提示、嵌套差分与隐藏文件、重名与缺项汇总、改名与空名回落、多角色根提示、无素材目录报缺、原生 `File` 列表回落 `webkitRelativePath`。
- 桌面端 `npm test` 67 项全部通过（原 54 项 + 新增 13 项）。
- `renderer` 类型检查（`tsc --noEmit`）通过，`vite build` 通过。
- 按 208 的完整目录结构做了一次端到端扫描，结果与 §5 验收项对应：

| 角色 | 识别结果 | 跳过 | 计划 |
| --- | --- | --- | --- |
| 千叶诗织 | `01_white_knit_stockings`（立绘 1／差分 0）、`02_classic`（立绘 1／差分 19）、`06_white_knit_barelegs`（立绘 1／差分 0）、`06_white_knit`（立绘 0／差分 19） | `outfits` 锚点 2 个 | 归并后 3 套：`02_classic` 重名跳过，其余可导入，差分共 38 张 |
| 樱 | `idol_sweet_white_thighhigh`、`initial_white_dress`（各立绘 1／差分 0） | `manifest.md`、`表情清单.md` | 两套均 `ready`，提示缺差分可稍后单张补图 |

- 本轮未改动 `backend/` 源码，RS-01 的 298 项后端测试与 21 步离线验收结论继续有效。

## 7. 未完成与后续

- 未做自动归并建议：`06_white_knit` 与 `06_white_knit_barelegs` 这类前缀相近的目录仍需手动指定，避免把「同一套的不同部件」误并成一套。
- 导入后不自动切换当前穿着，穿搭仍由 Agent 决定，与 DL-136 一致。
- 服饰删除、主页图补传／替换与差分删除已按 [262](262-role-appearance-deletion-history.md) 补齐后端接口；桌面端入口按 253 接入。
- 图片只校验格式与可解码性，未按角色做尺寸、透明通道或构图检查。
- 素材库若同时存在新旧两套目录，旧格式整目录跳过；需要旧数据的用户应先确认新目录完整，再删除旧目录。
