import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AccompanyError, InvalidSpecError } from '../../core/errors.js';
import { KeyedSerialExecutor } from '../../platform/async/keyed-serial-executor.js';
import { assertArtifactSegment, parseArtifactManifest } from '../../artifacts/manifest.js';
import { assertNoLinks, readArtifactSourceFile } from '../../artifacts/source-file.js';
import { publishArtifactRevision } from '../../artifacts/publish.js';
import { convertWorldbookImport } from '../../worldbook/import-adapter.js';
import { parseWorldbook, parseWorldbookOptions, summarizeWorldbook } from '../../worldbook/schema.js';
import { evaluateWorldbook } from '../../worldbook/matcher.js';
import type { WorldbookEvaluation } from '../../worldbook/types.js';
import type { WorldbookFilePreview, WorldbookList, WorldbookManifest, WorldbookResourceDetail, WorldbookSaveResult } from '../../contracts/worldbook-resources.js';

const MAX_BYTES = 2 * 1024 * 1024;
const writes = new KeyedSerialExecutor();
async function boundary<T>(task: () => Promise<T>): Promise<T> {
  try { return await task(); } catch (error) {
    if (error instanceof InvalidSpecError && error.message.startsWith('制品路径不允许')) throw new InvalidSpecError('资源路径含链接，已拒绝读取。');
    if (error instanceof AccompanyError) throw error;
    throw new AccompanyError('worldbook_io_error', '世界书读写失败，请检查文件和目录权限后重试。', { cause: error });
  }
}
const conflict = () => new AccompanyError('worldbook_conflict', '版本、基础指纹或请求标识发生冲突，请重新读取；未覆盖已有版本。');
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError('世界书请求必须是对象。');
  return raw as Record<string, unknown>;
}
function exact(raw: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new InvalidSpecError('世界书请求含不支持的字段。');
}
function canonical(raw: unknown): string {
  if (Array.isArray(raw)) return `[${raw.map(canonical).join(',')}]`;
  if (raw && typeof raw === 'object') return `{${Object.entries(raw).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(raw);
}
function digest(raw: unknown): string { return createHash('sha256').update(canonical(raw)).digest('hex'); }
function normalize(raw: unknown): WorldbookManifest {
  const manifest = parseArtifactManifest(raw, { strict: true });
  if (manifest.kind !== 'worldbook' || !manifest.worldbook) throw new InvalidSpecError('这里只接受worldbook制品。');
  for (const entry of manifest.worldbook.entries) {
    if (entry.enabled && !entry.constant && !entry.keys.length) throw new InvalidSpecError(`条目 ${entry.id} 已启用但没有关键词。`);
  }
  return manifest as WorldbookManifest;
}

/** Independent immutable resources. No catalog, account configuration, workers or provider calls. */
export class WorldbookResourceService {
  readonly root: string;
  constructor(options: { publicRoot: string }) { this.root = path.resolve(options.publicRoot); }

  detail(id: string, revision: string): Promise<WorldbookResourceDetail> { return boundary(() => this.#detail(id, revision)); }
  list(query: unknown = {}): Promise<WorldbookList> { return boundary(() => this.#list(query)); }
  save(raw: unknown, archive?: Buffer): Promise<WorldbookSaveResult> { return boundary(() => this.#save(raw, archive)); }
  previewDraft(raw: unknown): Promise<WorldbookEvaluation> { return boundary(() => this.#previewDraft(raw)); }
  previewFile(source: string): Promise<WorldbookFilePreview> { return boundary(() => this.#previewFile(source)); }
  importFile(source: string, fingerprint: string): Promise<WorldbookSaveResult> { return boundary(() => this.#importFile(source, fingerprint)); }

  async #detail(id: string, revision: string): Promise<WorldbookResourceDetail> {
    const dir = this.#directory(id, revision);
    let manifest: WorldbookManifest;
    try { manifest = normalize(JSON.parse((await readArtifactSourceFile(path.join(dir, 'manifest.json'), MAX_BYTES)).toString('utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AccompanyError('worldbook_not_found', '指定世界书版本不存在。');
      if (error instanceof SyntaxError) throw new InvalidSpecError('世界书文件不是有效JSON。');
      throw error;
    }
    if (manifest.id !== id || manifest.revision !== revision) throw new InvalidSpecError('世界书路径与版本声明不一致。');
    let baseRef: { id: string; revision: string } | undefined;
    try {
      const metadata = JSON.parse((await readArtifactSourceFile(path.join(dir, 'origin.json'), 4096)).toString('utf8'));
      if (metadata.baseRef) { assertArtifactSegment(metadata.baseRef.id, '基础id'); assertArtifactSegment(metadata.baseRef.revision, '基础revision'); baseRef = metadata.baseRef; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { manifest, fingerprint: digest(manifest), ...(baseRef ? { baseRef } : {}) };
  }

  async #list(raw: unknown = {}): Promise<WorldbookList> {
    const query = object(raw); exact(query, ['id', 'offset', 'limit']);
    const offset = query.offset ?? 0, limit = query.limit ?? 50;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new InvalidSpecError('offset须为非负整数，limit为1–100。');
    if (query.id !== undefined) assertArtifactSegment(query.id, '世界书id');
    const root = path.join(this.root, 'artifacts/worldbook');
    const names = async (directory: string): Promise<string[]> => {
      try {
        await assertNoLinks(directory, false);
        const values: string[] = []; let visited = 0;
        for await (const entry of await fs.opendir(directory)) {
          if (++visited > 5000) throw new InvalidSpecError('世界书目录超过扫描上限，请按id查询。');
          if (entry.isDirectory() && !entry.name.startsWith('.')) values.push(entry.name);
        }
        return values.sort();
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    };
    const ids = query.id === undefined ? await names(root) : [query.id as string];
    const refs: Array<{ id: string; revision: string }> = [];
    for (const id of ids) for (const revision of await names(path.join(root, id))) {
      assertArtifactSegment(id, '世界书id'); assertArtifactSegment(revision, '世界书revision');
      if (refs.length >= 10000) throw new InvalidSpecError('世界书版本超过扫描上限，请按id查询。');
      refs.push({ id, revision });
    }
    const items: WorldbookList['items'] = [];
    for (const ref of refs.slice(offset as number, (offset as number) + (limit as number))) {
      const detail = await this.detail(ref.id, ref.revision);
      const { entryCount, enabledEntryCount } = summarizeWorldbook(detail.manifest.worldbook);
      items.push({ ...ref, ...(detail.manifest.name ? { name: detail.manifest.name } : {}), entryCount, enabledEntryCount, fingerprint: detail.fingerprint });
    }
    const next = (offset as number) + items.length;
    return { items, ...(next < refs.length ? { nextOffset: next } : {}) };
  }

  async #save(raw: unknown, archive?: Buffer): Promise<WorldbookSaveResult> {
    const body = object(raw); exact(body, ['manifest', 'requestId', 'baseRef', 'expectedBaseFingerprint']);
    const manifest = normalize(body.manifest);
    assertArtifactSegment(body.requestId, '请求标识');
    const requestId = body.requestId;
    let baseRef: { id: string; revision: string } | undefined;
    if (body.baseRef !== undefined) {
      const base = object(body.baseRef); exact(base, ['id', 'revision']);
      assertArtifactSegment(base.id, '基础id'); assertArtifactSegment(base.revision, '基础revision');
      if (typeof body.expectedBaseFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedBaseFingerprint)) throw new InvalidSpecError('派生版本必须提供基础指纹。');
      baseRef = { id: base.id, revision: base.revision };
    } else if (body.expectedBaseFingerprint !== undefined) throw new InvalidSpecError('基础指纹必须与baseRef一起提供。');
    const payload = digest({ manifest, baseRef, expectedBaseFingerprint: body.expectedBaseFingerprint,
      archive: archive ? createHash('sha256').update(archive).digest('hex') : undefined });
    const receipt = path.join(this.root, '.worldbook-requests', requestId);
    return writes.run(receipt, async () => {
      // Durable immutable claim ties a request id to one payload across retries and process restarts.
      let existingClaim: string | undefined;
      try { existingClaim = (await readArtifactSourceFile(path.join(receipt, 'claim'), 128)).toString('utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existingClaim !== undefined && existingClaim !== payload) throw conflict();
      const target = this.#directory(manifest.id, manifest.revision);
      try {
        const detail = await this.detail(manifest.id, manifest.revision);
        const origin = JSON.parse((await readArtifactSourceFile(path.join(target, 'origin.json'), 4096)).toString('utf8'));
        if (existingClaim === payload && origin.payload === payload && origin.requestId === requestId && detail.fingerprint === digest(manifest)) return { ...detail, created: false };
        throw conflict();
      } catch (error) { if (!(error instanceof AccompanyError && error.code === 'worldbook_not_found')) throw error; }
      if (baseRef && (await this.detail(baseRef.id, baseRef.revision)).fingerprint !== body.expectedBaseFingerprint) throw conflict();
      if (existingClaim === undefined) {
        try { await publishArtifactRevision(this.root, receipt, temp => fs.writeFile(path.join(temp, 'claim'), payload, { flag: 'wx' })); }
        catch (error) {
          if (!(error instanceof AccompanyError && error.code === 'worldbook_conflict')) throw error;
          const claim = (await readArtifactSourceFile(path.join(receipt, 'claim'), 128)).toString('utf8');
          if (claim !== payload) throw conflict();
        }
      }
      await publishArtifactRevision(this.root, target, async temporary => {
        await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
        await fs.writeFile(path.join(temporary, 'origin.json'), JSON.stringify({ requestId, payload, ...(baseRef ? { baseRef } : {}) }), { flag: 'wx' });
        if (archive) await fs.writeFile(path.join(temporary, 'source-worldbook.json'), archive, { flag: 'wx' });
        if (baseRef && (await this.detail(baseRef.id, baseRef.revision)).fingerprint !== body.expectedBaseFingerprint) throw conflict();
      });
      return { manifest, fingerprint: digest(manifest), ...(baseRef ? { baseRef } : {}), created: true };
    });
  }

  async #previewFile(source: string): Promise<WorldbookFilePreview> {
    return (await this.#readImport(source)).preview;
  }

  /** Stateless draft evaluation: no model, history, resource write or memory. */
  async #previewDraft(raw: unknown): Promise<WorldbookEvaluation> {
    const body = object(raw); exact(body, ['book', 'text', 'scanDepth', 'budgetChars']);
    if (typeof body.text !== 'string' || body.text.length > 16000) throw new InvalidSpecError('测试文本必须是最多16000字符的文本。');
    const book = parseWorldbook(body.book);
    const options = parseWorldbookOptions({
      enabled: true,
      scanDepth: body.scanDepth === undefined ? book.scanDepth : body.scanDepth,
      budgetChars: body.budgetChars === undefined ? book.budgetChars : body.budgetChars
    });
    return evaluateWorldbook(book, { currentText: body.text, historyTexts: [], ...options });
  }

  async #importFile(source: string, expectedFingerprint: string): Promise<WorldbookSaveResult> {
    const { preview, bytes } = await this.#readImport(source);
    if (preview.fingerprint !== expectedFingerprint) throw conflict();
    return this.save({ manifest: preview.manifest, requestId: `i-${preview.fingerprint.slice(0, 60)}` }, bytes);
  }

  async #readImport(source: string): Promise<{ preview: WorldbookFilePreview; bytes: Buffer }> {
    if (path.extname(source).toLowerCase() !== '.json') throw new InvalidSpecError('请选择世界书JSON文件。');
    const bytes = await readArtifactSourceFile(path.resolve(source), MAX_BYTES);
    let raw: unknown; try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new InvalidSpecError('世界书JSON格式错误。'); }
    const result = convertWorldbookImport(raw);
    if (!result.worldbook) throw new InvalidSpecError(result.warnings.join('；') || '无法识别世界书。');
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    const native = (raw as Record<string, unknown>).kind === 'worldbook' ? raw as WorldbookManifest : undefined;
    const manifest = normalize({ id: native?.id ?? `book-${fingerprint.slice(0, 20)}`, kind: 'worldbook', revision: native?.revision ?? `i-${fingerprint.slice(0, 24)}`,
      ...(native?.name ? { name: native.name } : result.worldbook.name ? { name: result.worldbook.name } : {}), ...(native?.description ? { description: native.description } : {}), worldbook: result.worldbook });
    return { bytes, preview: { manifest, fingerprint, bytes: bytes.length, warnings: result.warnings, sourceFormat: result.detectedFormat } };
  }

  #directory(id: string, revision: string): string {
    assertArtifactSegment(id, '世界书id'); assertArtifactSegment(revision, '世界书revision');
    return path.join(this.root, 'artifacts/worldbook', id, revision);
  }
}
