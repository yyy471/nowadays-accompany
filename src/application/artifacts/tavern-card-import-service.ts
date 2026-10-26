import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InvalidSpecError } from '../../core/errors.js';
import { parseTavernCard } from '../../artifacts/tavern-card.js';
import { ArtifactImportService, readArtifactSourceFile, type ArtifactImportPreview } from './artifact-import-service.js';

export interface TavernCardImportPreview extends ArtifactImportPreview {
  sourceFormat: 'tavern-v1' | 'tavern-v2';
  warnings: string[];
  contentPreview: string;
  contentLength: number;
}

/** Conversion feeds the existing publication use case; no second catalog/write implementation. */
export class TavernCardImportService {
  readonly #artifacts: ArtifactImportService;
  constructor(options: { publicRoot: string }) { this.#artifacts = new ArtifactImportService(options); }

  preview(sourceFile: string): Promise<TavernCardImportPreview> {
    return this.#withSnapshot(sourceFile, undefined, false);
  }

  import(sourceFile: string, options: { expectedFingerprint?: string } = {}): Promise<TavernCardImportPreview> {
    return this.#withSnapshot(sourceFile, options.expectedFingerprint, true);
  }

  async #withSnapshot(sourceFile: string, expectedFingerprint: string | undefined, commit: boolean): Promise<TavernCardImportPreview> {
    const extension = path.extname(sourceFile).toLowerCase();
    if (extension !== '.json' && extension !== '.png') throw new InvalidSpecError('请选择酒馆角色卡 JSON 或 PNG 文件。');
    const bytes = await readArtifactSourceFile(path.resolve(sourceFile), 8 * 1024 * 1024);
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) throw new InvalidSpecError('角色卡内容已变化，请重新选择并预览。');
    const converted = parseTavernCard(bytes, extension === '.json' ? 'json' : 'png');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-tavern-conversion-'));
    try {
      await fs.writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify(converted.manifest, null, 2)}\n`, { flag: 'wx' });
      // Preserve all unimplemented fields verbatim without letting them become executable configuration.
      await fs.writeFile(path.join(temporary, `source-card${extension}`), bytes, { flag: 'wx' });
      const preview = await this.#artifacts.preview(temporary);
      const published = commit ? await this.#artifacts.import(temporary, { expectedFingerprint: preview.fingerprint }) : preview;
      return { ...published, fingerprint, sourceFormat: converted.format, warnings: converted.warnings,
        contentPreview: converted.manifest.content!.slice(0, 2000), contentLength: converted.contentLength };
    } finally {
      const parent = path.resolve(os.tmpdir());
      const resolved = path.resolve(temporary);
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('nowadays-tavern-conversion-')) throw new Error('Invalid conversion cleanup path');
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
}
