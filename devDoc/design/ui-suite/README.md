# Accompany 十二页 UI 图集

> 历史图集：导航与部分业务结构已失效。请优先查看 [当前关键页面修订图](../ui-suite-v2/index.html) 与 [15 最新方案](../../15-account-models-and-conversation-roles.md)。会话页已移除，任务媒体历史不再展示，模型配置为账号级五能力，角色卡逐群/私聊绑定且无默认卡。

2026-10-22。内置 image_gen 生图，静态概念稿，非应用截图。

[打开可放大的离线图集](index.html) · [整体前端方案](../../13-frontend-design-and-implementation.md) · [验收标准](../../14-frontend-design-acceptance.md) · [复核记录](REVIEW.md)

| 页面 | 图稿 | 提示词 |
| --- | --- | --- |
| 账号展示主页 | [01-home.png](01-home.png) | [prompt](01-home.prompt.txt) |
| 工作台总览 | [02-overview.png](02-overview.png) | [prompt](02-overview.prompt.txt) |
| 实例与监听 | [03-instances.png](03-instances.png) | [prompt](03-instances.prompt.txt) |
| 账号资料与角色 | [04-profile.png](04-profile.png) | [prompt](04-profile.prompt.txt) |
| 插件与 Skill | [05-extensions.png](05-extensions.png) | [prompt](05-extensions.prompt.txt) |
| 模型服务 | [06-models.png](06-models.png) | [prompt](06-models.prompt.txt) |
| 账号策略 | [07-policy.png](07-policy.png) | [prompt](07-policy.prompt.txt) |
| 会话 | [08-conversations.png](08-conversations.png) | [prompt](08-conversations.prompt.txt) |
| 任务与媒体 | [09-tasks.png](09-tasks.png) | [prompt](09-tasks.prompt.txt) |
| 事件诊断 | [10-diagnostics.png](10-diagnostics.png) | [prompt](10-diagnostics.prompt.txt) |
| 应用设置 | [11-settings.png](11-settings.png) | [prompt](11-settings.prompt.txt) |
| 资源库 | [12-resources.png](12-resources.png) | [prompt](12-resources.prompt.txt) |

设计令牌在 [design-tokens.css](design-tokens.css)，仅作为开发输入，尚未导入应用。图集无需联网。主页复用已认可的图稿；其余页面以同一工作台截图作为风格参考逐页生成。角色、账号、时间、状态均为示例。

图稿用于确定布局与气质；正式文字、能力、按钮与动效以设计文档为准。特别是停止监听、暂停自动处理、请求卸载三者必须分开；视频能力为视频理解。实际前端需使用清晰的无衬线正文，不能从图片识别字号直接照搬。
