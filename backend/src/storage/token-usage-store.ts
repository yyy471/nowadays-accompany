import type Database from "better-sqlite3";
import {
  buildTokenModelKey,
  GLOBAL_USAGE_ROLE_KEY,
  sanitizeTokenBigInt,
  TOKEN_USAGE_CATEGORIES,
  type TokenUsageCategory,
  type TokenUsageCategoryView,
  type TokenUsageDailyView,
  type TokenUsageFilterModelOption,
  type TokenUsageFilterRoleOption,
  type TokenUsageModelView,
  type TokenUsageRange,
  type TokenUsageRoleView,
  type TokenUsageSummaryView,
  type TokenUsageTotalsView,
} from "../domain/token-usage.js";

export interface StoredTokenUsageRecordInput {
  sourceCallId: string;
  localDate: string;
  occurredAt: string;
  roleId: string | null;
  roleName: string;
  resourceId: string | null;
  resourceName: string;
  provider: string | null;
  protocol: string;
  modelName: string;
  category: TokenUsageCategory;
  status: "succeeded" | "failed" | "unknown";
  usageReported: boolean;
  inputTokens: bigint;
  cachedTokens: bigint;
  cacheCreationTokens: bigint;
  outputTokens: bigint;
}

export interface TokenUsageQueryOptions {
  range: TokenUsageRange;
  startDate: string | null;
  endDate: string;
  roleKey?: string | null;
  category?: TokenUsageCategory | null;
  modelKey?: string | null;
  liveRoles: ReadonlyMap<string, string>;
  liveResources: ReadonlyMap<string, { name: string; provider: string | null }>;
}

interface RawUsageRow {
  local_date: string;
  role_id: string | null;
  role_name: string;
  resource_id: string | null;
  resource_name: string;
  provider: string | null;
  protocol: string;
  model_name: string;
  category: TokenUsageCategory;
  status: string;
  usage_reported: bigint;
  input_tokens: bigint;
  cached_tokens: bigint;
  cache_creation_tokens: bigint;
  output_tokens: bigint;
}

interface MutableAccumulator {
  inputTokens: bigint;
  cachedTokens: bigint;
  cacheCreationTokens: bigint;
  outputTokens: bigint;
  callCount: bigint;
  reportedCallCount: bigint;
  missingUsageCount: bigint;
  failedCallCount: bigint;
}

function emptyAccumulator(): MutableAccumulator {
  return {
    inputTokens: 0n,
    cachedTokens: 0n,
    cacheCreationTokens: 0n,
    outputTokens: 0n,
    callCount: 0n,
    reportedCallCount: 0n,
    missingUsageCount: 0n,
    failedCallCount: 0n,
  };
}

function addRow(acc: MutableAccumulator, row: RawUsageRow): void {
  const reported = row.usage_reported === 1n;
  acc.callCount += 1n;
  if (reported) {
    acc.reportedCallCount += 1n;
    acc.inputTokens += row.input_tokens >= 0n ? row.input_tokens : 0n;
    acc.cachedTokens += row.cached_tokens >= 0n ? row.cached_tokens : 0n;
    acc.cacheCreationTokens +=
      row.cache_creation_tokens >= 0n ? row.cache_creation_tokens : 0n;
    acc.outputTokens += row.output_tokens >= 0n ? row.output_tokens : 0n;
  } else {
    acc.missingUsageCount += 1n;
  }
  if (row.status === "failed") {
    acc.failedCallCount += 1n;
  }
}

/** 统一以 BigInt 计算缓存命中率（精确到万分之一），避免超大整数转 Number 溢出。 */
function computeCacheHitRate(cached: bigint, input: bigint): number | null {
  if (input <= 0n) {
    return null;
  }
  const bounded = cached > input ? input : cached;
  const basisPoints = Number((bounded * 10_000n) / input);
  return basisPoints / 10_000;
}

function toTotalsView(acc: MutableAccumulator): TokenUsageTotalsView {
  const totalTokens = acc.inputTokens + acc.outputTokens;
  return {
    inputTokens: acc.inputTokens.toString(),
    cachedTokens: acc.cachedTokens.toString(),
    cacheCreationTokens: acc.cacheCreationTokens.toString(),
    outputTokens: acc.outputTokens.toString(),
    totalTokens: totalTokens.toString(),
    cacheHitRate: computeCacheHitRate(acc.cachedTokens, acc.inputTokens),
    callCount: acc.callCount.toString(),
    reportedCallCount: acc.reportedCallCount.toString(),
    missingUsageCount: acc.missingUsageCount.toString(),
    failedCallCount: acc.failedCallCount.toString(),
  };
}

function compareDescByVolume(a: MutableAccumulator, b: MutableAccumulator): number {
  const totalA = a.inputTokens + a.outputTokens;
  const totalB = b.inputTokens + b.outputTokens;
  if (totalA !== totalB) {
    return totalB > totalA ? 1 : -1;
  }
  if (a.callCount !== b.callCount) {
    return b.callCount > a.callCount ? 1 : -1;
  }
  return 0;
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || cursor > end) {
    return dates;
  }
  while (cursor <= end && dates.length < 4000) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** 全局库（app.sqlite）Token 消耗账本存储层。 */
export class TokenUsageStore {
  constructor(private readonly db: Database.Database) {}

  hasMeta(key: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM token_usage_meta WHERE meta_key = ?")
      .get(key);
    return row !== undefined;
  }

  setMeta(key: string, value: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO token_usage_meta (meta_key, meta_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(meta_key) DO UPDATE SET
           meta_value = excluded.meta_value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  /** 幂等写入单次模型调用消耗；重复上报同一 sourceCallId 直接覆盖为最新终态。 */
  upsertRecord(input: StoredTokenUsageRecordInput): void {
    this.db
      .prepare(
        `INSERT INTO token_usage_records (
           source_call_id, local_date, occurred_at,
           role_id, role_name, resource_id, resource_name, provider,
           protocol, model_name, category, status, usage_reported,
           input_tokens, cached_tokens, cache_creation_tokens, output_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_call_id) DO UPDATE SET
           local_date = excluded.local_date,
           occurred_at = excluded.occurred_at,
           role_id = excluded.role_id,
           role_name = CASE WHEN excluded.role_name <> '' THEN excluded.role_name ELSE token_usage_records.role_name END,
           resource_id = excluded.resource_id,
           resource_name = CASE WHEN excluded.resource_name <> '' THEN excluded.resource_name ELSE token_usage_records.resource_name END,
           provider = COALESCE(excluded.provider, token_usage_records.provider),
           protocol = excluded.protocol,
           model_name = excluded.model_name,
           category = excluded.category,
           status = excluded.status,
           usage_reported = excluded.usage_reported,
           input_tokens = excluded.input_tokens,
           cached_tokens = excluded.cached_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens,
           output_tokens = excluded.output_tokens`,
      )
      .run(
        input.sourceCallId,
        input.localDate,
        input.occurredAt,
        input.roleId,
        input.roleName,
        input.resourceId,
        input.resourceName,
        input.provider,
        input.protocol,
        input.modelName,
        input.category,
        input.status,
        input.usageReported ? 1 : 0,
        sanitizeTokenBigInt(input.inputTokens),
        sanitizeTokenBigInt(input.cachedTokens),
        sanitizeTokenBigInt(input.cacheCreationTokens),
        sanitizeTokenBigInt(input.outputTokens),
      );
  }

  /**
   * 批量写入（用于首次升级回填）；已存在同 source_call_id 的记录不覆盖，确保幂等。
   */
  insertBackfillBatch(records: readonly StoredTokenUsageRecordInput[]): number {
    if (records.length === 0) {
      return 0;
    }
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO token_usage_records (
         source_call_id, local_date, occurred_at,
         role_id, role_name, resource_id, resource_name, provider,
         protocol, model_name, category, status, usage_reported,
         input_tokens, cached_tokens, cache_creation_tokens, output_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.db.transaction(() => {
      let inserted = 0;
      for (const item of records) {
        const res = stmt.run(
          item.sourceCallId,
          item.localDate,
          item.occurredAt,
          item.roleId,
          item.roleName,
          item.resourceId,
          item.resourceName,
          item.provider,
          item.protocol,
          item.modelName,
          item.category,
          item.status,
          item.usageReported ? 1 : 0,
          sanitizeTokenBigInt(item.inputTokens),
          sanitizeTokenBigInt(item.cachedTokens),
          sanitizeTokenBigInt(item.cacheCreationTokens),
          sanitizeTokenBigInt(item.outputTokens),
        );
        inserted += res.changes;
      }
      return inserted;
    })();
  }

  /**
   * 使用 safeIntegers(true) 按行流式读取并以 BigInt 累加，
   * 避免 SQLite SUM 64 位溢出以及 JS Number 53 位精度丢失。
   */
  querySummary(options: TokenUsageQueryOptions): TokenUsageSummaryView {
    const roleFilter = options.roleKey ?? null;
    const categoryFilter = options.category ?? null;
    const modelFilter = options.modelKey ?? null;

    const sql =
      options.startDate === null
        ? `SELECT local_date, role_id, role_name, resource_id, resource_name,
                  provider, protocol, model_name, category, status, usage_reported,
                  input_tokens, cached_tokens, cache_creation_tokens, output_tokens
             FROM token_usage_records
            ORDER BY local_date ASC, occurred_at ASC`
        : `SELECT local_date, role_id, role_name, resource_id, resource_name,
                  provider, protocol, model_name, category, status, usage_reported,
                  input_tokens, cached_tokens, cache_creation_tokens, output_tokens
             FROM token_usage_records
            WHERE local_date >= ? AND local_date <= ?
            ORDER BY local_date ASC, occurred_at ASC`;

    const stmt = this.db.prepare(sql).safeIntegers(true);
    const iterator = (
      options.startDate === null
        ? stmt.iterate()
        : stmt.iterate(options.startDate, options.endDate)
    ) as IterableIterator<RawUsageRow>;

    const totals = emptyAccumulator();
    const dailyMap = new Map<string, MutableAccumulator>();
    const roleMap = new Map<
      string,
      { roleId: string | null; roleName: string; deleted: boolean; acc: MutableAccumulator }
    >();
    const modelMap = new Map<
      string,
      {
        resourceId: string | null;
        resourceName: string;
        provider: string | null;
        protocol: string;
        modelName: string;
        deleted: boolean;
        acc: MutableAccumulator;
      }
    >();
    const categoryMap = new Map<TokenUsageCategory, MutableAccumulator>();
    for (const cat of TOKEN_USAGE_CATEGORIES) {
      categoryMap.set(cat, emptyAccumulator());
    }

    const availableRoles = new Map<string, TokenUsageFilterRoleOption>();
    const availableModels = new Map<string, TokenUsageFilterModelOption>();

    for (const row of iterator) {
      const roleKey = row.role_id ?? GLOBAL_USAGE_ROLE_KEY;
      const liveRoleName = row.role_id !== null ? options.liveRoles.get(row.role_id) : undefined;
      const roleDeleted = row.role_id !== null && liveRoleName === undefined;
      const resolvedRoleName =
        row.role_id === null
          ? "全局测试"
          : (liveRoleName ?? (row.role_name.trim() || "已删除角色"));

      const modelKey = buildTokenModelKey(row.resource_id, row.protocol, row.model_name);
      const liveResource =
        row.resource_id !== null ? options.liveResources.get(row.resource_id) : undefined;
      const resourceDeleted = row.resource_id !== null && liveResource === undefined;
      const resolvedResourceName =
        liveResource?.name ??
        (row.resource_name.trim() || (row.resource_id ? "已删除服务" : "未关联服务"));
      const resolvedProvider = liveResource?.provider ?? row.provider ?? null;

      const existingRoleFilter = availableRoles.get(roleKey);
      if (existingRoleFilter === undefined) {
        availableRoles.set(roleKey, {
          roleKey,
          roleId: row.role_id,
          roleName: resolvedRoleName,
          deleted: roleDeleted,
        });
      } else if (roleDeleted && row.role_name.trim()) {
        existingRoleFilter.roleName = row.role_name.trim();
      }
      const existingModelFilter = availableModels.get(modelKey);
      if (existingModelFilter === undefined) {
        availableModels.set(modelKey, {
          modelKey,
          resourceId: row.resource_id,
          resourceName: resolvedResourceName,
          modelName: row.model_name,
          deleted: resourceDeleted,
        });
      } else if (resourceDeleted && row.resource_name.trim()) {
        existingModelFilter.resourceName = row.resource_name.trim();
      }

      if (roleFilter !== null && roleKey !== roleFilter) continue;
      if (categoryFilter !== null && row.category !== categoryFilter) continue;
      if (modelFilter !== null && modelKey !== modelFilter) continue;

      addRow(totals, row);

      let dayAcc = dailyMap.get(row.local_date);
      if (dayAcc === undefined) {
        dayAcc = emptyAccumulator();
        dailyMap.set(row.local_date, dayAcc);
      }
      addRow(dayAcc, row);

      let roleEntry = roleMap.get(roleKey);
      if (roleEntry === undefined) {
        roleEntry = {
          roleId: row.role_id,
          roleName: resolvedRoleName,
          deleted: roleDeleted,
          acc: emptyAccumulator(),
        };
        roleMap.set(roleKey, roleEntry);
      } else if (roleDeleted && row.role_name.trim()) {
        roleEntry.roleName = row.role_name.trim();
      }
      addRow(roleEntry.acc, row);

      let modelEntry = modelMap.get(modelKey);
      if (modelEntry === undefined) {
        modelEntry = {
          resourceId: row.resource_id,
          resourceName: resolvedResourceName,
          provider: resolvedProvider,
          protocol: row.protocol,
          modelName: row.model_name,
          deleted: resourceDeleted,
          acc: emptyAccumulator(),
        };
        modelMap.set(modelKey, modelEntry);
      } else {
        if (resourceDeleted && row.resource_name.trim()) {
          modelEntry.resourceName = row.resource_name.trim();
        }
        if (resolvedProvider !== null) {
          modelEntry.provider = resolvedProvider;
        }
      }
      addRow(modelEntry.acc, row);

      const catAcc = categoryMap.get(row.category);
      if (catAcc !== undefined) {
        addRow(catAcc, row);
      }
    }

    let daily: TokenUsageDailyView[];
    if (options.startDate !== null) {
      daily = enumerateDates(options.startDate, options.endDate).map((date) => ({
        date,
        ...toTotalsView(dailyMap.get(date) ?? emptyAccumulator()),
      }));
    } else {
      daily = [...dailyMap.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, acc]) => ({
          date,
          ...toTotalsView(acc),
        }));
    }

    const byRole: TokenUsageRoleView[] = [...roleMap.entries()]
      .sort(([, a], [, b]) => {
        const diff = compareDescByVolume(a.acc, b.acc);
        return diff !== 0 ? diff : a.roleName.localeCompare(b.roleName, "zh-CN");
      })
      .map(([roleKey, entry]) => ({
        roleKey,
        roleId: entry.roleId,
        roleName: entry.roleName,
        deleted: entry.deleted,
        ...toTotalsView(entry.acc),
      }));

    const byModel: TokenUsageModelView[] = [...modelMap.entries()]
      .sort(([, a], [, b]) => {
        const diff = compareDescByVolume(a.acc, b.acc);
        return diff !== 0 ? diff : a.modelName.localeCompare(b.modelName, "en");
      })
      .map(([modelKey, entry]) => ({
        modelKey,
        resourceId: entry.resourceId,
        resourceName: entry.resourceName,
        provider: entry.provider,
        protocol: entry.protocol,
        modelName: entry.modelName,
        deleted: entry.deleted,
        ...toTotalsView(entry.acc),
      }));

    const byCategory: TokenUsageCategoryView[] = TOKEN_USAGE_CATEGORIES.map((category) => ({
      category,
      ...toTotalsView(categoryMap.get(category) ?? emptyAccumulator()),
    })).filter((row) => row.callCount !== "0");
    byCategory.sort((a, b) => {
      const totalA = BigInt(a.totalTokens);
      const totalB = BigInt(b.totalTokens);
      if (totalA !== totalB) return totalB > totalA ? 1 : -1;
      const callsA = BigInt(a.callCount);
      const callsB = BigInt(b.callCount);
      return callsB > callsA ? 1 : callsB < callsA ? -1 : 0;
    });

    return {
      range: options.range,
      startDate: options.startDate,
      endDate: options.endDate,
      appliedFilters: {
        roleKey: roleFilter,
        category: categoryFilter,
        modelKey: modelFilter,
      },
      totals: toTotalsView(totals),
      daily,
      byRole,
      byModel,
      byCategory,
      availableFilters: {
        roles: [...availableRoles.values()].sort((a, b) => {
          if (a.roleId === null && b.roleId !== null) return 1;
          if (a.roleId !== null && b.roleId === null) return -1;
          if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
          return a.roleName.localeCompare(b.roleName, "zh-CN");
        }),
        models: [...availableModels.values()].sort((a, b) =>
          `${a.resourceName}:${a.modelName}`.localeCompare(
            `${b.resourceName}:${b.modelName}`,
            "zh-CN",
          ),
        ),
      },
    };
  }
}
