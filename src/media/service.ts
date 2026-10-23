import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ConversationRef } from '../routing/identity.js';
import type { InboundMessageEvent } from '../channels/events.js';
import type { MessageSegment } from '../routing/message.js';
import type { ProviderMedia } from '../providers/contract.js';
import { sanitizeUrl } from '../platform/security/redaction.js';
import { MediaError } from './errors.js';
import type { AudioGenerationResult, GeneratedImage } from '../providers/contract.js';
import { AccountMediaStore } from './store.js';
import type { IngestInput, MediaCleanupResult, MediaData, MediaKind, MediaRef, MediaSource } from './types.js';

export interface MediaServiceOptions {
  accountDir: (accountId: string) => string;
  accountIds?: () => Promise<string[]>;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  maxDownloadMs?: number;
  maxRedirects?: number;
  retentionDays?: number | (() => number);
  logger?: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MS = 15_000;
const DEFAULT_REDIRECTS = 3;

export class MediaService {
  readonly #options: MediaServiceOptions;
  readonly #stores = new Map<string, { accountId: string; store: AccountMediaStore }>();
  readonly #logger?: Logger;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;

  constructor(options: MediaServiceOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get maxImageBytes(): number {
    return this.#options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  get maxVideoBytes(): number {
    return this.#options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
  }

  get maxAudioBytes(): number {
    return DEFAULT_MAX_AUDIO_BYTES;
  }

  retentionDays(): number {
    const configured = this.#options.retentionDays;
    const value = typeof configured === 'function' ? configured() : configured;
    return Math.max(1, Math.min(value ?? 7, 365));
  }

  store(accountId: string): AccountMediaStore {
    const root = path.join(this.#options.accountDir(accountId), 'media');
    const existing = this.#stores.get(root);
    if (existing) return existing.store;
    const store = new AccountMediaStore({
      root,
      accountId,
      ...(this.#logger ? { logger: this.#logger } : {}),
      now: this.#now
    });
    this.#stores.set(root, { accountId, store });
    return store;
  }

  async ingestInbound(
    accountId: string,
    conversation: ConversationRef,
    message: InboundMessageEvent,
    signal?: AbortSignal
  ): Promise<MediaRef[]> {
    if (conversation.accountId !== accountId) {
      throw new MediaError('media_account_mismatch', 'conversation does not belong to this account');
    }
    const refs: MediaRef[] = [];
    for (const segment of message.segments) {
      const kind = kindForSegment(segment);
      if (!kind) continue;
      refs.push(
        await this.#ingestSegment(accountId, {
          conversation,
          ...(message.messageId ? { messageId: message.messageId } : {}),
          direction: 'in'
        }, segment, kind, signal)
      );
    }
    return refs;
  }

  async ingestGenerated(
    accountId: string,
    conversation: ConversationRef,
    jobId: string,
    images: GeneratedImage[],
    signal?: AbortSignal
  ): Promise<MediaRef[]> {
    if (conversation.accountId !== accountId) {
      throw new MediaError('media_account_mismatch', 'generated media conversation does not belong to this account');
    }
    throwIfAborted(signal);
    if (images.length === 0) throw new MediaError('media_empty', 'service returned no images');
    if (images.length > 4) throw new MediaError('media_limit', 'service returned more than 4 images');
    const store = this.store(accountId);
    const source: MediaSource = { conversation: structuredClone(conversation), jobId, direction: 'out' };
    const refs: MediaRef[] = [];
    try {
      for (const image of images) {
        throwIfAborted(signal);
        let data: Buffer;
        let mimeType: string | undefined = image.mimeType;
        if (image.data) {
          data = image.data;
        } else if (image.base64) {
          data = decodeBase64(image.base64);
        } else if (image.url) {
          const downloaded = await this.#download(accountId, image.url, 'image', signal);
          data = downloaded.data;
          mimeType = downloaded.mimeType;
        } else if (image.assetId) {
          throw new MediaError(
            'media_asset_unsupported',
            `image asset ${image.assetId} cannot be fetched; the adapter must return base64 or an allowed URL`
          );
        } else {
          throw new MediaError('media_unsupported_output', 'image result has no data, base64, URL, or fetchable asset');
        }
        const resolved = resolveMime(mimeType, data, 'image');
        if (data.length > this.maxImageBytes) {
          throw new MediaError('media_too_large', `generated image is ${data.length} bytes, limit is ${this.maxImageBytes}`);
        }
        throwIfAborted(signal);
        refs.push(
          await store.put({
            accountId,
            kind: 'image',
            mimeType: resolved,
            data,
            source,
            retentionDays: this.retentionDays(),
            ...(image.width !== undefined ? { width: image.width } : {}),
            ...(image.height !== undefined ? { height: image.height } : {})
          })
        );
      }
      throwIfAborted(signal);
      return refs;
    } catch (error) {
      await Promise.allSettled(refs.map((ref) => store.delete(ref.mediaId)));
      throw error;
    }
  }

  async ingestGeneratedAudio(
    accountId: string,
    conversation: ConversationRef,
    jobId: string,
    audio: AudioGenerationResult,
    signal?: AbortSignal
  ): Promise<MediaRef> {
    if (conversation.accountId !== accountId) {
      throw new MediaError('media_account_mismatch', 'generated audio conversation does not belong to this account');
    }
    throwIfAborted(signal);
    if (!Buffer.isBuffer(audio.data) || audio.data.length === 0) throw new MediaError('media_empty', 'service returned no audio bytes');
    if (audio.data.length > this.maxAudioBytes) {
      throw new MediaError('media_too_large', `generated audio is ${audio.data.length} bytes, limit is ${this.maxAudioBytes}`);
    }
    const mimeType = resolveAudioMime(audio.mimeType, audio.data);
    throwIfAborted(signal);
    return this.store(accountId).put({
      accountId,
      kind: 'audio',
      mimeType,
      data: audio.data,
      source: { conversation: structuredClone(conversation), jobId, direction: 'out' },
      retentionDays: this.retentionDays()
    });
  }

  async prepareForProvider(accountId: string, mediaId: string): Promise<ProviderMedia> {
    const { ref, data } = await this.store(accountId).get(mediaId);
    return {
      mediaId: ref.mediaId,
      accountId: ref.accountId,
      mimeType: ref.mimeType,
      bytes: ref.bytes,
      kind: ref.kind === 'video' ? 'video' : 'image',
      data
    };
  }

  read(accountId: string, mediaId: string): Promise<MediaData> {
    return this.store(accountId).get(mediaId);
  }

  list(accountId: string): Promise<MediaRef[]> {
    return this.store(accountId).list();
  }

  delete(accountId: string, mediaId: string): Promise<boolean> {
    return this.store(accountId).delete(mediaId);
  }

  async cleanup(inUseByAccount: Map<string, Set<string>> = new Map()): Promise<MediaCleanupResult> {
    const accounts = new Set<string>();
    for (const entry of this.#stores.values()) accounts.add(entry.accountId);
    for (const accountId of (await this.#options.accountIds?.()) ?? []) accounts.add(accountId);
    const total: MediaCleanupResult = { deleted: [], skippedInUse: [], failed: [] };
    for (const accountId of accounts) {
      const result = await this.store(accountId).cleanup(
        this.#now(),
        inUseByAccount.get(accountId) ?? new Set()
      );
      total.deleted.push(...result.deleted);
      total.skippedInUse.push(...result.skippedInUse);
      total.failed.push(...result.failed);
    }
    return total;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#stores.values()].map((entry) => entry.store.dispose()));
    this.#stores.clear();
  }

  async #ingestSegment(
    accountId: string,
    source: MediaSource,
    segment: MessageSegment,
    kind: 'image' | 'video',
    signal?: AbortSignal
  ): Promise<MediaRef> {
    const data = segment.data as { file?: unknown; url?: unknown };
    const file = typeof data.file === 'string' ? data.file : undefined;
    const url = typeof data.url === 'string' ? data.url : undefined;
    let buffer: Buffer | undefined;
    let mimeType: string | undefined;
    if (file?.startsWith('base64://')) {
      buffer = decodeBase64(file.slice('base64://'.length));
    } else if (file?.startsWith('data:')) {
      const parsed = parseDataUrl(file);
      buffer = parsed.data;
      mimeType = parsed.mimeType;
    } else if (file && /^https?:\/\//i.test(file)) {
      const downloaded = await this.#download(accountId, file, kind, signal);
      buffer = downloaded.data;
      mimeType = downloaded.mimeType;
    } else if (url && /^https?:\/\//i.test(url)) {
      const downloaded = await this.#download(accountId, url, kind, signal);
      buffer = downloaded.data;
      mimeType = downloaded.mimeType;
    }
    if (!buffer) {
      throw new MediaError(
        'media_unavailable',
        `${kind} segment has no fetchable URL; local runtime file paths are not read directly`
      );
    }
    const max = kind === 'image' ? this.maxImageBytes : this.maxVideoBytes;
    if (buffer.length > max) {
      throw new MediaError('media_too_large', `${kind} is ${buffer.length} bytes, limit is ${max}`);
    }
    const resolved = resolveMime(mimeType, buffer, kind);
    return this.store(accountId).put({
      accountId,
      kind,
      mimeType: resolved,
      data: buffer,
      source,
      retentionDays: this.retentionDays()
    } satisfies IngestInput);
  }

  async #download(
    accountId: string,
    rawUrl: string,
    kind: 'image' | 'video',
    signal?: AbortSignal
  ): Promise<{ data: Buffer; mimeType: string }> {
    const maxBytes = kind === 'image' ? this.maxImageBytes : this.maxVideoBytes;
    let current = await validateMediaUrl(rawUrl);
    const redirects = this.#options.maxRedirects ?? DEFAULT_REDIRECTS;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = Math.max(1, this.#options.maxDownloadMs ?? DEFAULT_DOWNLOAD_MS);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new MediaError('media_download_timeout', 'media download timed out', { retryable: true }));
    }, timeoutMs);
    timeout.unref?.();
    const downloadSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      for (let attempt = 0; attempt <= redirects; attempt += 1) {
        throwIfAborted(signal);
        await assertResolvedHostAllowed(current.hostname);
        let response: Response;
        try {
          response = await this.#fetch(current, {
            method: 'GET',
            redirect: 'manual',
            signal: downloadSignal
          });
        } catch (error) {
          throw this.#downloadFailure(error, signal, timedOut, current);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {});
          const location = response.headers.get('location');
          if (!location) throw new MediaError('media_redirect_invalid', 'media redirect has no location');
          if (attempt === redirects) throw new MediaError('media_redirect_limit', 'too many media redirects');
          current = await validateMediaUrl(new URL(location, current).toString());
          continue;
        }
        if (response.status === 404 || response.status === 403 || response.status === 410) {
          await response.body?.cancel().catch(() => {});
          throw new MediaError('media_unavailable', `media URL returned HTTP ${response.status}`, {
            retryable: false
          });
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new MediaError('media_download_failed', `media URL returned HTTP ${response.status}`, {
            retryable: response.status >= 500
          });
        }
        const length = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(length) && length > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw new MediaError('media_too_large', `media is ${length} bytes, limit is ${maxBytes}`);
        }
        const contentType = response.headers.get('content-type') ?? undefined;
        const chunks: Buffer[] = [];
        let total = 0;
        if (!response.body) throw new MediaError('media_empty', 'media response has no body');
        const reader = response.body.getReader();
        try {
          while (true) {
            if (downloadSignal.aborted) {
              throw this.#downloadFailure(downloadSignal.reason, signal, timedOut, current);
            }
            const { done, value } = await readChunk(reader, downloadSignal);
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > maxBytes) {
              throw new MediaError('media_too_large', `media exceeds ${maxBytes} bytes`);
            }
            chunks.push(Buffer.from(value));
          }
        } catch (error) {
          void reader.cancel().catch(() => {});
          if (error instanceof MediaError) throw error;
          throw this.#downloadFailure(error, signal, timedOut, current);
        }
        const data = Buffer.concat(chunks, total);
        if (data.length === 0) throw new MediaError('media_empty', 'downloaded media is empty');
        throwIfAborted(signal);
        const mimeType = resolveMime(contentType, data, kind);
        this.#logger?.debug('media downloaded', { accountId, kind, bytes: data.length, mimeType });
        return { data, mimeType };
      }
      throw new MediaError('media_redirect_limit', 'too many media redirects');
    } finally {
      clearTimeout(timeout);
    }
  }

  #downloadFailure(error: unknown, signal: AbortSignal | undefined, timedOut: boolean, url: URL): MediaError {
    if (signal?.aborted) {
      return signal.reason instanceof MediaError
        ? signal.reason
        : new MediaError('media_aborted', 'media download aborted', { cause: error });
    }
    if (timedOut) {
      return new MediaError('media_download_timeout', 'media download timed out', { retryable: true, cause: error });
    }
    if (error instanceof MediaError) return error;
    return new MediaError('media_download_failed', `failed to download ${sanitizeUrl(url.toString())}`, {
      retryable: true,
      cause: error
    });
  }
}

function readChunk<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<T>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('media read aborted'));
  }
  return new Promise<ReadableStreamReadResult<T>>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('media read aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new MediaError('media_aborted', 'media operation aborted');
}

function kindForSegment(segment: MessageSegment): 'image' | 'video' | undefined {
  if (segment.type === 'image') return 'image';
  if (segment.type === 'video') return 'video';
  return undefined;
}

function decodeBase64(raw: string): Buffer {
  const cleaned = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length === 0) {
    throw new MediaError('media_invalid', 'media base64 is invalid');
  }
  const data = Buffer.from(cleaned, 'base64');
  if (data.length === 0) throw new MediaError('media_empty', 'media base64 decoded to an empty buffer');
  return data;
}

function parseDataUrl(raw: string): { mimeType: string; data: Buffer } {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(raw);
  if (!match) throw new MediaError('media_invalid', 'only base64 data URLs are supported');
  return {
    mimeType: match[1] ?? 'application/octet-stream',
    data: decodeBase64(match[2] ?? '')
  };
}

async function validateMediaUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new MediaError('media_url_invalid', 'media URL is invalid', { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MediaError('media_url_invalid', 'media URL must use http or https');
  }
  if (url.username || url.password) {
    throw new MediaError('media_url_invalid', 'media URL must not contain credentials');
  }
  return url;
}

async function assertResolvedHostAllowed(hostname: string): Promise<void> {
  const host = hostname.toLowerCase();
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === '169.254.169.254' ||
    host === '100.100.100.200'
  ) {
    throw new MediaError('media_url_blocked', 'media URL points to a metadata service');
  }
  if (net.isIP(host)) {
    assertIpAllowed(host);
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (error) {
    throw new MediaError('media_dns_failed', `media host ${host} cannot be resolved`, { cause: error });
  }
  if (addresses.length === 0) throw new MediaError('media_dns_failed', `media host ${host} has no addresses`);
  for (const address of addresses) assertIpAllowed(address.address);
}

function assertIpAllowed(address: string): void {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    if (a === 169 && b === 254) {
      throw new MediaError('media_url_blocked', 'media URL resolves to a link-local/metadata address');
    }
    if (a === 0) throw new MediaError('media_url_blocked', 'media URL resolves to an invalid address');
    return;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    throw new MediaError('media_url_blocked', 'media URL resolves to a link-local address');
  }
  if (lower === '::' || lower === '::1') return;
}

function resolveMime(provided: string | undefined, data: Buffer, kind: 'image' | 'video'): string {
  const detected = sniffMime(data);
  const base = (provided ?? '').split(';')[0]?.trim().toLowerCase();
  if (detected) {
    if (!detected.startsWith(`${kind}/`)) {
      throw new MediaError('media_unsupported_type', `detected ${detected}, expected ${kind}`);
    }
    if (base && base !== detected && !base.startsWith('application/octet-stream')) {
      // 服务声明的类型与内容不一致时以内容为准，避免把非图片内容当成图片。
    }
    return detected;
  }
  if (!base || !base.startsWith(`${kind}/`)) {
    throw new MediaError(
      'media_unsupported_type',
      `unsupported media type ${base || 'unknown'}; expected ${kind}`
    );
  }
  if (!base.startsWith('image/') && !base.startsWith('video/')) {
    throw new MediaError('media_unsupported_type', `unsupported media type ${base}`);
  }
  return base;
}

function resolveAudioMime(provided: string, data: Buffer): string {
  const mime = provided.split(';')[0]?.trim().toLowerCase() ?? '';
  const allowed = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/aac', 'audio/flac', 'audio/mp4', 'audio/webm']);
  if (!allowed.has(mime)) throw new MediaError('media_unsupported_type', `unsupported generated audio type ${mime || 'unknown'}`);
  const detected = sniffAudioMime(data);
  if (detected && !compatibleAudioMime(mime, detected)) {
    throw new MediaError('media_unsupported_type', `audio bytes are ${detected}, service declared ${mime}`);
  }
  return detected ?? (mime === 'audio/mp3' || mime === 'audio/x-wav' ? ({ 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav' } as const)[mime] : mime);
}

function sniffAudioMime(data: Buffer): string | undefined {
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (data.length >= 3 && data.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
  return undefined;
}

function compatibleAudioMime(provided: string, detected: string): boolean {
  if (provided === detected) return true;
  return (provided === 'audio/opus' && detected === 'audio/ogg') || (provided === 'audio/mp3' && detected === 'audio/mpeg') || (provided === 'audio/x-wav' && detected === 'audio/wav');
}

function sniffMime(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return undefined;
}

export type { MediaKind };
