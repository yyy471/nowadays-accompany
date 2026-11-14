# 266 角色配置与设置前端复核修复

2026-11-11。修复 [266](266-role-settings-frontend-independent-review.md) 的 CF-R01～CF-R05，并补修实际后端的角色设定保存响应处理。原场景均已通过独立复验。 [266 补修复验](266-role-settings-frontend-independent-review.md#267-补修-cf-r05-独立复验)

## 修复

- **CF-R01**：收到 `BINDING_REVISION_CONFLICT` 后清除旧版本、禁止继续提交，并提供「重试读取绑定」。重读成功后保留用户已修改的模型和扩展草稿，把没有修改的字段更新为服务端最新值；再次保存时使用新版本与最新的另一组绑定。重读失败仍禁止提交，可重试。
- **CF-R02**：删除请求成功后立即从本地列表移除角色并为被删的陪伴角色选择剩余角色，再同步后端列表。同步失败时在配置页面显示原因和重试入口；删除前已经发出的列表请求即使晚返回，也不能恢复已删除角色。
- **CF-R03**：取消角色、服饰和差分删除后，焦点回到对应的删除入口。
- **额外修复**：实际后端的角色设定 PATCH 只返回新版本和更新时间，前端改为用已提交的表单和新版本更新保存快照。之前误以为响应包含完整角色详情，导致实际保存成功后前端报错。模拟后端响应已同步修正。

## 实现方验证

- 前端 `npm run typecheck` 与 `npm run build` 通过；构建保留既有 `api.ts` 混合导入提示。
- Node 24 运行 `desktop/desk-preview/tests/*.test.cjs`：98／98 通过。
- `settings-review-fixes-check.cjs` 使用临时实际后端和 Electron，覆盖模型及扩展两个方向的绑定冲突、重读失败后重试、另一组的最新绑定保留、角色删除后列表一次 503、旧列表请求晚返回、显式重试，以及角色／服饰／差分取消删除的焦点。测试同时经过实际角色设定保存接口。全部通过，未调用真实外部服务。
- `settings-real-backend-check.cjs` 和 `settings-workspace-check.cjs` 重跑通过，覆盖原有外观、删除和双页流程。界面截图测试与另一 Electron 测试并发时曾出现一次主题截图时序差异；单独重跑通过，此结果不作为并发稳定性的证明。

未修改后端代码，未提交或推送。真实模型、语音与生图服务仍未在本轮调用。

## 266 复验追加 CF-R04 补修

自动刷新与冲突后重读统一使用同一份三方合并逻辑，以重读前的已保存绑定为基线：用户未修改的模型或扩展跟随最新绑定，已修改的草稿保留；已删除资源从草稿移除。版本同步到本次读取结果，后续写入仍由后端版本校验保护。

实现方验证：

- 直接重跑 `backend/test-results/review-267/binding-auto-reload.cjs`，原复现场景通过：对话模型草稿保留，另一客户端的记忆模型服务和 ID 被读取并在后续保存中保留。
- 新增 `desktop/desk-preview/tests/settings-auto-reload-check.cjs`，临时实际后端与 Electron 额外覆盖反向组合：本地修改记忆模型和一个扩展，外部修改对话模型和另一扩展，删除无关资源触发自动刷新；两组草稿与外部更新均正确合并，分别保存模型和扩展时不隐式提交另一组草稿。
- 前端类型检查、构建、98 项桌面单测、`settings-review-fixes-check.cjs` 和 `settings-workspace-check.cjs` 通过；构建保留既有混合导入提示，真实外部服务调用 0 次。 [266 独立复验](266-role-settings-frontend-independent-review.md#267-补修-cf-r04-独立复验)

## 266 复验追加 CF-R05 补修

- 首次绑定读取失败时，模型和扩展分区都提供重试；重试成功后将绑定标为已加载，显示最新模型和扩展。首次读取成功之前不允许修改未知的扩展绑定。
- 冲突导致绑定版本失效后，即使用户选择放弃草稿并切换角色，也保留读取错误和恢复入口；切回后可重新读取服务端最新绑定，再编辑和保存。入口由绑定版本是否可用与读取状态决定，不依赖草稿是否仍然存在。
- 原复现脚本 `backend/test-results/review-267-cf04/binding-read-recovery.cjs` 通过。新增 `desktop/desk-preview/tests/settings-binding-recovery-check.cjs` 使用临时实际后端和 Electron，覆盖首次读取与再次读取均失败后的重试、模型／扩展分区恢复入口、切换角色放弃草稿后读取最新值及继续保存。
- 前端类型检查、构建、98 项桌面单测、`settings-auto-reload-check.cjs`、`settings-review-fixes-check.cjs` 和 `settings-workspace-check.cjs` 通过。构建保留既有混合导入提示，真实外部服务调用 0 次。 [266 CF-R05 独立复验](266-role-settings-frontend-independent-review.md#267-补修-cf-r05-独立复验)
