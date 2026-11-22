import {
  classifyModelCallCategory,
  hasReportedUsage,
  parseStoredUsageJson,
  sanitizeTokenBigInt,
  type TokenUsageCallEvent,
  type TokenUsageCategory,
  type TokenUsageRange,
  type TokenUsageSummaryView,
} from "../../domain/token-usage.js";
import type { AppStore } from "../../storage/core/app-store.js";
import { localDateFromIso } from "../../storage/memory/evidence.js";
import {
  TokenUsageStore,
  type StoredTokenUsageRecordInput,
} from "../../storage/core/token-usage-store.js";
import type { RoleAccess } from "../role/role-access.js";

const BACKFILL_META_KEY = "backfill_v12_done";

export interface TokenUsageServiceOptions {
  now?: () => Date;
  timeZone?: string;
  listLiveRoles?: () => Array<{ roleId: string; displayName: string }>;
}

interface LegacyRoleModelCallRow {
  model_call_id: string;
  purpose: string;
  call_kind: string | null;
  resource_id: string | null;
  model_name: string;
  protocol: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  usage_json: string | null;
}

interface LegacyTestCallRow {
  test_call_id: string;
  resource_id: string | null;
  model_name: string;
  protocol: string;
  status: string;
  started_at: string;
  finished_at: string;
  usage_json: string | null;
}

function shiftLocalDate(dateText: string, deltaDays: number): string {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function resourceProviderOf(config: Record<string, unknown>): string | null {
  const provider = config.provider;
  return typeof provider === "string" && provider.trim().length > 0
    ? provider.trim()
    : null;
}

/**
 * 全局 Token 消耗记账与统计服务（DL-183）。
 * 账本持久化在 app.sqlite，角色或服务删除后历史消耗继续保留。
 */
export class TokenUsageService {
  private readonly store: TokenUsageStore;
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly listLiveRoles: () => Array<{ roleId: string; displayName: string }>;

  constructor(
    private readonly appStore: AppStore,
    private readonly roleAccess: RoleAccess,
    options: TokenUsageServiceOptions = {},
  ) {
    this.store = new TokenUsageStore(appStore.db);
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
    this.listLiveRoles = options.listLiveRoles ?? (() => this.readLiveRolesFallback());
  }

  /**
   * 写入单次模型调用消耗。
   * 记账失败不应阻断已完成的模型回复、记忆整理或配置测试。
   */
  recordCall(event: TokenUsageCallEvent): void {
    try {
      const occurredAt = event.occurredAt || this.now().toISOString();
      const localDate = this.safeLocalDate(occurredAt);
      const roleName =
        event.roleName?.trim() ||
        (event.roleId !== null ? this.resolveRoleName(event.roleId) : "");
      const resourceInfo =
        event.resourceId !== null ? this.resolveResourceInfo(event.resourceId) : null;
      const resourceName = event.resourceName?.trim() || resourceInfo?.name || "";
      const provider = event.provider ?? resourceInfo?.provider ?? null;
      const reported = hasReportedUsage(event.usage);
      this.store.upsertRecord({
        sourceCallId: event.sourceCallId,
        localDate,
        occurredAt,
        roleId: event.roleId,
        roleName,
        resourceId: event.resourceId,
        resourceName,
        provider,
        protocol: event.protocol,
        modelName: event.modelName,
        category: event.category,
        status: event.status,
        usageReported: reported,
        inputTokens: reported ? sanitizeTokenBigInt(event.usage?.inputTokens) : 0n,
        cachedTokens: reported ? sanitizeTokenBigInt(event.usage?.cachedTokens) : 0n,
        cacheCreationTokens: reported
          ? sanitizeTokenBigInt(event.usage?.cacheCreationTokens)
          : 0n,
        outputTokens: reported ? sanitizeTokenBigInt(event.usage?.outputTokens) : 0n,
      });
    } catch {
      // 记账异常隔离：不打断主业务链路。
    }
  }

  /**
   * 首次升级到 V12 时，一次性幂等回填本机已有存活角色的 model_calls 与全局 model_test_calls。
   * 完成后写入标记，避免后续经单角色迁移导入的历史记录重复计入本机账单。
   */
  backfillOnce(): { backfilled: number; skipped: boolean } {
    if (this.store.hasMeta(BACKFILL_META_KEY)) {
      return { backfilled: 0, skipped: true };
    }
    const resources = this.loadLiveResources();
    const records: StoredTokenUsageRecordInput[] = [];
    let allRolesReadable = true;

    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") {
        continue;
      }
      try {
        this.roleAccess.withStore(index.roleId, (storage) => {
          let roleName = "";
          try {
            roleName = storage.business.getRole(index.roleId).displayName;
          } catch {
            roleName = index.initPayload?.displayName ?? "";
          }
          const rows = storage.business.db
            .prepare(
              `SELECT model_call_id, purpose, call_kind, resource_id, model_name,
                      protocol, status, started_at, finished_at, usage_json
                 FROM model_calls
                WHERE role_id = ? AND status IN ('succeeded', 'failed', 'unknown')`,
            )
            .all(index.roleId) as LegacyRoleModelCallRow[];
          for (const row of rows) {
            const occurredAt = row.finished_at ?? row.started_at;
            const usage = parseStoredUsageJson(row.usage_json);
            const reported = usage !== null;
            const resource =
              row.resource_id !== null ? resources.get(row.resource_id) : undefined;
            records.push({
              sourceCallId: `role:${index.roleId}:${row.model_call_id}`,
              localDate: this.safeLocalDate(occurredAt),
              occurredAt,
              roleId: index.roleId,
              roleName,
              resourceId: row.resource_id,
              resourceName: resource?.name ?? "",
              provider: resource?.provider ?? null,
              protocol: row.protocol,
              modelName: row.model_name,
              category: classifyModelCallCategory(row.purpose, row.call_kind),
              status:
                row.status === "succeeded" || row.status === "failed"
                  ? row.status
                  : "unknown",
              usageReported: reported,
              inputTokens: reported ? sanitizeTokenBigInt(usage.inputTokens) : 0n,
              cachedTokens: reported ? sanitizeTokenBigInt(usage.cachedTokens) : 0n,
              cacheCreationTokens: reported
                ? sanitizeTokenBigInt(usage.cacheCreationTokens)
                : 0n,
              outputTokens: reported ? sanitizeTokenBigInt(usage.outputTokens) : 0n,
            });
          }
        });
      } catch {
        // 单个角色库暂时不可读时跳过，避免阻塞启动；留待下次补齐。
        allRolesReadable = false;
      }
    }

    const testRows = this.appStore.db
      .prepare(
        `SELECT test_call_id, resource_id, model_name, protocol, status,
                started_at, finished_at, usage_json
           FROM model_test_calls`,
      )
      .all() as LegacyTestCallRow[];
    for (const row of testRows) {
      const occurredAt = row.finished_at || row.started_at;
      const usage = parseStoredUsageJson(row.usage_json);
      const reported = usage !== null;
      const resource =
        row.resource_id !== null ? resources.get(row.resource_id) : undefined;
      records.push({
        sourceCallId: `test:${row.test_call_id}`,
        localDate: this.safeLocalDate(occurredAt),
        occurredAt,
        roleId: null,
        roleName: "",
        resourceId: row.resource_id,
        resourceName: resource?.name ?? "",
        provider: resource?.provider ?? null,
        protocol: row.protocol,
        modelName: row.model_name,
        category: "connection_test",
        status: row.status === "succeeded" ? "succeeded" : "failed",
        usageReported: reported,
        inputTokens: reported ? sanitizeTokenBigInt(usage.inputTokens) : 0n,
        cachedTokens: reported ? sanitizeTokenBigInt(usage.cachedTokens) : 0n,
        cacheCreationTokens: reported
          ? sanitizeTokenBigInt(usage.cacheCreationTokens)
          : 0n,
        outputTokens: reported ? sanitizeTokenBigInt(usage.outputTokens) : 0n,
      });
    }

    const inserted = this.store.insertBackfillBatch(records);
    if (allRolesReadable) {
      this.store.setMeta(BACKFILL_META_KEY, "1", this.now().toISOString());
    }
    return { backfilled: inserted, skipped: false };
  }

  getSummary(input: {
    range: TokenUsageRange;
    roleKey?: string | null;
    category?: TokenUsageCategory | null;
    modelKey?: string | null;
  }): TokenUsageSummaryView {
    const endDate = localDateFromIso(this.now().toISOString(), this.timeZone);
    const startDate =
      input.range === "today"
        ? endDate
        : input.range === "7d"
          ? shiftLocalDate(endDate, -6)
          : input.range === "30d"
            ? shiftLocalDate(endDate, -29)
            : null;
    const liveRoles = new Map<string, string>();
    for (const role of this.listLiveRoles()) {
      liveRoles.set(role.roleId, role.displayName);
    }
    const liveResources = this.loadLiveResources();
    return this.store.querySummary({
      range: input.range,
      startDate,
      endDate,
      ...(input.roleKey === undefined ? {} : { roleKey: input.roleKey }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.modelKey === undefined ? {} : { modelKey: input.modelKey }),
      liveRoles,
      liveResources,
    });
  }

  private safeLocalDate(iso: string): string {
    try {
      return localDateFromIso(iso, this.timeZone);
    } catch {
      return localDateFromIso(this.now().toISOString(), this.timeZone);
    }
  }

  private resolveRoleName(roleId: string): string {
    try {
      return this.roleAccess.withStore(roleId, (storage) =>
        storage.business.getRole(roleId).displayName,
      );
    } catch {
      const index = this.appStore.getRoleIndex(roleId);
      return index?.initPayload?.displayName ?? "";
    }
  }

  private resolveResourceInfo(
    resourceId: string,
  ): { name: string; provider: string | null } | null {
    // getResource 在服务已删除时会抛错；调用晚于删除到达时仍须保留本次消耗，
    // 因此这里把「查不到服务」收敛为 null，而不是让整条记账被外层 catch 丢弃。
    try {
      const record = this.appStore.getResource(resourceId);
      return {
        name: record.name,
        provider: resourceProviderOf(record.config),
      };
    } catch {
      return null;
    }
  }

  private loadLiveResources(): Map<string, { name: string; provider: string | null }> {
    const map = new Map<string, { name: string; provider: string | null }>();
    for (const resource of this.appStore.listResources("model")) {
      map.set(resource.resourceId, {
        name: resource.name,
        provider: resourceProviderOf(resource.config),
      });
    }
    return map;
  }

  private readLiveRolesFallback(): Array<{ roleId: string; displayName: string }> {
    const result: Array<{ roleId: string; displayName: string }> = [];
    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") continue;
      result.push({
        roleId: index.roleId,
        displayName: this.resolveRoleName(index.roleId) || index.initPayload?.displayName || index.roleId,
      });
    }
    return result;
  }
}
