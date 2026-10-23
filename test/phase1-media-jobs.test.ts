import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaService } from '../src/media/service.js';
import { MediaJobService } from '../src/jobs/service.js';
import { MediaError } from '../src/providers/errors.js';
import { silentLogger } from '../src/core/logger.js';
import type { MediaRef } from '../src/media/types.js';
import {
  inbound,
  imageSegment,
  TINY_PNG,
  videoSegment,
  waitFor
} from './phase1-helpers.js';

const roots: string[] = [];
const servers: http.Server[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(disposers.splice(0).map((dispose) => dispose()));
  await Promise.allSettled(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-p1-media-'));
  roots.push(dir);
  return dir;
}

async function mediaServer(): Promise<{ url: string }> {
  const server = http.createServer((request, response) => {
    if (request.url === '/img') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': TINY_PNG.length });
      response.end(TINY_PNG);
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/img' });
      response.end();
      return;
    }
    if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' });
      response.end();
      return;
    }
    if (request.url === '/huge') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': 100_000_000 });
      response.end(TINY_PNG);
      return;
    }
    if (request.url === '/text') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not an image');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server failed to bind');
  return { url: `http://127.0.0.1:${address.port}` };
}

function makeMedia(rootDir: string, options: { now?: () => number; maxImageBytes?: number } = {}): MediaService {
  const service = new MediaService({
    accountDir: (accountId) => path.join(rootDir, 'accounts', accountId),
    maxImageBytes: options.maxImageBytes ?? 8 * 1024 * 1024,
    maxVideoBytes: 32 * 1024 * 1024,
    maxDownloadMs: 2_000,
    maxRedirects: 2,
    retentionDays: 1,
    ...(options.now ? { now: options.now } : {}),
    logger: silentLogger('media-test')
  });
  return service;
}

function makeJobs(
  rootDir: string,
  options: {
    maxConcurrentJobs?: number;
    maxAccountConcurrentJobs?: number;
    maxPendingJobs?: number;
    maxPerAccountPending?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {}
): MediaJobService {
  const service = new MediaJobService({
    accountDir: (accountId) => path.join(rootDir, 'accounts', accountId, 'jobs'),
    maxConcurrentJobs: options.maxConcurrentJobs ?? 2,
    maxAccountConcurrentJobs: options.maxAccountConcurrentJobs ?? 1,
    maxPendingJobs: options.maxPendingJobs ?? 8,
    maxPerAccountPending: options.maxPerAccountPending ?? 4,
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.now ? { now: options.now } : {}),
    logger: silentLogger('jobs-test')
  });
  disposers.push(() => service.dispose());
  return service;
}

const conv = (accountId = '10001') => ({ accountId, kind: 'private' as const, peerId: '555' });

describe('phase 1 account media', () => {
  it('downloads bounded media, validates type and keeps accounts isolated', async () => {
    const dir = await root();
    const { url } = await mediaServer();
    const media = makeMedia(dir);
    const refs = await media.ingestInbound(
      '10001',
      conv(),
      inbound('a', '10001', '555', 'm1', [{ type: 'image', data: { url: `${url}/img` } }])
    );
    expect(refs).toHaveLength(1);
    const read = await media.read('10001', refs[0]!.mediaId);
    expect(read.ref.mimeType).toBe('image/png');
    expect(read.data.equals(TINY_PNG)).toBe(true);
    await expect(media.read('10002', refs[0]!.mediaId)).rejects.toMatchObject({ code: 'media_not_found' });

    await expect(
      media.ingestInbound(
        '10001',
        conv(),
        inbound('a', '10001', '555', 'm2', [{ type: 'image', data: { url: `${url}/huge` } }])
      )
    ).rejects.toMatchObject({ code: 'media_too_large' });

    await expect(
      media.ingestInbound(
        '10001',
        conv(),
        inbound('a', '10001', '555', 'm3', [{ type: 'image', data: { url: `${url}/text` } }])
      )
    ).rejects.toMatchObject({ code: 'media_unsupported_type' });

    await expect(
      media.ingestInbound(
        '10001',
        conv(),
        inbound('a', '10001', '555', 'm4', [{ type: 'image', data: { url: `${url}/loop` } }])
      )
    ).rejects.toMatchObject({ code: 'media_redirect_limit' });
    await media.dispose();
  });

  it('blocks metadata and non-http media URLs instead of reading local paths', async () => {
    const dir = await root();
    const media = makeMedia(dir);
    await expect(
      media.ingestInbound(
        '10001',
        conv(),
        inbound('a', '10001', '555', 'm5', [{ type: 'image', data: { url: 'http://169.254.169.254/latest/meta-data' } }])
      )
    ).rejects.toBeInstanceOf(MediaError);
    await expect(
      media.ingestInbound(
        '10001',
        conv(),
        inbound('a', '10001', '555', 'm6', [{ type: 'image', data: { file: 'C:\\secret\\local.png' } }])
      )
    ).rejects.toMatchObject({ code: 'media_unavailable' });
    await media.dispose();
  });

  it('normalizes base64/URL generated images and rejects remote filesystem paths and asset ids', async () => {
    const dir = await root();
    const { url } = await mediaServer();
    const media = makeMedia(dir);
    const refs = await media.ingestGenerated('10001', conv(), 'job-1', [
      { mimeType: 'image/png', base64: TINY_PNG.toString('base64') },
      { mimeType: 'image/png', url: `${url}/img` }
    ]);
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.source.jobId === 'job-1' && ref.source.direction === 'out')).toBe(true);

    await expect(
      media.ingestGenerated('10001', conv(), 'job-2', [{ url: 'C:\\remote\\file.png' }])
    ).rejects.toMatchObject({ code: 'media_url_invalid' });
    await expect(
      media.ingestGenerated('10001', conv(), 'job-3', [{ assetId: 'remote-asset' }])
    ).rejects.toMatchObject({ code: 'media_asset_unsupported' });

    await expect(
      media.ingestGenerated('10002', conv('10001'), 'job-4', [{ base64: TINY_PNG.toString('base64') }])
    ).rejects.toMatchObject({ code: 'media_account_mismatch' });
    await media.dispose();
  });

  it('cleans expired media but skips media referenced by active work', async () => {
    const dir = await root();
    let now = 1_000_000;
    const media = makeMedia(dir, { now: () => now });
    const refs = await media.ingestInbound(
      '10001',
      conv(),
      inbound('a', '10001', '555', 'm7', [imageSegment()])
    );
    const kept = refs[0]!;
    const second = await media.ingestInbound(
      '10001',
      conv(),
      inbound('a', '10001', '555', 'm8', [imageSegment(), { type: 'text', data: { text: 'x' } }])
    );
    now += 2 * 24 * 60 * 60 * 1_000;
    const result = await media.cleanup(new Map([['10001', new Set([kept.mediaId])]]));
    expect(result.skippedInUse).toContain(kept.mediaId);
    expect(result.deleted).toContain(second[0]!.mediaId);
    expect(await media.read('10001', kept.mediaId)).toBeTruthy();
    await expect(media.read('10001', second[0]!.mediaId)).rejects.toMatchObject({ code: 'media_not_found' });
    await media.dispose();
  });
});

describe('phase 1 media jobs', () => {
  it('deduplicates action IDs per account without crossing accounts', async () => {
    const dir = await root();
    const jobs = makeJobs(dir);
    const input = {
      conversation: conv(),
      capability: 'image.generate' as const,
      turnId: 't1',
      sessionEpoch: 1,
      cancelMode: 'none' as const,
      actionId: 'same-action',
      executor: async () => ({ text: 'done' })
    };
    const first = await jobs.submit({ ...input, accountId: '10001' });
    const second = await jobs.submit({ ...input, accountId: '10001' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);

    const other = await jobs.submit({ ...input, accountId: '10002', conversation: conv('10002') });
    expect(other.duplicate).toBe(false);
    expect(other.job.id).not.toBe(first.job.id);
    await waitFor(async () => (await jobs.get('10001', first.job.id))?.state === 'succeeded');
  });

  it('cancels a running job locally and records that remote cancellation is not claimed', async () => {
    const dir = await root();
    const jobs = makeJobs(dir);
    const submitted = await jobs.submit({
      accountId: '10001',
      conversation: conv(),
      capability: 'video.understand',
      turnId: 't1',
      sessionEpoch: 1,
      cancelMode: 'remote',
      executor: (context) =>
        new Promise<never>((_, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        })
    });
    await waitFor(async () => (await jobs.get('10001', submitted.job.id))?.state === 'running');
    await jobs.cancel('10001', submitted.job.id);
    await waitFor(async () => (await jobs.get('10001', submitted.job.id))?.state === 'cancelled');
    const cancelled = await jobs.get('10001', submitted.job.id);
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancelRequested: true,
      remoteCancelled: false,
      delivery: 'skipped'
    });
    expect(cancelled?.note).toContain('local cancellation');
  });

  it('marks non-terminal jobs interrupted after a restart without resubmitting them', async () => {
    const dir = await root();
    const jobs = makeJobs(dir);
    const submitted = await jobs.submit({
      accountId: '10001',
      conversation: conv(),
      capability: 'video.understand',
      turnId: 't1',
      sessionEpoch: 1,
      cancelMode: 'localOnly',
      executor: (context) =>
        new Promise<never>((_, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        })
    });
    await waitFor(async () => (await jobs.get('10001', submitted.job.id))?.state === 'running');
    await jobs.dispose();
    const reopened = makeJobs(dir);
    const recovered = await reopened.get('10001', submitted.job.id);
    expect(recovered).toMatchObject({ state: 'interrupted', delivery: 'skipped' });
    expect(recovered?.note).toMatch(/not resubmitted/);
  });

  it('runs at most one media job per account and keeps waiting jobs queued', async () => {
    const dir = await root();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const jobs = makeJobs(dir);
    const submit = (index: number) =>
      jobs.submit({
        accountId: '10001',
        conversation: conv(),
        capability: 'image.generate',
        turnId: `t${index}`,
        sessionEpoch: 1,
        cancelMode: 'none',
        executor: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return {};
        }
      });
    const first = await submit(1);
    const second = await submit(2);
    await waitFor(() => releases.length === 1);
    expect((await jobs.get('10001', first.job.id))?.state).toBe('running');
    expect((await jobs.get('10001', second.job.id))?.state).toBe('queued');
    releases.shift()?.();
    await waitFor(async () => (await jobs.get('10001', second.job.id))?.state === 'running');
    releases.shift()?.();
    await waitFor(async () => (await jobs.get('10001', second.job.id))?.state === 'succeeded');
    expect(maxActive).toBe(1);
  });

  it('keeps completed-but-undelivered media in use until delivery is marked', async () => {
    const dir = await root();
    const jobs = makeJobs(dir);
    const mediaRef: MediaRef = {
      mediaId: '11111111-1111-4111-8111-111111111111',
      accountId: '10001',
      kind: 'image',
      mimeType: 'image/png',
      bytes: 10,
      sha256: 'a'.repeat(64),
      createdAt: 1,
      expiresAt: 2,
      retention: 'temporary',
      source: { conversation: conv(), jobId: 'job-1' }
    };
    const submitted = await jobs.submit({
      accountId: '10001',
      conversation: conv(),
      capability: 'image.generate',
      turnId: 't1',
      sessionEpoch: 1,
      cancelMode: 'none',
      executor: async () => ({ media: [mediaRef] })
    });
    await waitFor(async () => (await jobs.get('10001', submitted.job.id))?.state === 'succeeded');
    expect(await jobs.inUseMedia('10001')).toContain(mediaRef.mediaId);
    await jobs.markDelivery('10001', submitted.job.id, 'sent');
    expect(await jobs.inUseMedia('10001')).not.toContain(mediaRef.mediaId);
  });

  it('recovers a queued job as interrupted on restart', async () => {
    const dir = await root();
    const jobs = makeJobs(dir, { maxConcurrentJobs: 1, maxAccountConcurrentJobs: 1 });
    const releases: Array<() => void> = [];
    const first = await jobs.submit({
      accountId: '10001',
      conversation: conv(),
      capability: 'image.generate',
      turnId: 't1',
      sessionEpoch: 1,
      cancelMode: 'none',
      executor: async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return {};
      }
    });
    await waitFor(() => releases.length === 1);
    const queued = await jobs.submit({
      accountId: '10001',
      conversation: conv(),
      capability: 'image.generate',
      turnId: 't2',
      sessionEpoch: 1,
      cancelMode: 'none',
      executor: async () => ({})
    });
    expect((await jobs.get('10001', queued.job.id))?.state).toBe('queued');
    await jobs.dispose();
    const reopened = makeJobs(dir);
    expect(await reopened.get('10001', queued.job.id)).toMatchObject({ state: 'interrupted' });
    expect(await reopened.get('10001', first.job.id)).toMatchObject({ state: 'interrupted' });
  });

  it('ignores late executor completion after cancellation', async () => {
    const dir = await root();
    const jobs = makeJobs(dir);
    let finish!: () => void;
    const submitted = await jobs.submit({
      accountId: '10001',
      conversation: conv(),
      capability: 'video.understand',
      turnId: 't1',
      sessionEpoch: 1,
      cancelMode: 'localOnly',
      executor: async (context) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { text: 'late result' };
      }
    });
    await waitFor(async () => (await jobs.get('10001', submitted.job.id))?.state === 'running');
    await jobs.cancel('10001', submitted.job.id);
    await waitFor(async () => (await jobs.get('10001', submitted.job.id))?.state === 'cancelled');
    finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await jobs.get('10001', submitted.job.id))?.state).toBe('cancelled');
  });
});
