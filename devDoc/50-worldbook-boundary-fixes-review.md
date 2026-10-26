# 世界书边界修复复核与接管记录

日期：2026-10-24。依据：[48 首轮复核](48-independent-worldbook-code-review.md)、[49 修复与剩余实现任务](49-independent-worldbook-remediation-plan.md)。本轮范围为FIX-WB1、FIX-WB2及其回归，不是WB02～WB06完整交付。

## 1. 本次修改核验

| 原问题 | 当前结果 |
| --- | --- |
| R1 来源提交假成功 | 路由对带source的设置请求明确400拒绝，不再假成功；这是49号允许的临时边界，不代表来源已接通 |
| R2 服务与运行时缺失 | 仍待WB02/WB03实施；未发现WorldbookResourceService、有效书应用用例及独立版本API |
| R3 世界书误展示为插件 | renderer使用新增kind，显示世界书且不提供部署按钮；完整编辑器及会话来源选择仍待WB04/WB05 |
| R4 非法原生manifest导入 | 转换器已调用严格parseArtifactManifest校验；裸Worldbook保留单独校验入口 |
| R5 省略revision跟随 | 通用resolve拒绝worldbook；新增resolveWorldbook要求固定public revision，setPublicRevision拒绝worldbook |

同时新增无副作用的artifact segment校验模块并供schema/manifest复用，避免新增两套目录名规则。上述改动方向正确。

## 2. 接管中发现并直接修复的问题

### F1：固定版本解析仍使用旧的宽松目录名检查

resolveWorldbook最初使用local.ts的旧assertSegment，只检查正则，未拒绝Windows保留名和尾随点。已改用共享assertArtifactSegment，在任何磁盘访问前拒绝无效id和revision。插件/角色卡的历史行为未随此次扩大修改。

证据：worldbook-store.test.ts新增con、NUL.json、garden.的id/revision测试，验证拒绝且不打开文件。

### F2：新解析器无界读取文件，并允许路径链接

新入口最初直接fs.readFile manifest，无法在读取前阻止超大文件，也未做目录联接/符号链接检查。

已将原ArtifactImportService中成熟的assertNoLinks、readFileBounded、readArtifactSourceFile抽到src/artifacts/source-file.ts。目录导入、酒馆卡导入沿用该实现，独立世界书解析也复用；原应用服务保留readArtifactSourceFile导出以兼容已有调用方，不建立第二套读取算法。

独立manifest最多2MiB；逐级路径链接、非普通文件、文件身份变化、超限或读取期间变化返回invalid；ENOENT返回missing，真实I/O失败返回error。文件关闭与既有读取后复验保持原行为。此检查不宣称能消除具有本机目录写权限的恶意程序制造的所有瞬时竞争。

证据：新增超限文件、链接祖先和EACCES测试。链接测试注入lstat结果，不依赖Windows创建链接权限，不新增跳过项。原目录与酒馆卡导入测试通过。

### F3：严格manifest解析修改调用方对象

worldbook分支直接赋值manifest.worldbook，导致纯校验改变输入；对冻结的有效manifest会抛TypeError。

已移除赋值，统一由末尾的复制归一化分支返回结果，避免重复解析。新增冻结manifest测试，确认输入不变且返回值包含规范化默认参数。

### F4：来源临时拒绝缺少不写入证据

新增真实鉴权HTTP集成测试，分别提交role-card来源、独立来源及null；均应400，role-bindings.json逐字不变，绑定revision不变，不能顺带开启世界书。独立来源正式接通时须将此测试更新为正式成功/非法来源拒绝用例，不能删掉持久化一致性断言。

## 3. 验证结果

| 命令 | 结果 |
| --- | --- |
| 定向：Store、契约、世界书集成、目录导入、酒馆卡导入 | 5文件，76项通过、1项既有跳过 |
| npm test | 81文件通过，706项通过、1项跳过，总计707项 |
| npm run typecheck | 通过 |
| npm run desktop:build | 通过，含核心、renderer、Electron main/preload |
| git diff --check | 通过 |

跳过仍为既有artifact-import.test.ts创建符号链接时EPERM的环境分支。本轮新增回归不含skip。使用临时目录/Fake服务，无真实QQ、SnowLuma或付费模型调用。

本轮前端类型/文案/部署分支为代码复核，未执行浏览器和Electron人工验收；不能以类型检查代替原生或完整交互验收。

## 4. 完成状态与下一步

FIX-WB1/WB2边界修复经本轮接管后通过自动回归。独立世界书整体仍未完成，49号任务计划继续有效：下一步是WB02资源服务与不可变版本提交，其后WB03运行时、WB04编辑器、WB05会话配置、WB06完整验收。

下一包WB02必须至少交付：有界摘要列表、指定版本详情、不可变创建/派生、幂等重试、受控JSON预览/导入、Core/API/桌面接线，以及并发/写失败/退出排空测试。先按46/47/49实施，不进入长期记忆，不因为已有resolveWorldbook就宣称资源管理已完成。

本轮保留此前全部未提交改动，未提交Git，未打包或替换release EXE。
