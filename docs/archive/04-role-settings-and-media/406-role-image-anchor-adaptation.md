# 406 角色生图锚点适配：夏澄实测与方案

> **现行契约入口**：生图服务目录、按 `class_type` 打补丁的工作流与草稿出图接口见 [TTS 与生图服务接入规范](../../specs/tts-and-image-services.md)；过场图拼接顺序、图层隔离与锚点快照见 [对话演出、输入状态、SSE 与过场图规范](../../specs/conversation-performance-and-scene-images.md)。本文只记录**固定角色的一次生图适配实测与锚点写法方案**，不新增代码与功能。

- 测试日期：2026-11-23，本机 WSL ComfyUI `0.45.0` + `MOSS-Image SFT INT8`（RTX 4080 Laptop，12 GB 显存）。
- 测试角色：系统预置助手「夏澄」（`builtinKey = xiacheng`，两套预置服饰「日常常服」「时序织梦」）。
- 全部出图走**现有系统流程**：后端正式接口 `probe → 角色生图配置 → 测试出图（`preview`）`，只额外用了一份自定义图生图工作流 JSON（配置资产，非新功能）。
- 证据目录：[test-results/image-anchor](../../../test-results/image-anchor)（`manifest.json` 用例索引、`metrics.json` 色彩抽样、`payloads/` 请求体）。

---

## 1. 结论速览

1. **身份不偏移**：脸型、琥珀金瞳、珊瑚橘长卷发、金色 N 字发夹、体型比例在 text2img 下跨场景、跨 seed 都稳定（02／04／05／12／17／20／21）。
2. **漂移集中在「服饰结构」与「发型收纳方式」**（03／04／06／07）。原因不是模型坏了，而是：
   - MOSS-Image 的 SFT 权重**本身不支持参考图条件**，官方模板注释写明 `ref_image` 只用于提示词增强、模型不接受它；服饰只能靠文字锚点描述，或靠 img2img 的起手潜空间。
   - 系统在 `img2img` 口径下**不拼服饰锚点**（服饰由该服饰的参考图承担），所以提示词里再写衣服也不生效。
3. **两档模式各管一段**（实测）：
   - `text2img`：场景自由，身份稳，服饰结构需要锚点打磨 → **过场图主线**；
   - `img2img` `denoise 0.45～0.55`：身份 + 服装几乎逐像素复刻，但**背景也一起被锁住**（08／09-040／15）；
   - `img2img` `denoise ≥0.70`：服装被整件替换（070 变黑高领 + 白牛仔外套，085 再变牛仔外套 + 围巾 + 短靴）。
4. **写法上两条硬规则**（都有对照实验）：
   - 正向提示词里**不要写「不 X」**：实测把「无耳饰、无项链」写进基础锚点后，**项链反而被画了出来**（16）；「T 恤不露脐」也没有生效（17）。
   - 否定项**放进负向提示词**才有效：`耳环、项链、露腰露脐、马尾辫` 进负向后，项链消失、衣长回到腰带、发型不再扎起（18／20／21）。
5. **单张耗时**：`1024×1536`、25 步、CFG 2.5、`er_sde` + `simple`、SLG 22，实测 **17.6～33.7 秒/张**（冷启动首张偏慢）。

---

## 2. 测试走法与系统一致

不启动桌面端，但每一步都是系统正式接口：

| 步骤 | 接口 | 本次结果 |
| --- | --- | --- |
| 建立生图服务 | `POST /v1/image-services` | `protocol: comfyui`、`baseUrl: http://127.0.0.1:8188`、`modelName`／`timeoutMs: 300000` |
| 探测节点齐全度 | `POST /v1/image-services/:id/probe` | `reachable=true`、`comfyuiVersion=0.45.0`、`workflowReady=true`、`missingNodes=[]`、`elapsedMs≈9.6s` |
| 保存角色生图配置 | `PUT /v1/roles/:roleId/scene-image` | 角色须处于 `stopped`；`text2img` 时 `workflow` 必须为 `null` |
| 上传服饰参考图 | `PUT /v1/roles/:roleId/scene-image/outfits/:outfitId/reference` | `multipart/form-data`，两套预置立绘各上传一张（≤8 MiB） |
| 测试出图 | `POST /v1/roles/:roleId/scene-image/preview` | 返回 `dataBase64`，样图不入过场图历史 |

```powershell
# 探测 + 出图（本机实测命令，roleId 与 outfitId 为夏澄的真实值）
curl.exe -s -X POST "http://127.0.0.1:3210/v1/image-services/33304f3f-ff10-4b70-8dc5-4aea9f47a997/probe"
curl.exe -s -X POST "http://127.0.0.1:3210/v1/roles/1d8b74a6-3a13-48c3-97c8-33c36f8b00ea/scene-image/preview" `
  -H "Content-Type: application/json; charset=utf-8" `
  --data-binary "@test-results/image-anchor/payloads/20-final-desk-default.json"
```

- 提示词拼接口径与后端一致：`basePrompt + outfitPrompts[outfitId] + 场景描述`（`img2img` 跳过服饰锚点）。
- `text2img` 用内置 11 节点 MOSS-Image 工作流（`UNETLoader → CLIPLoader → VAELoader → SpectrumMOSSImageManual → SkipLayerGuidanceDiTSimple → 双 CLIPTextEncode → EmptyFlux2LatentImage → KSampler → VAEDecode → SaveImage`）。
- `img2img` 用 [moss-img2img-reference.json](../../../tools/art-pipeline/workflows/moss-img2img-reference.json)：`LoadImage → ImageScale → VAEEncode` 作起手潜空间，`outputNodeId = "13"`，另带一条不读取参考图的纯背景分支（`14–17`，满足 `background` 图层隔离约束）。
- **踩到的坑（重要）**：`workflow` 字段在 `text2img`／`img2img` 之间共用。切回 `text2img` 时若仍保留 img2img 工作流，两条 `SaveImage` 分支会一起跑，两个请求各卡满 180 秒被判 `IMAGE_GENERATION_FAILED`（生图已取消）。切换模式必须同时把 `workflow` 清成 `null` 或按需重新导入。

---

## 3. 实测用例与结论

| # | 文件 | 模式 | denoise | 锚点版本 | 场景 | 耗时 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | [01-anchor-default.png](../../../test-results/image-anchor/01-anchor-default.png) | text2img | — | base-v1 + 常服 v1 | 站姿锚点（浅灰背景） | 33.7s | 身份稳，服装近似 |
| 02 | [02-scene-yard-default.png](../../../test-results/image-anchor/02-scene-yard-default.png) | text2img | — | base-v1 | 深夜木质回廊 / 雪后庭院 | 23.0s | 身份稳 |
| 03 | [03-scene-street-default.png](../../../test-results/image-anchor/03-scene-street-default.png) | text2img | — | base-v1 | 雨后街道 +「抬手理鬓发」 | 19.8s | **漂移**：长卷发→侧马尾；N 发夹→金色箭头 |
| 04 | [04-scene-desk-default.png](../../../test-results/image-anchor/04-scene-desk-default.png) | text2img | — | base-v1 | 书桌前记笔记 | 19.9s | **漂移**：内搭变露腰运动背心 + 颈带 |
| 05 | [05-scene-lamp-default-seed.png](../../../test-results/image-anchor/05-scene-lamp-default-seed.png) | text2img | — | base-v1 | 同 02，seed `777001` | 19.8s | 换 seed 身份仍稳 |
| 06 | [06-anchor-weaver.png](../../../test-results/image-anchor/06-anchor-weaver.png) | text2img | — | base-v1 + 礼服 v1 | 站姿锚点 | 18.5s | **漂移**：挂脖胸衣→高领衬衫+束腰裙 |
| 07 | [07-scene-hall-weaver.png](../../../test-results/image-anchor/07-scene-hall-weaver.png) | text2img | — | base-v1 + 礼服 v1 | 宴会厅端杯 | 19.0s | **漂移**：裙型→前短后长大摆礼服 |
| 08 | [08-i2i-yard-default.png](../../../test-results/image-anchor/08-i2i-yard-default.png) | img2img | 0.55 | base-v1 | 深夜木质回廊 | 30.8s | 身份/服装近乎复刻；**背景未换** |
| 09 | [09-denoise-040.png](../../../test-results/image-anchor/09-denoise-040.png) | img2img | 0.40 | base-v1 | 深夜木质回廊 | 28.7s | 最接近原立绘（仅多金色耳环） |
| 09 | [09-denoise-070.png](../../../test-results/image-anchor/09-denoise-070.png) | img2img | 0.70 | base-v1 | 深夜木质回廊 | 17.6s | **换装**：黑高领 + 白牛仔外套 |
| 09 | [09-denoise-085.png](../../../test-results/image-anchor/09-denoise-085.png) | img2img | 0.85 | base-v1 | 深夜木质回廊 | 17.5s | **换装+换背景**：牛仔外套 + 围巾 + 短靴 |
| 12 | [12-t2i-desk-default-v2.png](../../../test-results/image-anchor/12-t2i-desk-default-v2.png) | text2img | — | base-v2 + 常服 v2 | 书桌前记笔记 | 31.0s | N 字写清后夹子仍是箭头；内搭仍露腰 |
| 13 | [13-t2i-hall-weaver-v2.png](../../../test-results/image-anchor/13-t2i-hall-weaver-v2.png) | text2img | — | base-v2 + 礼服 v2 | 宴会厅端杯 | 19.8s | 礼服结构基本复原 |
| 14 | [14-anchor-default-v2.png](../../../test-results/image-anchor/14-anchor-default-v2.png) | text2img | — | base-v2 + 常服 v2 | 站姿锚点 | 30.6s | 接近原立绘 |
| 15 | [15-i2i-hall-weaver.png](../../../test-results/image-anchor/15-i2i-hall-weaver.png) | img2img | 0.55 | base-v1 | 宴会厅端杯 | 21.3s | 身份/礼服近乎复刻；背景未换 |
| 16 | [16-t2i-desk-default-v3.png](../../../test-results/image-anchor/16-t2i-desk-default-v3.png) | text2img | — | base-v3（正向写「无耳饰无项链」） | 书桌前记笔记 | 33.4s | **反噬**：项链被画出来 |
| 17 | [17-t2i-yard-default-v3.png](../../../test-results/image-anchor/17-t2i-yard-default-v3.png) | text2img | — | base-v3 + 常服 v3 | 深夜木质回廊 | 33.4s | 「不露脐」未生效，仍露腰 |
| 18 | [18-t2i-desk-default-v4.png](../../../test-results/image-anchor/18-t2i-desk-default-v4.png) | text2img | — | base-v3 + 常服 v4 + 负向 v4 | 书桌前记笔记 | 24.5s | 项链消失、衣长到腰带、N 字清晰 |
| 20 | [20-final-desk-default.png](../../../test-results/image-anchor/20-final-desk-default.png) | text2img | — | **定稿** | 书桌前记笔记 | 19.2s | 身份 + 服装命中 |
| 21 | [21-final-street-default.png](../../../test-results/image-anchor/21-final-street-default.png) | text2img | — | **定稿** | 雨后街道 +「抬手理鬓发」 | 19.1s | 马尾漂移已消除 |
| 22 | [22-final-hall-weaver.png](../../../test-results/image-anchor/22-final-hall-weaver.png) | text2img | — | **定稿** | 宴会厅端杯 | 22.1s | 礼服结构命中 |

**定稿对照图**（首行为参考立绘，其后为定稿方案出图）：

- 常服参考：[default/home.png](../../../apps/backend/assets/presets/xiacheng/outfits/default/home.png) → [20](../../../test-results/image-anchor/20-final-desk-default.png) · [21](../../../test-results/image-anchor/21-final-street-default.png)
- 礼服参考：[02_weaver/home.png](../../../apps/backend/assets/presets/xiacheng/outfits/02_weaver/home.png) → [22](../../../test-results/image-anchor/22-final-hall-weaver.png)

### 色彩抽样（辅助证据，不作判据）

发色像素（珊瑚橘色带）均值与参考立绘的距离（`0` 为完全一致，`metrics.json`）：

| 模式 | 用例 | 发色均值距离 |
| --- | --- | --- |
| img2img 0.55 | 08 / 15 | **0.0130 / 0.0162** |
| img2img 0.70 / 0.85 | 09-070 / 09-085 | 0.0242 / 0.0904 |
| text2img | 02 / 13 / 16 | 0.0475 / 0.0426 / 0.1000 |

发色只是身份的一个维度；脸型、瞳色高光、发夹形状、服饰结构目前靠**目视逐张比对**，本地没有可用的身份 embedding 模型，因此本文不宣称"像素级身份判定"。主色板距离受背景影响大（白底立绘 vs 场景背景），不列为判据。

---

## 4. 漂移诊断：为什么偏、怎么收回

| 现象 | 根因 | 收口手段（已验证） |
| --- | --- | --- |
| 「抬手把鬓边发丝别到耳后」→ 头发被扎成侧马尾 | 场景描述里的动作被模型当成造型指令 | 基础锚点补「长发自然披散不扎起」+ 负向补「马尾辫」（03 → 21） |
| 「金色 N 字发夹」→ 画成金色箭头/三角 | 中文「N 字」不够图形化 | 改写为「金色**大写字母 N 形状**的金属发夹」（13／14／18／20／21／22 均出可读的 N） |
| 礼服原图是露肩挂脖胸衣，v1 锚点却出高领衬衫 | 「白色大翻领荷叶边」被单独当成衬衫领 | 先写版型再写领子：「露肩挂脖式藏青色紧身胸衣…**肩颈处**白色大翻领荷叶边披肩」（06 → 13／22） |
| 常态多出项链、耳环、颈带、露腰 | 这些是模型的"默认美化"，且正向否定会反噬 | 全部进负向：`耳环, 项链, 露腰露脐, 高领毛衣, 马尾辫`（18／20 已消失，21 已消除马尾） |
| img2img 时衣服"换了" | 系统 img2img 不拼服饰锚点，服装只由参考图与 denoise 决定 | denoise 压到 `0.45～0.55`（0.70 起必换装） |
| img2img 时背景"没换" | 起手潜空间来自立绘，低 denoise 保留构图 | 要新场景就回 text2img；img2img 只用于锁服饰的画面 |
| 切 pattern 后请求卡满 180 秒 | `text2img` 沿用 img2img 工作流 → 两条 `SaveImage` 分支一起跑 | 切 `text2img` 时 `workflow: null`；切 `img2img` 时重新导入工作流并设 `outputNodeId` |

补充观察：固定 seed 让逐轮对比可复现；换 seed 只改构图不改身份（02 vs 05）。

---

## 5. 夏澄适配方案（可直接照抄）

### 5.1 基础锚点（`basePrompt`，183 字，全角逗号）

```text
日系二次元厚涂插画风格，约二十岁的年轻女性，鹅蛋脸下巴尖圆下颌线柔和，琥珀橙金色大眼睛，虹膜由中心橙金向外渐变并带高光反射，细而微挑的橙色眉毛，鼻梁小巧挺直，唇色浅珊瑚粉，珊瑚橘色微卷长发及胸且发丝蓬松有层次，发梢泛浅金色，偏分刘海，头顶左侧一撮卷翘呆毛，左侧太阳穴别一枚金色大写字母N形状的金属发夹，肤色白皙透粉且脸颊微红，身形纤细高挑肩窄腿长，长发自然披散不扎起
```

写这一段时按 **10 段固定顺序**：画风 → 年龄性别 → 脸型下颌 → 眼睛（虹膜渐变 + 高光）→ 眉 → 鼻唇 → 头发（长度/卷度/层次/发梢颜色/刘海/呆毛/左右位置）→ 标志性配饰（用图形化描述）→ 肤色 → 体型。**不写**服装、背景、构图、动作、光线。

### 5.2 服饰锚点（`outfitPrompts[outfitId]`）

「日常常服」（159 字）：

```text
米白色短款立领落肩夹克外套，正面拉链半开，袖身外侧一道橙色细条纹，宽大灯笼袖且袖口收紧无翻边，内搭深蓝色圆领短袖紧身T恤，衣长及腰并被橙色宽腰带束住，领口仅一圈橙色细滚边，靛蓝色不对称斜裁半身短裙，裙摆带橙色细滚边与米白色内衬，裙长至膝上，腰间橙色宽腰带配方形金属扣，白色中筒袜袜口一道橙色条纹，白橙拼色厚底老爹运动鞋
```

「时序织梦」（126 字）：

```text
露肩挂脖式藏青色紧身胸衣，胸前金色细交叉绑带，肩颈处白色大翻领荷叶边披肩，领口正中系金色大写字母N形状的领结，透明薄纱灯笼长袖带金色细纹与金色袖口，藏青色不对称百褶短裙配米白色荷叶内衬，裙边镶金色滚边，金色腰封带金色N字形装饰，黑色半透明过膝长袜，赤脚
```

写这一段时按 **6 段自上而下顺序**：外套（版型/开合/袖型/条纹位置）→ 内搭（领型/衣长/滚边）→ 裙（裁法/裙长/内衬/滚边）→ 腰（腰封/腰带/扣）→ 袜（长度/条纹数）→ 鞋（配色/鞋型/鞋底）。**不写**脸、发、身材、背景、动作。裸足、无鞋这类"没有的东西"直接写「赤脚」这类肯定式短句。

### 5.3 负向提示词（`negativePrompt`）

```text
nsfw, worst quality, bad anatomy, watermark, jpeg artifact, 多个人物, 手部畸形, 面部模糊, 画风中变, 现代写实摄影, 发色变深, 平淡无光的眼睛, 耳环, 项链, 露腰露脐, 高领毛衣, 马尾辫
```

前半段是 MOSS-Image 官方推荐质量负向（保留英文原样），后半段是**该角色实测出来的"默认美化"清单**：多出来的饰品、被换掉的衣长、被改掉的发型。

### 5.4 生成参数

| 参数 | 值 | 依据 |
| --- | --- | --- |
| 尺寸 | `1024×1536`（1.57 M px） | 官方推荐 1M／1.5M／2M 区间，立绘竖构图 |
| 步数 / CFG | `25` / `2.5` | 内置模板（kijai 快速档）；想更贴官方可 50 步 / CFG 3 |
| 采样器 / 调度器 | `er_sde` / `simple` | 内置模板 |
| SLG | `single_layers 22` | 官方负分支跳层，不要动 |
| seed | 固定（如 `20261122`） | 便于逐轮对比；日常出图可设 `null` 随机 |
| 模型 | `moss_image_sft_int8_convrot.safetensors` | 本机现成权重 |
| 超时 | `300000` ms | `1024×1536` 冷启动实测最慢 33.7 s，留足余量 |

### 5.5 模式选择矩阵

| 需求 | mode | denoise | 备注 |
| --- | --- | --- | --- |
| 对话过场图（换场景/换姿势/换机位） | `text2img` | — | 身份稳，服饰结构靠锚点；场景最自由 |
| 表情差分、半身特写、同款近景 | `img2img` | `0.45～0.55` | 几乎复刻立绘；背景/构图基本不变 |
| 想「新背景 + 原服装」 | — | — | **当前组合做不到**：0.7 起服装被替换，实测两档都换装 |

### 5.6 锚点图与参考图落地

- `role_scene_references` 每套服饰传**该服饰的立绘**（`outfits/<slug>/home.png`），不要传场景图或差分图：img2img 的起手潜空间就是它，构图干净才容易出全身。
- 「锚点图」在本角色这里不是新造一张，而是**先按 5.1／5.2 的锚点出一张站姿全身图做验收**（[14](../../../test-results/image-anchor/14-anchor-default-v2.png)）：能命中就直接沿用预置立绘做参考图；命中不了说明锚点还没写对，不要把错的锚点图拿去当参考图。
- 若日后换自定义角色没有现成立绘：先用 text2img + 锚点出正侧站姿图，逐张比对后**把满意的那张**写入 `role_scene_references`，再切 img2img。参考图建议浅灰/纯色底、全身、脚部完整入画。

### 5.7 页面上怎么填

1. 设置 → 模型 → 生图：选本机 ComfyUI 服务（`http://127.0.0.1:8188`），确认探测通过、模型下拉选中 `moss_image_sft_int8_convrot.safetensors`。
2. 角色配置 → 模型 → 生图：`modelType` 选 `text2img`，`workflow` 保持 `null`；填 5.1／5.2／5.3 三段文本与 5.4 参数。
3. 「生成参数」折叠区填尺寸/步数/CFG/采样器/调度器/seed。
4. 需要锁服饰时：切换 `img2img`，导入 [moss-img2img-reference.json](../../../tools/art-pipeline/workflows/moss-img2img-reference.json)（`outputNodeId: 13`），在「服饰参考图」里给每套服饰上传立绘；用完切回 `text2img` 时**记得把工作流清掉**。

---

## 6. 换角色可复用的锚点写法规则

| 维度 | 必须写 | 禁止写 | 实测坑 |
| --- | --- | --- | --- |
| 基础锚点内容 | 画风、年龄性别、脸型、眼（虹膜+高光）、眉、鼻唇、发（长度/卷度/发梢/刘海/呆毛/左右）、标志配饰、肤色、体型 | 服装、鞋袜、背景、构图、动作、光线 | 少于约 120 字容易退化成"通用美少女脸" |
| 标志配饰 | 图形化描述（「大写字母 N 形状」） | 缩写（「N 字」） | 中文缩写会被当成箭头/三角 |
| 发型锁定 | 「长发自然披散不扎起」 | — | 场景里一句"别到耳后"就能改发型，必须在基础锚点先锁死 |
| 服饰锚点内容 | 自上而下 6 段，含版型/开合/袖型/条纹位置/裙长/内衬/腰封/袜/鞋 | 脸、发、身材、背景、动作 | 「大翻领」单独出现会被当成衬衫领，要先写「露肩挂脖式」版型 |
| 否定表达 | 放负向提示词 | 正向里的「不 X」「无 Y」 | 实测正向否定**反噬**：写"无项链"就画了项链 |
| 长度 | 基础锚点 140～190 字；服饰锚点 90～160 字 | 超过 300 字的堆砌 | 过长会稀释关键词权重，反而更容易漂 |
| 标点 | 中文全角逗号分隔短语 | 分号、句号、换行 | 系统按 `，` 拼接三段 |
| 场景描述 | 只写环境、姿势、机位、光线、道具 | 重复外貌/服饰（会和锚点抢权重） | 场景里写"换件外套"会真的换装 |

---

## 7. 验证范围与未决

- **范围**：本记录是**实施方自验**（本机 WSL ComfyUI + MOSS-Image、隔离数据目录、正式 HTTP 接口），尚未独立复核；不构成"角色一致性已达标"的通用结论，只针对夏澄两套预置服饰。
- **锚点来源**：系统正式路径是 `POST /v1/roles/:roleId/scene-image/anchor-prompts`（用角色绑定的对话模型视觉能力读图提炼）。本轮没有绑定视觉对话模型，锚点由实施方逐图观察撰写 —— 第 6 节的写法规则就是"人肉版"的提炼口径，接入视觉模型后可直接当提示词模板。
- **未覆盖**：真实对话触发的自动过场图链路（`ModelSceneImagePlanner` 生成的场景文本）、长等待取消与并发、8 MiB 测试样图上限边界、显存压力与多角色并发、Windows 打包态。
- **已知遗留**：`workflow` 字段 text2img/img2img 共用导致的双分支超时（第 2 节），目前只能靠配置纪律规避，是否需要产品侧收口另议。
- **数据**：实机数据目录为隔离副本（`test-results/image-anchor/app-root`），未触碰开发库 `apps/backend/.nowadays-desktop`。
