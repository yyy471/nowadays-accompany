/**
 * 角色素材文件夹的目录识别与导入计划。
 *
 * 只处理路径字符串，不读文件内容、不碰 DOM，便于在 node:test 里直接覆盖目录结构。
 * 新素材库：`standees/<服饰标识>/` 为主页立绘，`expressions/<服饰标识>/` 为对话差分。
 * 旧格式：`outfits/<服饰名>/home.*` 与 `outfits/<服饰名>/sprites/`。
 */

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

/**
 * @param {Array<{ relativePath?: string, file?: unknown, webkitRelativePath?: string, name?: string }>} input
 * @returns {{
 *   root: string,
 *   format: "standees" | "legacy" | "none",
 *   entries: AppearanceImportEntry[],
 *   skipped: Array<{ path: string, reason: string }>,
 *   issues: Array<{ code: string, id?: string, detail?: string }>
 * }}
 */
export function scanAppearanceFolder(input) {
  const files = normalizeInput(input);
  const skipped = [];
  const issues = [];
  const layout = detectLayout(files);

  if (layout.format === "none") {
    return {
      root: "",
      format: "none",
      entries: [],
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

  const standees = new Map();
  const expressions = new Map();
  const legacy = new Map();

  for (const { relativePath, file } of files) {
    const parts = segmentsOf(relativePath);
    if (parts.length === 0) continue;
    if (parts.some(isHiddenSegment)) {
      skipped.push({ path: relativePath, reason: HIDDEN_REASON });
      continue;
    }

    const fileName = parts[parts.length - 1];
    const extension = extensionOf(fileName);
    const standeeIndex = parts.indexOf(STANDEE_DIR);
    const expressionIndex = parts.indexOf(EXPRESSION_DIR);
    const outfitsIndex = parts.indexOf(LEGACY_DIR);

    if (layout.format === "standees") {
      // 新素材库里的 outfits 放的是用户自行生图用的服饰锚点，不进入素材库。
      if (standeeIndex < 0 && expressionIndex < 0) {
        skipped.push({
          path: relativePath,
          reason: outfitsIndex >= 0 ? OUTFITS_SKIPPED_REASON : OUTSIDE_SOURCE_REASON
        });
        continue;
      }
      const reason = rejectReason(extension);
      if (reason !== null) {
        skipped.push({ path: relativePath, reason });
        continue;
      }
      const index = standeeIndex >= 0 ? standeeIndex : expressionIndex;
      const id = parts[index + 1];
      if (!id || index + 1 >= parts.length - 1) {
        skipped.push({ path: relativePath, reason: UNRECOGNIZED_REASON });
        continue;
      }
      const target = standeeIndex >= 0 ? standees : expressions;
      pushTo(target, id, file);
      continue;
    }

    if (outfitsIndex < 0) {
      skipped.push({ path: relativePath, reason: OUTSIDE_SOURCE_REASON });
      continue;
    }
    const reason = rejectReason(extension);
    if (reason !== null) {
      skipped.push({ path: relativePath, reason });
      continue;
    }
    const name = parts[outfitsIndex + 1];
    const rest = parts.slice(outfitsIndex + 2);
    if (!name || rest.length === 0) {
      skipped.push({ path: relativePath, reason: UNRECOGNIZED_REASON });
      continue;
    }
    const group = legacy.get(name) ?? { home: [], sprites: [] };
    if (rest.length === 1 && /^home\.[^.]+$/i.test(rest[0])) {
      group.home.push(file);
    } else if (rest[0] === LEGACY_SPRITE_DIR && rest.length >= 2) {
      group.sprites.push(file);
    } else {
      skipped.push({ path: relativePath, reason: UNRECOGNIZED_REASON });
      continue;
    }
    legacy.set(name, group);
  }

  const entries = [];
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
    const group = legacy.get(name);
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
    root: layout.roots[0] ?? "",
    format: layout.format,
    entries,
    skipped,
    issues
  };
}

/**
 * 把 `from` 条目的素材并入 `to` 条目。用于主页立绘与差分目录不同名的服饰。
 *
 * @param {AppearanceImportEntry[]} entries
 * @param {Record<string, string>} merges 形如 `{ "06_white_knit": "06_white_knit_barelegs" }`
 * @returns {AppearanceImportEntry[]}
 */
export function mergeOutfitEntries(entries, merges) {
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

/**
 * 判定每套服饰能否直接导入，并标出重名与缺项。
 *
 * @param {AppearanceImportEntry[]} entries
 * @param {{ existingNames?: string[] }} [options]
 * @returns {AppearanceImportPlan[]}
 */
export function planOutfitImport(entries, options = {}) {
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
    const notes = [];
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

/**
 * @param {AppearanceImportPlan[]} plans
 * @returns {{ total: number, ready: number, duplicate: number, missingHome: number, missingSprites: number, spriteCount: number }}
 */
export function summarizeOutfitPlan(plans) {
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

function createEntry({ id, source, standeeDir, expressionDir, homeCandidates, sprites }) {
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

function detectLayout(files) {
  const roots = new Set();
  let format = "none";
  for (const { relativePath } of files) {
    const parts = segmentsOf(relativePath);
    if (parts.some(isHiddenSegment)) continue;
    const standeeIndex = parts.indexOf(STANDEE_DIR);
    const expressionIndex = parts.indexOf(EXPRESSION_DIR);
    if (standeeIndex >= 0 || expressionIndex >= 0) {
      const index = standeeIndex >= 0 ? standeeIndex : expressionIndex;
      // 目录本身（没有服饰标识段）不算素材目录。
      if (index + 1 > parts.length - 1) continue;
      format = "standees";
      roots.add(parts.slice(0, index).join("/"));
    }
  }
  if (format === "standees") {
    return { format, roots: [...roots] };
  }
  for (const { relativePath } of files) {
    const parts = segmentsOf(relativePath);
    if (parts.some(isHiddenSegment)) continue;
    const outfitsIndex = parts.indexOf(LEGACY_DIR);
    if (outfitsIndex < 0) continue;
    format = "legacy";
    roots.add(parts.slice(0, outfitsIndex).join("/"));
  }
  return { format, roots: [...roots] };
}

function normalizeInput(input) {
  const list = Array.isArray(input) ? input : [];
  const normalized = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item === "object" && typeof item.relativePath === "string") {
      if (item.relativePath.length === 0) continue;
      normalized.push({ relativePath: item.relativePath, file: item.file ?? null });
      continue;
    }
    const relativePath =
      typeof item.webkitRelativePath === "string" && item.webkitRelativePath.length > 0
        ? item.webkitRelativePath
        : typeof item.name === "string"
          ? item.name
          : "";
    if (relativePath.length === 0) continue;
    normalized.push({ relativePath, file: item });
  }
  return normalized;
}

function segmentsOf(relativePath) {
  return String(relativePath)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0);
}

function isHiddenSegment(part) {
  return part.startsWith(".");
}

function extensionOf(fileName) {
  const index = fileName.lastIndexOf(".");
  return index < 0 ? "" : fileName.slice(index).toLowerCase();
}

function rejectReason(extension) {
  if (IMAGE_EXTENSIONS.has(extension)) return null;
  if (DOCUMENT_EXTENSIONS.has(extension)) return DOCUMENT_REASON;
  return NOT_IMAGE_REASON;
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function sortFiles(files) {
  return [...files].sort((left, right) =>
    nameOf(left).localeCompare(nameOf(right), "zh-Hans-CN", { numeric: true })
  );
}

function dedupeFiles(files) {
  const seen = new Set();
  const result = [];
  for (const file of files) {
    const name = nameOf(file);
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(file);
  }
  return sortFiles(result);
}

function nameOf(file) {
  const path = file?.name ?? file?.relativePath ?? "";
  const parts = segmentsOf(path);
  return parts[parts.length - 1] ?? "";
}

function compareIdentifiers(left, right) {
  return String(left).localeCompare(String(right), "zh-Hans-CN", { numeric: true });
}

/**
 * @typedef {Object} AppearanceImportEntry
 * @property {string} id
 * @property {string} name
 * @property {"standees" | "legacy"} source
 * @property {string | null} standeeDir
 * @property {string | null} expressionDir
 * @property {unknown} home
 * @property {unknown[]} homeCandidates
 * @property {unknown[]} sprites
 * @property {string[]} [mergedFrom]
 */

/**
 * @typedef {AppearanceImportEntry & {
 *   status: "ready" | "duplicate",
 *   missingHome: boolean,
 *   missingSprites: boolean,
 *   notes: string[]
 * }} AppearanceImportPlan
 */
