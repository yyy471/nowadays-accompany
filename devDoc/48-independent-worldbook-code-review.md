# 独立世界书阶段代码复核

日期：2026-10-23。依据：[46 实现方案](46-independent-worldbook-implementation-plan.md)、[47 验收标准](47-independent-worldbook-acceptance.md)。结论：**本阶段未通过验收；当前主要完成WB01领域与契约准备，WB02～WB06尚未形成完整链路。**

本轮只复核和补充计划，未修复生产代码，未提交Git，未更新EXE。工作区包含33号以来多轮未提交改动，不能把git diff中的全部文件都归为本轮新增。

## 1. 已完成与验证结果

已确认新增：worldbook资源kind、ResolvedWorldbook与来源/状态类型；parseConversationWorldbookSource、parseWorldbookSettings、summarizeWorldbook；独立JSON转换器及样例；资源目录识别；DeploymentService对worldbook部署的显式拒绝；公共导出。

新增worldbook-contract.test.ts的21项与worldbook-import.test.ts的9项通过。原世界书基础功能测试继续通过。

本次实跑：

| 检查 | 结果 |
| --- | --- |
| npm test | 80文件通过，693项通过、1项跳过，共694项 |
| npm run typecheck | 通过 |
| npm run desktop:build | 通过，含核心、renderer、main/preload |
| git diff --check | 通过 |

跳过为既有artifact-import.test.ts创建符号链接时EPERM触发的环境分支。全量通过说明现有断言成立，不能替代尚未编写的独立世界书服务、前端和运行时验收。

## 2. 具体问题

### R1 / P1：来源提交被静默丢弃，却返回成功

位置：src/service/routes/accounts.ts:40–54；src/profiles/role-bindings.ts:86–98、145–167；src/application/accounts/account-service.ts:234–251；src/agent/engine.ts:472。

新增parseWorldbookSettings仅存在于领域和测试，路由仍只向Core传body.worldbook和expectedRevision，完全忽略body.source。Store既不声明也不解析worldbookSource，账号服务及Agent仍只读取card.manifest.worldbook。

隔离真实HTTP复现：给已有角色绑定提交有效worldbook参数、expectedRevision及不存在的独立来源does-not-exist/r1，返回200；返回binding无source，来源没有保存，绑定revision却已变化。若用户据此认为选书成功，实际提示词仍可能使用内置书。

修复要求：端到端原子传递、校验、保存source与参数，解析有效书并供预览/Agent共用；未接通前有source的请求应显式拒绝，不能假成功。对应47号B03、B06、B07、B09、B14、A03。

### R2 / P1：资源服务、版本提交及运行时解析尚未实现

仓库未发现WorldbookResourceService、effective-worldbook用例、/worldbooks路由、revision创建/派生/幂等提交或受控独立文件导入链路。实际GET /worldbooks为404。

现有通用目录导入可因manifest支持新kind而接收worldbook目录，但不等于46号要求的独立JSON导入、条目管理与不可变编辑版本服务。

缺少有效书快照/内容指纹/缺失恢复状态；因此固定版本切换、外部同revision改写后的旧回复拒绝以及历史不变性均无新增集成证据。当前基础世界书的旧测试不能证明独立来源具备这些性质。

修复要求：继续完成WB02、WB03，沿用资源存储与公共写入原语，随后补FakeChannel→Agent→Provider→最终发送的独立来源测试。

### R3 / P1：后端已暴露新kind，前端仍按两种资源处理

位置：src/artifacts/local.ts:94–113；desktop/renderer/src/types.ts:94；desktop/renderer/src/pages/Artifacts.tsx:24、84、204–205、245–255；WorldbookSettings.tsx。

listPublic已包含worldbook，但前端ArtifactItem/ArtifactGroup仍只声明plugin或role-card，运行时对非role-card统一显示“插件”，提供“部署”按钮。存在实际世界书目录时会误标类型并引导到不支持的部署路径。后端部署服务虽有拒绝，不能弥补错误交互。

同时未发现独立书筛选、新建/版本查看/条目编辑器、来源与固定版本选择器、草稿试算、建议参数入口。现有WorldbookSettings仍仅编辑内置书参数。

修复要求：先穷尽处理新kind，世界书不显示部署操作；再完成WB04、WB05。前端共享contracts需导出新增契约，不继续维护另一套失真的kind定义。

### R4 / P2：原生manifest导入绕过外层严格校验

位置：src/worldbook/import-adapter.ts:41–44。

raw.kind为worldbook时，转换器仅parseWorldbook(raw.worldbook)，忽略外层id、revision及不应存在的entry/content等字段。

实际复现：输入{kind:'worldbook', worldbook:{version:1,entries:[]}, entry:'../wrong.js'}，parseArtifactManifest(...,{strict:true})拒绝；convertWorldbookImport却返回native、有效空书和空warnings。

当前尚无生产导入调用方，因此未发生实际越界写文件；这是待接入前需修复的契约缺口。应复用严格manifest校验，裸version=1书另走独立入口。若有意丢弃原资源元数据并重新指定ID，也须先验证并显示该转换规则，不能把非法manifest描述为无警告有效原生资源。对应D02、D03、D07。

### R5 / P2：底层worldbook解析仍允许省略revision并跟随最新

位置：src/artifacts/local.ts:63–70、123–146。

parseConversationWorldbookSource虽要求固定revision，但尚无生产调用；LocalArtifactStore.resolve对worldbook仍执行通用catalog/latest回退，setPublicRevision也接受worldbook。隔离目录中只放sample/r1且catalog为空，resolve('worldbook',{source:'public',id:'sample'})仍解析到r1。

当前没有已接通的独立来源运行时，未证明实际会话会错误跟随；但下一步接线必须封住此边界。建议提供专用固定公共书解析入口并拒绝省略revision，阻止worldbook写catalog；不必改变插件与角色卡既有跟随行为。补底层与服务层测试，避免只依赖UI约束。

## 3. 任务完成度

| 包 | 复核状态 | 原因 |
| --- | --- | --- |
| WB01 | 部分完成 | 类型/schema/转换与30项新增测试已具备；R4需修，尚缺生产契约接入 |
| WB02 | 未完成 | 无独立资源服务/版本API/幂等编辑提交/独立JSON选择流程 |
| WB03 | 未完成 | 来源未保存，Agent未解析独立书；无新guard/故障恢复链路 |
| WB04 | 未完成 | 无资源编辑器与草稿试算 |
| WB05 | 未完成 | 无会话来源、固定版本与状态恢复界面 |
| WB06 | 未完成 | 仅自动基线及局部复现；无本阶段完整集成/浏览器/原生证据与执行报告 |

未完成项不是对既有基础世界书能力的否定；该能力沿用45号记录。当前不能把47号整体验收标记通过。

## 4. 复现与证据边界

本地临时复现脚本：test-results/review-48/reproduce.ts，已确认被Git忽略。使用createTestCore、隔离临时dataRoot及鉴权HTTP；结束后停止服务并校验前缀清理临时目录，不触及真实账号数据。

关键输出摘要：source-write为200且binding无source；/worldbooks为404；非法原生外层strictRejected=true但adapter无警告成功；未固定revision的底层解析返回sample/r1。

前端R3来自具体生产分支静态复核，本轮没有声称执行新编辑器浏览器或Electron验收；这些界面尚不存在。没有真实QQ或付费模型调用。

下一轮执行依据见[49 修复与剩余实现任务](49-independent-worldbook-remediation-plan.md)。本阶段通过前不推进长期记忆。
