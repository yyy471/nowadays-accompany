# WB04/WB05 世界书编辑器与逐会话来源执行记录

日期：2026-10-26。依据：[53 后续实现计划](53-remaining-development-implementation-plan.md)、[54 验收标准](54-remaining-development-acceptance.md)、[47 世界书完整验收](47-independent-worldbook-acceptance.md)。前置实现见[51 资源服务](51-worldbook-resource-service-execution.md)、[52 会话与Agent链路](52-worldbook-conversation-runtime-execution.md)。

> 复核更新：56号发现 R1～R4（卸载旧回调、来源意图竞态、选书分页、副本语义），已在[57 修复与复验](57-worldbook-ui-review-fixes.md)关闭；本文涉及旧回调与选书保护的通过结论以57号为准。

## 1. 范围与结论

本轮完成 WB04-A～E 和 WB05，并执行 WB06 的自动与浏览器结构验收：

- WB04-A：新增 `POST /worldbooks/preview`，只对传入草稿和文本复用 `evaluateWorldbook`，经 Core 公共工作准入；不读历史、不调用模型、不写资源或记忆。
- WB04-B：资源库新增“独立世界书”分区、有界版本摘要、分页加载、指定版本详情，以及“导入世界书 JSON”入口。
- WB04-C：新增条目编辑器：新建/导入入口、派生/复制、条目增删复制、搜索/启用筛选、全部字段编辑、“保存新版本”与幂等 requestId。
- WB04-D：编辑器接入既有草稿注册、公共 Modal、旧回调/隐藏视图/退出锁；保存与列表刷新错误分开提示。
- WB05：会话世界书设置增加来源二选一、固定 revision、版本/有效状态/条目数、建议参数、来源保存与保存后元数据回读。
- 修复 API 静态服务前缀遗漏：`worldbooks` 此前会被 SPA fallback 吞掉，现与其它 API 前缀一致交给路由。
- WB06：自动与浏览器结构链路通过；Electron 原生、真实 QQ、真实付费服务未执行，结论限定为“实现/自动/浏览器结构通过，原生与真实环境待验收”。

未开始：MEM00～04、EXT00～03、MM00～02、DESK00～02。未提交 Git、未更新 release、未打包发行包。

## 2. 代码与契约

| 文件 | 变更 |
| --- | --- |
| `src/application/worldbooks/worldbook-resource-service.ts` | `previewDraft`：校验文本/草稿，复用 schema 与 matcher |
| `src/application/ports/control-api.ts`、`src/core/core.ts` | `previewWorldbookDraft` 端口与 `runPublicWork` 门面 |
| `src/service/routes/worldbooks.ts` | `POST /worldbooks/preview` 薄路由 |
| `src/service/http/static.ts` | `worldbooks` 加入 API 前缀，避免 UI fallback |
| `src/worldbook/types.ts` | 导出条目位置类型，供前端编辑器复用 |
| `desktop/renderer/src/components/WorldbookLibrary.tsx` | 版本摘要/分页/详情/新建/派生/复制入口 |
| `desktop/renderer/src/components/WorldbookEditor.tsx` | 条目编辑、草稿试算、幂等保存、草稿保护 |
| `desktop/renderer/src/components/WorldbookSettings.tsx` | 来源/revision 选择、有效状态、建议参数、保存后回读 |
| `desktop/renderer/src/components/WorldbookEvaluation.tsx` | 草稿测试与已保存测试共用展示 |
| `desktop/renderer/src/lib/worldbook-editor.ts` | revision 建议、复制 id、草稿校验/脏检查/requestId 纯逻辑 |
| `desktop/renderer/src/components/ArtifactImport.tsx` | 世界书 JSON 导入入口、格式/警告/结果提示 |
| `desktop/renderer/src/pages/Artifacts.tsx`、`Accounts.tsx` | 接入世界书库与来源元数据类型 |
| `desktop/renderer/src/styles.css` | 世界书库/编辑器/详情布局与窄窗口堆叠 |

保存语义继续沿用 WB02：新 revision 不可覆盖原版本，`requestId` 绑定完整提交，`baseRef` 与 `expectedBaseFingerprint` 复验；保存不修改 catalog、会话或角色绑定。编辑器只在保存成功并以服务端规范化内容重建基线后，才允许下一次保存；列表刷新失败单独提示，不重新生成 requestId 再保存同一版本。

## 3. 自动测试与命令

最终统一命令：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 85 文件通过；744 项通过、1 项既有跳过；总计 745 |
| `npm run typecheck` | 通过 |
| `npm run desktop:build` | 通过（核心、renderer、main/preload） |
| `git diff --check` | 通过 |

既有跳过仍为 Windows 创建链接时 EPERM 的原目录导入测试；本轮没有新增 skip。

新增/扩展测试：

| 测试 | 覆盖 |
| --- | --- |
| `test/worldbook-resources.test.ts` | 草稿试算默认/覆盖参数、16000 上限、未知字段、非法 schema、零写入；鉴权 HTTP、400、列表无正文；`worldbooks` 前缀不被 UI fallback 吞掉 |
| `test/worldbook-editor.test.ts` | revision 建议、64 字符复制 id、关键词解析、领域限制与错误定位、脏检查/基础版本冲突 |
| `test/worldbook-editor-renderer.test.tsx` | 草稿试算请求体与无历史、失败重试复用 requestId、成功后换内容生成新 id、基础指纹、刷新失败分离、校验定位、dirty 关闭确认、locked 旧回调、条目增删复制 |
| `test/worldbook-library-renderer.test.tsx` | 摘要列表不取正文、选择后读详情、分页、详情失败保留列表/版本、新建/派生 revision/复制新身份 |
| `test/worldbook-settings-renderer.test.tsx` | 固定来源选择、建议参数只改草稿、保存 source/expectedRevision、409 草稿保留、列表失败不清空引用、账号切换/隐藏视图/旧回调 |
| `test/artifact-import-renderer.test.tsx` | 世界书 JSON 预览格式/警告/确认导入与“未在任何会话启用”提示 |

## 4. 54 验收映射

| ID | 结果 | 证据/说明 |
| --- | --- | --- |
| W01 | 通过（自动+浏览器） | 列表仅摘要，详情按钮才请求正文；分页与详情失败保留列表/版本；浏览器实际读取 r1/r2 详情 |
| W02 | 通过（自动+浏览器） | 新建/复制/派生节点与 seed 正确；JSON 导入入口与警告；浏览器从 r1 派生保存 r3 |
| W03 | 通过（自动+浏览器） | 浏览器搜索 pond 后切换、改优先级，再切回 ginkgo 保留优先级 10；条目错误定位到当前条目 |
| W04 | 通过（自动） | 原版本逐字不变；失败重试同 requestId；改内容新 id；保存成功与列表刷新失败分开；r1/r2 在浏览器中保存 r3 后保持不变 |
| W05 | 通过（自动+浏览器） | 草稿测试与已保存测试分别标注；浏览器草稿测试使用未保存正文并命中 ginkgo；后端无写入/历史/模型调用 |
| W06 | 通过（自动+浏览器） | dirty 关闭弹出公共确认；取消保留草稿；隐藏/锁定旧回调不发请求；busy 禁用 Modal 与保存 |
| W07 | 通过（自动+浏览器） | 来源与固定 revision 显式保存；建议参数不自动启用；浏览器未保存 forest 时测试仍用已保存 garden，保存后才用 forest |
| W08 | 通过（自动） | 列表失败保留已保存引用；409 保留草稿；缺失/损坏允许明确关闭；关闭保留引用 |
| W09 | 通过（自动+浏览器） | 保存新版本不自动改会话；浏览器保存 r3 后 group/777 仍为 garden@r1；实际 Agent r1→r2 链路由既有集成测试覆盖 |
| W10 | 通过（自动+浏览器） | 两账号相同 peer 隔离；浏览器 10001 group 显示 3 条、10002 private 显示 1 条且来源不同 |
| W11 | 部分（自动/结构） | 公共控件、键盘 Tab 圈定与 Esc 关闭已验证；运行浏览器无可视视口（0×0），819×576/1280×720/200% 与截图待人工 |
| W12 | 待人工 | Electron 原生文件选择/取消/中文路径/源变化/IPC token 与指纹需实机验收；浏览器不使用原生选择器 |

47 号关键项：

- 数据/格式 D01～D10 与资源提交 S01～S12 继续由既有资源/导入测试覆盖；新增草稿试算不改变文件与绑定。
- 会话 B01～B15、匹配 M01～M08 由既有 `worldbook-integration.test.ts` 覆盖，包括实际 FakeChannel→Instance→Agent→FakeProvider→发送、固定版本、历史保留、旧回复拒绝、损坏恢复、两账号/群私聊隔离。
- API A01～A08：新增预览鉴权/非法 body/零写入测试；列表无正文、详情指定版本、草稿预览不读历史。
- 前端 U01～U15：U01～U11 由新增组件测试与浏览器结构流程覆盖；U12/U13 公共组件与键盘结构通过；U14 视觉缩放待人工；U15 纯文本渲染由现有 snippet/pre 展示与测试覆盖。

## 5. 浏览器结构验收

使用独立临时 dataRoot、真实 Core 静态同源服务与测试 token，renderer 为最新构建产物；未连接 QQ、未调用模型。

| 操作 | 实际结果 |
| --- | --- |
| 打开资源库 | 显示 garden r1/r2 与 forest r1 摘要；`GET /worldbooks` 响应 `listHasBody:false` |
| 查看 r2 详情 | 显示指纹、基础版本 garden@r1、建议参数、条目正文与位置 |
| 从 r1 编辑 | revision 自动建议 r3、id 锁定、条目/测试/保存控件可用 |
| 编辑并草稿测试 | 改正文为“浏览器验收：银杏树下有石凳。”、测试文本“我走进花园看银杏”；返回 `已选用：ginkgo`，标签“草稿测试，尚未保存” |
| 搜索/筛选与切条目 | 搜索 pond 后编辑优先级 0→5，清除搜索切回 ginkgo，仍为 10；草稿未丢 |
| 关闭 dirty 编辑器 | 出现“继续编辑 / 放弃修改并继续”，取消不丢内容 |
| 保存新版本 | 保存 r3；`baseRef=garden@r1`；r3 正文/pond 优先级正确；r1 正文仍为“花园里有一棵银杏树。”；group/777 仍为 garden@r1 |
| 会话选书 | 群聊 777 显示 garden@r1、3 条、启用 2；切到 forest@r1 并“采用书中建议参数”（4/1200），开关未被隐式打开 |
| 未保存来源测试 | 测试文本“松树”返回“已选用：无”，证明仍使用已保存 garden；保存后同文本返回 `pine`，有效状态变为 forest@r1、1 条 |
| 账号隔离展示 | 10001 group 世界书按钮“3 条”，10002 private“1 条”，10001 private“0 条”；来源/计数按作用域展示 |
| 键盘结构 | 详情 Modal 中 Tab 焦点保持内部、Esc 可关闭；隐藏视口下 rAF 首焦点未观察，视觉焦点待人工 |

未取得截图：运行中的 in-app Browser 报告 `viewport=0x0, visibility=hidden`，截图与响应式视口检查不可用。上表为真实浏览器 DOM/React 与真实 HTTP 结果，不替代视觉证据。

## 6. 人工与真实环境待验收

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Electron 原生选择器、取消、中文/空格路径、源变化 | 待执行 | 需最新桌面构建实机；不将浏览器导入按钮禁用视为原生通过 |
| 819×576/1280×720/1600×900、200% 缩放、截图 | 待执行 | 当前浏览器无可见视口；需人工检查横向裁切/滚动/焦点 |
| 托盘隐藏/恢复、dirty/busy 退出、重启恢复 | 待执行 | 既有退出契约未改动，但需最新构建实机复核 |
| 真实 QQ 注入/监听与固定书进入提示词 | 待执行 | 需测试 QQ、测试会话与当次授权；未发送真实消息 |
| 真实模型/付费服务测试 | 未执行 | 本轮不使用付费调用；草稿测试明确不调用模型 |
| 升级/便携包/发行 | 未执行 | 未更新 release，未打包，未发布 |

## 7. 剩余影响与下一阶段

- 世界书页面/编辑器/会话选书已可用；WB06 的人工项未完成，不能宣称完整发行验收。
- 编辑器删除最后一个条目后表单回到空态，需重新选择或新增；保存仍以领域校验为准。
- 版本列表默认每页 50、最多 100；单书版本极多时“建议下一版本”可能需用户手动调整以避免冲突，服务端 409 会保留草稿。
- 保存后回读绑定元数据是额外只读请求；失败时明确提示“可能仍是旧来源数据”，不覆盖用户草稿。
- 下一阶段按 53 号顺序：MEM00～04 长期记忆、EXT00～03 插件/Skill、MM00～02 多模态、DESK00～02 桌面发行；各 00 包先盘点再定稿参数与存储。
- 本轮未 Git 提交、未打包、未发布；README 已更新世界书能力与 API。

## 8. 工作区状态

- 保留此前所有未提交修改；本轮新增/修改文件见第 2 节。
- `test-results/wb04-browser-harness.mts` 与临时 dataRoot 仅用于本地验收，位于 Git 忽略目录。
- `desktop/renderer/dist`、`desktop-dist`、`dist` 为构建产物，不进入 Git。
- 是否提交代码、是否打包、是否公开发布应分别执行并单独记录。
