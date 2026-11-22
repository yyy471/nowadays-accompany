/**
 * 全局 Token 消耗统计的纯展示与查询逻辑（DL-183）。
 * 全程使用 BigInt 处理累积用量，避免超大数值溢出 JS 53 位安全整数上限。
 */

export const TOKEN_USAGE_RANGES = [
  { id: "today", label: "今日" },
  { id: "7d", label: "近 7 天" },
  { id: "30d", label: "近 30 天" },
  { id: "all", label: "全部" },
];

export const TOKEN_CATEGORY_LABELS = {
  dialogue: "对话回复",
  autonomy: "自主生活",
  memory: "记忆整理",
  annotation: "表情与情绪标注",
  scene_plan: "过场图规划",
  anchor_prompt: "生图锚点提炼",
  connection_test: "连接测试",
};

export function categoryLabel(category) {
  return TOKEN_CATEGORY_LABELS[category] ?? String(category ?? "");
}

/** 将后端返回的十进制字符串（或整数）安全解析为非负 BigInt。 */
export function parseTokenBigInt(value) {
  if (typeof value === "bigint") {
    return value > 0n ? value : 0n;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return 0n;
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
  }
  return 0n;
}

/** 按千分位格式化精确 Token 整数，供 tooltip 与无障碍读取使用。 */
export function formatExactTokenCount(value) {
  const digits = parseTokenBigInt(value).toString();
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatScaledUnit(amount, divisor, decimals, suffix) {
  const factor = 10n ** BigInt(decimals);
  const scaled = (amount * factor) / divisor;
  const whole = scaled / factor;
  const frac = scaled % factor;
  const wholeText = formatExactTokenCount(whole);
  if (frac === 0n) {
    return `${wholeText}${suffix}`;
  }
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${wholeText}.${fracText}${suffix}`;
}

/** 自适应换算 Token 展示单位（精确整数 / K / M / B / T），全程无 Number 精度损失。 */
export function formatTokenCount(value) {
  const amount = parseTokenBigInt(value);
  if (amount < 10_000n) {
    return formatExactTokenCount(amount);
  }
  if (amount < 1_000_000n) {
    return formatScaledUnit(amount, 1_000n, 1, "K");
  }
  if (amount < 1_000_000_000n) {
    return formatScaledUnit(amount, 1_000_000n, 2, "M");
  }
  if (amount < 1_000_000_000_000n) {
    return formatScaledUnit(amount, 1_000_000_000n, 2, "B");
  }
  return formatScaledUnit(amount, 1_000_000_000_000n, 2, "T");
}

/** 用 BigInt 计算缓存命中率百分比文案。 */
export function formatCacheHitRate(cached, input) {
  const c = parseTokenBigInt(cached);
  const i = parseTokenBigInt(input);
  if (i <= 0n) {
    return "—";
  }
  const bounded = c > i ? i : c;
  const tenths = (bounded * 1000n) / i;
  const whole = tenths / 10n;
  const dec = tenths % 10n;
  return dec === 0n ? `${whole.toString()}%` : `${whole.toString()}.${dec.toString()}%`;
}

/** 计算条形图占比百分比（0..100），非零极小值至少保留 1% 可见宽度。 */
export function sharePercent(part, max) {
  const p = parseTokenBigInt(part);
  const m = parseTokenBigInt(max);
  if (m <= 0n || p <= 0n) {
    return 0;
  }
  if (p >= m) {
    return 100;
  }
  const pct = Number((p * 100n) / m);
  return pct < 1 ? 1 : pct;
}

/** 构造统计查询接口路径。 */
export function buildTokenUsageQuery(filters = {}) {
  const params = new URLSearchParams();
  params.set("range", filters.range || "7d");
  if (filters.roleKey) {
    params.set("roleKey", filters.roleKey);
  }
  if (filters.category) {
    params.set("category", filters.category);
  }
  if (filters.modelKey) {
    params.set("modelKey", filters.modelKey);
  }
  return `/v1/usage/tokens?${params.toString()}`;
}
