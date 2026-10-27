# EXT-G 独立复核与修复要求

日期：2026-10-27。复核对象：当前工作区 EXT-G 策略路由、插件与 Skill 页面、公用 Skill 库；98 号文档是实现方自验记录，本文件记录独立结论。

**结论：暂不通过。** 路由、页面与真实 Core 的基础链路已经接通，但发现 3 项 P1 数据/配置问题、1 项 P2 状态展示问题。全量测试也有 1 项失败，不能沿用“全量通过”的结论进入 EXT-H。

本轮没有修改生产代码或正式测试源码，没有提交、推送、打包或替换 EXE。新增本文件与导航；独立探针及日志位于被忽略的 `test-results/review99/`。

## 99-R1 / P1：重载插件会无提示丢弃未保存的策略

- 位置：`desktop/renderer/src/pages/Extensions.tsx:450`、`:255`。
- 原因：重载插件成功后递增共用 `reloadKey`，加载 effect 无条件重新设置策略 `draft/baseline` 和插件安装草稿。该操作没有经过草稿保护。Skill 保存、复制、删除等操作也复用了这个加载入口，需要一并审计。
- 独立复现：实际页面函数加载后，将插件运行开关设为 `on`，再点击“重载插件”。结果从 dirty=true 变成 dirty=false，开关变回 `inherit`，没有出现确认。
- 探针输出：`PARENT_RELOAD_DRAFT {"dirty":false,"value":"inherit","newConfirmations":0}`，见 `ui-probes.log`。
- 修复：拆分策略、安装列表、Skill 列表与运行状态的刷新。重载 Worker 只更新运行状态；不应覆盖无关草稿。确需替换草稿时，通过统一 TransitionController 保护所有会受影响的草稿，而非只保护当前操作对应的一项。
- 验收：分别留下策略草稿、安装草稿、Skill 编辑草稿，执行插件重载、Skill 保存/复制/删除、策略刷新。未涉及的数据保持原样；确需替换时取消可完整保留，确认后才重置。补充不同草稿同时存在的组合用例。

## 99-R2 / P1：修改停用的公用 Skill 会隐式重新启用

- 位置：`desktop/renderer/src/components/SkillDefinitionEditor.tsx:107`。
- 原因：编辑器提交完整 Skill 定义时遗漏原有 `enabled:false`。后端使用替换保存，省略 enabled 的公用 Skill 默认可用，因此单纯改名称也会改变启用状态。
- 独立复现：编辑停用公用 Skill 的名称，实际页面提交体没有 enabled。将该提交体交给真实 Core 保存，预览结果从 included=[] 变为 included=["draw"]，保存的 enabled 变成 omitted。
- 证据：`public-editor-payload.json`、`ui-probes.log`、`public-backend.log`。
- 修复：编辑已有公用定义时保留启用状态；如提供显式开关，只有用户主动修改才能改变它。新建和复制的默认行为须与页面“不会自动启用”的提示一致。
- 验收：已停用公用 Skill 仅修改名称/正文后仍停用，预览及运行选择均不包含它；已有启用定义的普通编辑保持启用。覆盖实际编辑器提交体到真实服务的往返验证。

## 99-R3 / P1：刷新公用库会让旧草稿携带新 revision，绕过冲突保护

- 位置：`desktop/renderer/src/components/PublicSkillLibrary.tsx:96`、`:145`，`SkillDefinitionEditor.tsx:121`。
- 原因：打开编辑器后 `editing.skill` 和表单保留旧数据，但 `revision` 始终取刷新后的列表值。编辑期间仍可刷新。结果是“旧内容 + 新版本号”提交，后端 CAS 正确校验也无法识别丢失更新。
- 独立复现：以 pub1 打开表单，服务端正文改为 EXTERNAL_EDIT 并进入 pub2；刷新后，旧表单提交 expectedRevision=pub2、正文=DRAW。真实 Core 接受该请求，最终正文变为 DRAW，外部更新被覆盖。
- 证据：`cas-ui.log`、`public-cas-payload.json`、`public-backend.log`。
- 修复：在打开编辑会话时同时固定定义与 revision。列表刷新不能悄悄推进该编辑会话的 revision；发现冲突应保留草稿并提示，只有显式重新加载/合并后才能更新基线及令牌。
- 验收：打开编辑→外部修改→刷新列表→保存旧草稿，应返回 409 并保留草稿和服务端新值。测试删除后重建同 ID、新建期间列表变化等情况；不能仅测试后端 CAS。

## 99-R4 / P2：历史握手成功被当成当前 Worker 就绪

- 位置：`desktop/renderer/src/pages/Extensions.tsx:688`；`src/application/extensions/plugin-runtime-service.ts:62`。
- 原因：服务的 `plugins` 保存最后一次握手结果；当前运行就绪集合另由 `readyPlugins` 提供。页面用 `readyPlugins.includes(key) || status?.ready === true`，历史握手成功能覆盖当前已不就绪的状态。
- 证据：实际页面接收 `readyPlugins=[]`、上次握手 ready=true 的 DTO 后仍渲染“已就绪”，输出 `PARENT_STALE_READY`，见 `runtime-ui.log`。此项证据为源代码状态流审计与页面 DTO 探针，尚未执行真实 Worker 崩溃到页面的完整联合复现。
- 修复：明确区分上次启动结果与当前存活/就绪状态；当前就绪以实时集合为准，历史成功不能回填为当前就绪。必要时补充运行状态刷新机制。
- 验收：真实 Worker 握手成功后触发执行超时或异常终止，刷新页面状态，不再显示“已就绪”；重载成功后才能恢复。未同步与启动失败状态仍可区分。

## 独立验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 全量 `npm test` | 116 文件，115 通过 / 1 失败；1088 项通过 / 1 失败 / 1 既有跳过 | `test-results/ext-g-parent-initial-full.log` |
| EXT-G/Skill/运行时定向 6 文件 | 72 项通过 | `test-results/review99/targeted.log` |
| 完整类型检查 | 通过 | `test-results/review99/typecheck.log` |
| 桌面构建 | 通过 | `test-results/review99/build.log` |
| 已跟踪改动 diff 空白检查、新增文本文件尾随空白检查 | 通过 | 本轮命令输出，无告警 |
| 独立反向探针 | R1～R3 页面断言失败，R2/R3 真实 Core 持久化影响确认；R4 页面状态断言失败 | 上述探针日志 |

全量唯一失败位于 `test/extension-runtime.test.ts:746` 的 beforeContext 单钩子时限用例：预期两个 ok，实际为 failed/ok。慢钩子 fixture 主动等待 400ms，生产时限为 500ms，定向复跑该文件通过（本项耗时 472ms）。目前只能确认它在全量负载下失败、定向通过，尚未确定是实现问题或测试时间余量不足，不能简单记为环境噪声。修复时补充失败 reason、各阶段耗时及预算证据；保持生产 500ms/2s 契约，不可仅放宽生产时限换取测试通过。

独立 UI 探针调用实际页面与编辑器代码、事件回调，使用受控 React hook/HTTP mock；它们不是浏览器、原生 Electron 或可访问性交互验收。公用 Skill 的持久化验证使用真实 Core 与隔离临时数据目录。未连接真实 QQ、付费模型或真实插件服务，未验证发行包。

## 后续执行顺序

1. 先修 R1～R3，分别增加回归；重点验证同页面多个草稿互不覆盖及编辑会话 revision 的绑定。
2. 修 R4，补真实 Worker 终止到状态 DTO/页面的联合证据。
3. 诊断本轮全量时限失败，保留原始失败与修复依据。
4. 重新执行类型检查、相关回归、全量与桌面构建；独立复核通过后再进入 EXT-H。EXT-H 的真实 QQ、模型、本机界面与发行包证据不能由本轮自动化替代。
