# 241 角色配置后端第一包实施记录（RS-01）

2026-11-10，`dev-front` 工作树。按 [236 角色配置与全局设置后端缺口复核](236-role-settings-backend-gap-review.md) 的首版优先级，完成模型服务配置闭环：密钥只写存储、统一凭据解析、按已保存资源列模型与测试、测试结果过期与清理、模型地址与请求边界，以及声音配置的参考音频列表／删除和预置音色下架映射。真实生图服务、外观目录导入、删除语义仍待后续工作包；本文结论只覆盖本机离线范围。

## 1. 范围与结果

| 236 条目 | 本轮结果 |
| --- | --- |
| §2 密钥直填 | 已实现。`secret` 只写，资源与密钥同事务保存；更新支持保留、替换、清除；读接口只回 `stored`／`reference`／`missing`／`unavailable` 与 `resolvable`。对话、记忆整理、过场图规划、连接测试共用同一解析入口。 |
| §3 按资源列模型／测试 | 已实现。新增 `POST /v1/resources/:resourceId/models` 与 `/model-test`；测试记录带资源归属和配置指纹，资源视图返回最近测试及 `stale`。地址或协议变化清空该资源旧记录。 |
| §3 反查地址与请求边界 | 已实现。baseUrl 只允许 http/https，拒绝内嵌账号、查询串、片段并规范化末尾斜杠；列表 20 秒超时、连接测试 60 秒超时；请求不跟随重定向；列表响应区分空列表与格式不兼容。 |
| §4 参考音频 | 已实现列表与删除。列表标记当前引用，使用中拒绝删除；记录删除后文件清理失败返回 `fileRemoved=false`。 |
| §5 预置音色下架 | 已实现机器可读映射。上游 404 且带 `VOICE_NOT_FOUND`／`PRESET_VOICE_NOT_FOUND` 时返回 409 `TTS_VOICE_UNAVAILABLE`；单纯 404 仍按通用失败处理。 |
| §5 外观目录导入、§6 删除、§6.3 生图锚点 | 未开始，列入后续工作包；生图已于 [248](248-comfyui-adaptation.md) 适配 ComfyUI。 |

## 2. 密钥存储与统一解析

### 2.1 应用库 v3

- `APP_SCHEMA_VERSION` 由 2 升到 3，新增 `resource_secrets` 表保存密文、密钥版本和时间；`model_test_calls` 增加 `config_fingerprint` 与 `(resource_id, finished_at)` 索引。[schema.ts](../backend/src/storage/schema.ts#L88)
- 迁移按既有机制注册：v2 库执行 `CREATE TABLE`、`ALTER TABLE ... ADD COLUMN` 和索引，已有资源、角色和测试记录保持不变。v3 测试用真实回放验证：建 v3 库、删新表与新列、`user_version = 2` 后重开，资源仍可读且结构补齐。

### 2.2 本地密钥盒

- `SecretCipher` 首次保存密钥时在 `<app-root>/secrets/master.key` 生成 32 字节主密钥（目录 0700、文件 0600），用 AES-256-GCM 加密，密文格式为 `v1.<iv>.<tag>.<ciphertext>`；解密失败返回 `null`。[secret-cipher.ts](../backend/src/security/secret-cipher.ts#L20)
- 主密钥创建使用 `wx` 排他写入；并发创建时读取同一份，避免两个进程用不同密钥写库。
- 这是原型阶段的本地静态加密：能避免直接翻看数据库得到明文，但同账户进程仍可读取主密钥。桌面打包、跨重启和 Electron `safeStorage` 的取舍留到桌面接入时确定，已在 README 标明。

### 2.3 统一凭据解析

- `CredentialResolver` 按资源读取直填密钥，没有时回退 `env:`／`file:` 引用；`inspect` 返回四种状态，`resolve` 在不可解密或引用缺失时抛 `MODEL_CREDENTIAL_UNAVAILABLE`，`fingerprintSalt` 把密钥更新时间带入测试指纹。[credential-resolver.ts](../backend/src/application/credential-resolver.ts#L27)
- 对话服务、记忆运行时、过场图规划器和模型服务都改为通过该解析器取凭据；没有注入解析器的测试路径仍保留原 `resolveCredential` 行为。

## 3. 资源接口

- 创建：`secret` 与资源配置在同一事务写入；配置非法、密钥超长或非模型资源带密钥时整笔回滚，不会留下孤儿密钥。[resource-service.ts](../backend/src/application/resource-service.ts#L85)
- 更新：省略 `secret` 保留，`null` 清除，字符串替换。直填密钥与 `credentialRef` 二选一；替换密钥时配置带引用、保留密钥时新配置引入引用、创建时同时提供，均返回 `RESOURCE_CREDENTIAL_CONFLICT`。[resource-service.ts](../backend/src/application/resource-service.ts#L121)
- 读取：`GET /v1/resources` 与 `GET /v1/resources/:resourceId` 返回 `credential` 摘要和 `lastTest`，不包含明文或密文。[routes.ts](../backend/src/http/routes.ts#L516)
- `secret` 不进入 `config_json`，配置校验仍按 `modelConfigSchema` 执行；读接口回显的 `config` 与旧版本兼容。

## 4. 按资源探测与结果过期

- 新增 `POST /v1/resources/:resourceId/models` 与 `/model-test`，按资源 ID 读取配置和统一凭据；非模型资源返回 `RESOURCE_KIND_MISMATCH`。[routes.ts](../backend/src/http/routes.ts#L540) · [model-service.ts](../backend/src/application/model-service.ts#L83)
- 测试记录写入 `resource_id` 和 `config_fingerprint`；指纹由协议、规范化 baseUrl 和凭据版本（密钥更新时间或引用串）组成，不包含明文。[model-service.ts](../backend/src/application/model-service.ts#L95)
- 资源视图的 `lastTest` 带 `stale`：密钥替换、清除或重新保存后，旧结果不再对应当前配置。地址或协议变化时直接删除该资源的测试记录，视图返回 `lastTest: null`。
- 新建服务的候选探测仍用 `POST /v1/model-services/models` 与 `/test`，可带一次性 `secret`；该密钥只用于本次请求，不落库。[model.ts](../backend/src/domain/model.ts#L18)

## 5. 地址与请求边界

- `modelBaseUrlSchema` 统一校验和规范化：只接受 http/https，拒绝账号、查询串、片段和空主机名，去掉末尾斜杠。[resource.ts](../backend/src/domain/resource.ts#L18)
- 列表请求默认 20 秒超时，连接测试默认 60 秒超时；超时分别映射为 `MODEL_REQUEST_TIMEOUT`，调用方信号取消映射为 `MODEL_REQUEST_FAILED`（`reason=ABORTED`）。
- 所有模型请求使用 `redirect: "manual"`，3xx 返回 `MODEL_REDIRECT_BLOCKED`，避免带凭据的请求被带到未预期地址。[protocols.ts](../backend/src/model/protocols.ts#L579)
- 列表响应必须是 `{ "data": [...] }`：缺 `data`、`data` 非数组、条目没有 `id` 时返回 `MODEL_LIST_INCOMPATIBLE`；`data: []` 是合法空列表。[protocols.ts](../backend/src/model/protocols.ts#L34)

## 6. 声音配置补充

- `GET /v1/roles/:roleId/voice/references` 列出该角色已导入的参考音频，`inUse` 标记当前 `referenceAssetId`；不返回角色目录内的相对路径。[voice-service.ts](../backend/src/application/voice-service.ts#L285)
- `DELETE /v1/roles/:roleId/voice/references/:assetId` 先校验是否正在使用，使用中返回 409 `VOICE_REFERENCE_IN_USE`；记录删除成功后清理文件，失败返回 `fileRemoved=false` 并保留日志，便于配置页提示重试。[voice-service.ts](../backend/src/application/voice-service.ts#L310)
- 文件清理只允许角色目录内路径；异常记录不执行越界删除。
- 统一 TTS 错误解析新增 `code` 字段读取；404 且 `code` 为 `VOICE_NOT_FOUND`／`PRESET_VOICE_NOT_FOUND` 时映射为 409 `TTS_VOICE_UNAVAILABLE`，其余 404 仍按 `TTS_SYNTHESIS_FAILED`。[transport.ts](../backend/src/tts/transport.ts#L100) · [unified-tts-client.ts](../backend/src/tts/unified-tts-client.ts#L146)

## 7. 测试与自验

- 新增 `tests/p12-role-settings.test.ts` 12 项：密钥只写与对话取用、保留／替换／清除、创建原子性、按资源探测与指纹过期、不可解密状态、列表响应与重定向／超时、地址校验与规范化、环境引用状态、参考音频列表／删除／占用、预置音色下架映射、app v2→v3 迁移、文件清理失败。
- 全量正式测试 298 项通过（本轮新增 12 项）；类型检查通过。
- `npm run accept:offline`（Node 24.22.2）21／21 步通过，正式测试 298／298，交付回归 2／2，`sourceUnchanged=true`，`realServiceCalls=0`。
- 运行目录 `backend/test-results/p5-2026-11-10T04-14-09-067Z-eeea7094/`，`summary.json` 记录逐步结果、298 项测试与源码哈希。

## 8. 未完成与后续

- 236 §5 外观目录导入：`standees`／`expressions` 识别、按套预览、同名归并和旧格式兼容，属于桌面目录识别与后端素材用途复用，下一包处理。
- 236 §6.3 生图锚点与真实服务：基础提示词、服饰提示词、图生图锚点图、按所选模型校验和任务提交时固定配置，需先确定首个生图服务。
- 236 §6.4 删除：角色、资源、服饰、参考音频之外的配置对象仍缺安全删除与占用提示。归档已按 DL-151 取消，删除直接执行。
- 密钥方案仍是本地主密钥加密；桌面接入时验证 Electron `safeStorage`、独立 Node 后端取用方式和跨重启行为后再调整。
- 本轮未改动 MCP 的 `env` 回显；按 236 建议，页面接入直填 MCP 令牌时再纳入秘密存储。
