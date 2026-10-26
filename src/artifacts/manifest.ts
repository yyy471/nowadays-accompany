import path from 'node:path';
import { InvalidSpecError } from '../core/errors.js';
import type { ArtifactManifest } from './types.js';
import { parsePluginDeclarations } from '../extensions/contracts.js';
import { parseWorldbook } from '../worldbook/schema.js';
import { ARTIFACT_SEGMENT, RESERVED, isSafeArtifactSegment } from './segment.js';

export { ARTIFACT_SEGMENT } from './segment.js';
export const IMPORTED_ARTIFACT_MARKER = '.nowadays-imported';
export function assertArtifactSegment(value: unknown, label: string): asserts value is string {
  if (!isSafeArtifactSegment(value)) {
    throw new InvalidSpecError(`${label} 只能使用1至64位字母、数字、点、下划线或短横线，且必须是有效目录名。`);
  }
}

export function assertArtifactEntry(entry: unknown): asserts entry is string {
  if (typeof entry !== 'string' || !entry || path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)
    || entry.includes('\\') || entry.split('/').some(segment => !segment || segment === '.' || segment === '..'
      || /[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment) || RESERVED.test(segment))) {
    throw new InvalidSpecError('插件 entry 必须是制品内的安全相对文件路径，不能包含路径穿越。');
  }
}

/** Default preserves the catalog reader's historical minimal acceptance rules. */
export function parseArtifactManifest(raw: unknown, options: { strict?: boolean } = {}): ArtifactManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError('manifest.json 必须是制品对象。');
  const manifest = raw as Record<string, unknown>;
  if (typeof manifest.id !== 'string' || (manifest.kind !== 'plugin' && manifest.kind !== 'role-card' && manifest.kind !== 'worldbook') || typeof manifest.revision !== 'string') {
    throw new InvalidSpecError('manifest.json 必须声明 id、kind 和 revision。');
  }
  const declarationKeys = ['tools', 'hooks', 'skills', 'state'] as const;
  if (manifest.kind !== 'plugin' && declarationKeys.some(key => manifest[key] !== undefined)) {
    throw new InvalidSpecError('只有插件 manifest 可以声明 tools、hooks 或 skills。');
  }
  if (options.strict) {
    const allowed = new Set([
      'id',
      'kind',
      'revision',
      'name',
      'description',
      ...(manifest.kind === 'plugin'
        ? ['entry', 'apiVersion', ...declarationKeys]
        : manifest.kind === 'worldbook' ? ['worldbook'] : ['content', 'worldbook'])
    ]);
    const unknown = Object.keys(manifest).find(key => !allowed.has(key));
    if (unknown) throw new InvalidSpecError(`manifest.json 不支持字段 ${unknown}；请使用当前 manifest 制品格式。`);
    assertArtifactSegment(manifest.id, '制品 id'); assertArtifactSegment(manifest.revision, '制品 revision');
    for (const key of ['name', 'description']) {
      if (manifest[key] !== undefined && (typeof manifest[key] !== 'string' || (manifest[key] as string).length > 16384)) throw new InvalidSpecError(`manifest.${key} 必须是长度不超过16384的文本。`);
    }
    if (manifest.kind === 'plugin') {
      assertArtifactEntry(manifest.entry);
      if (manifest.apiVersion !== 1) throw new InvalidSpecError('插件 apiVersion 必须是当前支持的 1。');
    } else if (manifest.kind === 'worldbook') {
      if (manifest.worldbook === undefined) throw new InvalidSpecError('独立世界书制品必须包含 worldbook。');
    } else if (typeof manifest.content !== 'string' || !manifest.content.trim()) {
      throw new InvalidSpecError('角色卡 content 必须是非空文本；不支持直接导入酒馆JSON或PNG。');
    }
  }
  const parsed = manifest.kind === 'plugin' && declarationKeys.some(key => manifest[key] !== undefined)
    ? { ...manifest, ...parsePluginDeclarations(manifest, 'manifest.json') }
    : manifest;
  if ((manifest.kind === 'role-card' || manifest.kind === 'worldbook') && manifest.worldbook !== undefined) {
    return { ...parsed, worldbook: parseWorldbook(manifest.worldbook) } as unknown as ArtifactManifest;
  }
  return parsed as unknown as ArtifactManifest;
}
