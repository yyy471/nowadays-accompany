# 新主线文档导航

2026-11-09。对话演出第一包通过独立离线复验，见 [216 第 6 节](216-conversation-performance-independent-review.md#6-217-第-7-节补修独立复验)。旧 IndexTTS 接口的补修在 [219](219-indextts-integration-spec.md#补修独立复验) 通过复验。DL-140 统一 TTS 后端的 v12 回填在 [222 独立复验](222-tts-unified-independent-review.md#221-第-11-节-v12-回填独立复验) 通过 v10 和旧 v11 两条升级路径，TTS 的 R01～R04 在已验范围关闭。真实服务联调待验。

角色外观与每日穿搭在 [212](212-appearance-review-fixes.md) 补修后完成[独立复验](211-appearance-independent-review.md#r01-全帧校验补修独立复验)。过场图 CG-01／CG-02 经 [227 第 7 节](227-scene-image-independent-review.md#7-228-第-10-节-r06-独立复验) 独立复验通过，R01～R06 在已验范围关闭。关系藏页按 [233](233-relations-exlibris-migration-fixes.md) 迁移后，[234](234-relations-exlibris-independent-review.md) 复核未通过的三项已按 [235](235-relations-exlibris-review-fixes.md) 修复并自验，[234 第 3 节](234-relations-exlibris-independent-review.md#3-235-修复独立复验) 原场景通过；扩展场景 EX-R04、EX-R05 已在 [235 第 7 节](235-relations-exlibris-review-fixes.md#7-234-第-3-节补充修复ex-r04ex-r05) 补修，[234 第 4 节](234-relations-exlibris-independent-review.md#4-235-第-7-节补修独立复验) 确认 EX-R01～EX-R05 在离线范围关闭。对话页的明暗切换已按 `dialogue-demo-v4` 重做为「日落刻度」，实现方自验见 [237](237-dialogue-theme-transition.md)；关系页的「明暗推进」方案效果未获认可，已整块回滚到原折页刻度。角色配置与全局设置的后端缺口按 [236](236-role-settings-backend-gap-review.md) 复核，第一包 RS-01（密钥直填、按资源探测、地址与请求边界、参考音频列表／删除、音色下架映射）已按 [241](241-role-settings-backend-rs-01.md) 完成实现方自验，[244 第 7 节](244-role-settings-independent-review.md#7-245-第-12-节补修独立复验) 确认 RS-R01～RS-R08 在各自已验离线范围关闭；外观目录导入已按 [242](242-role-appearance-folder-import.md) 在桌面端实现，声音配置页已按 [243](243-voice-settings-desktop.md) 接入连接测试、试听与参考音频管理，角色语音的启用／停用已按 [246](246-role-voice-toggle.md) 补齐（停用保留单份配置、只阻止对话合成）；生图已按 DL-150 适配 ComfyUI，首版用 MOSS-Image 跑通文生图并接入桌面配置页（[248](248-comfyui-adaptation.md)），图生图待实施；[250 独立复核](250-comfyui-independent-review.md) 发现的 CG-R01～CG-R05（含复验追加的跨站点凭据问题）已按 [251](251-comfyui-review-fixes.md) 修复并通过独立离线复验；删除按 DL-151 直接执行、不做归档。角色语音启停的桌面端两项复核问题（VT-R01、VT-R02）已按 [249](249-role-voice-toggle-review-fixes.md) 修复，经 [247 第 4 节](247-role-voice-toggle-independent-review.md#4-249-补修独立复验) 关闭。[252](252-role-config-settings-development-plan.md) 第一包「角色活动与配置写入保护」已按 [254](254-role-activity-config-guard.md) 完成实施方自验：活动状态、停止边界、统一写入守卫与结构化 409，后端 321 项与 21 步离线验收通过，[255 独立复核](255-role-activity-independent-review.md)发现四项缺口，已按 [256](256-role-activity-review-fixes.md) 修复：后台结算后收敛停止、恢复重新调度原任务、全局写入提交前重验、额度写入纳入保护，后端 325 项与 21 步离线验收通过。[255 复验](255-role-activity-independent-review.md#256-修复独立复验) 关闭原四项，发现重启后正在停止状态无法自动收敛（RA-R05）。第二包「模型与扩展资源管理」已按 [257](257-resource-management.md) 完成实施方自验：资源引用报告与删除、MCP／Skill 修改与全局关闭的占用检查、绑定 revision 冲突保护、MCP 环境变量脱敏，实施方后端 332 项与 21 步离线验收通过，[258 独立复核](258-resource-management-independent-review.md)发现 RP-R01～RP-R03。RA-R05 与 RP-R01～RP-R03 已按 [259](259-role-activity-resource-review-fixes.md) 修复并通过实施方自验（336 项测试与 21 步离线验收）。[255 复验](255-role-activity-independent-review.md#259-修复独立复验) 确认第一包在已验离线范围通过；[258 复验](258-resource-management-independent-review.md#259-修复独立复验) 确认第二包原三项通过，预检后写入失败仍会丢失绑定（RP-R04）；RP-R04 原两个 SQL 执行失败场景已通过独立复验，后端实施方 338 项测试与 21 步离线验收通过。[258 补修复验](258-resource-management-independent-review.md#259-第-6-节补修独立复验) 复现逐库提交失败或进程中断后的绑定丢失（RP-R05）；RP-R05 已按 259 第 7 节补修（决策库先提交 + 待清理记录，读侧过滤并在启动或重试时继续清理），实施方后端 341 项测试与 21 步离线验收通过。[258 第 7 节补修复验](258-resource-management-independent-review.md#259-第-7-节补修独立复验) 确认 RP-R05 原场景通过，发现删除收尾与重试缺口 RP-R06、RP-R07；已按 259 第 8 节补修（收尾失败保留记录并返回成功、启动逐条容错、公开删除重试继续清理），实施方后端 343 项测试与 21 步离线验收通过。[258 第 8 节补修复验](258-resource-management-independent-review.md#259-第-8-节补修独立复验) 确认 RP-R06、RP-R07 关闭，第二包在已验离线范围通过。第三包「外观、删除与历史数据」已按 [262](262-role-appearance-deletion-history.md) 完成实施方自验：服饰改名、主页立绘补传／替换、服饰与差分删除、句段立绘快照与旧库回填，以及角色删除的保留与清理两条路径；实施方后端 350 项与 21 步离线验收通过。[263 独立复核](263-role-appearance-deletion-independent-review.md) 发现 AD-R01～AD-R04，已按 [264](264-role-appearance-deletion-review-fixes.md) 修复：并发删除保留至少一个角色、删除必须显式选择历史处理、清理记录失败不改写已接受的删除、旧立绘清理失败不影响新图；实施方后端 353 项与 21 步离线验收通过。[263 复验](263-role-appearance-deletion-independent-review.md#264-修复独立复验) 关闭原四项，发现服饰删除与上传交错问题 AD-R05；AD-R05 已按 264 第 6 节修复（素材写入与服饰有效性在同一事务复验），实施方后端 354 项与 21 步离线验收通过。[263 第 6 节补修复验](263-role-appearance-deletion-independent-review.md#264-第-6-节补修独立复验) 关闭 AD-R05，发现角色删除与在途上传交错问题 AD-R06；AD-R06 已按 264 第 7 节修复（同一角色的配置写入与删除串行，删除等待在途上传结束），实施方后端 355 项与 21 步离线验收通过。[263 第 7 节补修复验](263-role-appearance-deletion-independent-review.md#264-第-7-节补修独立复验) 关闭 AD-R06，252 后端三包通过独立离线复验。[265](265-role-settings-frontend-third-package.md) 完成第三包桌面接入与实现方自验。[266 独立复核](266-role-settings-frontend-independent-review.md) 确认正常链路通过。[267](267-role-settings-frontend-review-fixes.md) 修复的三个原场景通过独立复验，自动刷新绑定问题 CF-R04 已通过独立复验，绑定恢复入口问题 CF-R05 已通过独立复验。268 第 4 节「首次启动与角色初始状态」与外观导入预览不显示立绘的修复已按 [269](269-268-progress-first-launch-import-preview.md) 完成实施方自验；第 1、2、3、5 节与第 6 节核对已按 [270](270-268-progress-dialogue-model-picker.md) 完成（舞台差分回退、等待与点击推进、模型草稿探测与统一选择控件），生图草稿探测与扩展探测待实施。[271 独立复核](271-model-settings-and-dialogue-independent-review.md) 发现探测并发、候选重开、跨页共享、立绘回退与等待提示五项缺口，已按 [272](272-271-review-fixes.md) 修复，桌面 107 项测试通过；271 第 4 节复验关闭 MR-01／MR-02／MR-05，追加的 MR-03 候选转存与换密钥清理、MR-04 首图回退已按 [273](273-272-reverification-fixes.md) 修复，桌面 108 项测试通过；271 第 5 节复验追加的换密钥后在途旧候选写回已按 [274](274-273-reverification-fixes.md) 修复（供应商缓存代次），桌面 109 项测试通过；271 第 6 节复验关闭旧候选写回，追加的旧列表失败与旧测试结果晚到已按 [275](275-274-reverification-fixes.md) 修复（成功／失败统一核对缓存代次），桌面 109 项测试通过；271 第 7 节复验关闭迟到响应，追加的换密钥前已显示旧提示已按 [276](276-275-reverification-fixes.md) 修复（凭据代次变化时清除旧错误与测试结果），桌面 109 项测试通过。271 第 8 节独立复验确认 MR-01～MR-05 在已验范围关闭。278 操作链路简化的第一包（角色同页暂停并保存、消息接收结果与等待原因）已按 [280](280-278-progress-role-workspace-dialogue-receipt.md) 完成实施方自验，后端 358 项与桌面 109 项测试通过。外观、语音与生图写入已按 [281](281-278-progress-guarded-panels.md) 接入同一暂停并保存路径，桌面 109 项与构建通过。模型维护已按 [282](282-278-progress-model-impact-resource-detail.md) 只暂停实际依赖角色，资源详情支持结束任务与批量关闭绑定，首次对话入口与绑定自动合并已接入；后端 358 项与桌面 109 项通过。CG-03、残留文件自动清扫、真实服务和桌面对话按工作包推进。桌面前端完成后按 DL-115 恢复远程 Streamable HTTP MCP。

| 文档 | 定位与状态 |
| --- | --- |
| [283 操作链路简化实施独立复核](283-278-workflow-simplification-independent-review.md) | 第 26 节记录 306 复验及目录恢复、空整理与跨窗口整理补修，任务结束后的记忆整理通过离线复验 |
| [284 操作链路复核问题修复](284-278-review-fixes.md) | R01～R09 修复与实施方自验。独立结论见 [283 第 4 节](283-278-workflow-simplification-independent-review.md#4-284-修复独立复验) |
| [285 283 第 4 节复验问题修复](285-283-reverification-fixes.md) | 六项补修与实施方自验。独立结论见 [283 第 5 节](283-278-workflow-simplification-independent-review.md#5-285-补修独立复验) |
| [286 283 第 5 节复验问题修复](286-283-reverification-fixes.md) | 四项补修与实施方自验。独立结论见 [283 第 6 节](283-278-workflow-simplification-independent-review.md#6-286-补修独立复验) |
| [287 283 第 6 节复验问题修复](287-283-reverification-fixes.md) | 两项补修与实施方自验。独立结论见 [283 第 7 节](283-278-workflow-simplification-independent-review.md#7-287-补修独立复验) |
| [288 283 第 7 节复验问题修复](288-283-reverification-fixes.md) | 两项补修与实施方自验。独立结论见 [283 第 8 节](283-278-workflow-simplification-independent-review.md#8-288-补修独立复验) |
| [289 283 第 8 节复验问题修复](289-283-reverification-fixes.md) | 两项补修与实施方自验。独立结论见 [283 第 9 节](283-278-workflow-simplification-independent-review.md#9-289-补修独立复验) |
| [290 283 第 9 节复验问题修复](290-283-reverification-fixes.md) | 两项补修与实施方自验。独立结论见 [283 第 10 节](283-278-workflow-simplification-independent-review.md#10-290-补修独立复验) |
| [291 283 第 10 节复验问题修复](291-283-reverification-fixes.md) | 两项补修与实施方自验。独立复验通过，见 [283 第 11 节](283-278-workflow-simplification-independent-review.md#11-291-补修独立复验) |
| [292 278 剩余项：删除同页暂停与后台调用维护协调](292-278-remaining-deletion-maintenance.md) | 同页删除与后台调用等待的实施方自验。独立结论见 [283 第 12 节](283-278-workflow-simplification-independent-review.md#12-292-独立复核) |
| [293 292 独立复核问题修复](293-292-review-fixes.md) | 四项修复与实施方自验。独立结论见 [283 第 13 节](283-278-workflow-simplification-independent-review.md#13-293-补修独立复验) |
| [294 293 补修独立复验问题修复](294-293-reverification-fixes.md) | 三项补修与实施方自验。独立结论见 [283 第 14 节](283-278-workflow-simplification-independent-review.md#14-294-补修独立复验) |
| [295 294 补修独立复验问题修复](295-294-reverification-fixes.md) | 删除收尾期间拒绝同角色新过场图任务、失败后恢复可用。独立结论见 [283 第 15 节](283-278-workflow-simplification-independent-review.md#15-295-补修独立复验) |
| [296 295 补修独立复验问题修复](296-295-reverification-fixes.md) | 删除等待已领取的规划结算、删除期拒绝同角色手动整理。独立结论见 [283 第 16 节](283-278-workflow-simplification-independent-review.md#16-296-补修独立复验) |
| [297 296 补修独立复验问题修复](297-296-reverification-fixes.md) | 在途记忆整理纳入统一删除期限、超时保留角色并释放删除队列。独立结论见 [283 第 17 节](283-278-workflow-simplification-independent-review.md#17-297-补修独立复验) |
| [298 297 补修独立复验问题修复](298-297-reverification-fixes.md) | 删除失败后补发删除期被拒绝的维护唤醒。独立结论见 [283 第 18 节](283-278-workflow-simplification-independent-review.md#18-298-补修独立复验) |
| [299 298 补修独立复验问题修复](299-298-reverification-fixes.md) | 删除期暂存任务结束通知并在失败后补发整理。独立结论见 [283 第 19 节](283-278-workflow-simplification-independent-review.md#19-299-补修独立复验) |
| [300 299 补修独立复验问题修复](300-299-reverification-fixes.md) | 暂存任务通知保留到可运行批次，记忆服务晚恢复后仍形成整理。独立结论见 [283 第 20 节](283-278-workflow-simplification-independent-review.md#20-300-补修独立复验) |
| [301 300 补修独立复验问题修复](301-300-reverification-fixes.md) | 任务结束整理意图持久化并在重启后自动恢复。独立结论见 [283 第 21 节](283-278-workflow-simplification-independent-review.md#21-301-补修独立复验) |
| [302 301 补修独立复验问题修复](302-301-reverification-fixes.md) | 从持久化任务与待整理工具证据补写 `task_end` 触发并跨重启恢复。独立结论见 [283 第 22 节](283-278-workflow-simplification-independent-review.md#22-302-补修独立复验) |
| [303 302 补修独立复验问题修复](303-302-reverification-fixes.md) | 按任务隔离 `task_end` 补写失败并保留可重试状态。独立结论见 [283 第 23 节](283-278-workflow-simplification-independent-review.md#23-303-补修独立复验) |
| [304 303 补修独立复验问题修复](304-303-reverification-fixes.md) | 维护／删除／无绑定期间停止安排零延迟定时器并刷新退避时间戳。独立结论见 [283 第 24 节](283-278-workflow-simplification-independent-review.md#24-304-补修独立复验) |
| [305 304 补修独立复验问题修复](305-304-reverification-fixes.md) | 把调度绑定读取纳入异常保护，并在临时读库失败后继续处理已持久化触发。独立结论见 [283 第 25 节](283-278-workflow-simplification-independent-review.md#25-305-补修独立复验) |
| [306 305 补修独立复验问题修复](306-305-reverification-fixes.md) | 启动读库失败后的批次恢复实施记录。独立复核及补修见 [283 第 26 节](283-278-workflow-simplification-independent-review.md#26-306-补修独立复验) |
| [282 278 进展三：模型依赖维护与资源详情](282-278-progress-model-impact-resource-detail.md) | 实施方自验记录，范围包括模型影响报告、扩展停用、批量关闭绑定、首次对话与绑定合并。独立结论见 283 |
| [281 278 进展二：外观语音生图接入暂停保存](281-278-progress-guarded-panels.md) | 外观、语音配置保存与启停、生图保存接入暂停流程。参考录音上传和删除的缺口见 283 R08 |
| [280 278 进展一：角色同页暂停保存与消息接收结果](280-278-progress-role-workspace-dialogue-receipt.md) | 人设／绑定／额度保存时自动暂停并可在原处继续活动；消息接收结果与等待原因、恢复／配置／重试入口；后端 358 项与桌面 109 项通过 |
| [279 操作链路修复方案复核](279-workflow-simplification-two-pass-review.md) | 三轮复核覆盖页面操作、前后端关联、并发与失败恢复，含端到端验收用例 |
| [278 项目操作链路简化修复文档](278-project-workflow-simplification-fix-plan.md) | 模型按实际依赖暂停、同页配置与资源维护、首次对话、草稿测试及现有设计语言验收 |
| [277 项目操作链路复核与待修改项](277-project-workflow-simplification-audit.md) | 首次配置、角色活动、全局服务、资源占用、删除和失败恢复的简化建议，待实施 |
| [276 275 补修复验问题修复记录](276-275-reverification-fixes.md) | 换密钥和清除密钥后旧提示消失，同一密钥刷新保留有效结果；桌面 109 项测试通过，MR-03 独立复验关闭 |
| [275 274 补修复验问题修复记录](275-274-reverification-fixes.md) | 迟到的旧列表失败和旧测试成功独立复验通过；旧提示的最终复验见 271 第 8 节 |
| [274 273 补修复验问题修复记录](274-273-reverification-fixes.md) | 旧候选写回的两种返回顺序独立复验通过；旧列表错误和旧连接测试提示复验见 271 第 7 节 |
| [273 272 复验问题修复记录](273-272-reverification-fixes.md) | 独立复验关闭 MR-04，草稿候选转存与常规换密钥通过，在途旧候选写回复验见 271 第 6 节 |
| [272 271 复核问题修复记录](272-271-review-fixes.md) | 桌面 107 项测试通过；独立复验关闭 MR-01、MR-02、MR-05，MR-03、MR-04 的剩余缺口见 273 |
| [271 模型配置与对话演出独立复核](271-model-settings-and-dialogue-independent-review.md) | 276 独立复验见第 8 节，MR-01～MR-05 在已验范围关闭 |
| [270 268 进展二：对话演出与模型选择](270-268-progress-dialogue-model-picker.md) | 舞台差分回退、等待与点击推进、模型草稿探测与统一选择控件；后端 355 项、桌面 105 项与 21 步离线验收通过，生图草稿探测与扩展探测待实施 |
| [269 268 进展一：首次活动状态与外观预览](269-268-progress-first-launch-import-preview.md) | 新建角色默认停止（API／CLI／初始化重试），导入预览 CSP 允许 blob 图片；后端 355 项、桌面 101 项与 21 步离线验收通过 |
| [268 模型配置、首次启动与对话演出修复计划](268-model-settings-and-dialogue-fix-plan.md) | 第 1～5 节与第 6 节核对已按 269／270 完成；生图草稿探测、MCP／Skill 探测与整体联调待实施 |
| [267 角色配置与设置前端复核修复](267-role-settings-frontend-review-fixes.md) | CF-R01～CF-R05 均通过独立复验 |
| [266 253 角色配置与设置前端独立复核](266-role-settings-frontend-independent-review.md) | CF-R01～CF-R05 在已验本机范围关闭，真实服务待联调 |
| [265 角色配置与设置前端第三包接入记录](265-role-settings-frontend-third-package.md) | 外观、角色删除、历史素材与资源同步接入；本地实际后端与替身自验，独立结论见 266 |
| [264 263 复核问题修复记录](264-role-appearance-deletion-review-fixes.md) | AD-R01～AD-R06 的修复与自验：并发删除保留至少一个角色、删除必须显式选择历史处理、清理记录失败不改写已接受的删除、旧立绘清理失败不影响新图、上传与删除交错不写入已删除服饰、角色删除等待在途上传；后端 355 项与 21 步离线验收通过，AD-R01～AD-R06 已通过独立离线复验 |
| [263 252 第三包外观、删除与历史数据独立复核](263-role-appearance-deletion-independent-review.md) | AD-R01～AD-R06 已在离线范围关闭，第三包通过独立复验 |
| [262 252 第三包外观、删除与历史数据实施记录](262-role-appearance-deletion-history.md) | 服饰改名、主页立绘补传／替换、服饰与差分删除、句段立绘快照与旧库回填，以及角色删除的保留／清理两条路径；后端 350 项与 21 步离线验收通过，独立结论见 263，修复见 264 |
| [261 角色配置与设置原型迁移记录](261-role-settings-prototype-migration.md) | 两页原型结构、交互、资源管理及离线自验；第三包前端接入见 265，独立结论见 266，真实服务待联调 |
| [260 角色配置与设置前端首轮记录](260-role-settings-frontend-first-pass.md) | 双页、角色隔离、草稿、活动状态及已有接口接入和实现方自验；部分接口与整体验收待完成 |
| [259 255／258 复核问题修复记录](259-role-activity-resource-review-fixes.md) | RA-R05 与 RP-R01～RP-R03 的修复与自验，RP-R04 补修跨连接回滚，RP-R05 补修逐库提交中断的一致可见状态，RP-R06／RP-R07 补修删除收尾与重试；后端 343 项与 21 步离线验收通过，RP-R01～RP-R07 均已通过独立复验 |
| [258 模型与扩展资源管理独立复核](258-resource-management-independent-review.md) | RP-R01～RP-R07 均在已验离线范围关闭，第二包通过独立复验 |
| [257 252 第二包模型与扩展资源管理实施记录](257-resource-management.md) | 资源引用报告与删除、MCP／Skill 修改与全局关闭的占用检查、绑定 revision 冲突保护、MCP 环境变量脱敏；后端 332 项与 21 步离线验收通过，独立结论见 258，修复见 259 |
| [256 255 复核问题修复记录](256-role-activity-review-fixes.md) | RA-R01～RA-R04 的修复与自验：后台结算收敛停止、恢复重新调度、全局写入提交前重验、额度纳入保护；后端 325 项与 21 步离线验收通过，独立复验见 255 |
| [255 角色活动与配置写入保护独立复核](255-role-activity-independent-review.md) | RA-R01～RA-R05 已在离线范围通过独立复验 |
| [254 252 第一包角色活动与配置写入保护实施记录](254-role-activity-config-guard.md) | 实施方自验与接口记录，独立结论见 255，修复见 256、259 |
| [252 角色配置与设置后端开发计划](252-role-config-settings-development-plan.md) | 三包均通过独立离线复验，可交接 253 桌面整体验收 |
| [253 角色配置与设置前端接入计划](253-role-config-settings-frontend-plan.md) | 双页与跨页草稿按原型接入，后端已通过独立离线复验，可进行桌面整体验收 |
| [251 ComfyUI 复核问题修复](251-comfyui-review-fixes.md) | CG-R01～CG-R05 的修复与自验：纯背景提示词、凭据失效时配置可读写、任务接收固定服务与锚点、中止清理与超时统一、跨站点不复用新凭据；V16 任务配置快照 |
| [250 ComfyUI 生图适配独立复核](250-comfyui-independent-review.md) | CG-R01～CG-R05 在已验离线范围关闭，真实服务联调待验 |
| [249 角色语音启停复核问题修复](249-role-voice-toggle-review-fixes.md) | VT-R01 停用响应先按代际丢弃、VT-R02 保存与启停双向互斥并加写序号；独立复验见 247 第 4 节 |
| [247 角色语音启停独立复核](247-role-voice-toggle-independent-review.md) | 后端契约在已验范围通过，第 4 节关闭桌面端 VT-R01、VT-R02 |
| [248 ComfyUI 生图适配（CG-03）](248-comfyui-adaptation.md) | 全局生图服务与凭据、V15 角色配置、节点能力探测、按类型打补丁的 MOSS-Image 工作流、测试生图与过场图接入，以及桌面生图配置页；后端 308 项、桌面 97 项与 21 步离线验收通过 |
| [246 角色语音启用与停用（DL-149）](246-role-voice-toggle.md) | V14 加 `enabled`、启停接口与句段合成 409 `VOICE_DISABLED`，桌面开关及静默跳过。实现方自验见 246，独立结论见 247 |
| [244 角色配置开发进展独立复核](244-role-settings-independent-review.md) | 第 7 节复验关闭 RS-R08，RS-R01～RS-R08 在各自已验离线范围关闭 |
| [241 角色配置后端第一包（RS-01）](241-role-settings-backend-rs-01.md) | 密钥只写存储与统一解析、按资源探测与结果过期、地址与请求边界、参考音频列表／删除、音色下架映射；实现方自验见 241，独立发现见 244 |
| [242 角色外观目录导入（AI-01）](242-role-appearance-folder-import.md) | `standees`／`expressions` 识别、导入预览、跨目录手动归并与结果汇总，`outfits` 锚点与说明文件跳过；桌面端 67 项测试与类型检查、构建通过 |
| [243 声音配置页接入（VS-01）](243-voice-settings-desktop.md) | 连接测试、试听、参考音频上传／列表／删除、预置音色下架提示与按能力校验；桌面端 81 项测试与类型检查、构建通过 |
| [245 244 复核问题修复记录](245-role-settings-review-fixes.md) | 第 1～8 节为 RS-R01～RS-R05 首轮修复，第 9 节补修扩展场景（引用凭据、音色随服务失效、卸载后作废、忙碌状态归属），第 10 节补修换服务时参考模式失效，第 11 节补修能力来源顺序与不支持来源拒绝，第 12 节让请求与校验共用同一份能力声明；后端 301 项、桌面 89 项与 21 步离线验收通过 |
| [240 关系页顶部栏精简](240-relations-header-removal.md) | 移除关系页顶部标题栏，按用户澄清将日夜装饰条移入书页右上方；实现方自验，待独立复核 |
| [239 对话页 Dock 显示设置](239-dialogue-dock-visibility.md) | 对话页可隐藏底部导航、其他页面保留导航及本地偏好；实现方自验，待独立复核 |
| [238 对话页顶部精简与布局调整](238-dialogue-layout-refinement.md) | 对话框内工具图标、舞台上移和移除全局顶部设置入口；实现方自验，待独立复核 |
| [237 对话页明暗切换（关系页推进方案已回滚）](237-dialogue-theme-transition.md) | 对话页照 v4 参考实现舞台光线 + 纸面 14 档逐行推进；关系页快照推进方案经用户判定效果不对，已回滚到原折页刻度并复验无残留；实现方自验，独立复核待执行 |
| [236 角色配置与全局设置后端缺口复核](236-role-settings-backend-gap-review.md) | 对照现有接口核对附件，区分首版接入项、补齐项和后续能力；第一包实施进展见第 7 节与 241 |
| [235 关系藏页复核修复记录](235-relations-exlibris-review-fixes.md) | EX-R01～EX-R03 的修复与实现方自验，第 7 节补修 EX-R04／EX-R05；独立结论见 234 第 3～4 节 |
| [234 关系藏页迁移独立复核](234-relations-exlibris-independent-review.md) | 第 4 节确认 EX-R01～EX-R05 在离线范围关闭，真实数据联调待验 |
| [233 关系藏页原型对照与迁移修复](233-relations-exlibris-migration-fixes.md) | 对照用户提供的关系页原型，修复布局、主题、交互和资料读取，独立结论见 234 |
| [232 桌面对话 231 复核修复记录](232-conversation-desktop-review-fixes.md) | FE-R01～FE-R04 修复与离线自验，独立结论见 231 第 4 节 |
| [231 桌面对话页独立复核](231-conversation-desktop-independent-review.md) | 53 项桌面测试、10 组浏览器场景通过，FE-R01～FE-R04 在离线范围关闭 |
| [229 桌面对话页第一包实施记录](229-conversation-desktop-fe-01-record.md) | FE-01 页面装配、演出状态、演示语音与历史面板的实现方自验；当前接入与复核见 230、231 |
| [228 过场图复核修复记录](228-scene-image-review-fixes.md) | R01～R06 的实现方修复与自验，独立结论见 227 第 7 节 |
| [227 过场图后端独立复核](227-scene-image-independent-review.md) | CG-01／CG-02 离线范围通过，R01～R06 关闭 |
| [226 生成过场图第二包实施记录](226-scene-image-cg-02-record.md) | CG-02 模型规划、上下文与服饰参考素材、生成超时与重试的实现方自验；独立结论见 227 |
| [225 桌面对话页开发文档](225-conversation-desktop-development-guide.md) | v5 交互原型、正式前端分期、消息与媒体契约、验收清单 |
| [224 生成过场图第一包实施记录](224-scene-image-cg-01-record.md) | CG-01 任务与读取契约、v13 存储、假规划与假生成器、失败重试与重连的实现方自验；独立结论见 227 |
| [223 对话演出开发文档](223-conversation-performance-development-guide.md) | 213 的实现现状、过场图后端工作包与契约草案、待决策项、桌面与真实联调排期 |
| [222 TTS 统一接入独立复核](222-tts-unified-independent-review.md) | R01～R04 在已验范围关闭，v10 和旧 v11 升级到 v12 通过，真实语音服务待联调 |
| [221 TTS 统一接入首轮实施记录](221-tts-unified-implementation.md) | 能力探测、克隆／预置音色、multipart 合成、v10→v12 迁移与旧配置兼容；第 7～11 节记录 222 修复 |
| [220 TTS 统一接入说明](220-tts-unified-integration.md) | 音色克隆与预置音色共用的配置流程、服务接口、后端迁移和验收，已按 221 完成首轮后端实施 |
| [219 首版 IndexTTS 接入规范与独立复核](219-indextts-integration-spec.md) | R01～R03 及补修通过独立离线复验，真实桥接待联调 |
| [218 TTS 与角色音色首轮实施记录](218-tts-implementation-record.md) | IndexTTS 本地 HTTP、参考音频导入、试听与按句合成、v9 存储；第 7 节记录 219 R01～R03 修复与自验 |
| [217 对话演出第一包复核修复记录](217-conversation-performance-review-fixes.md) | R01～R04 的修复与实现方自验，最终独立结论见 216 第 6 节 |
| [216 对话演出第一包独立复核](216-conversation-performance-independent-review.md) | 离线回归和 v7 样例迁移通过，R01～R04 在已验范围关闭 |
| [215 对话演出第一包实施记录](215-conversation-segments-implementation.md) | 回复句段、快照、晚到表情标注与 v8 存储的实现方自验；历史结论见 216、217 |
| [214 关系藏页接入记录](214-relationship-exlibris-page.md) | 关系页改为人物藏书票与经历、日记、介绍；资料维护留在设置 |
| [213 对话演出后端方案](213-conversation-performance-backend-plan.md) | DL-137／DL-138 的回复消息设计、三条演出链路、句段契约和后端接口提案 |
| [212 211 外观复核 R01～R03 修复记录](212-appearance-review-fixes.md) | 图片全帧解码、状态版本门和图片与服饰名同步的实现方证据；独立结论见 211 |
| [211 角色外观与每日穿搭独立复核](211-appearance-independent-review.md) | 统一离线验收、真实原图与 Agent 链路通过。R01～R03 在已复验范围关闭 |
| [210 角色外观导入与每日穿搭首轮实施记录](210-appearance-implementation-record.md) | 衣柜存储、图片导入读图、Agent 穿搭状态、桌面入口与主页立绘的实现方自验；对话演出待实施 |
| [209 Agent 每日穿搭开发文档](209-agent-daily-outfit-development-guide.md) | DL-136 的穿搭决策时机、角色状态提交、主页与对话刷新及验收；首轮实施见 210，对话同步待实施 |
| [208 角色外观导入与对话立绘接入](208-character-appearance-import-and-dialogue.md) | DL-136 的用户图片规范、素材登记接口、桌面接入与验收；首轮实施见 210，对话立绘待实施 |
| [207 桌面前端四页重做记录](207-desktop-four-page-rebuild.md) | DL-135 的四页范围、主页与关系页实现及本机自验记录 |
| [230 桌面对话 FE-02 接入进展](230-conversation-desktop-fe-02-progress.md) | 窗口接入、历史分页定位、舞台与语音补修及离线自验；独立复核见 231 |
| [206 桌面主页精简、环境流转与角色外观入口](206-desktop-home-scene-and-role-visual-plan.md) | DL-132～DL-134 的历史前端方案与实现方自验，当前页面范围按 DL-135 |
| [205 光影书房与器物剧场前端重构计划](205-luminary-study-theater-frontend-plan.md) | `dev-front` 分支重构方案：单舞台双焦距、全屏五层光影流转与信笺／手账／胶片／推演四大器物转场 |
| [204 书桌 v0.1.2 原生窗口与天气细化](204-desktop-desk-window-weather-refinement.md) | 原生窗口、独立受光玩偶、画室拍立得、分层雨雪和室内外风动 |
| [203 书桌 v0.1.1 窗口与场景细化](203-desktop-desk-window-and-art-refinement.md) | dev 品牌图标、满幅窗口、书脊和场景重渲染及本机验证 |
| [202 书桌 Windows 前端初版](202-desktop-desk-windows-v1.md) | Windows x64 便携 EXE、物件交互、本地时间和四季天气，含本机实现方验证 |
| [201 桌面书桌首版样机实施记录](201-desktop-desk-preview-record.md) | FE-01、FE-02 的可运行离线样机、光照资产与实现方自验，待画面评审和独立复核 |
| [200 桌面前端开发与视觉优化计划](200-desktop-frontend-development-plan.md) | DL-131 的实施计划草案，覆盖书桌美术基准、环境分层、对话与角色切换、本地 API 联调和桌面交付 |
| [199 首轮后端功能缺口复核修复记录](199-p5-gaps-review-fix-record.md) | R01～R06 实现方修复、自验及 R01 两轮补修。后续独立结论见 198 |
| [198 首轮后端功能缺口独立复核](198-p5-capability-gaps-independent-review.md) | 统一离线验收 21 步通过，R01 提交前与提交后恢复均通过，R01～R06 在本机离线范围关闭 |
| [197 首轮后端功能缺口实施与自验记录](197-p5-capability-gaps-implementation-record.md) | GAP-01～GAP-06 实现、接管修复与自验证据；192 项测试及统一离线验收 21 步通过；其后 198 复核未通过，修复见 199 |
| [196 首轮后端功能缺口与补齐计划](196-backend-capability-gap-plan.md) | 六项首轮缺口、角色清单准备，以及待确认的管理与体验候选和同类功能排查；六项已实施并通过本机离线独立复核 |
| [195 P5 后端原型整体独立复核](195-p5-independent-review.md) | 整体复核通过，15 步、59 个业务场景与 4 项验收故障契约通过，首轮本机后端源码原型收口 |
| [194 P5 后端原型交付与自验记录](194-p5-prototype-delivery-record.md) | 保留 15 步实现方自验；后续整体独立复核已由 195 通过，P5 首轮原型范围收口 |
| [193 P5 后端原型复核与交付开发文档](193-p5-prototype-delivery-guide.md) | P5 范围、交付与证据规则；P5-01～P5-05 已由自验及 195 后续独立复核完成 |
| [192 产品介绍：视觉风格与设计语言探索](192-product-introduction-for-visual-direction.md) | 面向外部 AI 的简要产品背景，概括主体、功能与设计探索目标；不固定视觉方向或页面原型 |
| [191 P4 恢复缺口修复记录](191-p4-recovery-fix-record.md) | 第 10 节最终补修自验及第 11 节用户接受收口保留；最后补修已获 195 后续独立复验 |
| [190 P4 恢复、执行真实性与规则组合验收报告](190-p4-recovery-acceptance-report.md) | 第 13 节用户确认 P4 收口，进入 P5；最终补修为自验，历史独立结论和未验证范围保留 |
| [189 P3 独立复核修复记录](189-p3-independent-review-fix-record.md) | 历史修复与自验保留；188 第 7 节已独立复验通过，P3-R01～R06 关闭，142 项回归及 11 个边界场景通过 |
| [188 P3 自主安排、唤醒与额度独立复核](188-p3-independent-review.md) | 第 7 节最终通过：142 项回归、11 个边界场景，P3 六项关闭；离线复核通过，未提交、未推送，真实 P3 与后续阶段另验 |
| [187 P3 自主安排、唤醒与额度实施记录](187-p3-autonomy-implementation-record.md) | 首轮 119 项回归与 14 项 P3 专项自验保留；复核缺口与修复见 188、189 |
| [186 P3 自主推进开发文档](186-p3-autonomy-development-guide.md) | P3 范围、工作包、存储／额度／唤醒／工具／API 工程契约与验收矩阵；工程稿不构成新增用户决定 |
| [185 P2-06 R05／R09 阻断修复记录](185-p2-06-r05-r09-fix-record.md) | 实现方修复与 105 项自验保留；R05／R09 已由 184 第 7 节独立复验关闭，真实形成／召回已补齐 |
| [184 P2-06 阶段验收报告](184-p2-06-acceptance-report.md) | 第 7 节最终通过：105 项回归、20 个离线及 4 项真实复验，R01～R09 关闭；P2 首轮后端范围收口，可进入 P3；首轮失败证据保留 |
| [183 P2-05 复核问题修复记录](183-p2-05-review-fix-record.md) | 历史修复自验保留；第 12 节模型停用续行补正已通过 182 第 6 节复验；新真实验收阻断见 184 |
| [182 P2-05 独立开发复核](182-p2-05-independent-review.md) | 历次问题与复验记录；R01～R09 最终关闭，R05／R09 真实复验与 P2 收口见 184 第 7 节 |
| [161 数字生命方向与持续决策](161-digital-life-direction-decisions.md) | 用户逐项确认的需求与修订，当前记录至 DL-136，含角色自主选择服饰与素材导入 |
| [162 首轮后端原型实施方案](162-backend-prototype-implementation-plan.md) | R1～R64 已确认，首轮实施基线已定；P0 已实施并自验，后续工程契约按阶段落实 |
| [163 设计与方案一致性核对](163-design-consistency-review.md) | 本轮文档核对，记录已修正遗漏、需求覆盖、未采用底稿条款和剩余待讨论问题；非运行验收或独立复核 |
| [164 首轮后端原型执行清单](164-backend-prototype-execution-checklist.md) | R64／DL-129 确认的阶段入口；P0、P1 已通过，P2-01 契约已建立 |
| [165 后端开发文档：P0 技术小样](165-backend-development-guide.md) | 面向实施的工作包、最小职责、验收用例与证据模板；已补充实际运行命令与自验状态 |
| [166 P0 技术小样实施记录](166-p0-implementation-record.md) | P0-01～P0-04 实现、实际版本、运行证据、自验结论与限制；已追加 R01～R04 及 168 的 L01／L03／L06 修正与复验记录 |
| [167 P0 独立复核记录](167-p0-independent-review.md) | 保留首轮问题及修正后独立证据；37 项检查、5 个原场景及 4 个真实强杀场景通过，R01～R04 已关闭 |
| [168 P0 复验遗留修复清单](168-p0-followup-fix-list.md) | 第 2～6 节保留 9 项原始意见，第 7 节为逐项核对；L01、L03、L06 已修正并通过独立复核，L02／L04／L05／L07／L08／L09 不修改实现或留待 P1／P4 |
| [169 P1 开发文档：角色、存储与资源配置](169-p1-role-storage-development-guide.md) | P1 范围、数据／API 契约草案、6 个工作包与离线验收；契约已由 170 固定，P1-02～P1-05 已自验，工程草案不作为新增用户决定 |
| [170 P1-01 角色与存储工程契约](170-p1-01-contract.md) | 固定目录、appRoot、schema、初始化、HTTP／CLI、错误、凭据策略及验收边界；P1-02～P1-05 已按此实现 |
| [171 P1 实施记录](171-p1-implementation-record.md) | 实现方证据及历史轮次分别保留；P1-01～P1-06 完成，最新独立结论见 172 第 12 节 |
| [172 P1 独立开发复核](172-p1-independent-review.md) | 历次问题及修正、独立证据；第 12 节最终通过，13 个测试及三组共 13 个场景通过 |
| [173 P2 开发文档](173-p2-memory-agent-development-guide.md) | 完整记忆、检索维护、Agent 对话、模型和本地扩展的范围与工作包；P2-01 契约已由 174 固定 |
| [174 P2-01 事件记忆与对话执行契约](174-p2-01-memory-agent-contract.md) | 固定业务库 v2／迁移、证据与批次、事件／摘要／日记、检索召回、SSE、模型端口、API／CLI、中文样例与验收 |
| [175 P2-02 记忆形成与保存实施记录](175-p2-02-memory-formation-record.md) | 迁移、证据、触发、分批分段、离线整理、事件索引、defer、失败退避与 18 项用例；实现方自验，待独立复核 |
| [176 P2-03 检索、维护与主观记忆实施记录](176-p2-03-memory-query-record.md) | 中文检索、证据追溯、召回统计、100 轮精炼、事件／摘要纠错、日记 Markdown、HTTP／CLI 与 11 项用例；实现方自验，待独立复核 |
| [177 P2-04 模型与本地扩展实施记录](177-p2-04-model-extension-record.md) | 原实现方证据保留；本地离线范围已通过 178 第 6 节独立复验 |
| [178 P2-04 及前置工作包独立复核](178-p2-04-independent-review.md) | 首轮失败及补修证据保留；第 6 节最终通过，R01～R06 关闭，58 项回归与 27 个复验场景通过 |
| [179 P2-04 复核问题修复记录](179-p2-04-review-fix-record.md) | 实施方六项修正、完整续轮和空终态回退的自验；已通过 178 第 6 节独立复验 |
| [180 P2-05 Agent 对话联动实施记录](180-p2-05-agent-conversation-record.md) | 历史 77 项实施方自验保留；独立复验问题已关闭，完整 P2 最终证据见 184 第 7 节 |
| [181 P2-06 全量验收自验矩阵（草案）](181-p2-06-self-acceptance-matrix.md) | 历史实施方测试映射保留；P2 最终独立复验与真实联调通过范围见 184 第 7 节，后续阶段继续另验 |
| [用户参考底稿](design/digital-life/langgraph-roleplay-engine-v2.reference.md) | 原样保存的参考材料，未整体采纳 |

旧项目的完整设计时间线、代码和验收记录保留在 `dev` 分支。它们可以作为参考，不直接构成新主线的兼容要求或验收证据。

新旧分支布局保持：`dev` 保留旧代码与历史，`master` 保存既有设计基线。P0、P1 在各自本地开发分支完成独立复验；本轮将 P1 源码、记录及 P2 准备稿纳入用户要求的本地提交，不推送或合并。具体源码版本以包含本记录的 Git 提交为准。
