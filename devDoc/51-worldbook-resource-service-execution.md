# WB02 独立世界书资源服务执行与验收记录

日期：2026-10-26。依据：[46 实现方案](46-independent-worldbook-implementation-plan.md)、[47 验收标准](47-independent-worldbook-acceptance.md)、[49 剩余任务](49-independent-worldbook-remediation-plan.md)。前置边界修复见[50 记录](50-worldbook-boundary-fixes-review.md)。

## 1. 本轮结果与范围

已实现独立世界书的资源服务、版本HTTP接口、不可变创建/派生/幂等提交，以及桌面主进程受控JSON选择与导入通道。导入、保存不更新catalog、不改会话配置、不启动worker或调用模型。

本轮没有实现资源编辑器或会话来源选择。当前界面的既有导入按钮仍面向目录与酒馆角色卡；worldbook模式已在桥接与控制器支持，用户可见的完整入口随WB04编辑器接入，不把IPC具备能力等同于页面已提供操作。

带source的会话设置暂仍明确拒绝；下一包WB03接通后替换临时拒绝。本轮不宣称独立世界书已进入实际Agent提示词，也不宣布47号整阶段验收完成。

## 2. 结构与复用

| 文件 | 职责 |
| --- | --- |
| src/application/worldbooks/worldbook-resource-service.ts | 有界列表、指定详情、规范化与内容指纹、不可变保存、派生及文件导入 |
| src/contracts/worldbook-resources.ts | 资源摘要/详情/保存/文件预览的共享类型 |
| src/artifacts/publish.ts | 共享完整revision目录发布：安全目标、同目标锁、临时目录、prepare、原子rename与清理 |
| src/artifacts/source-file.ts | 复用有界读取/链接检查；抽取已有ensureDirectories供发布器与目录导入共用 |
| src/application/artifacts/artifact-import-service.ts | 原目录导入改为调用共享发布器，保留原复制/指纹复验语义 |
| src/service/routes/worldbooks.ts | 新资源API薄路由；鉴权沿用控制服务，写入使用现有审计 |
| src/core/core.ts、control-api.ts | 资源用例门面；所有新增公共操作经runPublicWork准入及退出排空 |
| desktop/artifact-import-controller.ts、main.ts | 增加worldbook模式，共用短期单次token、主进程文件选择和退出drain |

没有增加另一套匹配器、账号Store或角色绑定。通用/artifacts响应中的世界书仅返回外层摘要，正文必须走指定版本详情入口，避免复制整书到全局列表。

## 3. 版本、请求与失败语义

正式目录保持public/artifacts/worldbook/<id>/<revision>。目录发布前完整准备manifest.json、origin.json；文件导入另存source-worldbook.json，原文逐字归档。

保存先严格校验manifest并归一化；启用且非常驻又无关键词的条目拒绝，空书及禁用草稿条目可保存。fingerprint为规范化manifest的稳定排序JSON SHA-256，不是token计数，也不直接使用原文件格式空白作为资源内容指纹。

requestId为1–64位安全标识。public/.worldbook-requests/<requestId>/claim持久绑定本次完整提交的摘要（manifest、baseRef/expectedBaseFingerprint、可选原文摘要）。同请求同内容跨服务实例/重启返回原结果；同requestId变内容/目标拒绝。即使首次响应丢失，也不生成另一版本。

请求claim与资源目录分别原子发布。资源发布失败后claim可能保留为请求预留，**不表示资源已保存**；同请求原内容可重试，改内容需新请求ID。列表不扫描该内部目录。没有跨文件事务或自动垃圾回收承诺。

派生携带baseRef与expectedBaseFingerprint，在准备前及正式发布前复验基础资源；不同新revision可以从同一基础并发派生。原revision从不覆盖。不是“最新版本CAS”，没有自动跟随最新版本。

同目标锁冲突或请求/基础指纹冲突返回409。缺失详情404，结构/限制非法400，真实I/O错误503并返回安全摘要，不把本地路径泄漏到HTTP/审计；底层异常作为cause保留。所有清理先校验临时目录的绝对父目录和受控前缀。

进程崩溃遗留的.import-*.lock不自动删除；重试会明确冲突，需确认没有活跃写入后再处理。本阶段未增加跨进程等待或锁租约，也未模拟断电级文件系统持久化。

## 4. API与调用示例

全部沿用现有Bearer鉴权与控制服务请求体上限（默认1MiB，不为该功能整体扩大）。

| 方法与路径 | 输入 | 结果 |
| --- | --- | --- |
| GET /worldbooks | id可选，offset默认0，limit默认50/最多100 | items摘要、可选nextOffset；无条目正文 |
| GET /worldbooks/:id/revisions/:revision | 安全id及固定revision | manifest、fingerprint、可选baseRef |
| POST /worldbooks/revisions | manifest、requestId、可选baseRef与expectedBaseFingerprint | 首次201，幂等200；包含created与详情 |

创建示例（目标契约已落地，不会自动启用）：

```json
{
  "requestId": "save-garden-r1",
  "manifest": {
    "id": "garden",
    "kind": "worldbook",
    "revision": "r1",
    "name": "花园",
    "worldbook": {
      "version": 1,
      "entries": [{ "id": "tree", "keys": ["花园"], "content": "花园里有一棵银杏树。" }]
    }
  }
}
```

派生：新manifest使用不同revision与新requestId，附加baseRef:{id,revision}及详情返回的expectedBaseFingerprint。保存后已有会话不会变化。

列表使用有界目录遍历：每层最多5000项、聚合最多10000个版本，超过要求按id收窄查询。分页仅对选中页读取正文与计算摘要；目录中无效/损坏条目明确报错，不悄悄吞成空列表。本轮未提供服务端全文搜索。

## 5. 桌面文件导入通道

ArtifactImportMode新增worldbook；现有previewArtifactImport('worldbook')桥接打开主进程JSON选择器。renderer仅收到5分钟有效单次token和预览，不接收可用于任意路径读取的新API。

文件最多2MiB，复用安全读取、链接拒绝和格式转换。preview只读；commit重新读取并复验SHA-256。源变化或格式错误拒绝，取消不写资源。原生manifest保留其id/revision/name/description；裸书/酒馆书使用原文件SHA-256派生稳定id/revision。重复同文件导入使用同请求标识，可以返回已有版本。

此处原文件fingerprint与详情fingerprint含义不同：前者防止预览后源变化，后者表示规范化资源。不能互相代替。

通用目录导入仍限定plugin/role-card，避免绕过独立书提交与幂等协议。原角色卡JSON/PNG与目录导入回归继续通过。

## 6. 自动验证与实际证据

最终执行：

| 命令 | 结果 |
| --- | --- |
| npm test | 82文件，717项通过、1项既有跳过，总计718项 |
| npm run typecheck | 通过 |
| npm run desktop:build | 通过，含核心、renderer、main/preload |
| git diff --check | 通过 |

新增test/worldbook-resources.test.ts共11项，覆盖：

- 新建、稳定详情指纹、分页、无正文列表及跨服务实例重试。
- 请求标识变更负载冲突、同目标禁止覆盖、同请求并发与不同请求竞争同版本。
- 同基础多个派生版本和外部基础改写拒绝。
- 写manifest、prepare与rename失败，无可见半成品；原资源保留，同请求可重试。
- JSON只读预览、原文归档、重复导入、源变化、超限/非法格式与路径。
- 桌面取消选择、单次token与源指纹复验。
- 实际鉴权HTTP：401、201/200、409、404、400；指定正文详情与全局列表无正文。
- 保存不改角色绑定/catalog；Core停止拒绝新请求，并等待已准入且被测试门控的保存完成。

首次API测试曾错误假设测试Core不存在catalog；fixture实际预建角色catalog。已改为比较保存前后文件逐字一致，不改变生产行为或放宽“不修改catalog”的断言。

既有跳过为Windows创建链接时EPERM的原目录导入测试；新测试没有skip。本轮没有真实QQ、付费模型调用，也没有浏览器编辑器验收。Electron原生选择器仍待人工实机验证，控制器测试不冒充原生验证。

## 7. 下一任务与交付状态

下一步WB03：将worldbookSource原子保存到逐会话绑定，提供内置/固定独立书统一解析，向Agent传本轮书/参数快照，guard包含书内容指纹但不改变历史contextRevision；测试缺失/损坏、版本切换、旧轮回复与账号/群私聊隔离。随后WB04/WB05提供编辑器与会话选书，再执行WB06完整验收。

保留工作区此前所有修改；本轮未Git提交，未打包或替换release EXE。
