# 阶段D：公共资源目录导入执行记录

后续版本已增加独立的酒馆JSON/PNG文件入口，支持范围与映射见[43 酒馆角色卡导入](43-tavern-card-import.md)；本文的“仅manifest目录”保留为阶段D当时范围，目录入口本身仍按原规则校验。

日期：2026-10-23。本节记录后端内部用例；桌面桥和界面验收由父代理补充。未提交、未打包，保留既有A/B/C未提交改动。

## 1. 后端接口与架构

新增`src/application/artifacts/artifact-import-service.ts`，提供独立于Core、HTTP、catalog和deployment的`ArtifactImportService`：

```ts
new ArtifactImportService({ publicRoot, limits? });
preview(sourceDirectory: string): Promise<ArtifactImportPreview>;
import(sourceDirectory: string, options?: { expectedFingerprint?: string }): Promise<ArtifactImportPreview>;
```

返回kind、id、revision、可选name、fileCount、bytes、targetPath和fingerprint。targetPath为公共资源库内目标绝对路径，fingerprint为排序目录清单和实际文件SHA256摘要的整体SHA256。桌面桥可将bytes映射为totalBytes，保存选择路径与指纹并在确认时传入expectedFingerprint；不开放接收任意路径的HTTP接口。

复用`ArtifactManifest`类型，提取共享`artifacts/manifest.ts`解析器及segment常量。`LocalArtifactStore`读取默认保持历史必要字段验证；导入显式启用strict模式，避免让旧手工资源突然受到更严格规则影响。目录导入仅支持当前manifest制品：role-card要求非空content；plugin要求apiVersion=1、安全且存在的普通文件entry。拒绝未知字段、非法id/revision、Windows保留目录名、路径穿越和不支持的格式；酒馆JSON/PNG没有被当成现有角色卡格式导入。

## 2. 落盘与激活边界

- preview只读：验证全部源目录、文件、manifest、目标位置与冲突后返回预览，不创建公共目录。
- import重新扫描并核对确认指纹，拒绝预览后增加、删除或更改的内容；复制时再次核对逐文件内容摘要，复制后重新严格扫描临时目录及源目录清单。
- 源目录、全部祖先与后代、目标祖先均拒绝symlink/Windows目录junction；只接收普通文件和目录。文件读取使用有界缓冲和打开前后状态校验，默认限制1000文件、2000总条目、单文件8MiB、总文件32MiB和16层目录，可通过构造参数收紧。
- 在publicRoot下创建隐藏`.artifact-import-*`临时目录，验证通过后才rename到`artifacts/<kind>/<id>/<revision>`；按revision创建独占导入锁，重复revision（包括已有空目录）明确拒绝并提示更改manifest.revision，不覆盖已有制品。异常清理本次临时目录和锁；清理前确认临时目录绝对路径仍位于指定公共根内。
- 不写catalog、catalog.previous，不调用部署、重载或账号配置。

仅“不写catalog”不足以保证不自动激活：历史`LocalArtifactStore`在无catalog项时会选最新revision。因此导入在最终校验后写入系统保留标记`.nowadays-imported`，默认latestRevision回退跳过这些版本。已有手工资源回退兼容；导入版本仍可在资源列表看到并以显式revision解析，只有明确部署到catalog后才参与follow-current。源目录禁止携带该保留标记，避免伪造内部状态。

## 3. 后端验证结果

`test/artifact-import.test.ts`最终32项，31通过、1跳过。真实临时目录覆盖：

- 只读预览、实际复制、列表可见且catalog不变；旧手工v1回退不被新导入v2替代、只有导入版本时follow-current无法解析、显式revision及setPublicRevision后可解析。
- 重复revision及已有空目标目录拒绝、内容与库存指纹变更拒绝、真实安全插件入口、历史宽松parser兼容。
- 非法manifest字段/类型、路径穿越、缺失/坏JSON、缺失entry、错误apiVersion、保留标记、文件/条目/深度/字节限制。
- 真实目录junction（源后代、源根、目标祖先）全部拒绝；单独文件symlink用例在当前Windows账号下创建链接返回EPERM，故明确跳过，未冒充验证通过。
- 两服务实例并发同revision仅一次成功；rename失败、复制期间源文件改动、源库存增加、staging内容破坏均不暴露部分revision，临时目录和导入锁均清理。

测试清理前校验最终绝对目录属于os.tmpdir且具有本测试专用前缀，再执行递归删除。定向测试在获自动批准的sandbox外执行，以规避本环境Vitest依赖realpath的Windows EPERM。`npm run typecheck`和`git diff --check`通过。

以上验证覆盖内部用例；没有将源目录内代码执行、模型调用、真实QQ、部署或Electron交互作为本节验证内容。完整桌面桥、用户取消选择、导入确认、刷新与界面操作由父代理统一集成验收。

## 4. 桌面桥与界面集成

沿用 `window.nowadays`（兼容 accompany）的 preload 桥，新增打开目录、选择并预览、按 token 确认导入三项能力。所有 IPC 校验当前窗口、主 frame 与本地应用 origin；源目录只能来自主进程的原生选择器，渲染端不传源路径。主进程保存源路径和指纹，返回5分钟有效、一次性 token；取消重新选择使前一 token 失效，提交失败也需重新选择。类型契约统一放在 `src/contracts/artifact-import.ts`，不让渲染端导入文件系统用例。

资源页新增公共组件 `ArtifactImport`，复用已有 Button、CancelButton、ConfirmButton、Modal、ErrorNote 和暖色样式。展示类型、名称、ID、版本、文件数量、字节数及目标路径，明确导入不部署；取消不写入，失败可重新预览，成功刷新列表。导入已成功但刷新失败有独立反馈，避免误导用户重复导入。浏览器入口明确提示使用桌面版。

操作以 busy 登记统一草稿系统，并有即时防重与卸载检查。独立复核发现资源预览作为 Portal 在退出检查期间仍可能被点击，已返修：App向资源页/导入组件传 locked，旧回调读取最新状态，关闭/取消/提交均受限；主进程在退出协调器非idle时拒绝新资源操作，且 shutdown 等待已接受的导入完成后再停止Core。取消退出恢复操作。

桌面控制器6项真实文件系统测试覆盖选择token、伪造/重放/到期/取消、源变化、并发选择和退出等待成功/失败发布；前端10项回调测试覆盖取消、防重、busy、卸载、错误/刷新反馈及锁定旧回调，退出集成新增资源页锁定传参测试。最终全量及构建结果见[41 集成验收](41-storage-fix-and-stage-d-review.md)。原生选择器和实际桌面布局仍须实机验证，自动化不替代这两项。

## 5. 可用的角色卡目录样例

选择一个包含以下 `manifest.json` 的目录即可；此为项目自身格式，非酒馆角色卡交换格式。

```json
{
  "kind": "role-card",
  "id": "companion",
  "revision": "v1",
  "name": "陪伴者",
  "content": "你是一位温柔、坦诚的朋友。"
}
```

导入后在列表中显式部署，再去资料与角色为每个目标群聊/私聊分别绑定角色卡。插件目录同样需 manifest，并提供 `apiVersion: 1` 和制品内部的 `entry` 文件。
