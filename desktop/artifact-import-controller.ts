import crypto from 'node:crypto';
import type { ArtifactImportMode, ArtifactImportPreview, ArtifactImportResult } from '../src/contracts/artifact-import.js';
import { ArtifactImportService } from '../src/application/artifacts/artifact-import-service.js';
import { TavernCardImportService } from '../src/application/artifacts/tavern-card-import-service.js';
import { WorldbookResourceService } from '../src/application/worldbooks/worldbook-resource-service.js';
import path from 'node:path';

/** Main owns the selected source. Renderer receives only a short-lived, single-use capability. */
export class ArtifactImportController {
  readonly #service: ArtifactImportService;
  readonly #tavern: TavernCardImportService;
  readonly #worldbooks: WorldbookResourceService;
  #pending?: { token: string; source: string; fingerprint: string; expiresAt: number; mode: ArtifactImportMode };
  #busy = false;
  #activeImport?: Promise<unknown>;

  constructor(publicRoot: string, private readonly now: () => number = Date.now) {
    this.#service = new ArtifactImportService({ publicRoot });
    this.#tavern = new TavernCardImportService({ publicRoot });
    this.#worldbooks = new WorldbookResourceService({ publicRoot });
  }

  async preview(selectDirectory: () => Promise<string | undefined>, mode: ArtifactImportMode = 'directory'): Promise<ArtifactImportPreview | undefined> {
    if (this.#busy) throw new Error('资源操作正在进行，请稍候。');
    this.#busy = true;
    this.#pending = undefined;
    try {
      const source = await selectDirectory();
      if (!source) return;
      if (mode === 'worldbook') {
        const metadata = await this.#worldbooks.previewFile(source);
        const token = crypto.randomUUID();
        this.#pending = { token, source, fingerprint: metadata.fingerprint, expiresAt: this.now() + 5 * 60_000, mode };
        return { token, kind: 'worldbook', id: metadata.manifest.id, revision: metadata.manifest.revision,
          name: metadata.manifest.name, fileCount: 3, totalBytes: metadata.bytes,
          targetPath: path.join(this.#worldbooks.root, 'artifacts/worldbook', metadata.manifest.id, metadata.manifest.revision),
          sourceFormat: metadata.sourceFormat as ArtifactImportPreview['sourceFormat'], warnings: metadata.warnings };
      }
      const tavernMetadata = mode === 'tavern-card' ? await this.#tavern.preview(source) : undefined;
      const metadata = tavernMetadata ?? await this.#service.preview(source);
      const token = crypto.randomUUID();
      this.#pending = { token, source, fingerprint: metadata.fingerprint, expiresAt: this.now() + 5 * 60_000, mode };
      return { token, kind: metadata.kind, id: metadata.id, revision: metadata.revision,
        ...(metadata.name ? { name: metadata.name } : {}), fileCount: metadata.fileCount,
        totalBytes: metadata.bytes, targetPath: metadata.targetPath,
        ...(tavernMetadata ? { sourceFormat: tavernMetadata.sourceFormat, warnings: tavernMetadata.warnings,
          contentPreview: tavernMetadata.contentPreview, contentLength: tavernMetadata.contentLength } : {}) };
    } finally { this.#busy = false; }
  }

  async commit(token: unknown): Promise<ArtifactImportResult> {
    if (this.#busy) throw new Error('资源操作正在进行，请稍候。');
    const pending = this.#pending;
    if (typeof token !== 'string' || !pending || token !== pending.token || this.now() >= pending.expiresAt) {
      throw new Error('导入预览已失效，请重新选择资源。');
    }
    this.#pending = undefined;
    this.#busy = true;
    try {
      if (pending.mode === 'worldbook') {
        const operation = this.#worldbooks.importFile(pending.source, pending.fingerprint);
        this.#activeImport = operation;
        const result = await operation;
        return { kind: 'worldbook', id: result.manifest.id, revision: result.manifest.revision };
      }
      const service = pending.mode === 'tavern-card' ? this.#tavern : this.#service;
      const operation = service.import(pending.source, { expectedFingerprint: pending.fingerprint });
      this.#activeImport = operation;
      const result = await operation;
      return { kind: result.kind, id: result.id, revision: result.revision };
    } finally { this.#activeImport = undefined; this.#busy = false; }
  }

  /** Main closes admission before calling this; failures still reach the initiating renderer. */
  async drain(): Promise<void> {
    await this.#activeImport?.catch(() => {});
  }
}
