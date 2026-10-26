import { parseWorldbook } from './schema.js';
import type { Worldbook, WorldbookEntry } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUPPORTED_ENTRY_FIELDS = new Set(['id', 'keys', 'content', 'enabled', 'constant', 'case_sensitive', 'insertion_order', 'position', 'selective', 'use_regex', 'extensions', 'comment', 'name', 'secondary_keys']);

function object(raw: unknown): raw is Record<string, unknown> { return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw)); }

/** Only the supported literal, nonrecursive subset is activated; the caller archives all originals. */
export function convertTavernWorldbook(raw: unknown): { worldbook?: Worldbook; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined) return { warnings };
  if (!object(raw) || !Array.isArray(raw.entries) || raw.entries.length > 200) return { warnings: ['世界书结构无效或超过200条，仅归档原文，未启用世界书。'] };
  if (raw.token_budget !== undefined) warnings.push('酒馆token_budget不等同于字符数；本次使用默认2000字符预算，原始预算仅归档。');
  if (Object.keys(raw).some(key => !['name', 'description', 'scan_depth', 'token_budget', 'recursive_scanning', 'extensions', 'entries'].includes(key))) warnings.push('世界书其他字段仅归档，未生效。');
  if (raw.recursive_scanning !== undefined && typeof raw.recursive_scanning !== 'boolean') return { warnings: [...warnings, '世界书recursive_scanning类型无效，仅归档原文，未启用世界书。'] };
  const recursive = raw.recursive_scanning === true;
  if (recursive) warnings.push('世界书请求了递归扫描，当前不支持；相关条目均已禁用，不会使用命中文本继续触发。');
  if (raw.extensions !== undefined && !object(raw.extensions)) return { warnings: [...warnings, '世界书extensions类型无效，仅归档原文，未启用世界书。'] };
  if (object(raw.extensions) && Object.keys(raw.extensions).length) warnings.push('世界书全局extensions仅归档，未生效。');
  const entries: Array<{ entry: WorldbookEntry; order: number }> = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < raw.entries.length; index++) {
    const source: unknown = raw.entries[index]; const label = `世界书第${index + 1}条`;
    if (!object(source)) { warnings.push(`${label}不是对象，已跳过并仅归档。`); continue; }
    const keys = source.keys === undefined ? [] : source.keys;
    if (!Array.isArray(keys) || keys.length > 32 || keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 256)
      || typeof source.content !== 'string' || source.content.length > 8192) { warnings.push(`${label}关键词或正文无效/超限，已跳过并仅归档。`); continue; }
    if (['enabled', 'constant', 'case_sensitive', 'selective', 'use_regex'].some(key => source[key] !== undefined && typeof source[key] !== 'boolean')) { warnings.push(`${label}布尔选项类型无效，已跳过并仅归档。`); continue; }
    const order = source.insertion_order === undefined ? index : source.insertion_order;
    if (typeof order !== 'number' || !Number.isFinite(order)) { warnings.push(`${label}insertion_order无效，已跳过并仅归档。`); continue; }
    const position = source.position === undefined ? 'after_char' : source.position;
    const unsupported: string[] = [];
    if (position !== 'before_char' && position !== 'after_char') unsupported.push('位置规则');
    if (source.selective === true) unsupported.push('selective次关键词规则');
    if (source.use_regex === true) unsupported.push('use_regex正则规则');
    if (recursive) unsupported.push('全局递归规则');
    if (source.extensions !== undefined && !object(source.extensions)) { warnings.push(`${label}extensions类型无效，已跳过并仅归档。`); continue; }
    const extension = object(source.extensions) ? source.extensions : {};
    const probabilityKeys = ['probability', 'use_probability', 'useProbability'];
    if (probabilityKeys.some(key => source[key] !== undefined || extension[key] !== undefined)) unsupported.push('概率规则');
    const recursiveKeys = ['recursive', 'recursive_scanning', 'exclude_recursion', 'prevent_recursion', 'delay_until_recursion'];
    if (recursiveKeys.some(key => (source[key] !== undefined && source[key] !== false) || (extension[key] !== undefined && extension[key] !== false))) unsupported.push('递归扩展');
    if (['position', 'depth', 'role', 'scan_depth'].some(key => extension[key] !== undefined) || source.depth !== undefined) unsupported.push('位置/深度扩展');
    if (Object.keys(extension).some(key => ![...probabilityKeys, ...recursiveKeys, 'position', 'depth', 'role', 'scan_depth'].includes(key))
      || Object.keys(source).some(key => !SUPPORTED_ENTRY_FIELDS.has(key) && ![...probabilityKeys, ...recursiveKeys, 'depth'].includes(key))) warnings.push(`${label}其他扩展仅归档，未生效。`);
    let id = typeof source.id === 'string' && ID.test(source.id) ? source.id
      : typeof source.id === 'number' && Number.isSafeInteger(source.id) ? `entry-${source.id < 0 ? `n${-source.id}` : source.id}` : `entry-${index + 1}`;
    if (source.id !== undefined && !(typeof source.id === 'string' && ID.test(source.id)) && !(typeof source.id === 'number' && Number.isSafeInteger(source.id))) warnings.push(`${label}源id无效，已生成安全id；原id仅归档。`);
    const base = id; let suffix = 1;
    while (usedIds.has(id)) { const tail = `-${++suffix}`; id = `${base.slice(0, 64 - tail.length)}${tail}`; }
    usedIds.add(id);
    const constant = source.constant === true;
    if (!constant && keys.length === 0) unsupported.push('缺少可匹配关键词');
    if (unsupported.length) warnings.push(`${label}包含不支持的${unsupported.join('、')}，已禁用；全部原文仅归档。`);
    entries.push({ order, entry: {
      id, keys: [...keys] as string[], content: source.content, enabled: source.enabled !== false && unsupported.length === 0,
      constant, caseSensitive: source.case_sensitive === true, priority: 0,
      position: position === 'before_char' ? 'before-role' : 'after-role'
    } });
  }
  // Preserve ascending insertion_order without clamping large source values into equal priorities.
  const ordered = [...new Set(entries.map(({ order }) => order))].sort((a, b) => a - b);
  for (const { entry, order } of entries) entry.priority = ordered.length - 1 - ordered.indexOf(order);
  try {
    const worldbook = parseWorldbook({ version: 1, ...(raw.name !== undefined ? { name: raw.name } : {}),
      scanDepth: raw.scan_depth, budgetChars: 2000, entries: entries.map(({ entry }) => entry) });
    return { worldbook, warnings };
  } catch {
    return { warnings: [...warnings, '世界书名称、扫描深度或总文本无效/超限，仅归档原文，未启用世界书。'] };
  }
}
