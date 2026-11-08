# 「樱」的书房：人景合一美术资产生成与改造指南

本指南用于指导第一阶段的**全量美术重制**（WSL 本地 `miaomiaoRealskin_anima11` 生成角色动作集 + GPT 生成同机位书房背景），确保新生成的角色与背景在**透视高度、左侧受光、桌面物理接触与色彩质感**上 100% 咬合，彻底消除“抠图贴纸感”。

---

## 一、人景合一的三大核心基准（生图前必看）

为了让 `miaomiao` 画的「樱」和 GPT 画的「书房背景」合在一起像同一张原画，两边生图时共同遵守以下 3 条基准线：

1. **统一机位与桌面基准线（Horizon & Desk Lock）**
   - **机位**：平视微俯（约 5° 俯角），取景范围为 **书桌前上半身（`upper body, sitting at wooden desk`）**。
   - **桌面高度**：画面自下而上 **`22% ~ 28%`** 处为实木书桌台面。
   - **物理互动关键**：让 `miaomiao` 画「樱」时，**直接把她的手肘、小臂和手头正在互动的物品（摊开的书、钢笔信纸、热茶杯）画在桌面上**，但人物背后保持**干净浅色纯底（`simple pastel background, clean solid background`）**。这样后续抠除纯色背景时，**保留她与桌面物品的真实接触面与接触阴影**，叠进 GPT 的书房桌面时就能严丝合缝。
2. **统一光源方向（Left-Window Lighting Lock）**
   - 房间的大窗户固定在**画面左侧（`0% ~ 45%`）**。
   - 因此「樱」的所有动作统一带上 **`sunlight from left, soft rim light`**（夜晚动作带上 **`warm amber lamplight from lower left, cool moonlight rim light from left`**），使人物发丝与脸颊的受光面和房间窗户位置完全一致。
3. **统一色调与画风（Pastel Anime Palette Lock）**
   - `miaomiao` 的画风是 **清透柔光、粉白高调、细腻发丝与柔和暗部**。
   - 因此给 GPT 的背景提示词已专门锁定为 **清透日系治愈二次元插画风（奶油白墙、暖蜜色橡木桌、柔和晨午光）**，避免 GPT 默认生成厚重油画或写实暗调背景。

---

## 二、角色「樱（Sakura）」生图指南（WSL ComfyUI · `miaomiao`）

### 1. ComfyUI 工作流与参数设置（提速抽卡 → 锁 Seed 精修）

把参考图 `E:\tmp\testWorkSpace\materailPhoto\refer\wsl-connector_00065_.png` 拖入 ComfyUI 即可加载完整节点。

| 阶段 | 节点连接方式 | 分辨率 | 步数 / CFG / 采样器 | 用途说明 |
| :--- | :--- | :--- | :--- | :--- |
| **第 1 步：快速抽卡** | 将 **`VAEDecode (节点 8)`** 的 `IMAGE` 直接连到 **`SaveImage (节点 9)`**（或选中 `13~20` 号放大节点按 `Ctrl+B` Bypass 跳过） | `832 × 1216` | `steps: 28`<br>`cfg: 5.5`<br>`euler_ancestral` / `normal` | **不跑 2x 放大，生图速度提升 2~3 倍**。用于快速刷出满意的动作、手部姿势与神态。 |
| **第 2 步：2x 高清精修** | 挑中满意的图后，将 **`KSampler (节点 3)`** 的 `seed` 锁定为该图 Seed (`control_after_generate: fixed`)，恢复 **`13~20` 号节点**连接至 `SaveImage (节点 9)` | `1664 × 2432` | 二次采样 `steps: 10`<br>`cfg: 5.5`<br>`denoise: 0.2`<br>`4x-UltraSharp` | 在不改变动作与五官的前提下，精修发丝、手指、衣褶与书页材质细节。 |

---

### 2. 通用负面提示词（Negative Prompt · 6 张动作通用）

> 在原负面词末尾增加了 `cluttered background, complex room background, furniture in background`，防止 `miaomiao` 在人物背后乱画复杂的柜子，确保人物背后是干净易分离的柔和纯色/渐变底。

```text
lowres, (bad), text, error, extra, missing, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, oldest, early, signature, artistic error, username, bad feet, scan, high saturation, abstract, english text, shiny hair, mutated hands, malformed hands, extra fingers, bad anatomy, cluttered background, complex room background, furniture in background
```

---

### 3. 「樱」的 6 个书桌日常动作正面提示词（Positive Prompts）

所有提示词均严格锁定「樱」的外观特征（柔粉长卷发、圆润粉瞳、白皙肌肤、白色荷叶边柔美连衣裙），**建议全部重新生成**，挑选透视高度接近的一组：

#### 动作 ①：`💬 倾听与浅笑（pose-chatting.png）`
- **触发场景**：当你展开「✒️ 书信交谈」与她聊天，或你正在输入框打字、她停下手中事倾听你时。
- **画面重点**：坐在木桌前，手肘轻搭桌面，手指轻点脸颊，微微歪头注视镜头温柔微笑，桌面上有一本摊开的笔记本。
```text
score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, fair_skin, high contrast, 1girl, solo, long pink hair, curly hair, wavy hair, hair down, big round eyes, pink eyes, blush, gentle smile, closed mouth smile, white soft dress, frills, sitting at wooden desk, upper body, head tilt, finger to cheek, one elbow resting on wooden desk, open notebook on desk, looking at viewer, eye contact, sunlight from left, soft rim light, simple pastel background, clean solid background, soft lighting, sparkle
```

#### 动作 ②：`📖 窗畔专注阅读（pose-reading.png）`
- **触发场景**：主舞台默认陪伴态 / 自主阅读书籍时的安静状态。
- **画面重点**：坐在木桌后身体微倾，双手自然地轻压在桌面摊开的精装书页两侧，长睫毛微垂专注看书，神情静谧温柔。
```text
score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, fair_skin, high contrast, 1girl, solo, long pink hair, curly hair, wavy hair, hair down, big round eyes, pink eyes, slight blush, peaceful expression, soft closed mouth smile, white soft dress, frills, sitting at wooden desk, upper body, leaning forward slightly, reading a book, open hardcover book on wooden desk, both hands resting on open book pages, looking down at book, lowered eyelashes, sunlight from left, soft rim light, simple pastel background, clean solid background, soft lighting
```

#### 动作 ③：`✒️ 伏案执笔书写（pose-writing.png）`
- **触发场景**：写角色日记 / 在工作空间记 Markdown 札记 / 正在思考并组织长回复时。
- **画面重点**：身体前倾伏在书桌前，右手握着精致钢笔在信纸/手账上书写，左手轻按纸张边缘，神情认真可爱。
```text
score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, fair_skin, high contrast, 1girl, solo, long pink hair, curly hair, wavy hair, hair down, big round eyes, pink eyes, blush, focused expression, cute slight pout, white soft dress, frills, sitting at wooden desk, leaning over desk, upper body, holding fountain pen, writing on letter paper, open notebook on wooden desk, one hand pressing paper, looking down at paper, sunlight from left, soft rim light, simple pastel background, clean solid background, soft lighting
```

#### 动作 ④：`☕ 捧杯听风（pose-tea.png）`
- **触发场景**：窗外下雨、下雪、落叶飘飞，或她在检索深层回忆、午后茶歇放空时。
- **画面重点**：手肘轻靠桌面，双手捧着温热的白瓷马克杯贴近下巴，杯口有淡淡热气，目光温柔地望向画面左侧（窗外方向）。
```text
score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, fair_skin, high contrast, 1girl, solo, long pink hair, curly hair, wavy hair, hair down, big round eyes, pink eyes, blush, serene expression, gentle smile, white soft dress, frills, sitting at wooden desk, upper body, holding a white ceramic teacup with both hands near chin, steaming teacup, subtle steam, elbows resting on wooden desk, looking to the side, looking left, sunlight from left, soft rim light, simple pastel background, clean solid background, soft lighting
```

#### 动作 ⑤：`✉️ 折信主动分享（pose-sharing.png）`
- **触发场景**：当她在自主活动中发现了有趣的内容、为你折了一封未读信笺想第一时间分享给你时。
- **画面重点**：眼里闪着欣喜的光芒看向镜头，双手在桌前轻轻举起一封带火漆印的信封，开心微笑。
```text
score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, fair_skin, high contrast, 1girl, solo, long pink hair, curly hair, wavy hair, hair down, big round eyes, pink eyes, blush, happy smile, parted lips, sparkling eyes, excited expression, white soft dress, frills, sitting at wooden desk, upper body, holding a wax-sealed envelope letter in hands above wooden desk, showing letter to viewer, looking at viewer, eye contact, sunlight from left, soft rim light, simple pastel background, clean solid background, soft lighting, sparkle
```

#### 动作 ⑥：`🌙 夜阑台灯相伴（pose-night.png）`
- **触发场景**：夜晚时段（或手动开启台灯夜读模式）的温馨陪伴态。
- **画面重点**：在白裙外披了一件柔软蓬松的浅粉针织开衫，双臂交叠枕在木桌上，微微歪头趴在手臂上看着你，神情带一点困倦的温柔；受左下角暖橘色台灯光与左侧清冷月光双色渲染。
```text
score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, fair_skin, high contrast, 1girl, solo, long pink hair, curly hair, wavy hair, hair down, big round eyes, pink eyes, blush, sleepy gentle smile, half-closed eyes, soft gaze, white soft dress, frills, oversized pale pink knitted cardigan, sitting at wooden desk, upper body, resting head on arms on wooden desk, leaning on desk, open book beside arm, looking at viewer, warm amber lamplight from lower left, cool moonlight rim light from left, night lighting, simple dark pastel background, clean background, soft warm glow
```

---

## 三、书房背景与前景器物生图指南（GPT ImageGen）

> **生成顺序建议**：可以先在 GPT 中用【背景提示词 1】生成最满意的一张**白昼书房底图**，然后直接在同一个 GPT 会话中基于这张图发【背景提示词 2（黄昏）】和【背景提示词 3（夜晚）】，让 GPT 保持房间结构、窗户与书桌位置 **100% 同机位不偏移**，只改天色与光影。

### 1. 背景图 ①：白昼晴光书房底图（`scene-day.png` · 横版 `16:9` / `1536×1024`）

```text
Create a wide 16:9 (1536x1024) high-detail pastel anime background illustration of a cozy, sunlit personal study room. NO CHARACTERS, NO PEOPLE.

[Art Style & Palette]
- Match a delicate, airy pastel anime illustration style: soft translucent lighting, fine clean linework, rich material textures (natural wood grain, linen curtains, ceramic, brass, paper), warm cream, soft rose-ivory, and honey-oak color palette. Avoid heavy oil-painting brushwork or dark muddy shadows.

[Strict Spatial Composition]
1. Left Side (0% to 45% width): A large vintage wooden-framed window opening to a peaceful courtyard with soft green foliage and a bright clear sky. Translucent cream-white sheer curtains gently billowing at the window edge. Warm morning/afternoon sunlight streams diagonally from the left window into the room.
2. Foreground Bottom (Bottom 25% height): A warm honey-oak wooden desk stretching across the lower portion of the frame (viewed at eye-level with a slight 5-degree downward tilt).
   - IMPORTANT: Leave the CENTER of the desk surface (around 30% to 60% horizontal width) CLEAN and EMPTY so a character sitting behind the desk can be composited naturally with her arms resting on the desk.
   - On the FAR LEFT corner of the desk near the window sill: place a vintage brass desk lamp with a glass shade (turned off in daytime) and a small white ceramic vase holding a seasonal flowering branch.
3. Right Side & Mid-Background (45% to 100% width): A warm ivory-cream interior wall with a wooden bookshelf, neatly stacked art books, leather journals, small potted plants, and a few pinned Polaroid photos and postcards. A cozy wooden chair back is slightly visible behind the center of the desk.
```

---

### 2. 背景图 ②：黄昏暮色书房底图（`scene-dusk.png` · 基于白昼底图同机位重绘）

在 GPT 生成好上面那张满意的白昼图后，**直接在原图下追问**：

```text
Keep the exact same camera angle, room layout, window frame, desk, lamp, vase, and bookshelf positions 100% identical without moving any object. 
Change the time of day to Golden Hour / Dusk (sunset):
- Outside the left window, the sky is a dreamy gradient of warm amber, peach-pink, and soft twilight violet.
- Long, warm golden-orange sunset light beams cast diagonal window-frame shadows across the wooden desk and the right bookshelf wall.
- Keep the room devoid of any people.
```

---

### 3. 背景图 ③：夜阑台灯书房底图（`scene-night.png` · 基于白昼底图同机位重绘）

继续在同一会话中，**基于第一张白昼图追问生成夜景（台灯点亮版）**：

```text
Keep the exact same camera angle, room layout, window frame, desk, lamp, vase, and bookshelf positions 100% identical.
Change the time of day to a quiet, cozy Night with the desk lamp turned ON:
- Outside the left window, show a deep indigo night sky with a soft glowing full moon and distant courtyard tree silhouettes bathed in cool silver-blue moonlight.
- On the left corner of the desk, the vintage brass desk lamp is TURNED ON, casting a warm, cozy amber-gold pool of light across the wooden desk surface, creating a beautiful warm-vs-cool contrast with the moonlight from the window.
- Keep the center of the desk surface clean and no people in the scene.
```

---

## 四、其他相关确认内容与下一阶段工程衔接清单

等你把满意的样图生成出来后（可直接放在 `E:\tmp\testWorkSpace\materailPhoto\` 或 `desktop\desk-preview\tools\source\` 下告诉我），我们下一步将一次性完成以下合成与界面改造工作：

1. **高精人物背景分离与「桌面融合三明治」合成**
   - 对你生成的 6 张「樱」动作图进行高精度发丝级背景去除，**保留她身前与木桌接触的手臂、书本/信纸/茶杯及桌面接触阴影**。
   - 在前端搭建三明治图层：
     - `底层`：GPT 同机位书房底图（白昼 / 黄昏 / 夜晚）+ 窗外四季动态景深层；
     - `中层`：「樱」的 6 态日常动作图层 + **桌面接触阴影融合层（Contact Shadow）** + **环境光边缘浸染层（Light-Wrap：白天吃晴光、黄昏吃夕阳金光、夜晚吃台灯暖橘光与月光）**；
     - `前层`：左下角茶杯升腾的袅袅水汽、穿过窗棂落在她肩头与桌面上的丁达尔阳光光束、雨雪天气粒子。
2. **动作与项目功能全链路联动**
   - 主舞台闲置 / 自主阅读 → 自动展示 **`📖 窗畔专注阅读`**；
   - 打开「✒️ 书信交谈」或你正在打字输入（`DL-80~82`）→ 自动平滑切换为 **`💬 倾听与浅笑`**；
   - 翻开「📖 手账 · 心境」或她正在写日记 / 记工作空间笔记 → 切换为 **`✒️ 伏案执笔书写`**；
   - 雨雪天气 / 翻阅「🎞️ 胶片 · 记忆」→ 切换为 **`☕ 捧杯听风`**；
   - 有未读主动分享折信浮现时 → 切换为 **`✉️ 折信主动分享`**；
   - 夜间模式 / 点亮台灯时 → 切换为 **`🌙 夜阑台灯相伴`**。
3. **落实已确认的「书信交谈 · 方案 A」改造（对齐 `DL-04`）**
   - 移除「✒️ 书信交谈」右上角原本容易混淆的三个子窗口标签（`窗畔主信笺 / 读书共鸣批注 / 夜阑闲谈`），让「✒️ 书信交谈」成为**唯一、纯粹的主对话窗口**。
   - 将其他独立渠道窗口（如 QQ 私聊、QQ 群聊等外部入口会话）收归到 **`🧭 她的一天（活动与消息日志）`** 中作为外部渠道日志查看。
   - 将全界面的角色名、自称、日记口吻、记忆示例全面更新为 **「樱」**。
