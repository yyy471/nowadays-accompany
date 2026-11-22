/**
 * 角色素材文件夹的目录识别与导入计划。
 *
 * 只处理路径字符串，不读文件内容、不碰 DOM，便于在 node:test 里直接覆盖目录结构。
 * 新素材库：`standees/<服饰标识>/` 为主页立绘，`expressions/<服饰标识>/` 为对话差分。
 * 旧格式：`outfits/<服饰名>/home.*` 与 `outfits/<服饰名>/sprites/`。
 */

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

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".html",
  ".htm",
  ".csv",
  ".pdf"
]);

const STANDEE_DIR = "standees";
const EXPRESSION_DIR = "expressions";
const LEGACY_DIR = "outfits";
const LEGACY_SPRITE_DIR = "sprites";

const HIDDEN_REASON = "HIDDEN";
const DOCUMENT_REASON = "DOCUMENT";
const NOT_IMAGE_REASON = "NOT_IMAGE";
const OUTFITS_SKIPPED_REASON = "OUTFITS_SKIPPED";
const OUTSIDE_SOURCE_REASON = "OUTSIDE_SOURCE";
const UNRECOGNIZED_REASON = "UNRECOGNIZED";

interface NormalizedInputFile {
  relativePath: string;
  file: File | null;
}

export function scanAppearanceFolder(
  input: ReadonlyArray<AppearanceImportFileEntry | File>
): AppearanceScanResult {
  const files = normalizeInput(input);
  const skipped: AppearanceImportSkipped[] = [];
  const issues: AppearanceImportIssue[] = [];
  const layout = detectLayout(files);

  if (layout.format === "none") {
    return {
      root: "",
      format: "none",
      entries: [],
      suggestedMerges: {},
      skipped,
      issues: [{ code: "NO_OUTFITS" }]
    };
  }

  if (layout.roots.length > 1) {
    issues.push({
      code: "MULTIPLE_ROOTS",
      detail: layout.roots.join("、")
    });
  }

  const standees = new Map<string, File[]>();
  const expressions = new Map<string, File[]>();
  const legacy = new Map<string, { home: File[]; sprites: File[] }>();
  const root = layout.roots[0];
  const sourceIndex = root === "" ? 0 : 1;

  for (const { relativePath, file } of files) {
    const parts = segmentsOf(relativePath);
    if (parts.length === 0) continue;
    if (parts.some(isHiddenSegment)) {
      skipped.push({ path: relativePath, reason: HIDDEN_REASON });
      continue;
    }

    const fileName = parts[parts.length - 1];
    const extension = extensionOf(fileName);
    const source = sourceIndex === 0 || parts[0] === root ? parts[sourceIndex] : undefined;

    if (layout.format === "standees") {
      // 新素材库里的 outfits 放的是用户自行生图用的服饰锚点，不进入素材库。
      if (source !== STANDEE_DIR && source !== EXPRESSION_DIR) {
        skipped.push({
          path: relativePath,
          reason: source === LEGACY_DIR ? OUTFITS_SKIPPED_REASON : OUTSIDE_SOURCE_REASON
        });
        continue;
      }
      const reason = rejectReason(extension);
      if (reason !== null) {
        skipped.push({ path: relativePath, reason });
        continue;
      }
      const id = parts[sourceIndex + 1];
      if (!id || sourceIndex + 1 >= parts.length - 1) {
        skipped.push({ path: relativePath, reason: UNRECOGNIZED_REASON });
        continue;
      }
      if (file) {
        const target = source === STANDEE_DIR ? standees : expressions;
        pushTo(target, id, file);
      }
      continue;
    }

    if (source !== LEGACY_DIR) {
      skipped.push({ path: relativePath, reason: OUTSIDE_SOURCE_REASON });
      continue;
    }
    const reason = rejectReason(extension);
    if (reason !== null) {
      skipped.push({ path: relativePath, reason });
      continue;
    }
    const name = parts[sourceIndex + 1];
    const rest = parts.slice(sourceIndex + 2);
    if (!name || rest.length === 0) {
      skipped.push({ path: relativePath, reason: UNRECOGNIZED_REASON });
      continue;
    }
    const group = legacy.get(name) ?? { home: [], sprites: [] };
    if (rest.length === 1 && /^home\.[^.]+$/i.test(rest[0])) {
      if (file) group.home.push(file);
    } else if (rest[0] === LEGACY_SPRITE_DIR && rest.length >= 2) {
      if (file) group.sprites.push(file);
    } else {
      skipped.push({ path: relativePath, reason: UNRECOGNIZED_REASON });
      continue;
    }
    legacy.set(name, group);
  }

  const entries: AppearanceImportEntry[] = [];
  const newIds = new Set([...standees.keys(), ...expressions.keys()]);
  for (const id of [...newIds].sort(compareIdentifiers)) {
    const homeCandidates = sortFiles(standees.get(id) ?? []);
    const sprites = sortFiles(expressions.get(id) ?? []);
    entries.push(
      createEntry({
        id,
        source: "standees",
        standeeDir: standees.has(id) ? id : null,
        expressionDir: expressions.has(id) ? id : null,
        homeCandidates,
        sprites
      })
    );
    if (homeCandidates.length > 1) {
      issues.push({ code: "MULTIPLE_HOME_CANDIDATES", id });
    }
  }
  for (const name of [...legacy.keys()].sort(compareIdentifiers)) {
    const group = legacy.get(name)!;
    const homeCandidates = sortFiles(group.home);
    entries.push(
      createEntry({
        id: name,
        source: "legacy",
        standeeDir: null,
        expressionDir: null,
        homeCandidates,
        sprites: sortFiles(group.sprites)
      })
    );
    if (homeCandidates.length > 1) {
      issues.push({ code: "MULTIPLE_HOME_CANDIDATES", id: name });
    }
  }

  if (entries.length === 0) {
    issues.push({ code: "NO_OUTFITS" });
  }

  return {
    root,
    format: layout.format,
    entries,
    suggestedMerges: suggestOutfitMerges(standees, expressions),
    skipped,
    issues
  };
}

/** 把 `from` 条目的素材并入 `to` 条目。用于主页立绘与差分目录不同名的服饰。 */
export function mergeOutfitEntries(
  entries: readonly AppearanceImportEntry[],
  merges?: Record<string, string>
): AppearanceImportEntry[] {
  const mapping = merges ?? {};
  const result = entries
    .filter((entry) => !Object.prototype.hasOwnProperty.call(mapping, entry.id))
    .map((entry) => ({ ...entry }));

  for (const [fromId, toId] of Object.entries(mapping)) {
    const from = entries.find((entry) => entry.id === fromId);
    const to = result.find((entry) => entry.id === toId);
    if (from === undefined || to === undefined) continue;
    const homeCandidates = dedupeFiles([...to.homeCandidates, ...from.homeCandidates]);
    const sprites = dedupeFiles([...to.sprites, ...from.sprites]);
    to.homeCandidates = homeCandidates;
    to.home = homeCandidates[0] ?? null;
    to.sprites = sprites;
    to.standeeDir = to.standeeDir ?? from.standeeDir;
    to.expressionDir = to.expressionDir ?? from.expressionDir;
    to.mergedFrom = [...(to.mergedFrom ?? []), fromId];
  }

  return result;
}

/** 判定每套服饰能否直接导入，并标出重名与缺项。 */
export function planOutfitImport(
  entries: readonly AppearanceImportEntry[],
  options: { existingNames?: readonly string[] } = {}
): AppearanceImportPlan[] {
  const existing = new Set(
    (options.existingNames ?? [])
      .map((name) => String(name).trim())
      .filter((name) => name.length > 0)
  );
  return entries.map((entry) => {
    const name = String(entry.name ?? entry.id).trim() || entry.id;
    const missingHome = entry.home === null || entry.home === undefined;
    const missingSprites = entry.sprites.length === 0;
    const duplicate = existing.has(name);
    const notes: string[] = [];
    if (duplicate) {
      notes.push("已存在同名服饰，导入时会跳过");
    }
    if (missingHome) {
      notes.push("没有主页立绘");
    }
    if (missingSprites) {
      notes.push("没有对话差分，可稍后单张补图");
    }
    if (entry.mergedFrom !== undefined && entry.mergedFrom.length > 0) {
      notes.push(`已归并 ${entry.mergedFrom.join("、")}`);
    }
    return {
      ...entry,
      name,
      status: duplicate ? "duplicate" : "ready",
      missingHome,
      missingSprites,
      notes
    };
  });
}

export function summarizeOutfitPlan(
  plans: readonly AppearanceImportPlan[]
): AppearancePlanSummary {
  return plans.reduce(
    (summary, plan) => {
      summary.total += 1;
      if (plan.status === "duplicate") summary.duplicate += 1;
      else summary.ready += 1;
      if (plan.missingHome) summary.missingHome += 1;
      if (plan.missingSprites) summary.missingSprites += 1;
      summary.spriteCount += plan.sprites.length;
      return summary;
    },
    { total: 0, ready: 0, duplicate: 0, missingHome: 0, missingSprites: 0, spriteCount: 0 }
  );
}

/**
 * 把本轮已经确认上传成功的套标成不可重试，即使列表刷新失败拿不到新名称。
 * 重试时只会提交仍未成功的套（283 §5 R09）。
 */
export function markImportedPlans(
  plans: readonly AppearanceImportPlan[],
  importedIds: Record<string, boolean>
): AppearanceImportPlan[] {
  const imported = importedIds ?? {};
  return plans.map((plan) =>
    imported[plan.id]
      ? {
          ...plan,
          status: "duplicate",
          notes: [...plan.notes, "本次已导入"],
        }
      : plan
  );
}

function createEntry({
  id,
  source,
  standeeDir,
  expressionDir,
  homeCandidates,
  sprites,
}: {
  id: string;
  source: "standees" | "legacy";
  standeeDir: string | null;
  expressionDir: string | null;
  homeCandidates: File[];
  sprites: File[];
}): AppearanceImportEntry {
  return {
    id,
    name: id,
    source,
    standeeDir,
    expressionDir,
    home: homeCandidates[0] ?? null,
    homeCandidates,
    sprites
  };
}

function detectLayout(files: NormalizedInputFile[]): { format: "standees" | "legacy" | "none"; roots: string[] } {
  const paths = files.map(({ relativePath }) => segmentsOf(relativePath))
    .filter((parts) => !parts.some(isHiddenSegment));
  // 浏览器相对路径带一层角色目录，同时接受已去掉角色目录的路径。
  for (const sourceIndex of [1, 0]) {
    const modernRoots = new Set<string>();
    const legacyRoots = new Set<string>();
    for (const parts of paths) {
      if (parts.length < sourceIndex + 2) continue;
      const root = sourceIndex === 0 ? "" : parts[0];
      const source = parts[sourceIndex];
      if (source === STANDEE_DIR || source === EXPRESSION_DIR) modernRoots.add(root);
      if (source === LEGACY_DIR) legacyRoots.add(root);
    }
    if (modernRoots.size > 0) return { format: "standees", roots: [...modernRoots] };
    if (legacyRoots.size > 0) return { format: "legacy", roots: [...legacyRoots] };
  }
  return { format: "none", roots: [] };
}

function groupOutfitDirectoriesByNumber(directories: Map<string, File[]>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const id of directories.keys()) {
    const number = /^(\d+)[_-]/.exec(id)?.[1];
    if (number !== undefined) pushTo(groups, number, id);
  }
  return groups;
}

function suggestOutfitMerges(standees: Map<string, File[]>, expressions: Map<string, File[]>): Record<string, string> {
  const standeeGroups = groupOutfitDirectoriesByNumber(standees);
  const expressionGroups = groupOutfitDirectoriesByNumber(expressions);
  const merges: Record<string, string> = {};
  for (const [number, standeeIds] of standeeGroups) {
    const expressionIds = expressionGroups.get(number);
    if (standeeIds.length !== 1 || expressionIds?.length !== 1) continue;
    const [standee] = standeeIds;
    const [expression] = expressionIds;
    if (["_", "-"].some((separator) =>
      standee.startsWith(expression + separator) || expression.startsWith(standee + separator)
    )) {
      merges[expression] = standee;
    }
  }
  return merges;
}

function normalizeInput(input: ReadonlyArray<AppearanceImportFileEntry | File>): NormalizedInputFile[] {
  const list = Array.isArray(input) ? input : [];
  const normalized: NormalizedInputFile[] = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if ("relativePath" in item && typeof item.relativePath === "string") {
      if (item.relativePath.length === 0) continue;
      normalized.push({ relativePath: item.relativePath, file: item.file ?? null });
      continue;
    }
    const file = item as File & { relativePath?: string };
    const relativePath =
      typeof file.webkitRelativePath === "string" && file.webkitRelativePath.length > 0
        ? file.webkitRelativePath
        : typeof file.name === "string"
          ? file.name
          : "";
    if (relativePath.length === 0) continue;
    normalized.push({ relativePath, file });
  }
  return normalized;
}

function segmentsOf(relativePath: string): string[] {
  return String(relativePath)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0);
}

function isHiddenSegment(part: string): boolean {
  return part.startsWith(".");
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index < 0 ? "" : fileName.slice(index).toLowerCase();
}

function rejectReason(extension: string): string | null {
  if (IMAGE_EXTENSIONS.has(extension)) return null;
  if (DOCUMENT_EXTENSIONS.has(extension)) return DOCUMENT_REASON;
  return NOT_IMAGE_REASON;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function sortFiles(files: File[]): File[] {
  return [...files].sort((left, right) =>
    nameOf(left).localeCompare(nameOf(right), "zh-Hans-CN", { numeric: true })
  );
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const result: File[] = [];
  for (const file of files) {
    const name = nameOf(file);
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(file);
  }
  return sortFiles(result);
}

function nameOf(file: File & { relativePath?: string }): string {
  const path = file?.name ?? file?.relativePath ?? "";
  const parts = segmentsOf(path);
  return parts[parts.length - 1] ?? "";
}

function compareIdentifiers(left: string, right: string): number {
  return String(left).localeCompare(String(right), "zh-Hans-CN", { numeric: true });
}
