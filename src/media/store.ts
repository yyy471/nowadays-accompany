import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from '../storage/atomic-write.js';
import { MediaError } from './errors.js';
import type { IngestInput, MediaCleanupResult, MediaData, MediaRef } from './types.js';

interface MediaIndex {
  version: 1;
  media: Record<string, MediaRef>;
}

const MEDIA_ID = /^[a-f0-9-]{36}$/;

/**
 * 账号私有媒体库。路径永远不进入 MediaRef 或 API DTO；
 * 同一个根目录只服务一个 accountId，读取时再校验归属。
 */
export class AccountMediaStore {
  readonly #root: string;
  readonly #accountId: string;
  readonly #logger?: Logger;
  readonly #now: () => number;
  #index: MediaIndex | undefined;
  #init: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: { root: string; accountId: string; logger?: Logger; now?: () => number }) {
    this.#root = path.resolve(options.root);
    this.#accountId = options.accountId;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  get accountId(): string {
    return this.#accountId;
  }

  async put(input: IngestInput): Promise<MediaRef> {
    if (input.accountId !== this.#accountId) {
      throw new MediaError('media_account_mismatch', `media store for ${this.#accountId} refused ${input.accountId}`);
    }
    if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
      throw new MediaError('media_empty', 'media data is empty');
    }
    await this.#ready();
    const mediaId = crypto.randomUUID();
    const sha256 = crypto.createHash('sha256').update(input.data).digest('hex');
    const createdAt = this.#now();
    const retentionDays = Math.max(1, Math.min(input.retentionDays ?? 7, 365));
    const ref: MediaRef = {
      mediaId,
      accountId: this.#accountId,
      kind: input.kind,
      mimeType: input.mimeType.toLowerCase(),
      bytes: input.data.length,
      sha256,
      createdAt,
      expiresAt: createdAt + retentionDays * 24 * 60 * 60 * 1_000,
      retention: 'temporary',
      source: structuredClone(input.source),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {})
    };
    const file = this.#fileFor(mediaId);
    await writeFileAtomic(file, input.data);
    this.#index!.media[mediaId] = ref;
    try {
      await this.#persist();
    } catch (error) {
      delete this.#index!.media[mediaId];
      await fs.unlink(file).catch(() => {});
      throw error;
    }
    return structuredClone(ref);
  }

  async get(mediaId: string): Promise<MediaData> {
    const ref = await this.ref(mediaId);
    let data: Buffer;
    try {
      data = await fs.readFile(this.#fileFor(mediaId));
    } catch (error) {
      throw new MediaError('media_missing', `media file for ${mediaId} is missing`, { cause: error });
    }
    if (data.length !== ref.bytes) {
      throw new MediaError('media_corrupt', `media ${mediaId} size does not match its record`);
    }
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== ref.sha256) {
      throw new MediaError('media_corrupt', `media ${mediaId} checksum does not match its record`);
    }
    return { ref, data };
  }

  async ref(mediaId: string): Promise<MediaRef> {
    if (!MEDIA_ID.test(mediaId)) throw new MediaError('media_not_found', `invalid media id ${mediaId}`);
    await this.#ready();
    const ref = this.#index!.media[mediaId];
    if (!ref || ref.accountId !== this.#accountId) {
      throw new MediaError('media_not_found', `media ${mediaId} is not available for this account`);
    }
    return structuredClone(ref);
  }

  async has(mediaId: string): Promise<boolean> {
    try {
      await this.ref(mediaId);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<MediaRef[]> {
    await this.#ready();
    return Object.values(this.#index!.media)
      .filter((ref) => ref.accountId === this.#accountId)
      .sort((left, right) => right.createdAt - left.createdAt || left.mediaId.localeCompare(right.mediaId))
      .map((ref) => structuredClone(ref));
  }

  async delete(mediaId: string): Promise<boolean> {
    await this.#ready();
    const ref = this.#index!.media[mediaId];
    if (!ref || ref.accountId !== this.#accountId) return false;
    delete this.#index!.media[mediaId];
    await this.#persist();
    await fs.unlink(this.#fileFor(mediaId)).catch((error: unknown) => {
      this.#logger?.warn('media file delete failed', {
        mediaId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  }

  async cleanup(now: number, inUse: Set<string>): Promise<MediaCleanupResult> {
    await this.#ready();
    const result: MediaCleanupResult = { deleted: [], skippedInUse: [], failed: [] };
    let changed = false;
    for (const [mediaId, ref] of Object.entries(this.#index!.media)) {
      if (ref.accountId !== this.#accountId || ref.expiresAt > now) continue;
      if (inUse.has(mediaId)) {
        result.skippedInUse.push(mediaId);
        continue;
      }
      try {
        await fs.unlink(this.#fileFor(mediaId));
        delete this.#index!.media[mediaId];
        result.deleted.push(mediaId);
        changed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          delete this.#index!.media[mediaId];
          changed = true;
          result.deleted.push(mediaId);
          continue;
        }
        result.failed.push({ mediaId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (changed) await this.#persist();
    return result;
  }

  async dispose(): Promise<void> {
    await this.#writeChain.catch(() => {});
  }

  get #filesDir(): string {
    return path.join(this.#root, 'files');
  }

  #fileFor(mediaId: string): string {
    if (!MEDIA_ID.test(mediaId)) throw new MediaError('media_not_found', `invalid media id ${mediaId}`);
    return path.join(this.#filesDir, mediaId);
  }

  async #ready(): Promise<void> {
    if (!this.#init) {
      this.#init = this.#load();
    }
    await this.#init;
  }

  async #load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.#root, 'index.json'), 'utf8')) as Partial<MediaIndex>;
      const media: Record<string, MediaRef> = {};
      for (const [mediaId, ref] of Object.entries(raw.media ?? {})) {
        if (!MEDIA_ID.test(mediaId) || !ref || typeof ref !== 'object') continue;
        if (ref.accountId !== this.#accountId) continue;
        media[mediaId] = ref;
      }
      this.#index = { version: 1, media };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#index = { version: 1, media: {} };
        return;
      }
      throw new MediaError('media_index_corrupt', `media index is unreadable: ${this.#root}`, { cause: error });
    }
  }

  async #persist(): Promise<void> {
    const index = this.#index;
    if (!index) return;
    const payload = `${JSON.stringify(
      {
        version: 1,
        media: Object.fromEntries(
          Object.entries(index.media).sort(([left], [right]) => left.localeCompare(right))
        )
      },
      null,
      2
    )}\n`;
    const task = this.#writeChain
      .catch(() => {})
      .then(() => writeFileAtomic(path.join(this.#root, 'index.json'), payload));
    this.#writeChain = task.then(
      () => undefined,
      () => undefined
    );
    try {
      await task;
    } catch (error) {
      this.#logger?.error('media index persist failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      throw new MediaError('media_persist_failed', 'failed to persist media index', { cause: error });
    }
  }
}
