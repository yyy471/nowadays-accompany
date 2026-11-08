/**
 * 天气来源模块（DL-133）。
 *
 * 天气来源是可替换的：默认的 `simulated` 完全离线、确定性，同一时刻总是得到同一天气，
 * 因此重启不会重新抽签；`real`（真实天气）目前只是占位入口，尚未接入，
 * 选择它时会明确回退到模拟并带上 `fallback: true`。
 *
 * 来源接口（后续接入真实天气时实现）：
 *   { id, available, sample(now, ctx) -> { kind, intensity, cloudCover, wind } | null }
 * - kind: "clear" | "cloud" | "rain" | "snow"
 * - intensity: 0～1，当前 kind 的强度
 * - cloudCover: 0～1，遮挡阳光的程度
 * - wind: 0～1，风力
 * ctx.seasonOf(date) 返回该时刻所在季节，供模拟来源按季节调整转移概率。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.deskWeather = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KINDS = ["clear", "cloud", "rain", "snow"];
  const SLOT_MS = 3 * 3600 * 1000;
  // 天气切换时，旧天气淡出、新天气淡入所用的时间。
  const RAMP_MS = 5 * 60 * 1000;
  // 从多少个时段之前开始推演，使当前天气只依赖时间而不依赖任何存储。
  const CHAIN_LENGTH = 10;

  // 转移权重顺序与 KINDS 一致：[晴, 阴, 雨, 雪]。
  const TRANSITIONS = {
    spring: {
      clear: [0.55, 0.30, 0.15, 0],
      cloud: [0.30, 0.35, 0.35, 0],
      rain: [0.20, 0.40, 0.40, 0],
      snow: [0.30, 0.40, 0.30, 0]
    },
    summer: {
      clear: [0.65, 0.20, 0.15, 0],
      cloud: [0.35, 0.35, 0.30, 0],
      rain: [0.25, 0.40, 0.35, 0],
      snow: [0.40, 0.40, 0.20, 0]
    },
    autumn: {
      clear: [0.55, 0.30, 0.15, 0],
      cloud: [0.30, 0.40, 0.30, 0],
      rain: [0.20, 0.45, 0.35, 0],
      snow: [0.30, 0.40, 0.30, 0]
    },
    winter: {
      clear: [0.50, 0.30, 0, 0.20],
      cloud: [0.25, 0.35, 0, 0.40],
      rain: [0.30, 0.50, 0, 0.20],
      snow: [0.15, 0.40, 0, 0.45]
    }
  };

  function smoothstep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** 整数哈希，返回 [0, 1)。 */
  function hash01(n) {
    let x = (Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  function pickWeighted(weights, r) {
    let acc = 0;
    let last = 0;
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] <= 0) continue;
      last = i;
      acc += weights[i];
      if (r < acc) return i;
    }
    return last;
  }

  function createSimulatedProvider(seed = 0) {
    const salt = (Math.imul(seed | 0, 2654435761) | 0);

    function rand(slot, channel) {
      return hash01((slot * 7919 + channel * 104729 + salt) | 0);
    }

    function kindAtSlot(slot, seasonOf) {
      const start = slot - CHAIN_LENGTH;
      const startSeason = seasonOf(new Date(start * SLOT_MS));
      let kind = KINDS[pickWeighted(TRANSITIONS[startSeason].clear, rand(start, 1))];
      for (let s = start + 1; s <= slot; s++) {
        const season = seasonOf(new Date(s * SLOT_MS));
        const row = TRANSITIONS[season][kind] || TRANSITIONS[season].clear;
        kind = KINDS[pickWeighted(row, rand(s, 2))];
      }
      return kind;
    }

    function intensityOf(slot, kind) {
      if (kind === "clear") return 0;
      const r = rand(slot, 3);
      return kind === "cloud" ? 0.4 + 0.5 * r : 0.35 + 0.65 * r;
    }

    function coverOf(kind, intensity) {
      if (kind === "clear") return 0;
      if (kind === "cloud") return 0.6 + 0.25 * intensity;
      if (kind === "rain") return 0.8 + 0.2 * intensity;
      return 0.7 + 0.2 * intensity;
    }

    function windAt(ms, cover) {
      const hours = ms / 3600000;
      const base = Math.floor(hours);
      const noise = lerp(rand(base, 4), rand(base + 1, 4), smoothstep(hours - base));
      // 云越厚风越大；用云量而不是天气种类，保证切换时风力连续。
      const bonus = 0.12 * cover;
      return Math.max(0, Math.min(1, 0.12 + 0.55 * noise + bonus));
    }

    return {
      id: "simulated",
      available: true,
      sample(now, ctx) {
        const ms = now.getTime();
        const slot = Math.floor(ms / SLOT_MS);
        const into = ms - slot * SLOT_MS;
        const cur = kindAtSlot(slot, ctx.seasonOf);
        const prev = kindAtSlot(slot - 1, ctx.seasonOf);

        let kind = cur;
        let full = intensityOf(slot, cur);
        let ramp = 1;
        if (into < RAMP_MS) {
          const m = smoothstep(into / RAMP_MS);
          if (prev !== cur) {
            // 切换点前后，强度和云量先降到 0 再升起，避免雨或雪瞬间出现或消失。
            kind = m < 0.5 ? prev : cur;
            full = intensityOf(m < 0.5 ? slot - 1 : slot, kind);
            ramp = Math.abs(2 * m - 1);
          } else {
            // 种类不变时，强度从上一时段平滑过渡到本时段。
            full = lerp(intensityOf(slot - 1, cur), full, m);
          }
        }
        const cloudCover = coverOf(kind, full) * ramp;
        return {
          kind,
          intensity: full * ramp,
          cloudCover,
          wind: windAt(ms, cloudCover)
        };
      }
    };
  }

  /** 真实天气占位：尚未接入，始终不可用，调用方会回退到模拟。 */
  const realProviderStub = {
    id: "real",
    available: false,
    sample() {
      return null;
    }
  };

  function defaultProviders(seed = 0) {
    return { simulated: createSimulatedProvider(seed), real: realProviderStub };
  }

  /**
   * 按设置选择来源取样。来源不可用或返回空时回退到模拟，并标记 fallback。
   */
  function sampleWeather(sourceId, now, ctx, providers) {
    const wanted = providers[sourceId];
    if (wanted && wanted.available) {
      const sample = wanted.sample(now, ctx);
      if (sample) return { ...sample, source: wanted.id, fallback: false };
    }
    const sample = providers.simulated.sample(now, ctx);
    return { ...sample, source: "simulated", fallback: sourceId !== "simulated" };
  }

  return { KINDS, RAMP_MS, SLOT_MS, createSimulatedProvider, realProviderStub, defaultProviders, sampleWeather };
});
