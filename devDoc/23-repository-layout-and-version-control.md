# 目录与版本管理规范

日期：2026-10-23。首次本地提交前整理。

## 目录约定

| 路径 | 用途 | 进入Git |
| --- | --- | --- |
| `src/` | 核心、CLI及业务模块；TypeScript文件使用kebab-case | 是 |
| `desktop/` | Electron入口、构建脚本、应用图标和React前端；React组件使用PascalCase | 是 |
| `test/` | 回归测试源码、测试辅助函数 | 是 |
| `test/diagnostics/` | 可重复运行的独立诊断脚本 | 是 |
| `devDoc/` | 用户指定的设计与开发文档目录，保留现有命名 | 是 |
| `devDoc/design/` | 设计概念稿、提示词、规范和静态图集 | 是 |
| `test-results/ui/` | 本地页面验收截图；文档中的截图链接在本机可用 | 否 |
| `coverage/`、`playwright-report/` | 自动测试报告 | 否 |
| `nowadays.config*.example.json` | 不含真实凭据的配置样例 | 是 |
| `dist/`、`desktop-dist/`、`desktop/renderer/dist/` | 可重新构建的输出 | 否 |
| `release/`、`release-*/`、`.packaging*/` | EXE、安装包、解包与打包中间目录 | 否 |
| `node_modules/`、本地缓存、运行数据、真实配置与环境变量文件 | 本机依赖与用户私有数据 | 否 |

`test/`是有效且常见的测试源码目录，无需仅为改名迁移为`tests/`。`devDoc/`为已有明确约定，不为统一大小写而破坏文档路径。历史概念图中的accompany名称及文档编号保留历史含义。

## 本轮整理

1. 两份位于`devDoc/`的复现脚本移至`test/diagnostics/`，同步修正导入与文档运行命令。
2. 六组页面验收截图及品牌接入截图移至`test-results/ui/`，同步更新文档引用。截图只在本地保留，不随克隆分发；验收结论与复现源码保留在Git中。
3. 旧`accompany.config*.example.json`与新名称样例逐份哈希一致，删除重复旧样例；实际CLI兼容入口、配置兼容和数据目录迁移逻辑保留。
4. 前端`public/icon.png`与`nowadays-icon.png`哈希一致，且无使用引用，移除旧重复文件。`desktop/assets/`内图标为桌面端实际资源，继续保留。
5. 补充`.gitignore`、`.gitattributes`和`.editorconfig`，约定UTF-8、LF、二进制资源识别，以及测试产物、私有配置和构建输出的排除规则。

## release管理

不提交EXE到Git。提交源码、`package.json`中的版本号、锁文件、构建脚本和配置样例；后续正式发布时，可对发布提交打版本标签，并将安装包、便携包及校验值放入发布平台的Release附件或独立归档。本轮仅本地提交，不推送、不创建远端发行版。

用户已确认：保留测试源码，仅忽略测试产物；release不进入Git。

## 整理后的验证

- `npm run typecheck`通过。
- `npm test`：40个文件、262项测试通过。
- 两份独立诊断脚本从新目录执行成功；第一份历史脚本补齐了当前强制要求的会话角色绑定准备。
- `npm run desktop:build`通过。
- 使用`git check-ignore`确认测试截图、release、构建目录、本地环境配置被忽略；测试源码与配置样例未被忽略。
