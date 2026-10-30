# 模型配置 HTML 候选：设计与实现方自验

2026-10-29。用户要求为当前前端设计语言提供模型配置页面HTML样例，同时覆盖深色和浅色。交付为[单文件HTML](design/character-studio/model-config/index.html)，[目录说明](design/character-studio/model-config/README.md)含离线和本地服务打开方式。状态为候选，未正式接入。

## 设计与范围

保留夏澄手账系统的纸白／墨蓝、深蓝提交、手账红／琥珀强调、樱粉书签、系统中文字体、等宽技术字段、折信N和底部昼夜Dock。页面采用能力索引和配置纸页，纸页内分服务接入与模型／测试两栏；窄屏降为纵向表单，业务内容独立滚动，顶部和Dock不被页面滚走。

参考当前`Models.tsx`和`Policy.tsx`，将“服务与模型”和“账号使用”分为两个视图，避免保存模型服务等同账号授权。五类能力沿用文本、视觉、视频、图片生成和语音生成；配置支持来源、协议、URL、密钥、模型、工具能力与语音音色。示例保留凭据来源变更需重填、测试不保存、未知不自动重试等语义，但不接真实API。

生成器嵌入已有`character-tokens.css`、`dock-notebook.css`、公共图标路径与折信SVG。未修改正式renderer、全局token、业务契约或应用配置。独立HTML原生控件不冒称正式公共UI组件。样例模型和账号均有示例标记，没有伪造真实连通状态或耗时数据。

## 实际验证

本机Playwright Chromium以`file://`直接打开生成HTML。脚本：`test-results/verify-model-config-sample.mjs`。本批最终结果为：

| 检查 | 本次结果 |
| --- | --- |
| 昼夜布局 | 1440×1160、1280×900、1024×720、768×900、414×896、375×812、320×740，两主题共14组；根无横向溢出，必要控件横向留在视窗内 |
| 草稿 | 切主题、能力、服务／账号视图均保留各自输入 |
| 测试 | 加载、成功、鉴权失败、超时未知，当前输入保留，成功不保存、未知不重试 |
| 异步归属 | 等待时修改配置，旧演示结果不会覆盖新草稿 |
| 模型列表 | 列表选择、空列表、获取失败及手动输入回退 |
| 字段 | 无效URL关联错误并聚焦；自定义地址保存后可复用自身凭据来源，改域后要求重新输入；保存清空密钥字段 |
| 能力专属 | 文本工具开关、视频协议和语音音色仅在对应能力出现 |
| 账号 | 权限控制模型选项、两个示例账号草稿隔离、分别保存 |
| 键盘与弹窗 | 页签方向键结构已实现；模型列表选择关闭、Esc和返回焦点、外观减少动效检查通过 |
| 网络与运行 | pageerror为0，HTTP请求为0；无Core、QQ、SnowLuma或模型进程 |
| 语法 | `node --check sample.js`通过；生成器成功输出单文件HTML |

13组交互断言及14组布局的机器记录：[verification.json](design/character-studio/model-config/verification.json)。[白昼](design/character-studio/model-config/daylight.png)和[晚风](design/character-studio/model-config/nightwave.png)为最终HTML的实际截图。

视觉自验修正：最初长表单改为桌面双栏，修正shadow token名称与Dock标记可见性；将必要下拉边界改用lineControl；测试过的吸附保存栏会遮挡窄屏标题，最终移除，保存栏随纸页在独立业务区域内滚动可达。凭据来源从固定示例域修正为按草稿保存的credentialOrigin；独立复核也发现了同项，修复由双方分别验证。

## 交付纪律

独立方的测试和结论见[149](149-model-config-html-independent-review.md)。候选布局、交互与浏览器证据不等同正式React迁移、原生Electron组合或发行EXE验收。未改生产页面，未执行全量项目回归；本轮是HTML候选的实际渲染与交互检查。未提交、推送或打包。
