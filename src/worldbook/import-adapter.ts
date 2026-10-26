import { parseArtifactManifest } from '../artifacts/manifest.js';
import { parseWorldbook } from './schema.js';
import { convertTavernWorldbook } from './tavern.js';
import type { WorldbookImportResult } from './types.js';

function isObject(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseNative(raw: unknown): WorldbookImportResult {
  try {
    return { detectedFormat: 'native', worldbook: parseWorldbook(raw), warnings: [] };
  } catch (error) {
    return { detectedFormat: 'native', warnings: [`原生世界书结构无效：${errorMessage(error)}`] };
  }
}

/**
 * Object-form entries (`{ "0": {...}, "7": {...} }`) are ordered by explicit numeric keys when
 * all keys are non-negative integers, otherwise by a stable lexicographic order. An opaque
 * enumeration order is never trusted, matching the tavern array semantics.
 */
function normalizeEntriesObject(entries: Record<string, unknown>): { array: unknown[]; warnings: string[] } {
  const keys = Object.keys(entries);
  const warnings: string[] = [];
  const allNumeric = keys.length > 0 && keys.every((key) => /^(0|[1-9]\d*)$/.test(key));
  if (!allNumeric) warnings.push('独立世界书条目键不是连续数字编号，已按稳定字典序转换，可能与原显示顺序不同。');
  const ordered = allNumeric ? [...keys].sort((left, right) => Number(left) - Number(right)) : [...keys].sort();
  return { array: ordered.map((key) => {
    const value = entries[key];
    return isObject(value) && value.id === undefined ? { ...value, id: key } : value;
  }), warnings };
}

/** Detect and convert a standalone worldbook JSON into the shared Worldbook schema. Never guesses role cards. */
export function convertWorldbookImport(raw: unknown): WorldbookImportResult {
  if (!isObject(raw)) return { detectedFormat: 'unknown', warnings: ['世界书导入内容必须是JSON对象。'] };

  if (raw.kind === 'worldbook') {
    try {
      const manifest = parseArtifactManifest(raw, { strict: true });
      return { detectedFormat: 'native', worldbook: manifest.worldbook, warnings: [] };
    } catch (error) {
      return { detectedFormat: 'native', warnings: [`原生世界书manifest无效：${errorMessage(error)}`] };
    }
  }

  if (raw.version === 1 && Array.isArray(raw.entries)) return parseNative(raw);
  if (raw.version !== undefined && raw.version !== 1) return { detectedFormat: 'unknown', warnings: ['世界书version不为1，格式无法识别。'] };

  if (raw.entries !== undefined) {
    if (Array.isArray(raw.entries)) {
      const { worldbook, warnings } = convertTavernWorldbook(raw);
      return { detectedFormat: 'tavern-array', ...(worldbook ? { worldbook } : {}), warnings };
    }
    if (isObject(raw.entries)) {
      const normalized = normalizeEntriesObject(raw.entries);
      const { worldbook, warnings } = convertTavernWorldbook({ ...raw, entries: normalized.array });
      return { detectedFormat: 'tavern-object', ...(worldbook ? { worldbook } : {}), warnings: [...normalized.warnings, ...warnings] };
    }
    return { detectedFormat: 'unknown', warnings: ['世界书entries格式无法识别，既不是数组也不是对象。'] };
  }

  return { detectedFormat: 'unknown', warnings: ['世界书JSON缺少entries，无法识别格式；角色卡请使用角色卡导入。'] };
}
