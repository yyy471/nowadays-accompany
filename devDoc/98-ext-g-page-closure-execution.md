# EXT-G 页面闭环执行记录

日期：2026-10-27。状态：EXT-G 实现与自验完成，待独立复核。未提交、未打包、未替换 EXE，也未调用真实 QQ 或付费模型。

> 99 号独立复核后的修复见[100 EXT-G 复核修复](100-ext-g-review-fixes.md)。本文关于私有定义不保存 `enabled`、刷新入口和全量数字的表述以 100 号为准。

依据：[79 Agent 主体、统一工具与扩展作用域方案](79-agent-extension-execution-plan.md) §8/§9、[80 验收标准](80-agent-extension-acceptance.md) U01–U05、E05，以及[97 EXT-E/F 修复收口](97-ext-e-f-final-independent-recheck.md)的放行结论。

## 1. 结论

EXT-G 在本地自动化与隔离预览范围内完成：扩展策略 HTTP 接口、插件与Skill 页面（账号插件/工具授权/Skill）、资源库公用 Skill 管理、按会话有效状态、草稿与失败态、导航与旧入口清理，以及 E05 真实 Core 端到端闭环。全量 116 文件、1089 项通过、1 项既有跳过；完整类型检查、桌面构建与已跟踪 diff 空白检查通过。

本轮属于实现方自验，不等同于阶段验收。按复核门控流程，EXT-G 仍需独立复核并复跑正式回归后才能收口；EXT-H 的整体验收、真实 QQ、付费模型、Electron 原生交互与发行包仍不在本轮范围。

## 2. 交付

### G-A 契约、策略服务与 HTTP

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 共享 DTO | [extensions.ts](file:///D:/app/nowadays/accompany/src/contracts/extensions.ts) | 策略 patch、更新信封、目录、运行状态、有效视图与重载结果，后端与 renderer 共用同一契约 |
| 策略读取带运行状态 | [extension-policy-service.ts:66](file:///D:/app/nowadays/accompany/src/application/extensions/extension-policy-service.ts#L66) | 返回 `revision`/`profileRevision`/`configVersion`、授权工具、三档开关、目录及 `runtime`；`readyPlugins`/`readyTools` 只在同步成功且插件 ready 时计算，不把安装误当就绪 |
| 局部 CAS 更新 | [extension-policy-service.ts:121](file:///D:/app/nowadays/accompany/src/application/extensions/extension-policy-service.ts#L121)、[extensions.ts:72](file:///D:/app/nowadays/accompany/src/service/routes/extensions.ts#L72) | `PUT /accounts/:id/extensions/policy` 要求 `expectedRevision`，可选 `expectedProfileRevision`；过期返回 `extension_conflict`→409；授权工具必须在目录内 |
| 有效状态 | [extension-policy-service.ts:104](file:///D:/app/nowadays/accompany/src/application/extensions/extension-policy-service.ts#L104)、[extensions.ts:41](file:///D:/app/nowadays/accompany/src/service/routes/extensions.ts#L41) | `GET /accounts/:id/extensions/effective?kind=&peerId=`，缺少范围返回 `invalid_scope`；只读解析工具/钩子/Skill/共享状态及来源、问题，不执行工具 |
| 显式重载 | [plugin-runtime-service.ts:31](file:///D:/app/nowadays/accompany/src/application/extensions/plugin-runtime-service.ts#L31)、[extensions.ts:58](file:///D:/app/nowadays/accompany/src/service/routes/extensions.ts#L58) | 记录最近一次握手状态；`POST /accounts/:id/extensions/reload` 关闭旧 runtime 后重新同步并返回新状态，不重放工具调用 |
| Core 与路由接线 | [core.ts:867](file:///D:/app/nowadays/accompany/src/core/core.ts#L867)、[routes/index.ts](file:///D:/app/nowadays/accompany/src/service/routes/index.ts) | 四个公共方法纳入 `#runPublicWork`；审计动作 `update_extension_policy`、`reload_extensions` |
| 静态 UI 前缀 | [static.ts:48](file:///D:/app/nowadays/accompany/src/service/http/static.ts#L48) | 补入 `skills`，避免生产静态 UI 把 `/skills` 当作 SPA 回退返回 index.html |
| 模型页不覆盖扩展子树 | [config-store.ts:135](file:///D:/app/nowadays/accompany/src/providers/config-store.ts#L135)、[model-settings-service.ts:239](file:///D:/app/nowadays/accompany/src/application/model-settings/model-settings-service.ts#L239) | 模型配置页整包保存账号策略时保留 `extensions`；旧 `enabledTools` 写入仍按原语义生效，避免破坏既有调用 |
| 状态持久化修正 | [types.ts:498](file:///D:/app/nowadays/accompany/src/providers/types.ts#L498) | `parseExtensionRunPolicy` 增加 `state` 合法键，账号共享状态的开关不再被解析器拒绝 |

### G-B 插件与Skill 页面

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 三个标签 | [Extensions.tsx:74](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L74)、[Extensions.tsx:565](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L565) | 账号插件、工具授权、Skill 共用账号级策略；账号选择和目标会话只在页面顶部选一次 |
| 作用域与精确 patch | [extensions-policy.ts:211](file:///D:/app/nowadays/accompany/desktop/renderer/src/lib/extensions-policy.ts#L211)、[Extensions.tsx:376](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L376) | 账号默认/会话类型/指定会话三档；保存时把目录与已存键全部写成明确值或 `inherit`，既清除旧覆盖又不会误改未展示字段 |
| 工具授权与运行开关 | [Extensions.tsx:745](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L745) | 账号授权是硬边界；运行开关只展示继承来源与解析结果，不自动开启未授权工具 |
| 目录、安装与重载 | [Extensions.tsx:737](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L737) | 插件行显示来源、版本、就绪/未加载；安装配置走账号 profile 草稿，重载按钮只在明确点击时调用接口并显示失败原因 |
| Skill 面板 | [Extensions.tsx:830](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L830) | 展示公用、私有覆盖公用、插件来源及停用原因；私有 Skill 可编辑/删除/新建/从公用复制 |
| 有效状态卡 | [Extensions.tsx:915](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L915) | 填写目标会话后展示工具/钩子/Skill/共享状态计数、提示词选择结果与 `runtimeMayTrim` 说明；明确不会调用模型或执行工具 |
| 草稿保护 | [Extensions.tsx:311](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L311)、[Extensions.tsx:347](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L347) | 策略、安装、私有 Skill 编辑器分别注册草稿 id；切账号、切标签、重新读取、撤销均走统一确认；账号代际守卫丢弃旧账号慢响应 |
| CAS 冲突 | [Extensions.tsx:405](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L405) | 冲突时保留当前草稿并提示刷新，不用旧 revision 覆盖 |
| 文案与原因标签 | [labels.ts](file:///D:/app/nowadays/accompany/desktop/renderer/src/lib/labels.ts) | 未安装、作用域关闭、未授权、依赖能力缺失、handler 未就绪、版本变化、预算未选中等原因统一映射 |

### G-C 资源库公用 Skill

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 公用 Skill 卡片 | [PublicSkillLibrary.tsx](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/PublicSkillLibrary.tsx)、[Artifacts.tsx:163](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Artifacts.tsx#L163) | 位于资源库，显示来源、工具数、说明字符与 kinds/peers 限制；新建/编辑/删除/刷新复用现有组件与确认控件 |
| 删除影响 | [PublicSkillLibrary.tsx:40](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/PublicSkillLibrary.tsx#L40) | 删除前读取 impact，列引用账号、私有覆盖与显式开关，确认后才带 CAS 删除 |
| 复制为私有 | [PublicSkillLibrary.tsx:66](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/PublicSkillLibrary.tsx#L66) | 先读私有 revision；同 id 覆盖需二次确认；提示复制后仍需在账号 Skill 作用域启用 |
| 共用编辑器 | [SkillDefinitionEditor.tsx](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/SkillDefinitionEditor.tsx) | 公用与私有共用表单；名称/正文/工具上限在提交前校验；保存使用当前 revision；编辑器打开期间禁用被替换的操作 |
| 私有编辑器草稿 | [SkillDefinitionEditor.tsx:33](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/SkillDefinitionEditor.tsx#L33) | 注册 `skill-<scope>:<account|public>:<id|new>` 草稿；取消/切换需确认，保存成功才结束草稿 |

### G-D 导航与旧路径清理

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 导航更名 | [App.tsx:48](file:///D:/app/nowadays/accompany/desktop/renderer/src/App.tsx#L48) | “账号插件”改为“插件与Skill”，副标题说明按账号管理生效范围 |
| 页面切换范围 | [App.tsx:212](file:///D:/app/nowadays/accompany/desktop/renderer/src/App.tsx#L212) | 设置页内切页只保护当前页；关闭设置后按全部草稿保护，避免跨页未保存内容丢失 |
| 账号页收窄 | [Accounts.tsx:110](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Accounts.tsx#L110) | 移除插件视图、插件安装状态与相关复制/checkbox UI，只保留资料与角色职责 |
| 模型页清理 | [Policy.tsx:395](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Policy.tsx#L395) | 删除旧的“允许 AI 调用的工具”和 Skill 可用性卡，改为指向“插件与Skill”页 |
| 文案回归 | [frontend-state-copy.test.ts](file:///D:/app/nowadays/accompany/test/frontend-state-copy.test.ts) | 断言新导航存在、旧工具区/账号插件卡不存在，防止回退 |

### G-E 测试与端到端

| 测试 | 代码 | 覆盖 |
| --- | --- | --- |
| 扩展 HTTP 集成 | [extension-api.test.ts](file:///D:/app/nowadays/accompany/test/extension-api.test.ts) | 真实 Core + 插件 fixture：目录/运行状态、CAS 409、非法工具 400、状态与范围开关、清除覆盖、缺少范围/revision、模型整包写入保留扩展子树、显式重载；并验证静态 UI 下 `/` 返回 HTML、`/skills` 返回 JSON |
| 页面渲染 | [extensions-page-renderer.test.tsx](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx) | 8 项：精确 patch、脏草稿切账号/切标签、旧账号慢响应、Skill 来源与只读预览、新建私有 Skill CAS、冲突保留草稿、重载失败原因、公用删除影响与复制 |
| E05 真实闭环 | [extension-skill-e2e.test.ts](file:///D:/app/nowadays/accompany/test/extension-skill-e2e.test.ts) | 真实 Core/假通道/捕获模型：公用创建→复制私有→群聊启用→实际请求包含说明→撤销工具授权→预览显示 `skill_tool_unavailable`→第二次请求不再注入说明与工具 |

## 3. 验收对照

| 项 | 证据 | 状态 |
| --- | --- | --- |
| U01 账号选择/启用/授权/配置/有效状态 | `extension-api.test.ts` 全流程 + 页面渲染第 1 项 + 隔离预览实际保存并回读 | 实现自验通过 |
| U02 公用 Skill 管理/复制/依赖缺失/继承覆盖 | `extensions-page-renderer` 第 4、5、8 项；E05；预览中公用 Skill 复制到 10001 后页面显示“私有覆盖公用” | 实现自验通过 |
| U03 切账号慢响应/草稿/CAS/重载失败 | 页面渲染第 2、3、6、7 项 | 实现自验通过 |
| U04 控件/焦点/弹窗/禁用态 | 复用 `ui` 导出与草稿保护；编辑期间禁用替换操作 | 实现自验通过 |
| U05 导航与配置清理 | 导航/账号页/模型页清理 + 文案回归 | 实现自验通过 |
| E05 Skill 闭环 | 真实 Core 用例通过；撤销工具后 `enabled:false`、`selected:false`、原因 `skill_tool_unavailable` | 通过 |

## 4. 隔离预览

使用 `test-results/ext-g/preview/config.json` 启动本地 Core（端口 7891、token `ext-g-preview`、独立数据目录、内置已构建 UI），未连接真实 QQ。

实际观察：

- 首屏为“插件与Skill”，账号 10001，三个标签与插件运行状态（未加载）正确显示。
- 勾选 `builtin.image.generate` 账号授权并把第一项运行开关设为开启后保存，页面提示“账号 10001 的扩展策略已保存”；回读接口得到 `authorizedTools=["builtin.image.generate"]`、`defaults.tools={"builtin.image.generate":"on"}` 与新 revision。
- 在资源库新建公用 Skill 并用“复制为私有”到 10001，提示复制成功；Skill 标签显示“私有覆盖公用”和继承开关。
- 填写群聊 `preview-group` 后出现有效状态卡：工具 0/3、Skill 0/1；由于预览 Core 未连接插件运行时，Skill 因 `public/plugin/demo/query` 未就绪未注入，与只读解析语义一致。

## 5. 运行证据

| 验证 | 实际结果 | 本地忽略输出 |
| --- | --- | --- |
| `npm test` | **116 文件全部通过；1089 项通过、1 项既有跳过，无失败** | `test-results/ext-g/full-suite.log` |
| `npm run typecheck` | 通过（含测试源码与 renderer） | `test-results/ext-g/typecheck.log` |
| `npm run desktop:build` | Core、renderer、Electron main/preload 构建通过 | `test-results/ext-g/build.log` |
| `git diff --check` | 已跟踪修改通过，无输出 | 命令输出 |
| 隔离预览 | 上述页面与接口行为一致 | `test-results/ext-g/preview/server.log`（忽略目录） |

## 6. 边界与后续

- 本轮未执行真实 QQ 注入/收发、真实模型调用、Electron 原生窗口与视觉交互、安装包构建或发布；这些仍属 EXT-H/实机验收。
- 预览中的插件状态为“未加载”，因为未启动 SnowLuma runtime 握手；E05 使用假通道与捕获模型验证同一条解析/注入路径，不代表真实插件进程已在实机运行。
- 页面只消费后端有效解析结果，没有在前端另算一套工具/Skill 可用性。
- 按用户长期要求，未 `git add`、提交、推送、打包或替换发行包；工作树与预览数据保留原样，供复核。
