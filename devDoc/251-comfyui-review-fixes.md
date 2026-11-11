# ComfyUI 生图复核修复（250 CG-R01～CG-R05）

2026-11-11，`dev-front` 工作树。按 [250 独立复核](250-comfyui-independent-review.md) 修复 CG-R01～CG-R04，并处理复验追加的 CG-R05；保存与生成链路仍以 [248](248-comfyui-adaptation.md) 的 ComfyUI 适配为基础。真实 ComfyUI／MOSS-Image 联调与图生图仍未开始。

## 1. CG-R01 纯背景只传环境描述

- 新增按最终图层模式组装的提示词：`background` 只用规划器给出的环境描述；`full_scene` 才拼接角色基础锚点、目标服饰锚点和场景描述。[提示词组装](../backend/src/scene/comfyui-generator.ts#L57)
- 生成器对两种图层模式都不再无条件拼接锚点；测试生图仍按完整肖像组装，不受影响。
- 正式测试发起纯背景任务，假服务收到的正向提示词仅为「与对话氛围相符的环境背景，不出现人物。」，不再包含基础锚点或服饰锚点。[用例](../backend/tests/p13-comfyui.test.ts#L608)

## 2. CG-R02 配置读写不解析生图凭据

- 全局生图服务新增只读记录查询，不解析密钥；角色生图配置的 GET 与 PUT 改用该查询，服务存在且启用即可读取和修正。[记录查询](../backend/src/application/image-service.ts#L160) · [配置读取与保存](../backend/src/application/scene-image-settings.ts#L77)
- 探测、测试生图、任务生成仍解析凭据；引用无法解析时返回 500 `MODEL_CREDENTIAL_UNAVAILABLE`，不会静默跳过认证。
- 测试将已关联服务改为缺失的 `env:` 引用：配置仍可 GET 和 PUT，探测与测试生图返回该错误；补上环境变量后同一份配置可继续测试生图。[用例](../backend/tests/p13-comfyui.test.ts#L646)

## 3. CG-R03 任务接收时固定服务、模型与锚点

- 业务库升到 V16，`scene_image_tasks` 增加 `config_json`，在任务接收时保存当前角色生图配置、服务地址与超时快照。[迁移](../backend/src/storage/schema.ts#L1478)
- 生成器新增锁定入口：接收任务时取当前设置与服务记录，不解析凭据；任务开始后把快照原样交给生成器。[锁定](../backend/src/scene/comfyui-generator.ts#L164) · [接收时快照](../backend/src/application/scene-image-service.ts#L108)
- 生成阶段优先使用快照中的模型、锚点、工作流与采样参数，以及固定的服务地址和超时；服务是否存在、是否启用和凭据仍按生成时的状态检查，删除返回 `SCENE_IMAGE_NOT_CONFIGURED`，停用返回 `IMAGE_SERVICE_DISABLED`，不回退占位生成器。[固定配置生成](../backend/src/scene/comfyui-generator.ts#L206)
- 测试在规划期间保存新模型与新锚点：完成后假服务收到的仍是接收时的模型与锚点；规划期间停用服务则任务失败为 `IMAGE_SERVICE_DISABLED`，假服务收到 0 次工作流提交。[配置固定用例](../backend/tests/p13-comfyui.test.ts#L710) · [停用用例](../backend/tests/p13-comfyui.test.ts#L774)
- 快照同时记录「接收时尚未配置真实服务」：这类任务固定使用占位生成器，规划期间新增配置不会切换真实服务。[未配置任务用例](../backend/tests/p13-comfyui.test.ts#L903)

## 4. CG-R04 中止清理与有效超时

- ComfyUI 客户端在提交成功后的轮询外层补一次兜底：轮询请求因信号中止而抛错时，尝试一次 `POST /queue` 删除远端任务再抛出原错误；循环顶部的取消分支只清理一次，不重复删除。[轮询清理](../backend/src/scene/comfyui-client.ts#L122)
- 过场图外层等待上限改为采用任务固定快照中的服务超时；没有快照或未配置真实服务时默认 180 秒，与 ComfyUI 客户端的默认生成上限一致，不再让 120 秒外层上限提前截断 180 秒的服务等待。[外层超时](../backend/src/application/scene-image-service.ts#L418)
- 测试在 `/history` 挂起时中止客户端，假服务收到 `/queue` 删除请求；配置 5 秒服务超时后任务按 `SCENE_IMAGE_GENERATION_TIMEOUT` 结算，并同样清理远端任务。[中止用例](../backend/tests/p13-comfyui.test.ts#L817) · [超时用例](../backend/tests/p13-comfyui.test.ts#L849)

## 5. CG-R05 旧任务跨站点不复用新凭据

- 任务快照增加服务协议；生成前用协议与 origin 比较快照和当前服务。跨站点（域名或端口）变更时以 409 `SCENE_IMAGE_SERVICE_CHANGED` 失败并提示重新发起，不再组合旧地址与新站点凭据发起请求。[站点比较](../backend/src/scene/comfyui-generator.ts#L231) · [错误定义](../backend/src/domain/errors.ts#L566)
- 同站点路径变化沿用快照地址；同站点轮换令牌仍按当前凭据正常生成。站点身份规则与生图服务保存配置共用同一实现。[站点身份](../backend/src/domain/image-service.ts#L59)
- 测试覆盖：任务停在规划阶段时把同一服务的地址和令牌从 A 改到 B，任务失败为 `SCENE_IMAGE_SERVICE_CHANGED`，A、B 均收到 0 次请求；同站点轮换令牌后新任务成功，`/prompt` 认证头分别为旧、新令牌。[跨站点用例](../backend/tests/p13-comfyui.test.ts#L951) · [令牌轮换用例](../backend/tests/p13-comfyui.test.ts#L1005)

## 6. 验证

- `p13-comfyui.test.ts` 由 6 项增至 15 项；类型检查通过；后端全量 **317／317** 通过。
- 版本断言同步到业务库 V16；v9／v10／v11 迁移样例补上缺失的 `config_json` 列，旧库仍可从各自版本升级。[p9 迁移样例](../backend/tests/p9-tts-unified.test.ts) · [v12 迁移样例](../backend/tests/p10-scene-image.test.ts#L513)
- 统一离线验收 21／21 步，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-11T01-50-20-647Z-1ace53fd/`。
- 桌面端未改代码；真实 ComfyUI 与 MOSS-Image 待联调，图生图待实施。独立复验见 [250](250-comfyui-independent-review.md#251-第-5-节补修独立复验)。
