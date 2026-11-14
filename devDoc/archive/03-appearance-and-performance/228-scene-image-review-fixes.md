# 228 过场图后端复核修复记录

2026-11-09，`dev-front` 工作树。针对 [227 独立复核](227-scene-image-independent-review.md) 的 R01～R04 修复并自验：生成等待不再依赖生成器配合取消、规划调用改为先登记后发出、指定图层在规划前进入约束并拒绝冲突方案、历史回复不再回填当前服饰。工作树未提交、未推送，真实模型与真实生图调用 0。复验由独立复核执行，本文只记录实现方自验。

## 1. 修复结论

| 编号 | 修复 | 证据 |
| --- | --- | --- |
| R01 | 规划与生成都用服务侧竞速等待，信号中止立即结算；关闭不被挂起的生成器拖住；晚到结果不再写盘或改状态 | [raceWithSignal](../../../backend/src/application/scene-image-service.ts#L607) · [生成等待](../../../backend/src/application/scene-image-service.ts#L406) |
| R02 | 规划模型调用先登记成功再发出；登记失败抛 `SCENE_IMAGE_PLAN_UNAVAILABLE`，任务可追溯失败且实际调用为 0 | [登记失败即返回](../../../backend/src/scene/model-planner.ts#L109) |
| R03 | 指定图层写入提示词与请求载荷，纯背景明确不描述人物；规划结果与指定图层冲突时拒绝，不送生成端 | [图层规则](../../../backend/src/scene/model-planner.ts#L232) · [冲突拒绝](../../../backend/src/scene/model-planner.ts#L188) |
| R04 | 服饰只认句段记录的 `outfitId`，删除角色当前服饰回退；无记录按未知服饰、无参考图生成 | [服饰查询](../../../backend/src/storage/scene-image-store.ts#L148) |

## 2. R01 服务侧超时与关闭

原实现直接 `await generator.generate(...)`，只有生成器响应 `AbortSignal` 时超时和关闭才会返回；忽略信号的实现会让任务停在 `generating`，并让 `close()` 无限等待。

修复方式：

- 新增 `raceWithSignal(promise, signal)`：信号中止时立即拒绝，同时消费底层 promise 的后续结果与拒绝，避免未处理异常。
- 规划调用与生成调用都通过该函数等待；超时或关闭先结算任务，生成器之后返回的数据不再进入解码、写盘或 `completeTask`。
- 超时仍优先结算为 `SCENE_IMAGE_GENERATION_TIMEOUT`；父信号中止（服务关闭）结算为 `SCENE_IMAGE_INTERRUPTED`。
- `close()` 只等待已竞速的在途任务，不再被单个挂起生成器阻塞。

边界测试使用完全忽略信号、永不返回的生成器，40 ms 超时后任务进入 `failed/SCENE_IMAGE_GENERATION_TIMEOUT`，随后 `close()` 在 2 秒内返回。

## 3. R02 先登记后调用

原实现登记失败时继续调用模型，导致实际调用没有 `model_calls` 记录。现改为：

- `startModelCall` 在事务内完成，失败直接抛 `SCENE_IMAGE_PLAN_UNAVAILABLE`，不构造模型请求。
- 任务以该错误码结算，错误摘要说明未发出请求；重试仍按新幂等键创建新尝试。

边界测试在角色库对 `model_calls` 注入 `BEFORE INSERT` 失败，规划模型请求数保持 1（仅原回复），生成器调用 0，任务失败为 `SCENE_IMAGE_PLAN_UNAVAILABLE`。

## 4. R03 图层约束与冲突处理

原提示词只在规则里并列两种图层，手动请求的 `layerMode` 没有进入模型输入，模型可返回相反图层与人物描述，而生成端仍按手动图层出图。

现改为：

- 提示词按请求图层生成硬约束：`background` 只描述环境、光线与氛围，不描述人物外貌、动作或表情，`layerMode` 必须输出 `background`；`full_scene` 要求描述角色与场景。
- 用户载荷增加 `requestedLayerMode`，模型能直接看到本次指定图层。
- 解析后若模型返回的图层与指定图层相反，抛 `SCENE_IMAGE_PLAN_INVALID`，任务失败，生成器不收到矛盾方案。

边界测试让模型返回 `full_scene` 与「站在窗边挥手」的描述，手动请求 `background`，断言任务失败、生成器 0 次、提示词包含 `layerMode="background"` 与「不要描述人物」。

## 5. R04 历史服饰归属

原实现在句段没有 `outfitId` 时回退角色当前服饰，后来换装会被回填进旧场景。现改为只读取该回复句段记录的服饰；没有记录时规划输入为未知服饰、`hasCharacterReference=false`，整幅图也不附带参考图。

边界测试先生成一轮无服饰回复，再导入并穿上新外套，从旧回复发起整幅图：规划载荷 `outfit.name` 为 `null`，生成器未收到参考图，任务成功。

## 6. 测试与自验

- `p11-scene-image-planning.test.ts` 由 6 项增至 10 项，新增 R01～R04 各 1 项边界测试；`p10` 的 8 项契约测试保持通过。
- 类型检查通过；`npm run accept:offline`（Node 24.22.2）21／21 步通过，正式测试 280／280，交付回归 2／2，`sourceUnchanged=true`，`realServiceCalls=0`。
- 运行目录为 `backend/test-results/p5-2026-11-09T09-08-51-330Z-accee45e/`，`summary.json` 记录逐步结果与源码哈希。
- 227 第 4 节补充复验后，本文件第 8 节追加两项修复；最终验收为 283／283，目录 `backend/test-results/p5-2026-11-09T09-25-52-153Z-73007863/`。

## 7. 未完成与后续

- 227 的复验尚未执行；R01～R04 是否关闭以独立复核结论为准。
- 真实生图服务、CG-03 自动触发、CG-04 完整复核与桌面对话演出仍待推进。
- 规划冲突当前以失败收尾，是否改为自动重规划一次，留待真实模型联调时按稳定性决定。

## 8. 227 第 4 节补充修复

[227 第 4 节](227-scene-image-independent-review.md#4-228-修复独立复验)确认 R02、R04 关闭，R01 的解码等待与 R03 的缺失图层、固定回退提示仍需处理。

### 8.1 R01 解码与写盘

- 原实现生成返回后直接等待 `inspectImage`，解码未参与竞速：关闭时仍等待解码，解码完成后还会写盘并把任务改为 `succeeded`。
- 现在解码同样通过 `raceWithSignal` 等待，并新增 `assertActive()` 在生成返回后、解码完成后、写盘后和提交前复查取消；写盘后遇到关闭会删除未提交文件，任务结算为 `SCENE_IMAGE_INTERRUPTED`。
- 为可复验性新增 `imageInspector` 注入点（默认仍为 `inspectImage`），边界测试用挂起的解码验证：`close()` 在 2 秒内返回、任务失败、`scene-images/` 目录为空。

### 8.2 R03 缺失或非法图层

- 原实现只在模型返回相反图层时拒绝；省略 `layerMode` 或返回 `portrait` 时静默按请求图层成功，人物描述仍会送到生成端。
- 现在手动指定图层时要求模型返回值严格相等，缺失或非法值一律 `SCENE_IMAGE_PLAN_INVALID`；自动规划（无指定图层）也要求返回有效图层，不再默认 `background`。
- 边界测试分别让模型省略 `layerMode` 和返回 `portrait`，两个任务均失败，生成器调用 0 次。

### 8.3 R03 固定回退的纯背景提示

- 原固定规划器在纯背景模式仍拼接服饰名与回复摘要，会把人物动作带进背景提示。
- 现在 `background` 回退只输出中性环境描述「与对话氛围相符的环境背景，不出现人物。」，不含服饰与动作；`full_scene` 仍使用服饰名与回复摘要。
- 边界测试在解绑对话模型后请求纯背景，生成提示包含「环境背景」，不含服饰名与「外套拢紧」「挥手」。

### 8.4 测试与自验

- `p11-scene-image-planning.test.ts` 由 10 项增至 13 项，新增解码关闭、缺失／非法图层、固定回退背景各 1 项；`p10` 8 项保持通过。
- `npm run accept:offline`（Node 24.22.2）21／21 步通过，正式测试 283／283，交付回归 2／2，`sourceUnchanged=true`，`realServiceCalls=0`。
- 运行目录 `backend/test-results/p5-2026-11-09T09-25-52-153Z-73007863/`。
- 首次验收时 `p4-boundaries` 的 `two-process-memory-correction` 返回 `SQLITE_READONLY`；单独重跑该场景 14／14 通过，再次全量验收通过，未改动相关代码，按环境瞬时文件锁记录。

### 8.5 待办

- R01、R03 的追加修复待独立复验；R02、R04 已由 227 第 4 节关闭。
- 真实生图服务、CG-03 自动触发与桌面对话演出仍待推进。

## 9. 227 第 5 节补修：R05 写盘所有权

[227 第 5 节](227-scene-image-independent-review.md#5-228-第-8-节补修独立复验)确认 R01、R03 关闭，R02、R04 维持关闭；新增 R05：排他写入中途失败会残留部分文件。

### 9.1 修复

- 原实现先 `fs.writeFileSync(path, data, { flag: "wx" })`，完整返回后才登记 `writtenPath`；写入中途抛错时清理路径仍为空，半张图留在 `scene-images/`。
- 现在先 `fs.openSync(path, "wx")` 取得新文件所有权并立即登记清理目标，再用文件描述符写入；写入或关闭异常由外层 `catch` 删除已创建文件。
- 目标已存在时 `openSync` 抛 `EEXIST`，不登记清理目标，不会误删已有素材。

### 9.2 测试与自验

- 新增两项边界测试：注入「先写 12 字节再抛 `ENOSPC`」，任务失败后素材表 0 条且目录为空；注入 `EEXIST` 且预先放入已有素材，任务失败后该文件内容保持完整。
- `p11-scene-image-planning.test.ts` 由 13 项增至 15 项；`p10` 8 项保持通过。
- `npm run accept:offline`（Node 24.22.2）21／21 步通过，正式测试 285／285，交付回归 2／2，`sourceUnchanged=true`，`realServiceCalls=0`。
- 运行目录 `backend/test-results/p5-2026-11-09T09-42-12-127Z-0f87ae5c/`。
- 验收期间 `p4-boundaries/two-process-memory-correction` 仍偶发 `SQLITE_READONLY`：单独连续 3 次均 14／14，全量重跑通过，未改动该场景代码，按环境瞬时文件锁记录。

### 9.3 待办

- R05 待独立复验；R01～R04 已在已验范围关闭。
- 真实生图服务、CG-03 自动触发与桌面对话演出仍待推进。

## 10. 227 第 6 节补修：R06 清理失败仍结算

[227 第 6 节](227-scene-image-independent-review.md#6-228-第-9-节-r05-独立复验)确认 R05 关闭，新增 R06：删除未提交文件被拒绝时，异常发生在结算之前，任务停在 `generating`。

### 10.1 修复

- 新增 `discardUncommitted`：删除失败只返回简短说明并输出含完整路径的告警日志，不再把异常抛给调用方。
- 生成失败路径先清理、再结算；错误摘要保留原失败原因并追加「未提交文件未能清理」，任务仍持久化并发布 `failed` 终态。
- `settle` 增加可选说明参数，服务关闭路径也会带上未清理提示。
- 后台任务增加兜底 `catch`：任何未预期异常都会以 `SCENE_IMAGE_INTERNAL_ERROR`（或异常自身错误码）结算，任务不会停留在 `generating`。

### 10.2 测试与自验

- 新增边界测试：注入「写入 12 字节后 `ENOSPC`」与「删除返回 `EPERM`」。断言任务 `failed`、错误码保留 `SCENE_IMAGE_GENERATION_FAILED`、摘要同时包含 `ENOSPC` 与「未提交文件未能清理」、残留 12 字节文件保留以便追溯、流事件末条为 `failed`、同一幂等键重放返回原失败任务。
- `p11-scene-image-planning.test.ts` 由 15 项增至 16 项；`p10` 8 项保持通过。
- `npm run accept:offline`（Node 24.22.2）21／21 步通过，正式测试 286／286，交付回归 2／2，`sourceUnchanged=true`，`realServiceCalls=0`。
- 运行目录 `backend/test-results/p5-2026-11-09T09-52-40-773Z-a7905aab/`。

### 10.3 待办

- R06 待独立复验；R01～R05 已在已验范围关闭。
- 残留文件的后续清扫（例如启动时按素材表核对孤儿文件）尚未实现，当前只保证可追溯与不阻断结算。
- 真实生图服务、CG-03 自动触发与桌面对话演出仍待推进。
