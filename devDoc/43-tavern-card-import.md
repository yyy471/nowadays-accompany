# 酒馆角色卡基础转换与导入

日期：2026-10-23。对应“继续下一步”。在阶段D资源导入和阶段E首轮收口上增加酒馆JSON/PNG文件入口；本轮已实现并完成自动化复核，未提交Git、未生成或更新release EXE。原生窗口验收保留为待办。

## 1. 支持范围与产品行为

资源库保留“导入资源”的manifest目录入口，新增“导入酒馆角色卡”，通过原生选择器选择单个JSON或PNG文件。预览显示名称、来源版本、自动生成ID/revision、文件数/大小、目标目录、角色文本字符数、前2000字符和全部转换提示，确认后才发布。取消不导入，重复版本不覆盖，导入不部署、不改账号绑定、不发送QQ消息。

支持V1平铺JSON、`spec=chara_card_v2/spec_version=2.0`的data对象，以及PNG的tEXt/chara内base64 UTF-8 JSON。PNG同时有ccv3时明确提示只取chara兼容数据；只有ccv3或JSON声明V3时拒绝并提示导出V2。不是完整酒馆运行时，也不宣称支持全部第三方格式、压缩文字块或所有宏。

name为必要非空文本；其余已知文本字段如存在须为文本，数组/元数据对象须符合各自类型。只有name的卡片会生成基本角色句。无spec但有entries数组的独立世界书明确拒绝，不误认成角色卡。

## 2. 字段映射与限制

| 源字段 | 本项目行为 |
| --- | --- |
| name | 资源显示名称，角色文本开头说明身份 |
| description/personality/scenario | 分别进入角色描述、性格和场景分节 |
| mes_example | 作为对话示例文本分节，不伪造聊天历史 |
| system_prompt/post_history_instructions | 作为角色文本分节，提示用户不复现酒馆的替换/后置注入位置语义 |
| `{{char}}` | 转换为此角色name，仅做文本替换 |
| `{{user}}`及其他宏 | 保留原文并提示当前不会展开；不求值或执行 |
| first_mes/alternate_greetings | 仅保留原文件，不自动发开场白 |
| creator_notes/tags/creator/character_version | 原文件归档，不混入AI角色设定 |
| character_book/extensions/其他未知字段 | 原文件归档并提示未生效，不启用世界书、不下载远程资源、不执行扩展 |

角色文本超过12000字符时提示现有上下文默认限制可能截断；导入本身保留完整文本。当前引擎、Skill、模型授权、媒体工具和记忆逻辑未更改。

生成规则：ID为`tavern-`加规范化名称SHA256的前16位；revision为`r-`加原文件字节SHA256的前16位。同名卡片视为同一资源的不同版本，名称不同会生成不同ID；完全相同文件重复导入会被拒绝。本期无手工改ID或覆盖入口，修改内容后重新预览会生成新revision。PNG重编码或JSON空白变化也可能产生新revision，这是按原文件快照识别的结果。

制品包含生成的manifest.json及逐字节保留的source-card.json或source-card.png。PNG原图被归档，不自动替换QQ展示头像。不要删除内部导入标记；未部署的新版本跳过latest回退，沿用40号的不自动激活保护。

## 3. 架构与发布链路

`ArtifactImport`公共弹窗 → preload mode（directory/tavern-card）→ 主进程来源校验与原生选择 → `ArtifactImportController` → `TavernCardImportService` → 纯解析器`artifacts/tavern-card.ts` → 受控临时转换目录 → 既有`ArtifactImportService`校验/复制/原子发布。

不新增HTTP任意路径导入API，不复制catalog/部署实现。文件读取复用目录导入的链接、文件身份和有界读取检查，临时转换目录清理前校验最终绝对路径属于系统临时目录及专用前缀。

桌面控制器仍持有源路径、模式、指纹和5分钟一次性token；渲染端仅能提交token，不能指定源路径。文件确认后变化即拒绝；提交失败token也消耗。退出检查期间主进程拒绝新操作，已接纳的导入由shutdown drain等待。前端沿用busy登记、即时防重、卸载保护及locked旧回调拦截。

原文件上限8MiB，JSON/解码元数据上限2MiB，PNG最多4096块；校验签名、长度、CRC、IHDR/PLTE/连续IDAT/IEND结构及规范base64。重复chara、损坏/越界、未知关键PNG块和错误UTF-8拒绝；不解压像素、不加载图片、不取远程内容。

## 4. 复核与证据

- 解析器69项通过：字段映射/类型、版本与确定性、宏与元数据隔离、PNG结构/CRC/重复/越界/base64/UTF-8/V3、独立世界书拒绝及近2MiB合法元数据。大元数据测试未复现正则栈溢出，但最终仍使用线性字节检查消除该依赖。
- 导入集成6项通过：只读公共库预览、原文件归档、重复/源变化拒绝、链接拒绝、token模式及重放，以及真实Core会话绑定和上下文链路。
- Core集成验证两个账号、同账号群/私聊分别绑定不同卡片，未指定会话不继承；转换角色文本进入原有buildChatContext，世界书原始内容未混入。
- 导入组件17项通过：两种入口参数、取消、防重、全部警告与2000字符纯文本预览、HTML转义、卸载与退出锁。前端复用Modal和公共ui-modal-content，未创建另一套确认框。
- 独立复核确认mode在main/preload/API/controller间一致，原token与退出保护链路保留。初次集成类型检查发现controller的继承类型联合收窄问题，改为显式区分酒馆元数据后通过。
- 最终全量`npm test`：75文件通过，559项通过、1项跳过、0失败（560项）。跳过仍为现有Windows文件symlink创建权限用例。
- `npm run typecheck`、`npm run desktop:build`、`git diff --check`通过。

本轮未执行真实Electron JSON/PNG选择器和托盘交互，未声称完成新增预览的浏览器视觉/缩放验收；组件与Core测试不是原生验收。未连接QQ、SnowLuma、付费模型或执行卡片扩展。历史42号的隔离浏览器布局证据不冒充本轮原生选择器证据。

## 5. 参考与实机验收

格式依据：[V2原始规范](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)、[SillyTavern PNG解析实现](https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js)、[官方角色字段说明](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)，于本轮读取。实现刻意限定上述基础转换范围，不等于复刻参考项目。

实机应依次确认：V1 JSON、V2 JSON、带chara的PNG可预览；取消不写；确认后列表出现但未部署；同文件重复拒绝；长文本和警告可滚动查看；部署后逐会话绑定；切换或退出受保护。只有ccv3/V3和独立世界书应给出明确不支持提示。

下一阶段应先制定世界书的触发规则、会话隔离、上下文预算及编辑/导入方案，再实现长期记忆，不能仅把character_book文本直接拼进角色设定宣称世界书已可用。
