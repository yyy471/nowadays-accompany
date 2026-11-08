"use strict";

// 环境解析与天气来源的纯函数测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveEnvironment, seasonAt, daylightAt } = require("../environment.js");
const weather = require("../weather-provider.js");

const local = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi);

test("季节：非边界日期没有混合", () => {
  assert.deepEqual(pick(seasonAt(local(2026, 1, 15))), { season: "winter", from: "winter", to: "winter", blend: 0 });
  assert.equal(seasonAt(local(2026, 4, 20)).season, "spring");
  assert.equal(seasonAt(local(2026, 7, 20)).season, "summer");
  assert.equal(seasonAt(local(2026, 10, 15)).season, "autumn");
  assert.equal(seasonAt(local(2026, 12, 25)).season, "winter");
});

test("季节：换季前后各 5 天交叉过渡，且在边界处连续", () => {
  const before = seasonAt(local(2026, 2, 27));
  assert.equal(before.from, "winter");
  assert.equal(before.to, "spring");
  assert.ok(before.blend > 0 && before.blend < 0.5);
  assert.equal(before.season, "winter");

  const after = seasonAt(local(2026, 3, 2));
  assert.equal(after.from, "winter");
  assert.equal(after.to, "spring");
  assert.ok(after.blend > 0.5 && after.blend < 1);
  assert.equal(after.season, "spring");

  assert.equal(seasonAt(local(2026, 3, 7)).blend, 0);

  // 以 1 小时为步长跨过 3/1，混合量只增不减，且没有大跳变。
  let last = -1;
  for (let t = local(2026, 2, 24, 0).getTime(); t <= local(2026, 3, 8, 0).getTime(); t += 3600000) {
    const { blend, to } = seasonAt(new Date(t));
    if (to === "spring" && blend > 0) {
      assert.ok(blend >= last - 1e-9, "blend 应单调不减");
      if (last >= 0) assert.ok(blend - last < 0.02, "相邻小时的混合量不应跳变");
      last = blend;
    }
  }
  assert.ok(last > 0.99);
});

test("日出日落随日期连续变化，夏至最长、冬至最短", () => {
  const summer = daylightAt(172);
  const winter = daylightAt(355);
  assert.ok(Math.abs(summer.sunrise - 5.3) < 0.05 && Math.abs(summer.sunset - 19.5) < 0.05);
  assert.ok(Math.abs(winter.sunrise - 7.0) < 0.05 && Math.abs(winter.sunset - 17.0) < 0.05);
  for (let d = 1; d < 365; d++) {
    assert.ok(Math.abs(daylightAt(d + 1).sunrise - daylightAt(d).sunrise) < 0.03, "相邻两天日出变化应很小");
  }
});

test("时段：夏季正午为白昼、凌晨为夜、傍晚进入黄昏", () => {
  const day = resolveEnvironment(local(2026, 7, 1, 12), { weather: "clear" });
  assert.equal(day.phase, "day");
  assert.equal(day.night, false);
  assert.equal(day.lamp, false);

  assert.equal(resolveEnvironment(local(2026, 7, 1, 2), { weather: "clear" }).phase, "night");
  assert.equal(resolveEnvironment(local(2026, 7, 1, 19.0 | 0, 5), { weather: "clear" }).phase, "dusk");
  assert.equal(resolveEnvironment(local(2026, 7, 1, 12), { weather: "clear", hour: 23 }).phase, "night");
});

test("台灯：夜间自动亮，白天晴天不亮，雨天会亮，手动设置优先", () => {
  assert.equal(resolveEnvironment(local(2026, 7, 1, 23), { weather: "clear" }).lamp, true);
  assert.equal(resolveEnvironment(local(2026, 7, 1, 12), { weather: "clear" }).lamp, false);
  assert.equal(resolveEnvironment(local(2026, 7, 1, 12), { weather: "rain" }).lamp, true);
  assert.equal(resolveEnvironment(local(2026, 7, 1, 12), { weather: "clear", lamp: true }).lamp, true);
  assert.equal(resolveEnvironment(local(2026, 7, 1, 23), { weather: "clear", lamp: false }).lamp, false);
});

test("手动指定季节、时段、天气会覆盖自动结果", () => {
  const env = resolveEnvironment(local(2026, 7, 1, 12), { season: "winter", time: "night", weather: "snow" });
  assert.equal(env.season, "winter");
  assert.equal(env.phase, "night");
  assert.equal(env.weather, "snow");
  assert.equal(env.weatherSource, "manual");
  assert.ok(env.weatherIntensity > 0);
});

test("模拟天气：同一时刻结果固定，重启不会重新抽签", () => {
  const ctx = { seasonOf: d => seasonAt(d).season };
  const a = weather.createSimulatedProvider(0).sample(local(2026, 5, 20, 9, 30), ctx);
  const b = weather.createSimulatedProvider(0).sample(local(2026, 5, 20, 9, 30), ctx);
  assert.deepEqual(a, b);
});

test("模拟天气：四季只出现合理的天气，且各种天气都会出现", () => {
  const provider = weather.createSimulatedProvider(0);
  const ctx = { seasonOf: d => seasonAt(d).season };
  const seen = { spring: new Set(), summer: new Set(), autumn: new Set(), winter: new Set() };
  for (let t = local(2026, 1, 1, 0).getTime(); t < local(2027, 1, 1, 0).getTime(); t += 3 * 3600000) {
    // 取时段中点，避开切换时的 5 分钟渐变帧。
    const date = new Date(t + 30 * 60000);
    if (seasonAt(date).blend > 0) continue; // 换季过渡期的归属不唯一，不计入统计
    const s = provider.sample(date, ctx);
    seen[seasonAt(date).season].add(s.kind);
    assert.ok(s.intensity >= 0 && s.intensity <= 1);
    assert.ok(s.cloudCover >= 0 && s.cloudCover <= 1);
    assert.ok(s.wind >= 0 && s.wind <= 1);
  }
  assert.ok(!seen.summer.has("snow") && !seen.spring.has("snow") && !seen.autumn.has("snow"));
  assert.ok(!seen.winter.has("rain"));
  assert.ok(seen.winter.has("snow"));
  for (const season of ["spring", "summer", "autumn"]) assert.ok(seen[season].has("rain"), `${season} 应出现雨天`);
  assert.ok(seen.winter.has("clear") && seen.winter.has("cloud"));
});

test("模拟天气：强度、云量和风随时间连续，没有瞬间跳变", () => {
  const provider = weather.createSimulatedProvider(0);
  const ctx = { seasonOf: d => seasonAt(d).season };
  let prev = null;
  for (let t = local(2026, 4, 1, 0).getTime(); t < local(2026, 4, 11, 0).getTime(); t += 10000) {
    const s = provider.sample(new Date(t), ctx);
    if (prev) {
      assert.ok(Math.abs(s.intensity - prev.intensity) < 0.12, `强度跳变 ${prev.intensity} → ${s.intensity}`);
      assert.ok(Math.abs(s.cloudCover - prev.cloudCover) < 0.12, `云量跳变 ${prev.cloudCover} → ${s.cloudCover}`);
      assert.ok(Math.abs(s.wind - prev.wind) < 0.03, "风力不应跳变");
    }
    prev = s;
  }
});

test("天气来源：真实天气尚未接入时回退到模拟并标明", () => {
  const env = resolveEnvironment(local(2026, 5, 20, 9), { weatherSource: "real" });
  assert.equal(env.weatherSource, "simulated");
  assert.equal(env.weatherFallback, true);

  const sim = resolveEnvironment(local(2026, 5, 20, 9), { weatherSource: "simulated" });
  assert.equal(sim.weatherSource, "simulated");
  assert.equal(sim.weatherFallback, false);
  assert.equal(sim.weather, env.weather);
});

test("天气来源：可用的真实来源会被采用", () => {
  const providers = weather.defaultProviders();
  providers.real = {
    id: "real",
    available: true,
    sample: () => ({ kind: "rain", intensity: 0.7, cloudCover: 0.9, wind: 0.5 })
  };
  const env = resolveEnvironment(local(2026, 5, 20, 9), { weatherSource: "real" }, { providers });
  assert.equal(env.weather, "rain");
  assert.equal(env.weatherSource, "real");
  assert.equal(env.weatherFallback, false);
});

test("输出字段保持渲染层依赖的形状", () => {
  const env = resolveEnvironment(local(2026, 10, 3, 17, 40), {});
  for (const key of [
    "season", "weather", "phase", "night", "lamp", "nightMix", "duskMix", "dawnMix", "godRayAlpha", "goboAlpha",
    "summary", "poeticSummary", "weatherIntensity", "wind", "seasonBlend"
  ]) {
    assert.ok(key in env, `缺少字段 ${key}`);
  }
  assert.ok(env.nightMix >= 0 && env.nightMix <= 1);
});

function pick(s) {
  return { season: s.season, from: s.from, to: s.to, blend: s.blend };
}
