import { publishArtifactRevision } from '../../artifacts/publish.js';
import { assertNoLinks, readFileBounded, ensureDirectories } from '../../artifacts/source-file.js';
export { readArtifactSourceFile } from '../../artifacts/source-file.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InvalidSpecError } from '../../core/errors.js';
import { assertArtifactEntry, IMPORTED_ARTIFACT_MARKER, parseArtifactManifest } from '../../artifacts/manifest.js';
import type { ArtifactKind, ArtifactManifest } from '../../artifacts/types.js';

/** Directory import handles only plugin/role-card; worldbook resources use their own commit endpoint. */
type ImportArtifactKind = Extract<ArtifactKind, 'plugin' | 'role-card'>;

export interface ArtifactImportPreview {
  kind: ImportArtifactKind; id: string; revision: string; name?: string;
  fileCount: number; bytes: number; targetPath: string; fingerprint: string;
}
export interface ArtifactImportLimits {
  maxFiles: number; maxEntries: number; maxFileBytes: number; maxTotalBytes: number; maxDepth: number;
}
const DEFAULT_LIMITS: ArtifactImportLimits = { maxFiles: 1000, maxEntries: 2000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxDepth: 16 };
type Entry = { relative: string; directory: boolean; bytes: number; digest?: string };
type Scan = { manifest: ArtifactManifest; entries: Entry[]; fileCount: number; bytes: number; fingerprint: string };

/** Directory import is an internal application use case, independent of catalog/deployment. */
export class ArtifactImportService {
  readonly #root: string;
  readonly #limits: ArtifactImportLimits;
  constructor(options: { publicRoot: string; limits?: Partial<ArtifactImportLimits> }) {
    this.#root = path.resolve(options.publicRoot);
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (Object.values(this.#limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new InvalidSpecError('制品导入限制必须为正整数。');
  }
  async preview(sourceDirectory: string): Promise<ArtifactImportPreview> {
    const scan = await this.#scan(path.resolve(sourceDirectory));
    const preview = this.#preview(scan);
    await this.#checkDestination(preview.targetPath);
    return preview;
  }
  async import(sourceDirectory: string, options: { expectedFingerprint?: string } = {}): Promise<ArtifactImportPreview> {
    const source = path.resolve(sourceDirectory);
    const scan = await this.#scan(source);
    const preview = this.#preview(scan);
    if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== scan.fingerprint) throw new InvalidSpecError('所选制品内容已发生变化，请重新选择并预览后再导入。');
    await publishArtifactRevision(this.#root, preview.targetPath, async temporary => {
      for (const entry of scan.entries) {
        const destination = path.join(temporary, entry.relative);
        if (entry.directory) { await ensureDirectories(destination); continue; }
        await ensureDirectories(path.dirname(destination));
        const copied = await readFileBounded(path.join(source, entry.relative), this.#limits.maxFileBytes, destination);
        if (copied.bytes !== entry.bytes || copied.digest !== entry.digest) throw new InvalidSpecError('复制期间源文件发生变化，请重新预览后导入。');
      }
      if ((await this.#scan(temporary)).fingerprint !== scan.fingerprint || (await this.#scan(source)).fingerprint !== scan.fingerprint) throw new InvalidSpecError('制品复制期间内容发生变化，请重新预览。');
      await fs.writeFile(path.join(temporary, IMPORTED_ARTIFACT_MARKER), JSON.stringify({ fingerprint: scan.fingerprint }), { flag: 'wx' });
    });
    return preview;
  }

  #preview(scan: Scan): ArtifactImportPreview {
    const { kind, id, revision, name } = scan.manifest;
    if (kind !== 'plugin' && kind !== 'role-card') throw new InvalidSpecError('独立世界书目录不在本导入入口支持；请使用世界书导入或编辑入口。');
    return { kind, id, revision, ...(name !== undefined ? { name } : {}), fileCount: scan.fileCount, bytes: scan.bytes,
      targetPath: path.join(this.#root, 'artifacts', kind, id, revision), fingerprint: scan.fingerprint };
  }
  async #checkDestination(target: string): Promise<void> {
    const relative = path.relative(this.#root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new InvalidSpecError('制品目标路径超出公共资源目录。');
    await assertNoLinks(path.dirname(target), true);
    try { await fs.lstat(target); }
    catch (error) { if (isCode(error, 'ENOENT')) return; throw error; }
    throw new InvalidSpecError('此 id / revision 已存在，不能覆盖运行中的制品；目录资源请修改 manifest.revision，酒馆角色卡请选择内容不同的新版本。');
  }
  async #scan(source: string): Promise<Scan> {
    await assertNoLinks(source, false);
    if (!(await fs.lstat(source)).isDirectory()) throw new InvalidSpecError('请选择包含 manifest.json 的制品目录。');
    const entries: Entry[] = [];
    let fileCount = 0, bytes = 0;
    let manifestText: string | undefined;
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > this.#limits.maxDepth) throw new InvalidSpecError('制品目录层级超过限制。');
      await assertNoLinks(directory, false);
      for (const name of (await fs.readdir(directory)).sort()) {
        if (name.toLowerCase() === IMPORTED_ARTIFACT_MARKER) throw new InvalidSpecError('源目录包含系统保留的导入标记，请使用原始制品目录。');
        assertArtifactEntry(name);
        const relative = prefix ? `${prefix}/${name}` : name;
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw new InvalidSpecError(`制品不允许符号链接：${relative}`);
        if (entries.length >= this.#limits.maxEntries) throw new InvalidSpecError('制品文件及目录数量超过限制。');
        if (stat.isDirectory()) {
          entries.push({ relative, directory: true, bytes: 0 }); await walk(file, relative, depth + 1);
        } else if (stat.isFile()) {
          if (++fileCount > this.#limits.maxFiles || stat.size > this.#limits.maxFileBytes || bytes + stat.size > this.#limits.maxTotalBytes) throw new InvalidSpecError('制品文件数量或大小超过导入限制。');
          const content = await readFileBounded(file, this.#limits.maxFileBytes, undefined, relative === 'manifest.json');
          bytes += content.bytes;
          if (bytes > this.#limits.maxTotalBytes) throw new InvalidSpecError('制品总大小超过导入限制。');
          entries.push({ relative, directory: false, bytes: content.bytes, digest: content.digest });
          if (relative === 'manifest.json') manifestText = content.text;
        } else throw new InvalidSpecError(`制品只允许普通文件和目录：${relative}`);
      }
    };
    await walk(source, '', 0);
    if (manifestText === undefined) throw new InvalidSpecError('所选目录缺少 manifest.json；JSON/PNG 文件请使用“导入酒馆角色卡”入口。');
    let raw: unknown;
    try { raw = JSON.parse(manifestText); } catch { throw new InvalidSpecError('manifest.json 不是有效JSON。'); }
    const manifest = parseArtifactManifest(raw, { strict: true });
    if (manifest.kind === 'plugin' && !entries.some(entry => !entry.directory && entry.relative === manifest.entry)) throw new InvalidSpecError('插件 entry 必须指向制品目录内存在的普通文件。');
    const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return { manifest, entries, fileCount, bytes, fingerprint };
  }
}

function isCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code); }
