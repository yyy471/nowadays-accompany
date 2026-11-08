/**
 * 角色外观适配器与人物动作选择（DL-133、DL-134）。
 *
 * 外观数据由“来源”提供：来源是一个函数 `(roleInfo) => manifest | null | Promise`，
 * 依次尝试，第一个返回清单的生效。用户以后配置好的位置只需新增一个来源，
 * 不用改渲染代码。本模块自带夏澄的内置来源，没有外观的角色会得到占位清单。
 *
 * 清单（manifest）：
 *   {
 *     seal: "澄",                              // 占位印章字，缺立绘时显示
 *     sprites: { day, evening } | null,         // 基础立绘，缺失时用占位
 *     actions: { reading: { day, evening }, … } // 动作图，缺失的动作整体跳过
 *   }
 * 动作图只给了一种光照时，两种光照共用它。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.deskRoleVisual = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 人物动作集合。顺序即文档与规范里的顺序。 */
  const ACTION_IDS = ["reading", "writing", "thinking", "tea", "window", "sharing", "resting"];
  const LIGHTS = ["day", "evening"];

  function isAssetPath(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  /**
   * 校验并规范化清单。未知动作、非字符串路径都会被丢弃并记录在 issues 中，
   * 不会抛错，保证一份坏清单不会让主页打不开。
   */
  function normalizeManifest(raw, fallbackSeal = "·") {
    const issues = [];
    const manifest = { seal: fallbackSeal, sprites: null, actions: {} };
    if (!raw || typeof raw !== "object") {
      issues.push("清单不是对象，已忽略");
      return { manifest, issues };
    }
    if (isAssetPath(raw.seal)) manifest.seal = Array.from(raw.seal.trim())[0];

    if (raw.sprites && typeof raw.sprites === "object") {
      const day = isAssetPath(raw.sprites.day) ? raw.sprites.day : null;
      const evening = isAssetPath(raw.sprites.evening) ? raw.sprites.evening : null;
      if (day || evening) manifest.sprites = { day: day || evening, evening: evening || day };
      else issues.push("sprites 里没有可用的图片路径");
    }

    if (raw.actions && typeof raw.actions === "object") {
      for (const [id, entry] of Object.entries(raw.actions)) {
        if (!ACTION_IDS.includes(id)) {
          issues.push(`未知动作 ${id}，已忽略`);
          continue;
        }
        const light = {};
        if (typeof entry === "string") {
          if (isAssetPath(entry)) light.day = light.evening = entry;
        } else if (entry && typeof entry === "object") {
          const day = isAssetPath(entry.day) ? entry.day : null;
          const evening = isAssetPath(entry.evening) ? entry.evening : null;
          if (day || evening) {
            light.day = day || evening;
            light.evening = evening || day;
          }
        }
        if (light.day) manifest.actions[id] = light;
        else issues.push(`动作 ${id} 没有可用的图片路径`);
      }
    }
    return { manifest, issues };
  }

  /** 内置来源：只认识夏澄（原名“樱”）。其他角色交给后续配置的来源。 */
  function builtinSource(roleInfo) {
    if (roleInfo && (roleInfo.displayName === "夏澄" || roleInfo.displayName === "樱")) {
      return {
        seal: "澄",
        sprites: { day: "assets/xiacheng-day.webp", evening: "assets/xiacheng-night.webp" },
        actions: {}
      };
    }
    return null;
  }

  /**
   * 创建解析器。sources 依次尝试；内置来源总是排在最后作为兜底。
   * 每个解析器各自持有来源列表，不使用模块级共享状态。
   */
  function createRoleVisualResolver(sources = []) {
    const chain = [...sources, builtinSource];
    return {
      async resolve(roleInfo) {
        const fallbackSeal = Array.from(String(roleInfo?.displayName || "·"))[0];
        const problems = [];
        for (const source of chain) {
          let raw = null;
          try {
            raw = await source(roleInfo);
          } catch (error) {
            problems.push(`来源出错：${error?.message || error}`);
            continue;
          }
          if (!raw) continue;
          const { manifest, issues } = normalizeManifest(raw, fallbackSeal);
          return { visual: manifest, issues: [...problems, ...issues] };
        }
        return { visual: { seal: fallbackSeal, sprites: null, actions: {} }, issues: problems };
      }
    };
  }

  /** 取某个动作在某种光照下的图。没有图返回 null，调用方应回退到基础立绘。 */
  function resolveActionSprite(visual, actionId, light) {
    const entry = visual?.actions?.[actionId];
    if (!entry) return null;
    return entry[light] || entry.day || null;
  }

  function hash01(n) {
    let x = (Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  /** 本地日程：按小时给出倾向的动作。仅在没有后端活动时参与。 */
  function scheduledAction(hour) {
    if (hour >= 23 || hour < 6) return "resting";
    if (hour < 9) return "tea";
    if (hour < 12) return "reading";
    if (hour < 14) return "resting";
    if (hour < 18) return "reading";
    if (hour < 21) return "writing";
    return "thinking";
  }

  /**
   * 选择当前动作，纯函数。优先级从高到低：
   *   1. 后端真实活动（backendActivity）
   *   2. 天气反应：下雨或下雪时一部分时段看向窗外
   *   3. 本地日程
   * 返回 { action, source }，source 为 "backend" 或 "schedule"，界面据此标注。
   * 同一个“停留时段”内结果固定，避免动作闪烁；停留时长为 dwellMs。
   */
  function chooseAction({ backendActivity = null, env, now, dwellMs = 2 * 60 * 1000 }) {
    if (backendActivity && ACTION_IDS.includes(backendActivity)) {
      return { action: backendActivity, source: "backend" };
    }
    const slot = Math.floor(now.getTime() / Math.max(1, dwellMs));
    const precipitating = env && (env.weather === "rain" || env.weather === "snow") && env.weatherIntensity > 0.3;
    if (precipitating && hash01(slot) < 0.4) {
      return { action: "window", source: "schedule" };
    }
    const hour = now.getHours() + now.getMinutes() / 60;
    return { action: scheduledAction(hour), source: "schedule" };
  }

  return {
    ACTION_IDS,
    LIGHTS,
    normalizeManifest,
    createRoleVisualResolver,
    resolveActionSprite,
    chooseAction,
    scheduledAction
  };
});
