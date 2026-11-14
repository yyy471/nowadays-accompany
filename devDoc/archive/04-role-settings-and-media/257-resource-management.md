# 252 第二包 · 模型与扩展资源管理实施记录

> **现行规范入口**：本文资源引用报告、绑定整表替换与两阶段删除契约已整合并入 [角色配置、全局资源与活动守卫规范](../../specs/role-config-and-activity.md)（含后续模型依赖维护窗口及 MCP/Skill 全局停用放行的演进说明）；下文保留第二包实施与自验记录。

2026-11-11。按 [252 第 2 节第二包](252-role-config-settings-development-plan.md#第二包--模型与扩展资源管理) 实施，第 4 节确认的范围是：不纳入独立「已保存模型」条目，不纳入全局 TTS 目录，沿用「服务 + 模型 ID」与每角色一份语音配置。占用规则以 [236 第 8 节](236-role-settings-backend-gap-review.md#8-已确认的配置操作规则) 为准。

## 1. 交付范围与结论

| 252 要求 | 实现 | 用例 |
| --- | --- | --- |
| 配置闭环：建角色 → 配对话服务 → 保存绑定 → 启动对话并收到回复 | 复用现有接口跑通；绑定写入属角色配置写入，先由后端确认停止，保存后恢复活动 | p15 `配置闭环：建角色、配服务、存绑定后可以对话` |
| 同时验收独立记忆模型与跟随对话 | 有独立记忆模型时用它，未绑定时跟随对话模型；记忆运行时按解析结果建模型 | p15 `独立记忆模型可单独绑定，未绑定时跟随对话模型` |
| 绑定整表替换的调用方约定与冲突保护 | 读视图返回 `revision`；写回整表；`expectedRevision` 过期返回 409 | p15 `绑定整表替换支持版本冲突保护`；约定见第 4 节 |
| 全局资源删除与引用检查 | `GET /v1/resources/:id/references` 定位角色、能力、任务与原因；`DELETE` 按报告决定放行或拒绝 | p15 `删除资源前检查角色选择与未结束任务链`、`关闭的角色绑定不拦删除，删除后绑定一并清理` |
| MCP／Skill 修改、删除、全局关闭的占用检查 | 角色开启或未结束任务链都算占用；修改与全局关闭在服务层拦截 | p15 `MCP 修改与全局关闭检查角色开关和未结束任务链` |
| 资源列表与错误响应提供脱敏摘要 | MCP 环境变量值统一为 `***`，`redacted` 标记；密钥仍只出现在凭据摘要 | p15 `资源列表与详情脱敏 MCP 环境变量` |

## 2. 接口与数据结构

| 方法与路径 | 说明 | 主要状态码 |
| --- | --- | --- |
| `GET /v1/resources/:resourceId/references` | 资源引用报告 | 200、404 |
| `DELETE /v1/resources/:resourceId` | 删除全局资源，清理密钥与关闭的绑定 | 200、404、409 `RESOURCE_IN_USE` |
| `PATCH /v1/resources/:resourceId` | 修改或全局关闭；占用时拒绝 | 200、409 `RESOURCE_IN_USE` |
| `GET /v1/roles/:roleId/bindings` | 绑定整表 + `revision` | 200 |
| `PUT /v1/roles/:roleId/bindings` | 整表替换，可带 `expectedRevision` | 200、409 `BINDING_REVISION_CONFLICT` |

引用报告：

```json
{
  "resourceId": "…",
  "kind": "mcp",
  "references": [
    { "roleId": "…", "capability": "mcp", "bindingEnabled": true, "reason": "ROLE_BINDING" },
    { "roleId": "…", "capability": null, "bindingEnabled": null, "reason": "TASK_CHAIN",
      "taskId": "…", "taskStatus": "paused" }
  ],
  "canUpdate": false,
  "canDisable": false,
  "canDelete": false
}
```

占用错误：`409 RESOURCE_IN_USE`，`details = { resourceId, action, references }`，`action` 取 `UPDATE`／`DISABLE`／`DELETE`。版本冲突：`409 BINDING_REVISION_CONFLICT`，`details = { roleId, expected, actual }`。

CLI 增加 `resource references --id` 与 `resource delete --id`，与 HTTP 同源。

## 3. 占用判定

两类引用都算占用：

- `ROLE_BINDING`：任一 `ready` 角色的绑定行指向该资源，`bindingEnabled` 记录该开关状态。
- `TASK_CHAIN`：`task_resource_continuations.ended_at IS NULL` 且任务仍是 `active`／`paused`。终态任务留下的未关闭记录不算占用，由既有清理逻辑收尾。

派生结论：

| 字段 | 判定 |
| --- | --- |
| `canUpdate`／`canDisable` | MCP／Skill：无启用中的绑定且无未结束任务链。模型服务恒为 `true`，修改与关闭由「所有角色已停止」守卫负责（236 第 8 节第 4 行） |
| `canDelete` | 无启用中的绑定且无未结束任务链；关闭的绑定不拦（236 第 8 节第 5 行末句） |

删除前先完成引用检查与角色库预检，角色库读不到时直接失败，不静默跳过（RP-R02、RP-R03）。[259](259-role-activity-resource-review-fixes.md) 第 6～7 节起，资源删除与待清理记录在全局库同一事务提交，角色库绑定清理与资源删除放进跨连接的一组事务：决策提交前的失败全部回滚，提交后的中断或清理失败由待清理记录、读侧过滤和启动恢复继续收敛。

模型服务与扩展资源的差别来自产品规则本身：扩展的「关闭」是角色侧开关，关掉后绑定仍保留，因此关闭的绑定不该拦删除；模型的「关闭」意味着角色暂时没有可用模型，删除前要求先解绑更安全，实现上同样由 `canDelete` 覆盖（启用中的绑定一律拦）。[259](259-role-activity-resource-review-fixes.md) 起 `PATCH`／`DELETE /v1/resources/:resourceId` 按资源类型分流守卫：模型资源仍要求全角色停止，MCP／Skill 只按本节的占用规则判断。

## 4. 绑定整表替换的调用方约定

`PUT` 仍是整表替换，调用方按三步走：

1. `GET /v1/roles/:roleId/bindings` 取 `items` 与 `revision`；
2. 在 `items` 上增删改本次要动的能力，其他能力的绑定原样回传；
3. 带上 `expectedRevision: revision` 提交。服务端重算当前表的 revision，不一致返回 409，调用方重新读取后再保存。

不带 `expectedRevision` 时按「最后写入生效」处理，兼容脚本与旧调用方。`revision` 是规范化后的内容摘要：按 `capability`、`resourceId`、`modelName`、`enabled` 拼行、排序、`sha256` 取前 16 位，与行顺序和写入时间无关。

## 5. 脱敏

- 列表、详情、创建与修改的响应里，MCP 的 `config.env` 值统一为 `***`，键名保留；`redacted` 表示本次是否真的遮蔽了值。
- 页面把 `***` 原样提交时表示「保持原值」，服务端用库里的真实值回填；其他字段按提交值覆盖。这样未编辑的保存不会把环境变量写成占位符。
- 模型密钥不进任何读视图，仍只通过 `credential` 摘要暴露是否已配置、来源与指纹。
- 错误响应只带角色、能力与任务标识，不带配置内容。

## 6. 既有用例的适配

占用检查落在服务层，因此「运行期间资源被外部改动」这一类既有用例不再走 `resources.update`，改为直写存储层。断言一律未改，改的只是制造前置状态的方式。

| 文件 | 原做法 | 改法 |
| --- | --- | --- |
| `tests/p2-05-skill.test.ts` | 会话中途改 Skill 的 `sourcePath` | `updateResourceConfigDirect`，模拟目录被外部换掉 |
| `tests/p2-05-mcp.test.ts` | 中途全局关闭 MCP、中途改 MCP 配置 | `disableResourceDirect`／`updateResourceConfigDirect` |
| `tests/p3-03-autonomy-scheduling.test.ts` | 关闭 Skill 后看下一条自主链 | `disableResourceDirect` |
| `tests/p3-review-fixes.test.ts` | 关闭 MCP／模型、把 MCP 命令改成不存在的 | `disableResourceDirect`／`updateResourceConfigDirect` |
| `tests/p5-skill-run.test.ts` | 关闭 Skill 后看工具是否消失 | `disableResourceDirect` |
| `reviews/20261104-p2-05-review.ts` | R02 中途改 MCP 环境变量 | 先读库里的原始配置再写回，避免用到脱敏后的 `***` |
| `reviews/20261104-p3-review.ts` | 关闭 MCP 后恢复额度 | 直写存储层 |
| `reviews/20261104-p4-recovery-recheck.ts` | 强杀前关闭全部资源 | 直写存储层 |
| `reviews/20261106-p5-background-tools.ts` | 关闭资源后结束任务 | 直写存储层 |
| `reviews/20261106-p5-task-decisions.ts` | 关闭 MCP 后另起目标 | 直写存储层 |
| `reviews/20261106-p5-skill-run.ts` | 关闭 Skill 后看工具是否消失 | 直写存储层 |

这些用例验证的是运行期取舍（原链保留、下一轮不再提供、每次派发重读配置），不是配置写入规则；规则本身由 p15 的 HTTP 用例把关。

## 7. 验证

| 项目 | 结果 |
| --- | --- |
| 类型检查 | `tsc --noEmit` 通过；复核脚本按严格参数单独检查通过 |
| 全量测试 | 332／332 通过 |
| 离线验收 | 21／21 步通过，`realServiceCalls=0`、`sourceUnchanged=true`，报告 `backend/test-results/p5-2026-11-11T06-49-58-583Z-5db9b52a/summary.json` |
| 定向用例 | `tests/p15-resource-management.test.ts` 7 项通过 |

离线验收中 16 个复核矩阵全部通过，其中 6 个按第 6 节改了制造前置状态的方式。

## 8. 变更清单

- 服务：`src/application/resource-service.ts`（引用报告、删除、占用检查、绑定 revision、MCP 脱敏与回填）。
- 存储：`src/storage/app-store.ts`（删除资源与测试记录）、`src/storage/role-store.ts`（未结束任务链查询、按资源清理绑定）。
- 接口：`src/http/routes.ts`、`src/http/schemas.ts`（`expectedRevision`）、`src/domain/errors.ts`（两类 409）。
- 命令行：`src/cli/commands.ts`（`resource references`／`resource delete`）。
- 用例：新增 `tests/p15-resource-management.test.ts`；`tests/p2-05-fixture.ts` 增加两个直写辅助；第 6 节列出的 11 个文件按表调整。

## 9. 交接边界

- 本包为实施方自验，等待独立复核；复核通过前不启动 [253 前端接入](253-role-config-settings-frontend-plan.md)。
- 第三包（外观、删除与历史数据）未开始；角色删除的两条数据路径、服饰删除与历史素材保留仍待实施。
- 未纳入本包：独立「已保存模型」条目、全局 TTS 目录。模型选择仍是「服务 + 模型 ID」，语音仍是每角色一份配置。
- 页面接入时注意三点：绑定保存要回传整表并带 `revision`；MCP 环境变量的 `***` 表示保持原值；删除前先取引用报告，用 `canDelete` 决定按钮状态，用 `references` 说明原因。
