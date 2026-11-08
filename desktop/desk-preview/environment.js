/**
 * 环境解析（DL-133）。
 *
 * 唯一的环境状态来源：由本地时间、设置和天气来源得出一个连续的场景状态，
 * 渲染层只读取结果，不再自己判断“现在是不是晚上、是不是下雨”。
 * 这是纯函数模块，可在浏览器与 Node 中使用，便于离线测试。
 */
(function (root, factory) {
  const weather = typeof module === "object" && module.exports
    ? require("./weather-provider.js")
    : root.deskWeather;
  const api = factory(weather);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.deskEnvironment = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (deskWeather) {
  "use strict";

  const DAY_MS = 86400000;
  // 换季前后各 5 天交叉过渡，共 10 天。
  const SEASON_BLEND_HALF_DAYS = 5;

  const phaseMeta = {
    dawn: { label: "清晨", poetic: "晨雾初散 · 晓光微凉", nightMix: 0.28, duskMix: 0.18, dawnMix: 0.85, godRayAlpha: 0.42, goboAlpha: 0.24 },
    day: { label: "白昼", poetic: "晴窗竹影 · 日暖风恬", nightMix: 0.0, duskMix: 0.0, dawnMix: 0.0, godRayAlpha: 0.62, goboAlpha: 0.44 },
    dusk: { label: "黄昏", poetic: "暮色琥珀 · 落照染卷", nightMix: 0.34, duskMix: 0.92, dawnMix: 0.0, godRayAlpha: 0.56, goboAlpha: 0.38 },
    night: { label: "夜阑", poetic: "月华如水 · 灯火相伴", nightMix: 1.0, duskMix: 0.0, dawnMix: 0.0, godRayAlpha: 0.14, goboAlpha: 0.18 }
  };

  const seasonMeta = {
    spring: { label: "春", poetic: "春樱 · 落瓣吹雪", particle: "petal", accent: "#e899a8" },
    summer: { label: "夏", poetic: "夏木 · 熏风流萤", particle: "firefly", accent: "#5ba37f" },
    autumn: { label: "秋", poetic: "秋枫 · 霜叶流丹", particle: "leaf", accent: "#d47a45" },
    winter: { label: "冬", poetic: "冬雪 · 晴雪初霁", particle: "snow", accent: "#88a9c9" }
  };

  const weatherMeta = {
    clear: { label: "晴", poetic: "晴光通透" },
    cloud: { label: "阴", poetic: "天光柔漫" },
    rain: { label: "雨", poetic: "檐雨敲窗" },
    snow: { label: "雪", poetic: "细雪覆枝" }
  };

  // 手动指定天气（调试台）时使用的默认强度与遮挡。
  const manualWeather = {
    clear: { intensity: 0, cloudCover: 0 },
    cloud: { intensity: 0.6, cloudCover: 0.75 },
    rain: { intensity: 0.85, cloudCover: 0.95 },
    snow: { intensity: 0.85, cloudCover: 0.85 }
  };

  function smoothstep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** 当年的第几天，含小数（本地时间）。1 月 1 日 0 点为 1。 */
  function dayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 1);
    return 1 + (date.getTime() - start.getTime()) / DAY_MS;
  }

  /**
   * 季节与换季混合。季节边界为 3/1、6/1、9/1、12/1，边界前后各 5 天交叉过渡。
   * 返回 { season, from, to, blend }：season 为占优季节，blend 为 0～1，
   * 0 表示完全是 from，1 表示完全是 to。
   */
  function seasonAt(date) {
    const y = date.getFullYear();
    const marks = [
      { t: new Date(y - 1, 8, 1), season: "autumn" },
      { t: new Date(y - 1, 11, 1), season: "winter" },
      { t: new Date(y, 2, 1), season: "spring" },
      { t: new Date(y, 5, 1), season: "summer" },
      { t: new Date(y, 8, 1), season: "autumn" },
      { t: new Date(y, 11, 1), season: "winter" },
      { t: new Date(y + 1, 2, 1), season: "spring" }
    ];
    const now = date.getTime();
    let i = 0;
    while (i < marks.length - 2 && marks[i + 1].t.getTime() <= now) i++;

    const current = marks[i].season;
    const sinceStart = (now - marks[i].t.getTime()) / DAY_MS;
    const untilEnd = (marks[i + 1].t.getTime() - now) / DAY_MS;

    let from = current;
    let to = current;
    let blend = 0;
    if (sinceStart < SEASON_BLEND_HALF_DAYS && i > 0) {
      from = marks[i - 1].season;
      blend = (sinceStart + SEASON_BLEND_HALF_DAYS) / (2 * SEASON_BLEND_HALF_DAYS);
    } else if (untilEnd < SEASON_BLEND_HALF_DAYS) {
      to = marks[i + 1].season;
      blend = (SEASON_BLEND_HALF_DAYS - untilEnd) / (2 * SEASON_BLEND_HALF_DAYS);
    }
    return { season: blend < 0.5 ? from : to, from, to, blend };
  }

  /** 日出日落随日期连续变化：夏至最长（约 5.3～19.5），冬至最短（约 7.0～17.0）。 */
  function daylightAt(doy) {
    const c = Math.cos((2 * Math.PI * (doy - 172)) / 365);
    return { sunrise: 6.15 - 0.85 * c, sunset: 18.25 + 1.25 * c };
  }

  function resolveEnvironment(now, settings = {}, deps = {}) {
    const providers = deps.providers || (deskWeather ? deskWeather.defaultProviders() : null);

    const forcedSeason = settings.season && settings.season !== "auto" ? settings.season : null;
    const seasonInfo = forcedSeason
      ? { season: forcedSeason, from: forcedSeason, to: forcedSeason, blend: 0 }
      : seasonAt(now);
    const season = seasonInfo.season;

    const hour = typeof settings.hour === "number"
      ? settings.hour
      : now.getHours() + now.getMinutes() / 60;
    const doy = dayOfYear(now);
    const { sunrise, sunset } = daylightAt(doy);
    const boundaries = [0, sunrise - 0.9, sunrise + 0.3, sunrise + 1.8, sunset - 1.6, sunset + 0.1, sunset + 1.2, 24];
    const phaseChain = ["night", "night", "dawn", "day", "day", "dusk", "night", "night"];

    let fromPhase = "day";
    let toPhase = "day";
    let mix = 0;
    if (!settings.time || settings.time === "auto") {
      let idx = boundaries.findIndex((b, i) => i > 0 && hour < b);
      if (idx === -1) idx = boundaries.length - 1;
      fromPhase = phaseChain[idx - 1];
      toPhase = phaseChain[idx];
      const span = Math.max(0.01, boundaries[idx] - boundaries[idx - 1]);
      mix = fromPhase === toPhase ? 0 : smoothstep((hour - boundaries[idx - 1]) / span);
    } else {
      fromPhase = settings.time;
      toPhase = settings.time;
    }
    const dominantPhase = mix < 0.5 ? fromPhase : toPhase;
    const fromInfo = phaseMeta[fromPhase] || phaseMeta.day;
    const toInfo = phaseMeta[toPhase] || phaseMeta.day;

    // 天气：手动指定优先，否则按设置的来源取样。
    let sample;
    if (settings.weather && settings.weather !== "auto") {
      const m = manualWeather[settings.weather] || manualWeather.clear;
      sample = { kind: settings.weather, ...m, wind: 0.35, source: "manual", fallback: false };
    } else if (providers) {
      sample = deskWeather.sampleWeather(
        settings.weatherSource || "simulated",
        now,
        { seasonOf: d => seasonAt(d).season },
        providers
      );
    } else {
      sample = { kind: "clear", intensity: 0, cloudCover: 0, wind: 0.3, source: "simulated", fallback: false };
    }
    const weather = sample.kind;
    const wInfo = weatherMeta[weather] || weatherMeta.clear;
    const sInfo = seasonMeta[season] || seasonMeta.autumn;
    const precipitation = weather === "rain" || weather === "snow" ? sample.intensity : 0;

    const nightMix = Math.min(
      1,
      lerp(fromInfo.nightMix, toInfo.nightMix, mix) + (weather === "rain" ? 0.12 * sample.intensity : 0) + 0.05 * sample.cloudCover
    );
    const duskMix = lerp(fromInfo.duskMix, toInfo.duskMix, mix);
    const dawnMix = lerp(fromInfo.dawnMix, toInfo.dawnMix, mix);
    const godRayAlpha = lerp(fromInfo.godRayAlpha, toInfo.godRayAlpha, mix) * (1 - sample.cloudCover * 0.92);
    const goboAlpha = lerp(fromInfo.goboAlpha, toInfo.goboAlpha, mix) * (1 - sample.cloudCover * 0.85);

    // 室内亮度：夜越深、云越厚越暗；台灯在亮度低于阈值时自动点亮。
    const ambientLight = (1 - nightMix) * (1 - 0.45 * sample.cloudCover) * (1 - 0.35 * duskMix) * (1 - 0.2 * dawnMix);
    const lampLevel = smoothstep((0.7 - ambientLight) / 0.25);
    const lamp = settings.lamp === null || settings.lamp === undefined || settings.lamp === "auto"
      ? ambientLight < 0.56
      : (settings.lamp === true || settings.lamp === "on");

    const round = (n) => Number(n.toFixed(3));
    return {
      season,
      seasonFrom: seasonInfo.from,
      seasonTo: seasonInfo.to,
      seasonBlend: round(seasonInfo.blend),
      weather,
      weatherIntensity: round(precipitation),
      cloudCover: round(sample.cloudCover),
      wind: round(sample.wind),
      weatherSource: sample.source,
      weatherFallback: sample.fallback,
      phase: dominantPhase,
      fromPhase,
      toPhase,
      mix,
      dayOfYear: round(doy),
      sunrise: round(sunrise),
      sunset: round(sunset),
      ambientLight: round(ambientLight),
      lamp,
      lampLevel: round(lampLevel),
      night: dominantPhase === "night",
      nightMix: round(nightMix),
      duskMix: round(duskMix),
      dawnMix: round(dawnMix),
      godRayAlpha: round(godRayAlpha),
      goboAlpha: round(goboAlpha),
      seasonLabel: sInfo.label,
      seasonPoetic: sInfo.poetic,
      weatherLabel: wInfo.label,
      weatherPoetic: wInfo.poetic,
      phaseLabel: phaseMeta[dominantPhase].label,
      phasePoetic: phaseMeta[dominantPhase].poetic,
      summary: `${sInfo.label} · ${phaseMeta[dominantPhase].label} · ${wInfo.label}`,
      poeticSummary: `${sInfo.poetic} · ${phaseMeta[dominantPhase].poetic}`
    };
  }

  return { resolveEnvironment, seasonAt, daylightAt, dayOfYear };
});
