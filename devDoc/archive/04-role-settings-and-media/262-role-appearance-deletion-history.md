# 252 第三包 · 外观、删除与历史数据实施记录

> **现行规范入口**：本文外观软删除回退与角色 `keepHistory` 双路径删除契约已整合并入 [角色配置、全局资源与活动守卫规范](../../specs/role-config-and-activity.md)；下文保留第三包实施与自验记录。

2026-11-11。按 [252 第 2 节第三包](252-role-config-settings-development-plan.md#第三包--外观删除与历史数据) 实施。四项产品决定已经用户确认并写入 [161](../../161-digital-life-direction-decisions.md) 的变更记录（DL-148／DL-151）。本文是实现方自验与接口交接记录，独立复核由复核方另行执行。

## 1. 交付范围与决定

| 252 要求 | 实现 | 用例 |
| --- | --- | --- |
| 服饰改名、主页立绘补传或替换、服饰及差分删除 | 新增改名、主页立绘补传／替换、删除服饰、删除差分四个写接口；批量导入保持 `standees`／`expressions` 来源不变 | p6 `服饰改名与立绘替换保留旧句段的立绘指向`、`删除服饰与差分保留历史素材并回退当前服饰` |
| 删除素材移出衣柜与 Agent 候选 | 衣柜与 Agent 阅读同一条 `listOutfits()`，软删除后立即排除；按素材标识读取仍可服务历史 | p6 同上；p7 既有的 Agent 标注／穿搭用例保持通过 |
| 历史句段按原素材读取 | 句段保存 `home_asset_id`；差分继续使用 `sprite_asset_id`；删除或替换时仅清理未被引用的素材 | p6 同上 |
| 当前素材／最后一项的回退 | 删除当前服饰后切到剩余服饰中最早创建的一套；最后一套服饰与最后一个角色都返回 409 | p6 `LAST_OUTFIT_REQUIRED`；p16 `至少保留一个角色` |
| 角色删除的两条数据路径 | `DELETE /v1/roles/:roleId?keepHistory=0|1`：保留路径只移除索引与活动记录，清理路径连同角色目录删除 | p16 四项用例 |

已确认的决定：

1. **不能删到空**：删除最后一套服饰或最后一个角色返回 409 `LAST_OUTFIT_REQUIRED`／`LAST_ROLE_REQUIRED`；用户会预置一个默认角色。
2. **当前服饰回退**：删除当前服饰后切换到剩余服饰中最早创建的一套，并清掉 `outfitReviewedOn`。
3. **保留角色的数据读取**：本轮只保留角色目录与仍被历史引用的受管素材，不提供已删除角色的读取接口；用户源目录与源文件始终保留。
4. **旧句段立绘回退**：服饰不等同于立绘，主页立绘来自 `standees` 素材。升级时按句段所属服饰当时的主页立绘回填 `home_asset_id`，此后替换或删除不影响旧回放；缺少服饰的句段不显示立绘。

## 2. 外观接口

| 方法与路径 | 请求 | 成功响应 | 主要错误 |
| --- | --- | --- | --- |
| `PATCH /v1/roles/:roleId/appearance/outfits/:outfitId` | JSON `{ name?, description? }`，至少一项 | `200 OutfitRecord` | 400 名称非法；409 `OUTFIT_ALREADY_EXISTS`；404 `OUTFIT_NOT_FOUND` |
| `POST /v1/roles/:roleId/appearance/outfits/:outfitId/home` | multipart，文件字段 `home`（恰好一张） | `201 OutfitAssetRecord`（新主页立绘） | 400 `HOME_FILE_REQUIRED`；404 `OUTFIT_NOT_FOUND` |
| `DELETE /v1/roles/:roleId/appearance/outfits/:outfitId` | 无 | `200 { outfitId, removedAssets, retainedAssets }` | 409 `LAST_OUTFIT_REQUIRED`；404 `OUTFIT_NOT_FOUND` |
| `DELETE /v1/roles/:roleId/appearance/outfits/:outfitId/sprites/:assetId` | 无 | `200 { assetId, retained }` | 409 `ASSET_NOT_SPRITE`；404 `OUTFIT_NOT_FOUND`／`ASSET_NOT_FOUND` |

四个接口都加入 `ROLE_CONFIG_WRITES`：目标角色须先由后端确认 `stopped`，运行中或正在停止时返回 409 `ROLE_NOT_STOPPED`。

**删除语义。**

- 服饰与素材使用 `deleted_at` 软删除：衣柜、管理列表与 Agent 候选只读未删除项，按 `assetId` 的读图接口不区分是否删除。
- 差分删除：仍被任一句段 `sprite_asset_id` 引用时保留素材行与文件（响应 `retained=true`）；未引用时删除行与文件。
- 删除服饰：服饰本身软删除；每张素材按历史引用保留或清理；同时移除生图设置里该服饰的提示词键。
- 主页立绘替换：旧立绘标记删除；仍被句段 `home_asset_id` 引用时保留行与文件，否则清理。新立绘成为唯一主页立绘。
- 同名重导仍按 208／242 的约定返回 409，由用户进入该服饰补图；不会改变旧句段的素材指向。

## 3. 立绘快照与迁移

- 业务库 **V16 → V17**：`outfits.deleted_at`、`outfit_assets.deleted_at`、`message_segments.home_asset_id`；服饰名唯一索引与「单一主页立绘」索引改为仅约束未删除行。
- 回复落库时句段同时写入 `outfit_id` 与当时的 `home_asset_id`；差分标注时补写 `home_asset_id`（已有值不覆盖）。`message_segments` 读视图与 `segment_annotations` SSE 事件都新增 `homeAssetId`。
- 迁移时按 `message_segments.outfit_id` 回填当时的服饰主页立绘；没有服饰的旧句段保持 `null`，历史回放不显示立绘。
- 场景图任务继续通过 `message_segments.outfit_id` 解析服饰名称与描述；服饰软删除不破坏旧消息的过场图上下文。

## 4. 角色删除

`DELETE /v1/roles/:roleId?keepHistory=0|1` 必须显式传入 `keepHistory`，缺失返回 400 `KEEP_HISTORY_REQUIRED`。`1` 表示保留，`0` 表示一并清理，亦接受 `true` 或 `false`。 [264 第 3 节](264-role-appearance-deletion-review-fixes.md#3-ad-r02--删除必须显式选择历史处理)

| 路径 | 行为 | 响应 |
| --- | --- | --- |
| `keepHistory=1` | 移除角色索引与活动记录；角色目录、业务库、外观／语音／场景图受管素材全部保留 | `200 { roleId, keepHistory: true, filesRemoved: false }` |
| `keepHistory=0` | 先提交「移除角色 + 待清理记录」，再删除角色目录；目录删除失败时保留记录，由启动恢复或同一接口重试继续 | `200 { roleId, keepHistory: false, filesRemoved: boolean }` |

- 删除前要求角色已由后端确认停止；运行中或正在停止返回 409 `ROLE_NOT_STOPPED`。至少要保留一个角色，否则 409 `LAST_ROLE_REQUIRED`。
- 移除索引前释放运行时：中止该角色的过场图任务、等待对话执行／标注／续行收尾、关闭该角色的 SSE 事件流、清理唤醒定时器、工具目录、输入状态与记忆队列。仍有在途工作时返回 409 `ROLE_BUSY`。
- app 库 **V6 → V7** 新增 `role_deletions` 待清理表；`role_activity` 的外键行与角色索引在同一事务删除。
- 两条路径都不触碰用户源目录与源文件（后端从未保存源路径）。清理路径删除的是角色目录内的对话、记忆、工作区与受管素材副本。
- 保留路径不提供读取接口（用户决定）；该目录不参与启动恢复、资源引用扫描或后续清理，需要的归档由用户自行管理。

## 5. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p6-appearance.test.ts`、`tests/p16-role-deletion.test.ts` | 12／12 |
| 迁移与关联用例 | `p1-02`、`p2-02`、`p7-performance`、`p8-voice`、`p9-tts-unified`、`p10-scene-image`、`p11-scene-image-planning`、`p12-role-settings` | 通过 |
| 全量测试 | `--test-concurrency=8 tests/*.test.ts` | 350／350 |
| 离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0`、`sourceUnchanged=true` |

验收报告：`backend/test-results/p5-2026-11-11T11-51-09-879Z-2f6759d6/summary.json`。

新增定向用例：

1. `tests/p6-appearance.test.ts`：`服饰改名与立绘替换保留旧句段的立绘指向`（含活动期写入拒绝、改名、立绘替换与旧图保留）。
2. `tests/p6-appearance.test.ts`：`删除服饰与差分保留历史素材并回退当前服饰`（含引用／未引用素材、当前服饰回退、提示词清理、最后一套拒绝）。
3. `tests/p6-appearance.test.ts`：`旧库升级按句段服饰当时的主页立绘回填`。
4. `tests/p16-role-deletion.test.ts`：保留路径、清理路径、至少保留一个角色、清理中断后重试与启动恢复。

## 6. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/storage/schema.ts` | 业务库 V17（软删除、立绘快照、索引与回填）；app 库 V7（`role_deletions`）；必需列与索引说明同步 |
| `backend/src/storage/appearance-store.ts` | 衣柜过滤、改名、替换立绘、软删除、素材引用计数与回退查询 |
| `backend/src/application/appearance-service.ts` | 改名、立绘替换、删除服饰／差分与未引用素材清理 |
| `backend/src/storage/scene-image-settings-store.ts` | 删除服饰时清理提示词键 |
| `backend/src/domain/appearance.ts` | 素材记录增加 `deletedAt` |
| `backend/src/storage/conversation-store.ts`、`backend/src/domain/conversation.ts` | 句段 `home_asset_id` 快照、读视图与标注事件字段 |
| `backend/src/http/appearance-routes.ts`、`schemas.ts`、`config-writes.ts` | 四个外观写接口、请求 schema 与停止保护 |
| `backend/src/storage/app-store.ts` | 角色索引删除、角色活动清理与 `role_deletions` 读写 |
| `backend/src/application/role-deletion-service.ts` | 两条删除路径、待清理记录、启动与重试清理 |
| `backend/src/application/conversation-service.ts` | 角色事件流关闭、静默等待与运行时清理 |
| `backend/src/application/scene-image-service.ts` | 按角色中止过场图任务 |
| `backend/src/application/memory-runtime.ts` | 按角色停止定时器与队列 |
| `backend/src/http/write-guard.ts`、`routes.ts`、`bootstrap/app.ts` | 删除接口与守卫、运行时装配与启动恢复 |
| `backend/tests/p6-appearance.test.ts`、`p16-role-deletion.test.ts` | 新增用例 |
| `backend/tests/p1-02`、`p2-02`、`p7`、`p8`、`p9`、`p10`、`p12`、`tests/config-write.ts` | 版本断言、旧库模拟、句段字段与删除作用域同步 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/161`、`devDoc/252`、`devDoc/242`、项目工作记忆 |

## 7. 交接边界

- 本轮记录实施方自验。AD-R01～AD-R06 已按 [264](264-role-appearance-deletion-review-fixes.md) 修复，第三包已通过 [263 独立离线复验](263-role-appearance-deletion-independent-review.md#264-第-7-节补修独立复验)。
- 前端接入（[253](253-role-config-settings-frontend-plan.md)、[260](260-role-settings-frontend-first-pass.md)）需要：服饰改名／补传／删除按钮、差分删除、历史句段按 `homeAssetId`／`spriteAssetId` 取图、角色删除的两路径确认框与「至少保留一个」提示。
- 未纳入本轮：已删除角色的读取／恢复入口（用户确认只保留文件）；同名重导的覆盖式导入（仍按 208／242 返回 409）；被保留角色目录中残留资源绑定的后续清理；真实服务联调。
- 外观删除只改角色业务库与受管目录；资源（模型、MCP、Skill）与用户源文件夹不受影响。
