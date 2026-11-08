"use strict";

// 角色外观适配器与动作选择的测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const rv = require("../role-visual.js");

const at = (h, mi = 0) => new Date(2026, 9, 3, h, mi);

test("内置来源：夏澄有基础立绘，没有动作图", async () => {
  const resolver = rv.createRoleVisualResolver();
  const { visual, issues } = await resolver.resolve({ roleId: "r1", displayName: "夏澄" });
  assert.equal(visual.seal, "澄");
  assert.equal(visual.sprites.day, "assets/xiacheng-day.webp");
  assert.equal(visual.sprites.evening, "assets/xiacheng-night.webp");
  assert.deepEqual(visual.actions, {});
  assert.deepEqual(issues, []);
});

test("没有外观的角色得到占位清单，印章取名字首字", async () => {
  const { visual } = await rv.createRoleVisualResolver().resolve({ roleId: "r2", displayName: "林夕" });
  assert.equal(visual.sprites, null);
  assert.equal(visual.seal, "林");
  assert.deepEqual(visual.actions, {});
});

test("自定义来源优先于内置来源，来源出错不影响兜底", async () => {
  const good = rv.createRoleVisualResolver([
    () => ({ seal: "夕", sprites: { day: "x/day.webp" }, actions: { tea: "x/tea.webp" } })
  ]);
  const { visual } = await good.resolve({ roleId: "r2", displayName: "夏澄" });
  assert.equal(visual.seal, "夕");
  assert.equal(visual.sprites.evening, "x/day.webp", "只给一种光照时两种共用");
  assert.deepEqual(visual.actions.tea, { day: "x/tea.webp", evening: "x/tea.webp" });

  const broken = rv.createRoleVisualResolver([() => { throw new Error("读取失败"); }]);
  const result = await broken.resolve({ roleId: "r1", displayName: "夏澄" });
  assert.equal(result.visual.seal, "澄", "出错的来源被跳过，回退到内置");
  assert.ok(result.issues.some(i => i.includes("读取失败")));
});

test("清单校验：未知动作与无效路径被丢弃并给出提示，不抛错", () => {
  const { manifest, issues } = rv.normalizeManifest({
    sprites: { day: "" },
    actions: { dancing: "a.webp", reading: { day: "r.webp", evening: "r2.webp" }, writing: { day: 3 } }
  });
  assert.equal(manifest.sprites, null);
  assert.deepEqual(Object.keys(manifest.actions), ["reading"]);
  assert.equal(issues.length, 3);
  assert.equal(rv.normalizeManifest(null).manifest.sprites, null);
});

test("动作图：缺图返回 null，有图按光照取，缺一种光照用另一种", () => {
  const visual = { actions: { reading: { day: "d.webp", evening: "e.webp" }, tea: { day: "t.webp", evening: "t.webp" } } };
  assert.equal(rv.resolveActionSprite(visual, "reading", "evening"), "e.webp");
  assert.equal(rv.resolveActionSprite(visual, "reading", "day"), "d.webp");
  assert.equal(rv.resolveActionSprite(visual, "window", "day"), null);
  assert.equal(rv.resolveActionSprite({ actions: {} }, "reading", "day"), null);
  assert.equal(rv.resolveActionSprite(null, "reading", "day"), null);
});

test("动作选择：后端真实活动优先，并标注来源", () => {
  const pick = rv.chooseAction({ backendActivity: "writing", env: { weather: "rain", weatherIntensity: 1 }, now: at(8) });
  assert.deepEqual(pick, { action: "writing", source: "backend" });
});

test("动作选择：无效的后端活动被忽略，退回本地日程", () => {
  const pick = rv.chooseAction({ backendActivity: "flying", env: { weather: "clear", weatherIntensity: 0 }, now: at(8) });
  assert.deepEqual(pick, { action: "tea", source: "schedule" });
});

test("动作选择：日程随时间变化", () => {
  const env = { weather: "clear", weatherIntensity: 0 };
  const expect = { 7: "tea", 10: "reading", 13: "resting", 15: "reading", 19: "writing", 22: "thinking", 2: "resting" };
  for (const [hour, action] of Object.entries(expect)) {
    assert.equal(rv.chooseAction({ env, now: at(Number(hour)) }).action, action, `${hour} 点`);
  }
});

test("动作选择：下雨时部分时段看窗，同一停留时段内结果固定", () => {
  const env = { weather: "rain", weatherIntensity: 0.8 };
  const base = at(15).getTime();
  const picks = [];
  for (let i = 0; i < 200; i++) {
    picks.push(rv.chooseAction({ env, now: new Date(base + i * 120000), dwellMs: 120000 }).action);
  }
  const windows = picks.filter(a => a === "window").length;
  assert.ok(windows > 40 && windows < 120, `看窗比例应在 40% 上下，实际 ${windows}/200`);

  const a = rv.chooseAction({ env, now: new Date(base + 1000), dwellMs: 120000 });
  const b = rv.chooseAction({ env, now: new Date(base + 100000), dwellMs: 120000 });
  assert.deepEqual(a, b, "同一个停留时段内不应变化");

  const dry = rv.chooseAction({ env: { weather: "rain", weatherIntensity: 0.1 }, now: at(15) });
  assert.equal(dry.action, "reading", "雨很小时不触发看窗");
});
