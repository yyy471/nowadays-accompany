# 本地插件与 Skill 示例

这两个目录演示本轮后端接入格式，不访问网络，也不需要真实 QQ 或付费模型。

## 目录

- `weather/`：最小插件，声明一个 `query` 工具，并从账号插件配置 `ctx.config.city` 读取默认城市；同时声明一个插件内 Skill `forecast`。
- `travel-planning/`：独立 Skill，使用 `SKILL.md` 正文和可选 `skill.json` 元数据，引用 `public/plugin/weather/query`。

## 放入待导入目录

把整个包目录复制到运行数据的 imports 目录：

```text
<dataRoot>/imports/plugins/weather/
<dataRoot>/imports/skills/travel-planning/
```

扫描只读取 `manifest.json`、`SKILL.md`、`skill.json` 和目录结构，不执行插件代码。扫描、预览和导入都通过本地控制面接口完成：

```http
POST /extensions/imports/scan
POST /extensions/imports/preview
POST /extensions/imports
```

导入插件示例：

```json
{
  "kind": "plugin",
  "sourceDirectory": "<dataRoot>/imports/plugins/weather",
  "target": { "source": "public" }
}
```

导入 Skill 需要当前 `expectedRevision`：

```json
{
  "kind": "skill",
  "sourceDirectory": "<dataRoot>/imports/skills/travel-planning",
  "target": { "source": "private", "accountId": "10001" },
  "expectedRevision": "<listPublicSkills 或 listPrivateSkills 返回的 revision>"
}
```

插件导入到公用或账号私有 artifacts，之后仍由账号 `profile.plugins` 选择；Skill 导入到已有定义并默认关闭。导入不会安装依赖、授权工具、启用插件或启动 Worker。

## 账号配置

插件配置只写 `profile.plugins[].config`，Skill 配置写账号策略的 `skills.configs`。两者都是普通 JSON 对象，宿主不解释业务字段：

```http
GET /accounts/10001/extensions/config?kind=plugin&id=public%2Fplugin%2Fweather
PUT /accounts/10001/extensions/config?kind=plugin&id=public%2Fplugin%2Fweather
```

PUT 请求体：

```json
{ "config": { "city": "杭州" }, "expectedRevision": "<GET 返回的 revision>" }
```

Skill 配置使用实际解析后的 id，插件 Skill 保留完整命名空间，例如 `public/plugin/weather/skill/forecast`。

## 手动测试

工具直接测试会实际启动本次测试 Worker 并执行插件代码，不调用对话模型：

```json
{
  "toolId": "public/plugin/weather/query",
  "arguments": { "city": "杭州" },
  "scope": { "kind": "private", "peerId": "extension-test" }
}
```

Skill 预览不启动 Worker、不调用模型、不执行插件；Skill 实际测试会调用已配置的对话模型，并允许模型使用当前可用工具：

```http
POST /accounts/10001/extensions/tests/skill-preview
POST /accounts/10001/extensions/tests/skill
```

```json
{
  "skillId": "travel-planning",
  "input": "帮我安排明天的杭州一日游",
  "roleText": "你是一位旅行规划助手。"
}
```

测试使用账号已保存的安装项、开关、授权和配置；未授权或关闭时不会启动目标插件，也不会自动安装、启用或授权资源。直接工具测试只启动目标插件，Skill 实际测试只启动目标 Skill 及当前启用的工具/Hook 所需插件。`test.status`、最终 reply 和 `tools` 来自实际运行；Skill 测试的 `tools` 是第一次真实模型请求实际提供的工具，模型不支持 tools 时为空。内置媒体结果通过现有 `/jobs` 查询。插件自身写文件或访问外部服务的副作用无法由宿主隔离。`config.example.json` 只是说明文件，不会被自动合并。
