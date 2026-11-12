export interface AppearanceImportFileEntry {
  relativePath: string;
  file: File | null;
}

export interface AppearanceImportEntry {
  id: string;
  name: string;
  source: "standees" | "legacy";
  standeeDir: string | null;
  expressionDir: string | null;
  home: File | null;
  homeCandidates: File[];
  sprites: File[];
  mergedFrom?: string[];
}

export interface AppearanceImportIssue {
  code: string;
  id?: string;
  detail?: string;
}

export interface AppearanceImportSkipped {
  path: string;
  reason: string;
}

export interface AppearanceScanResult {
  root: string;
  format: "standees" | "legacy" | "none";
  entries: AppearanceImportEntry[];
  suggestedMerges: Record<string, string>;
  skipped: AppearanceImportSkipped[];
  issues: AppearanceImportIssue[];
}

export interface AppearanceImportPlan extends AppearanceImportEntry {
  status: "ready" | "duplicate";
  missingHome: boolean;
  missingSprites: boolean;
  notes: string[];
}

export interface AppearancePlanSummary {
  total: number;
  ready: number;
  duplicate: number;
  missingHome: number;
  missingSprites: number;
  spriteCount: number;
}

export function scanAppearanceFolder(
  input: ReadonlyArray<AppearanceImportFileEntry | File>
): AppearanceScanResult;

export function mergeOutfitEntries(
  entries: readonly AppearanceImportEntry[],
  merges?: Record<string, string>
): AppearanceImportEntry[];

export function planOutfitImport(
  entries: readonly AppearanceImportEntry[],
  options?: { existingNames?: readonly string[] }
): AppearanceImportPlan[];

export function summarizeOutfitPlan(
  plans: readonly AppearanceImportPlan[]
): AppearancePlanSummary;
