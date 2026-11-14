# 289 283 第 8 节复验问题修复

2026-11-12。按 [283 第 8 节复验](283-278-workflow-simplification-independent-review.md#8-288-补修独立复验) 修复两处相邻操作路径缺口。第 7 节的两个原场景在该轮复验中通过。本文为实现方自验记录，复验仍由独立复核确认。283 第 9 节复验后的补修见 [290](290-283-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| R01 删除跳过在途调用 | 资源引用报告新增 `INFLIGHT_CALL`：目标服务上仍有在途模型调用时，即使角色已改绑或任务已终结，`canDelete` 也为 false。删除返回 409 `RESOURCE_IN_USE` 并说明是后台调用仍在进行，旧调用结算后重试即可删除；检查按目标服务计算，无关服务不受影响。资源详情在模型与扩展的占用列表中显示「后台调用进行中，稍后重试」，不提供错误的绑定操作。 |
| R02 回执丢失后的重复发送 | 窗口快照确认某条原提交已入库时，除结束重试记录外，同时发出草稿收敛信号。对话页与输入区收到后，如果当前草稿与该已确认消息文本一致就清空草稿并同步草稿映射；用户无需重输，也不会在未修改的情况下把同一次发送再提交一次。用户事后手动重新输入相同文本仍作为新消息发送；只有尚未确认的提交保留去重保护。 |

## 2. 变更文件

- 后端：`errors.ts`（引用原因加入 `INFLIGHT_CALL`）、`resource-service.ts`（引用报告汇总在途调用并拦截删除）、`tests/p18-278-review-fixes.test.ts`（删除占用用例）。
- 桌面：`use-window-session.ts`（快照确认发出草稿收敛信号）、`Conversation.tsx`／`ChatPane.tsx`（按内容清空恢复草稿）、`Settings.tsx`（在途占用显示）。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p18-278-review-fixes.test.ts` | 13／13 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 372／372 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 114／114 |

验收报告：`backend/test-results/p5-2026-11-12T11-11-24-274Z-3541aef8/summary.json`。

新增用例覆盖：

1. 记忆调用挂起时角色改绑到其他服务，旧服务引用报告返回 `INFLIGHT_CALL` 且禁止删除；DELETE 返回 409 并保留服务。
2. 同一时间无关服务可以删除；旧调用结算后旧服务删除成功，再查询为 404。

## 4. 交接边界

- 本文为实现方自验；R02 的响应丢失与切窗草稿收敛仍需按 Electron 场景复验。
- [283 第 3 节](283-278-workflow-simplification-independent-review.md#3-待实施与待验收) 所列的句段标注与过场图规划维护期拦截、角色删除同页流程、草稿生图、未保存录音试听、设置导航收敛仍未实施。
