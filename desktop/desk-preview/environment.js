(() => {
  "use strict";

  const seasonsByMonth = [
    "winter", "winter", "spring", "spring", "spring",
    "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"
  ];
  const daylightHours = {
    spring: [6.0, 18.5],
    summer: [5.3, 19.5],
    autumn: [6.4, 17.8],
    winter: [7.0, 17.0]
  };
  const weatherPool = {
    spring: ["clear", "clear", "cloud", "rain"],
    summer: ["clear", "clear", "rain", "cloud"],
    autumn: ["clear", "clear", "cloud", "rain"],
    winter: ["clear", "snow", "cloud", "clear"]
  };

  const phaseMeta = {
    dawn: {
      label: "清晨",
      poetic: "晨雾初散 · 晓光微凉",
      nightMix: 0.28,
      duskMix: 0.18,
      dawnMix: 0.85,
      godRayAlpha: 0.42,
      goboAlpha: 0.24,
      defaultLamp: false
    },
    day: {
      label: "白昼",
      poetic: "晴窗竹影 · 日暖风恬",
      nightMix: 0.0,
      duskMix: 0.0,
      dawnMix: 0.0,
      godRayAlpha: 0.62,
      goboAlpha: 0.44,
      defaultLamp: false
    },
    dusk: {
      label: "黄昏",
      poetic: "暮色琥珀 · 落照染卷",
      nightMix: 0.34,
      duskMix: 0.92,
      dawnMix: 0.0,
      godRayAlpha: 0.56,
      goboAlpha: 0.38,
      defaultLamp: true
    },
    night: {
      label: "夜阑",
      poetic: "月华如水 · 灯火相伴",
      nightMix: 1.0,
      duskMix: 0.0,
      dawnMix: 0.0,
      godRayAlpha: 0.14,
      goboAlpha: 0.18,
      defaultLamp: true
    }
  };

  const seasonMeta = {
    spring: { label: "春", poetic: "春樱 · 落瓣吹雪", particle: "petal", accent: "#e899a8" },
    summer: { label: "夏", poetic: "夏木 · 熏风流萤", particle: "firefly", accent: "#5ba37f" },
    autumn: { label: "秋", poetic: "秋枫 · 霜叶流丹", particle: "leaf", accent: "#d47a45" },
    winter: { label: "冬", poetic: "冬雪 · 晴雪初霁", particle: "snow", accent: "#88a9c9" }
  };

  const weatherMeta = {
    clear: { label: "晴", poetic: "晴光通透", rayFactor: 1.0, goboFactor: 1.0 },
    cloud: { label: "阴", poetic: "天光柔漫", rayFactor: 0.25, goboFactor: 0.35 },
    rain: { label: "雨", poetic: "檐雨敲窗", rayFactor: 0.08, goboFactor: 0.15 },
    snow: { label: "雪", poetic: "细雪覆枝", rayFactor: 0.2, goboFactor: 0.22 }
  };

  function smoothstep(t) {
    const clamped = Math.max(0, Math.min(1, t));
    return clamped * clamped * (3 - 2 * clamped);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function resolveEnvironment(now, settings = {}) {
    const month = now.getMonth();
    const season = settings.season && settings.season !== "auto"
      ? settings.season
      : seasonsByMonth[month];

    const hour = now.getHours() + now.getMinutes() / 60;
    const [sunrise, sunset] = daylightHours[season] || daylightHours.autumn;
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
      mix = 0;
    }

    const dominantPhase = mix < 0.5 ? fromPhase : toPhase;
    const fromInfo = phaseMeta[fromPhase] || phaseMeta.day;
    const toInfo = phaseMeta[toPhase] || phaseMeta.day;

    const pool = weatherPool[season] || weatherPool.autumn;
    const weather = settings.weather && settings.weather !== "auto"
      ? settings.weather
      : pool[(now.getDate() + month * 7 + Math.floor(hour / 6)) % pool.length];

    const wInfo = weatherMeta[weather] || weatherMeta.clear;
    const sInfo = seasonMeta[season] || seasonMeta.autumn;

    const lamp = settings.lamp === null || settings.lamp === undefined || settings.lamp === "auto"
      ? (toInfo.defaultLamp || weather === "rain" || weather === "snow")
      : (settings.lamp === true || settings.lamp === "on");

    const nightMix = lerp(fromInfo.nightMix, toInfo.nightMix, mix) + (weather === "rain" ? 0.12 : 0);
    const duskMix = lerp(fromInfo.duskMix, toInfo.duskMix, mix);
    const dawnMix = lerp(fromInfo.dawnMix, toInfo.dawnMix, mix);
    const godRayAlpha = lerp(fromInfo.godRayAlpha, toInfo.godRayAlpha, mix) * wInfo.rayFactor;
    const goboAlpha = lerp(fromInfo.goboAlpha, toInfo.goboAlpha, mix) * wInfo.goboFactor;

    return {
      season,
      weather,
      phase: dominantPhase,
      fromPhase,
      toPhase,
      mix,
      lamp,
      night: dominantPhase === "night",
      nightMix: Math.min(1, Number(nightMix.toFixed(3))),
      duskMix: Number(duskMix.toFixed(3)),
      dawnMix: Number(dawnMix.toFixed(3)),
      godRayAlpha: Number(godRayAlpha.toFixed(3)),
      goboAlpha: Number(goboAlpha.toFixed(3)),
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

  globalThis.deskEnvironment = { resolveEnvironment };
})();
