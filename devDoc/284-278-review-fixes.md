# 284 操作链路简化复核问题修复（283 R01～R09）

2026-11-12。按 [283 独立复核](283-278-workflow-simplification-independent-review.md) 修复整条链路的九项问题，并补齐定向回归用例。本文为实现方自验记录；283 所列复验条件仍需独立复核确认。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| R01 模型维护并发 | 模型连接变化的写入进入目标服务维护窗口：期间拒绝新增启用绑定、拒绝仍依赖该服务的角色恢复活动，并在调度层跳过目标服务的新执行、任务续行、自主唤醒与后台记忆调用。停止等待结束后重新解析实际依赖，出现未暂停的依赖角色时返回 409 `RESOURCE_MAINTENANCE`；成功、失败或取消都释放窗口并唤醒可运行工作。无关服务的角色可继续运行与恢复。 |
| R02 模型恢复后的调度 | 模型服务启用、连接或凭据变化后唤醒所有已初始化角色的待处理消息与任务续行；恢复记忆整理队列；绑定保存后唤醒该角色。窗口因失败被拉黑后，用原提交标识重试会解除阻塞并重新调度原消息。 |
| R03 任务终结资源占用 | 终结任务不再立即关闭资源续用记录：仍有在途工具调用、后台工具结算或连接收尾时保留占用，结算与目录关闭后再释放。资源引用报告把「已终结但仍未结算工具调用」的任务继续计入 `TASK_CHAIN`，修改与删除保持受阻；已发出的后台工具结算仍写回原任务。 |
| R04 影响范围解析 | 新增与运行时共用的 `usageTargets`：对话取启用且资源可用的对话绑定，记忆先取可用的独立记忆绑定、不可用时回退对话模型。影响报告、维护前暂停与提交前重查使用同一规则；全局停用且无续用的资源不列入依赖，只有旧任务依赖时不暂停角色，由调度按任务暂缓。 |
| R05 保存失败后的暂停 | 抽出 `validateUpdate`，跨站点凭据、密钥冲突、占用检查等在暂停角色之前完成。停止后写入仍失败时，错误详情携带本次 `maintenance.pausedRoleIds`；资源详情保留草稿并直接提供「继续本次活动暂停的角色」。 |
| R06 绑定合并 | 新增 `mergeBindingDrafts`：对话与记忆按能力合并，同一能力被两边改成不同目标时报冲突并保留草稿、要求重读；MCP／Skill 继续按「能力＋资源」逐项合并。 |
| R07 对话页就地恢复 | 页面已知角色停止、或发送被后端以 `ROLE_ACTIVITY_STOPPED` 拒绝时，输入区都显示「恢复活动」。恢复保留原角色、窗口和草稿；被拒绝的消息未入库，恢复后由用户重新提交，原提交标识仍可复用。 |
| R08 参考录音写入 | 参考录音上传与删除接入 `guardWrite`：先暂停角色、后端确认停止后执行，完成后可在原处继续活动。试听与读取不触发暂停。 |
| R09 导入部分失败 | 批量导入部分失败时保留预览；已成功的服饰重读后显示为重名，原处再次导入只提交仍未成功的套，不重复上传。 |

## 2. 变更文件

- 后端：`resource-service.ts`（维护窗口、共用解析、预校验、唤醒）、`conversation-service.ts`（调度暂缓、恢复唤醒、窗口重试、资源延迟释放）、`role-store.ts`（未结算工具占用、任务续用查询）、`model-binding-resolver.ts`（`usageTargets`／任务目标）、`memory-runtime.ts`（维护暂缓与唤醒）、`role-activity-service.ts`（恢复守卫）、`routes.ts`（维护流程与失败详情）、`app.ts`（装配顺序与回调）。
- 桌面：`Settings.tsx`（失败后恢复入口、按用途合并）、`components/model/binding-merge.js`（新增）、`Conversation.tsx`／`ChatPane.tsx`／`use-window-session.ts`（就地恢复与拒绝状态）、`VoicePanel.tsx`（录音写入保护）、`AppearancePanel.tsx`（失败保留预览）、`api.ts`（错误详情）。
- 测试：`backend/tests/p18-278-review-fixes.test.ts`（R01～R05 与 R03 后台工具场景）、`desktop/desk-preview/tests/binding-merge.test.cjs`（R06 合并规则）。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p18-278-review-fixes.test.ts` | 6／6 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 364／364 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查 | `desktop/desk-preview/renderer && npm run typecheck` | 通过 |
| 渲染端构建 | `desktop/desk-preview/renderer && npm run build` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 112／112 |

验收报告：`backend/test-results/p5-2026-11-12T07-52-02-848Z-0b743b48/summary.json`。

新增用例覆盖：

1. 模型维护期间无关角色可恢复、新增绑定与依赖角色恢复被拒绝，操作结束后同一角色可恢复。
2. 停用模型后消息返回 `MODEL_MISSING`，重新启用后自动只产生一次回复。
3. 窗口失败后用原提交标识重试，解除阻塞并只保留一条用户消息和一次回复。
4. 独立记忆模型全局停用后按回退计入对话目标；停用且无续用的资源不扩大暂停范围。
5. 跨站点沿用旧密钥在暂停角色之前返回 400，角色保持活动。
6. 发出后台工具调用、关闭角色绑定后终结任务：结算与连接收尾前扩展仍被占用，结算后释放且结果记在原任务上。
7. 绑定合并的三类规则：互不重叠自动合并、同用途冲突、扩展逐项合并。

## 4. 交接边界

- 本文为实现方自验；Electron 端的 R06、R07、R08、R09 交互与完整视觉对照仍需独立复核。
- [283 第 3 节](283-278-workflow-simplification-independent-review.md#3-待实施与待验收) 所列的句段标注、过场图规划的维护期统一拦截，以及角色删除同页流程、草稿生图、未保存录音试听、设置导航收敛仍未实施。
- 真实模型、TTS、生图服务与桌面交付继续按 278、279 的联调场景单独验收。
