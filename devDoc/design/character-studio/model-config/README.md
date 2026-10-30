# 模型配置 · 昼夜手账 HTML 候选样例

2026-10-29。此目录是用户要求的设计与交互样例，未接入正式React页面，也未替换发行EXE。

## 打开

直接双击 [index.html](index.html)，可离线使用；CSS、昼夜token、图标和折信SVG全部内嵌，不依赖CDN、字体服务或后端。

本地浏览器预览：在仓库根执行 `node devDoc/design/character-studio/model-config/serve.mjs`，打开 `http://127.0.0.1:50440/`。预览服务只提供本目录静态文件，不提供业务接口。

## 可以体验

- 白昼来信与晚风电台；两套独立色板，主题切换保留表单内容。
- 服务与模型／账号使用两个视图，左右方向键可切换页签。
- 文本、视觉、视频、图片生成和语音生成五类能力，分别保留草稿。
- 配置来源、协议、地址、API Key显隐、模型选择、工具开关及音色。
- 获取模型、空列表、失败与超时；等待中修改输入会使旧结果失效。
- 连接测试的加载、成功、鉴权失败和结果未知；测试成功不自动保存。
- 保存演示及勾画确认反馈；每个示例账号的授权和分配互相隔离。
- 设置弹窗、Esc和返回焦点；系统与本页减少动态效果。

模型、账号和状态都明确标为示例。保存仅更新当前页面内存；API Key不会写入localStorage或文件，也不会发送。刷新会恢复示例配置，只有昼夜外观偏好会被本机记住。

## 视觉依据与范围

遵循根DESIGN、105共用规范、110晚风标准、117动效及120 Dock规范。采用折信N与Nowadays字标；复用当前生成的token、正式Dock CSS和现有SVG图标路径。页面采用能力索引＋双栏配置纸页；窄屏改为能力横向列表和纵向表单。业务内容独立滚动，顶部与Dock保留。

HTML原生表单和dialog仅用于这个独立样例；若正式迁移，需改用现有公共UI、导航／草稿准入和真实服务接口，不能将样例操作当作已有业务能力。

维护源为 `index.template.html`、`sample.css`、`sample.js`；执行 `node devDoc/design/character-studio/model-config/build.mjs` 重新生成单文件HTML。生成器读取仓库内正式token、Dock CSS、图标和折信SVG，不改这些来源文件。

## 本次证据

- [白昼整体图](daylight.png)、[晚风整体图](nightwave.png)
- [白昼窄屏](daylight-mobile.png)、[晚风窄屏](nightwave-mobile.png)
- [账号使用](nightwave-account.png)、[失败反馈](nightwave-error.png)
- [实施方浏览器记录](verification.json)、[独立复核记录](independent-review.json)

实施方通过两主题×7视窗共14组布局及13组交互检查。详见[148执行记录](../../../148-model-config-html-execution.md)与[149独立复核](../../../149-model-config-html-independent-review.md)。未运行真实模型或QQ，未进行正式页面类型检查、全量回归或发行包验收；纯HTML候选不以这些替代实际页面验证。

## 后续正式开发文档

[150开发方案](../../../150-model-config-development-plan.md)定义统一工作区、旧入口兼容、公共UI、真实接口、草稿与异步、凭据以及MC-0～MC-5实施包；[151验收标准](../../../151-model-config-acceptance.md)提供53项可执行检查；[152文档复核](../../../152-model-config-development-docs-independent-review.md)记录源码对应核验。开发方案仍为待实施，不改变本目录HTML的候选状态。
