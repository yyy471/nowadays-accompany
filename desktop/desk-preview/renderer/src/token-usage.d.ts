export type TokenUsageRange = "today" | "7d" | "30d" | "all";

export type TokenUsageCategory =
  | "dialogue"
  | "autonomy"
  | "memory"
  | "annotation"
  | "scene_plan"
  | "anchor_prompt"
  | "connection_test";

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

export const TOKEN_USAGE_RANGES: ReadonlyArray<{ id: TokenUsageRange; label: string }>;
export const TOKEN_CATEGORY_LABELS: Readonly<Record<TokenUsageCategory, string>>;

export function categoryLabel(category: string): string;
export function parseTokenBigInt(value: string | number | bigint | null | undefined): bigint;
export function formatExactTokenCount(value: string | number | bigint | null | undefined): string;
export function formatTokenCount(value: string | number | bigint | null | undefined): string;
export function formatCacheHitRate(
  cached: string | number | bigint | null | undefined,
  input: string | number | bigint | null | undefined,
): string;
export function sharePercent(
  part: string | number | bigint | null | undefined,
  max: string | number | bigint | null | undefined,
): number;
export function buildTokenUsageQuery(filters?: {
  range?: TokenUsageRange;
  roleKey?: string | null;
  category?: TokenUsageCategory | null;
  modelKey?: string | null;
}): string;
