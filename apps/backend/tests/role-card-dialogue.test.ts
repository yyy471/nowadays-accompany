import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { roleCardForDialogue, roleCardPayloadForDialogue } from "../src/application/role-card-dialogue.js";

const card = [
  "# 林同学", "说话简短，重承诺。",
  "### 6. 开场白 (First Message)", "独自等车。",
  "### 7. 全周期对话示例 (Example Dialogues)", "#### 初识",
  "{{user}}：我的粉色围巾借你。", "{{char}}：那我放东门的柜子里。",
  "```md", "## 这不是设定标题", "```", "隐藏的例子结尾",
  "### 后续约束", "尊重他人决定。", "## 衣着", "冬天戴手套。",
].join("\n");

test("ordinary dialogue omits scripted scenes but preserves sibling or higher sections", () => {
  const normal = roleCardForDialogue(card, ["晚饭吃什么？"]);
  assert.doesNotMatch(normal, /等车|粉色围巾|柜子|隐藏的例子/);
  assert.match(normal, /重承诺/);
  assert.match(normal, /尊重他人决定/);
  assert.match(normal, /冬天戴手套/);
  assert.match(roleCardForDialogue(card, ["请按卡里的开场白开始"]), /等车/);
  assert.doesNotMatch(roleCardForDialogue(card, ["请按卡里的开场白开始"]), /粉色围巾/);
  assert.match(roleCardForDialogue(card, ["给我看看对话示例"]), /粉色围巾/);
  assert.equal(roleCardForDialogue(card, ["展示人物卡原文"]), card);
});

test("the everyday card keeps relationship conditions without replaying future sample dialogue", () => {
  const everyday = readFileSync(new URL("../examples/lin-zhixia.md", import.meta.url), "utf8");
  const projected = roleCardForDialogue(everyday, ["我的公交到站了。"]);
  assert.match(projected, /她很慢热/);
  assert.match(projected, /双方确实谈过并愿意在一起/);
  assert.doesNotMatch(projected, /第三页我看懂了|给我留半张沙发/);
  assert.equal(roleCardForDialogue(everyday, ["给我看看卡里不同阶段的说话样例"]), everyday);
});

test("a negative request leaves examples out while later explicit requests select the intended section", () => {
  assert.doesNotMatch(roleCardForDialogue(card, ["不要按说话样例回答，像平时一样和我说。"]), /粉色围巾/);
  assert.doesNotMatch(roleCardForDialogue(card, ["别展示人物卡原文，我想和你说话。"]), /粉色围巾|独自等车/);
  assert.doesNotMatch(roleCardForDialogue(card, ["不用开场白，也不想看对话样例。"]), /粉色围巾|独自等车/);
  assert.doesNotMatch(roleCardForDialogue(card, ["给我看看对话示例。", "别再展示对话示例。"]), /粉色围巾/);
  const opening = roleCardForDialogue(card, ["不要按说话样例回答，不过请按开场白开始。"]);
  assert.match(opening, /独自等车/);
  assert.doesNotMatch(opening, /粉色围巾/);
  const examples = roleCardForDialogue(card, ["别展示人物卡原文，只要对话示例。"]);
  assert.match(examples, /粉色围巾/);
  assert.doesNotMatch(examples, /独自等车/);
});

test("structured cards share explicit read modes without changing stored or unrelated fields", () => {
  const fields = { first_mes: "在码头碰头", mes_example: "把围巾留在车站", description: "冷静", extensions: { first_mes: "扩展自有字段" } };
  const payload = { ...fields, data: { ...fields }, vendor: { mes_example: "透传" } };
  const original = structuredClone(payload);
  const normal = roleCardPayloadForDialogue(payload, ["今天好吗"]);
  assert.deepEqual(normal, {
    description: "冷静", extensions: fields.extensions, data: { description: "冷静", extensions: fields.extensions }, vendor: payload.vendor,
  });
  for (const [question, present, absent] of [["给我看看对话示例", "mes_example", "first_mes"], ["请按开场白开始", "first_mes", "mes_example"]]) {
    const view = roleCardPayloadForDialogue(payload, [question!]);
    assert.ok(present! in view && present! in (view.data as object));
    assert.ok(!(absent! in view) && !(absent! in (view.data as object)));
  }
  assert.deepEqual(roleCardPayloadForDialogue(payload, ["请展示人物卡原文"]), original);
  assert.deepEqual(payload, original);
});

test("a colon example block ends before ambiguous prose", () => {
  const normal = roleCardForDialogue("性格从容。\n对话示例：\n用户：这是红围巾。\n角色：请收好。\n她也喜欢海边。", []);
  assert.doesNotMatch(normal, /红围巾|请收好/);
  assert.match(normal, /她也喜欢海边/);
  const ambiguous = "对话示例：\n自由段落和角色说明混排。";
  assert.equal(roleCardForDialogue(ambiguous, []), ambiguous);
});

test("engine-only JSON templates stay out of dialogue while ordinary prose, public JSON and original card remain available", () => {
  const engine = ["## 隐藏机制", "坦率度影响她愿意说多少。", "## 输出格式规范",
    "每次回复结尾必须严格附带以下 JSON 状态栏（用于引擎正则解析与 UI 渲染），不可省略：",
    "", "```json", "{\"inner_thought\":\"只在心里想\"}", "```", "她愿意直接说出自己的选择。"].join("\n");
  const dialogue = roleCardForDialogue(engine, ["今天吃什么？"]);
  assert.match(dialogue, /坦率度/u);
  assert.match(dialogue, /愿意直接说出/u);
  assert.doesNotMatch(dialogue, /inner_thought|引擎正则解析/u);
  assert.equal(roleCardForDialogue(engine, ["请展示角色卡原文"]), engine);
  const structured = {description:engine, data:{description:engine}, extensions:{description:engine}};
  assert.deepEqual(roleCardPayloadForDialogue(structured, ["今天吃什么？"]), {
    description:dialogue, data:{description:dialogue}, extensions:{description:engine},
  });
  assert.deepEqual(roleCardPayloadForDialogue(structured, ["请展示角色卡原文"]), structured);
  const publicCard = "每次回复附上一句公开状态。用户要求 JSON 时按其格式回答。";
  assert.equal(roleCardForDialogue(publicCard, []), publicCard);
  const negative = engine.replace("必须严格附带", "不要附带");
  assert.equal(roleCardForDialogue(negative, []), negative);
});

test("plain prose and fenced headings stay intact; a card built from samples retains its voice", () => {
  const plain = "文中提到对话示例。\n~~~markdown\n## Example Dialogues\n~~~\n正文";
  assert.equal(roleCardForDialogue(plain, []), plain);
  const sampleOnly = "我的角色\n=======\nExample Dialogues\n----------------\n{{user}}：借一条围巾？\n{{char}}：有借有还。";
  const normal = roleCardForDialogue(sampleOnly, []);
  assert.match(normal, /有借有还/);
  assert.doesNotMatch(normal, /围巾/);
  assert.match(roleCardForDialogue("## 对话示例\n她说话像在念诗。", []), /说话像在念诗/);
});
