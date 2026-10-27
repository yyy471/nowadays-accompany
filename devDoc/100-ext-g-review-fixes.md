# EXT-G 复核修复记录

日期：2026-10-27。依据：[99 EXT-G 独立复核与修复要求](99-ext-g-independent-review.md)。复核对象为当前未提交工作树；实现方完成修复与自验，仍需独立复验收口。

## 1. 结论

99 的 R1～R4 已修复并各自增加回归，全量时限失败已按“保留生产契约、增加测试余量与失败证据”处理。定向 8 文件 84 项、全量连续三次 118 文件 1101 项通过/1 项既有跳过，类型检查、桌面构建与空白检查通过。

未提交、推送、打包或替换 EXE；未连接真实 QQ、付费模型或真实插件服务。按复核门控，本记录不代表 EXT-G 已独立通过。

## 2. R1 重载/刷新不再覆盖草稿

| 修复 | 代码 | 说明 |
| --- | --- | --- |
| 拆分刷新路径 | [Extensions.tsx:245](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L245)、[Extensions.tsx:278](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L278) | `refreshPolicyView` 只刷新目录/运行状态与已保存基线；草稿脏且服务端策略内容变化时只标记冲突，不把旧草稿接到新 revision。`refreshRuntime` 只更新运行状态与工具 handler 就绪标记，不触碰任何草稿 |
| 重载插件只更新运行时 | [Extensions.tsx:530](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L530) | 用重载响应更新 `readyPlugins`/`readyTools`/插件状态及工具 `handlerReady`；不再递增全量加载键，策略、安装与 Skill 编辑草稿保持原值 |
| Skill 保存/复制/删除 | [Extensions.tsx:610](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L610)、[Extensions.tsx:641](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L641)、[Extensions.tsx:654](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L654) | 只更新私有列表、目录与有效状态，不再触发账号级全量加载；策略/安装草稿不受影响 |
| 硬刷新保护全部受影响草稿 | [Extensions.tsx:433](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L433) | “重新读取”统一保护策略、插件安装和当前 Skill 编辑会话；取消保留全部草稿，确认后才重置并关闭编辑器 |
| 运行状态刷新 | [Extensions.tsx:708](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L708) | 新增“刷新状态”，只读取运行/就绪状态，可在任意标签使用且不影响草稿 |
| 编辑期间禁用复制 | [Extensions.tsx:956](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L956) | 私有 Skill 编辑器打开时禁用复制/新建/删除，避免同一列表的 revision 在编辑会话中变化 |

回归：[extensions-page-renderer.test.tsx:512](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx#L512) 覆盖重载保留策略+安装草稿；[:565](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx#L565) 覆盖 Skill 保存/删除后仍保留两类草稿；[:610](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx#L610) 覆盖三种草稿存在时取消/确认硬刷新。

## 3. R2 保留 Skill 默认启用状态

| 修复 | 代码 | 说明 |
| --- | --- | --- |
| 提交体保留已有状态 | [skill-payload.ts:18](file:///D:/app/nowadays/accompany/desktop/renderer/src/lib/skill-payload.ts#L18) | 编辑已有定义时写入原 `enabled`（true/false 均保留），不再因省略字段被后端按默认启用处理 |
| 新建默认关闭 | [skill-payload.ts:20](file:///D:/app/nowadays/accompany/desktop/renderer/src/lib/skill-payload.ts#L20)、[SkillDefinitionEditor.tsx:120](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/SkillDefinitionEditor.tsx#L120) | 新建公用/私有定义显式 `enabled:false`，页面提示“保存不会自动在任何账号启用”；已有定义的编辑保留原状态 |
| 复制默认关闭 | [skill-service.ts:102](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L102) | 复制到私有统一写 `enabled:false`，仍需账号 Skill 作用域显式打开，与复制成功提示一致 |
| 私有定义可保留关闭状态 | [skill-service.ts:92](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L92)、[types.ts:679](file:///D:/app/nowadays/accompany/src/providers/types.ts#L679) | 私有定义允许保存 `enabled:false` 作为默认值；作用域开关 `on` 仍可覆盖，不是硬禁用。此前“私有定义不得保存 enabled=false”的解析限制已移除 |
| 状态展示 | [PublicSkillLibrary.tsx:111](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/PublicSkillLibrary.tsx#L111)、[Extensions.tsx:933](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L933) | 公用/私有定义显示“默认关闭”，与“默认启用”区分 |

回归：真实 Core + 实际编辑器提交函数往返见 [skill-editor-payload.test.tsx:46](file:///D:/app/nowadays/accompany/test/skill-editor-payload.test.tsx#L46)，覆盖“停用定义改名称后仍停用、作用域 on 可注入、复制默认关闭、启用定义普通编辑保持启用”；页面提交体保留状态见 [extensions-page-renderer.test.tsx:646](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx#L646)。

## 4. R3 编辑会话固定 revision

| 修复 | 代码 | 说明 |
| --- | --- | --- |
| 公用编辑会话固定令牌 | [PublicSkillLibrary.tsx:26](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/PublicSkillLibrary.tsx#L26)、[PublicSkillLibrary.tsx:121](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/PublicSkillLibrary.tsx#L121) | 打开编辑/新建时同时保存定义与当时的 revision；列表刷新（含同 ID 删除重建）不会推进该会话令牌 |
| 提交固定令牌 | [PublicSkillLibrary.tsx:146](file:///D:/app/nowadays/accompany/desktop/renderer/src/components/PublicSkillLibrary.tsx#L146) | 编辑器始终使用打开时的 revision；外部变化会得到 409，草稿与服务端新值都保留，必须显式重新打开/合并 |
| 私有编辑会话固定令牌 | [Extensions.tsx:155](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L155)、[Extensions.tsx:963](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L963) | 私有编辑器同样在打开时固定 revision，且编辑期间禁用会改变列表的复制/删除/新建操作 |

回归：[extensions-page-renderer.test.tsx:669](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx#L669) 覆盖打开编辑→外部修改/同 ID 重建→列表刷新→保存仍用旧 revision 并保留草稿；[:712](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx#L712) 覆盖新建期间列表变化。

## 5. R4 历史握手与当前就绪分离

| 修复 | 代码 | 说明 |
| --- | --- | --- |
| 当前就绪只取实时集合 | [Extensions.tsx:785](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L785) | 页面只用 `runtime.readyPlugins` 判定“已就绪”；上次握手成功但已终止显示“已停止”并提示重载恢复，启动失败仍显示“未就绪”和原因 |
| 明确区分未同步 | [Extensions.tsx:787](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L787) | `synced=false` 显示“未加载”，不与失败/已停止混淆 |
| 状态刷新闭环 | [Extensions.tsx:278](file:///D:/app/nowadays/accompany/desktop/renderer/src/pages/Extensions.tsx#L278) | “刷新状态”重新读取 DTO，Worker 终止后工具 `handlerReady` 与插件就绪同步更新；重载成功后可恢复“已就绪” |

联合证据：真实 Worker 握手成功后触发 handler 超时终止，实时 `readyPlugins/readyTools` 清空而历史状态仍为 `ready:true`，策略 DTO 仍以实时集合为准；显式重载后恢复，见 [extension-readiness.test.ts:23](file:///D:/app/nowadays/accompany/test/extension-readiness.test.ts#L23)。页面使用同一 DTO 的渲染回归见 [extensions-page-renderer.test.tsx:756](file:///D:/app/nowadays/accompany/test/extensions-page-renderer.test.tsx#L756)，同时覆盖“已停止/已就绪/未加载”三种展示。

## 6. 全量时限失败诊断

- 原用例：[extension-runtime.test.ts:741](file:///D:/app/nowadays/accompany/test/extension-runtime.test.ts#L741) 的 beforeContext 单钩子时限。
- 原因判断：慢钩子 fixture 等待 400ms，生产单钩子上限 500ms；本地定向耗时 472ms，全量负载下事件循环额外延迟即可越过上限。因此该用例对调度抖动没有余量，不能简单归为环境噪声。
- 处理：fixture 等待改为 250ms（[slow-hook/index.mjs:2](file:///D:/app/nowadays/accompany/test/fixtures/plugins/slow-hook/index.mjs#L2)），保留生产 `500ms` 单钩子与 `2s` 轮次预算不变；断言失败时输出状态、结果与 elapsed，便于下次直接看到失败原因。
- 证据：修复前本项目全量日志该用例整体耗时 515ms；修复后连续三次全量分别为 354ms、347ms、392ms，定向 322ms，均低于 500ms 单钩子上限且通过 `elapsed < 700ms` 断言。

## 7. 自验结果

| 验证 | 实际结果 | 忽略目录输出 |
| --- | --- | --- |
| 定向 8 文件 | **84 项通过** | `test-results/review99/fix-targeted-final.log` |
| `npm test` 第一次 | **118 文件、1101 项通过、1 项既有跳过** | `test-results/review99/fix-full3.log` |
| `npm test` 第二次 | **118 文件、1101 项通过、1 项既有跳过** | `test-results/review99/fix-full4.log` |
| `npm test` 第三次 | **118 文件、1101 项通过、1 项既有跳过** | `test-results/review99/fix-full-final.log` |
| `npm run typecheck` | 通过（含测试与 renderer） | `test-results/review99/fix-typecheck-final.log` |
| `npm run desktop:build` | Core、renderer、Electron main/preload 通过 | `test-results/review99/fix-build-final.log` |
| `git diff --check` / 未跟踪文本空白 | 通过 | 命令输出 |

## 8. 范围与后续

- 本轮不改生产 500ms/2s 时限，不把失败简单记为环境噪声；慢钩子 fixture 的余量调整与失败诊断输出同时保留。
- 私有定义现在可以带默认关闭状态；这是为关闭 R2 的“修改即隐式启用”而做的语义修正，作用域开关仍是唯一启停入口，`on` 可覆盖默认关闭。
- 以上为实现方自验。仍需独立复核复跑其原探针（R1 草稿、R2 往返、R3 CAS、R4 就绪）与正式全量；通过后才能进入 EXT-H。真实 QQ、付费模型、Electron 原生交互与发行包仍未验收。
- 未提交、推送、打包或替换 EXE。
