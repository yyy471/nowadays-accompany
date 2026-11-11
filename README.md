# Nowadays

Nowadays 是一个面向单用户桌面的数字生命项目。每个角色拥有独立身份、角色设定、记忆、日记和工作空间，可以在多个对话窗口中延续经历，也可以按自己的安排使用工具、记录成果并主动分享。

当前可运行的是首轮本机后端原型，提供命令行、HTTP API 和 SSE 事件流。首轮整体复核已通过。 [P5 复核报告](devDoc/195-p5-independent-review.md)

首轮补齐的六项功能包括慢工具转后台、任务暂停与续行、未知结果补录、记忆容量分批、Skill 脚本执行和日记正文读取，均已通过本机离线复核。 [功能补齐复核记录](devDoc/198-p5-capability-gaps-independent-review.md#r01-第三次补修的独立复验)

角色外观导入、Agent 每日穿搭和桌面主页立绘已完成首轮实施。独立复验覆盖千叶原图导入、图片全帧解码、换装状态与主页展示，R01～R03 在已复验范围关闭。 [外观实施记录](devDoc/210-appearance-implementation-record.md) · [独立复验记录](devDoc/211-appearance-independent-review.md#r01-全帧校验补修独立复验)

对话演出第一包已完成首轮实现并经独立复核，发现快照接续、服饰回退、标注计量和旁白切分问题后已修复：回复按自然句段保存稳定标识，窗口快照携带 SSE 游标并支持向前翻页，句段保存回复时服饰，标注接入模型计量与自主额度；补充复验后，断线重连从较新游标续接、标注扣点与调用登记同事务、行内多段星号动作之间的台词归还台词；最新补修把标注适配器初始化前移到扣点之前，凭据缺失不扣点、不记调用。统一离线验收 21 步、230 项测试通过，已通过独立复验。第二部分 TTS 已完成 IndexTTS 本地 HTTP 后端，并通过 219 的 WAV 帧完整性、拒绝媒体类型时的连接收尾和空查询串／片段补修复验；DL-140 统一接入已按 220／221 完成首轮后端实施：服务能力探测、克隆／预置音色、multipart 合成、业务库升级到 v12 和旧配置兼容；222 复核的重定向、试听 `config`、服务切换音色绑定和语言／语速声明已修复，后续补充的单模式自动绑定、语速下限、模式确认持久化、默认语速范围、v10 迁移待确认状态和上一版 v11 迁移回填也已修复，统一离线验收 21 步、261 项测试通过，R01～R04 在已验范围关闭。[TTS 独立复验](devDoc/222-tts-unified-independent-review.md#221-第-11-节-v12-回填独立复验)ComfyUI 生图适配已按 248 接入，250 复核的 CG-R01～CG-R05 已按 [251](devDoc/251-comfyui-review-fixes.md) 修复并通过 [250 独立离线复验](devDoc/250-comfyui-independent-review.md#251-第-5-节补修独立复验)。桌面对话语音播放和角色配置页试听已接入，真实服务待联调。 [TTS 记录](devDoc/218-tts-implementation-record.md) [统一接入记录](devDoc/221-tts-unified-implementation.md) [复核记录](devDoc/216-conversation-performance-independent-review.md) · [修复记录](devDoc/217-conversation-performance-review-fixes.md)

## 主要功能

- **角色与对话**。同一角色可以维护多个独立窗口，并在窗口之间共享长期记忆。更新设定时，角色身份和已有经历会保留。
- **事件记忆**。从对话和活动中整理事件与日常摘要，并保留角色写下的日记。角色回复时可以按需检索，并追溯到原始证据。
- **自主活动**。角色可以安排后续行动、到时唤醒、保存成果并主动分享。自主调用使用统一的每日额度。
- **模型与扩展**。提供 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 适配，支持模型列表与连接测试。工具通过本地 stdio MCP 接入，方法与知识通过 Agent Skills 按需加载。
- **中断与恢复**。持久化消息、任务、工具结果及图检查点。进程重启时可恢复符合条件的任务，并记录结果未知的操作以供核查。

## 快速开始

需要 Git、Node.js 24 或更高版本，以及 npm。以下命令使用 PowerShell。首轮验收环境为 Windows x64 和 Node.js 24.22.2。

```powershell
git clone --branch master https://github.com/yyy471/nowadays-accompany.git
Set-Location nowadays-accompany/backend
npm ci
npm run dev -- --app-root ./.nowadays --port 3210
```

后端启动后监听 `127.0.0.1:3210`。另开终端，在仓库的 `backend/` 目录检查服务并创建一个示例角色。

```powershell
npm run cli -- health
npm run cli -- role create --name 小今 --definition '@examples/role.md'
```

创建结果包含 `roleId` 和 `defaultWindowId`。用 `roleId` 为角色绑定对话模型与记忆模型，发消息时指定角色和窗口。模型配置样例位于 `backend/examples/`，凭据通过环境变量或文件引用提供。 [模型配置、发送消息与本地工具接入](backend/README.md)

运行数据保存在指定的 `app-root` 内。上述命令将数据写到 `backend/.nowadays/data/`，每个角色有自己的目录，里面保存业务库、执行检查点库和工作空间。重启时使用同一个 `app-root` 即可保留角色与记录。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `backend/src/` | TypeScript 后端、LangGraph 执行、SQLite 存储、HTTP／SSE 与 CLI |
| `backend/examples/` | 角色设定、模型配置、资源绑定、本地 MCP 和 Skill 样例 |
| `backend/tests/` | 后端自动化测试 |
| `backend/reviews/` | 各阶段的专项验收脚本 |
| `prototypes/p0/` | LangGraph、SQLite 与本地 MCP 技术小样 |
| `devDoc/` | 产品决策、实施方案和阶段复核记录 |

CLI 通过本机 HTTP API 操作角色，SSE 提供回复和执行进度。后端使用 LangGraph 编排对话与任务，SQLite 按角色保存业务数据和执行检查点，工作空间中的笔记使用 Markdown。

## 开发与验证

在 `backend/` 目录运行以下命令。

```powershell
npm run typecheck
npm test
npm run accept:offline
```

`accept:offline` 汇总类型检查、后端测试、进程冒烟及业务专项，使用离线模型与本地工具，并把本轮报告写入 `backend/test-results/`。首轮复核覆盖 168 项正式测试和 59 个业务场景。真实模型联调记录限定于已验证的 DeepSeek Anthropic Messages 配置。 [复核范围与证据](devDoc/195-p5-independent-review.md)

## 开发进度

- **已完成**。首轮本机后端原型及整体复核。
- **下一阶段**。接入远程 Streamable HTTP MCP，并复核连接、调用及恢复行为。
- **后续阶段**。单用户桌面界面和打包，以及网页浏览、视频、电脑控制和 QQ 等平台接入。

`master` 是当前主开发分支，包含可运行的后端原型、项目设计和验收记录。`dev` 用于归档旧版项目代码与历史。

## 文档

- 详细的安装、启动、配置和 CLI 用法。 [后端使用说明](backend/README.md)
- 需求、架构与已确认的产品边界。 [持续决策记录](devDoc/161-digital-life-direction-decisions.md)
- 各开发阶段的工程方案、验收和问题记录。 [开发文档索引](devDoc/README.md)
- 仓库协作及提交约定。 [协作指南](AGENTS.md)
