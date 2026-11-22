import type { ModelProtocol, ModelUsage } from "./model.js";

/** 全局 Token 消耗统计的 7 类用途（DL-183）。 */
export const TOKEN_USAGE_CATEGORIES = [
  "dialogue",
  "autonomy",
  "memory",
  "annotation",
  "scene_plan",
  "anchor_prompt",
  "connection_test",
] as const;

export type TokenUsageCategory = (typeof TOKEN_USAGE_CATEGORIES)[number];

/** 查询支持的时间范围（按本机时区自然日）。 */
export const TOKEN_USAGE_RANGES = ["today", "7d", "30d", "all"] as const;
export type TokenUsageRange = (typeof TOKEN_USAGE_RANGES)[number];

/** SQLite 有符号 64 位整数上限，单次调用字段写入前做安全封顶。 */
export const MAX_SQLITE_INT64 = 9_223_372_036_854_775_807n;

/** 合并流式事件中陆续到达的用量字段，保留全部 4 项归一化口径。 */
export function mergeModelUsage(
  previous: ModelUsage | null,
  incoming: ModelUsage,
): ModelUsage {
  return {
    ...(previous ?? {}),
    ...(incoming.inputTokens === undefined
      ? {}
      : { inputTokens: incoming.inputTokens }),
    ...(incoming.cachedTokens === undefined
      ? {}
      : { cachedTokens: incoming.cachedTokens }),
    ...(incoming.outputTokens === undefined
      ? {}
      : { outputTokens: incoming.outputTokens }),
    ...(incoming.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: incoming.cacheCreationTokens }),
  };
}

/** 判断上游是否至少回报了一项有效 Token 数值。 */
export function hasReportedUsage(usage: ModelUsage | null | undefined): boolean {
  if (usage === null || usage === undefined) {
    return false;
  }
  return (
    isNonNegativeFinite(usage.inputTokens) ||
    isNonNegativeFinite(usage.cachedTokens) ||
    isNonNegativeFinite(usage.cacheCreationTokens) ||
    isNonNegativeFinite(usage.outputTokens)
  );
}

/** 将单个 Token 字段转为非负 BigInt，并限制在 SQLite 64 位有符号整数范围内。 */
export function sanitizeTokenBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0n;
    return value > MAX_SQLITE_INT64 ? MAX_SQLITE_INT64 : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0n;
    const floored = Math.floor(value);
    if (floored <= 0) return 0n;
    if (floored >= Number.MAX_SAFE_INTEGER) {
      // 超出 JS 安全整数的浮点数已失真，转为 BigInt 后仍受 SQLite INT64 上限保护。
      const big = BigInt(Math.trunc(floored));
      return big > MAX_SQLITE_INT64 ? MAX_SQLITE_INT64 : big;
    }
    return BigInt(floored);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const big = BigInt(value.trim());
    return big > MAX_SQLITE_INT64 ? MAX_SQLITE_INT64 : big;
  }
  return 0n;
}

/** 解析 model_calls.usage_json 文本为归一化对象。 */
export function parseStoredUsageJson(raw: string | null): ModelUsage | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const usage: ModelUsage = {};
    if (isNonNegativeFinite(obj.inputTokens)) usage.inputTokens = Math.floor(obj.inputTokens);
    if (isNonNegativeFinite(obj.cachedTokens)) usage.cachedTokens = Math.floor(obj.cachedTokens);
    if (isNonNegativeFinite(obj.cacheCreationTokens)) {
      usage.cacheCreationTokens = Math.floor(obj.cacheCreationTokens);
    }
    if (isNonNegativeFinite(obj.outputTokens)) usage.outputTokens = Math.floor(obj.outputTokens);
    return hasReportedUsage(usage) ? usage : null;
  } catch {
    return null;
  }
}

/** 按 model_calls 的 purpose 与 call_kind 归入 7 类用途。 */
export function classifyModelCallCategory(
  purpose: string,
  callKind: string | null | undefined,
): TokenUsageCategory {
  if (callKind === "memory_maintenance" || purpose === "memory_maintenance") {
    return "memory";
  }
  if (callKind === "segment_annotation") {
    return "annotation";
  }
  if (callKind === "scene_plan") {
    return "scene_plan";
  }
  if (callKind === "anchor_prompt") {
    return "anchor_prompt";
  }
  if (purpose === "connection_test") {
    return "connection_test";
  }
  if (purpose === "autonomous") {
    return "autonomy";
  }
  return "dialogue";
}

/** 构造模型维度的稳定分组键（区分不同服务商资源下的同名模型）。 */
export function buildTokenModelKey(
  resourceId: string | null,
  protocol: string,
  modelName: string,
): string {
  return `${resourceId ?? ""}::${protocol}::${modelName}`;
}

/** 写入全局账本的事件结构（由各模型调用点上报）。 */
export interface TokenUsageCallEvent {
  sourceCallId: string;
  roleId: string | null;
  roleName?: string | null;
  resourceId: string | null;
  resourceName?: string | null;
  provider?: string | null;
  protocol: ModelProtocol;
  modelName: string;
  category: TokenUsageCategory;
  status: "succeeded" | "failed" | "unknown";
  occurredAt: string;
  usage: ModelUsage | null;
}

/** 对外输出的数值一律使用十进制整数字符串，彻底规避 JS 53 位安全整数上限。 */
export interface TokenUsageTotalsView {
  inputTokens: string;
  cachedTokens: string;
  cacheCreationTokens: string;
  outputTokens: string;
  totalTokens: string;
  cacheHitRate: number | null;
  callCount: string;
  reportedCallCount: string;
  missingUsageCount: string;
  failedCallCount: string;
}

export interface TokenUsageDailyView extends TokenUsageTotalsView {
  date: string;
}

export interface TokenUsageRoleView extends TokenUsageTotalsView {
  /** 全局无角色调用（如连接测试）使用 "__global__"。 */
  roleKey: string;
  roleId: string | null;
  roleName: string;
  deleted: boolean;
}

export interface TokenUsageModelView extends TokenUsageTotalsView {
  modelKey: string;
  resourceId: string | null;
  resourceName: string;
  provider: string | null;
  protocol: string;
  modelName: string;
  deleted: boolean;
}

export interface TokenUsageCategoryView extends TokenUsageTotalsView {
  category: TokenUsageCategory;
}

export interface TokenUsageFilterRoleOption {
  roleKey: string;
  roleId: string | null;
  roleName: string;
  deleted: boolean;
}

export interface TokenUsageFilterModelOption {
  modelKey: string;
  resourceId: string | null;
  resourceName: string;
  modelName: string;
  deleted: boolean;
}

export interface TokenUsageSummaryView {
  range: TokenUsageRange;
  startDate: string | null;
  endDate: string;
  appliedFilters: {
    roleKey: string | null;
    category: TokenUsageCategory | null;
    modelKey: string | null;
  };
  totals: TokenUsageTotalsView;
  daily: TokenUsageDailyView[];
  byRole: TokenUsageRoleView[];
  byModel: TokenUsageModelView[];
  byCategory: TokenUsageCategoryView[];
  availableFilters: {
    roles: TokenUsageFilterRoleOption[];
    models: TokenUsageFilterModelOption[];
  };
}

export const GLOBAL_USAGE_ROLE_KEY = "__global__";

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
