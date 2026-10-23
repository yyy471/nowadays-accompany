import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LayeredConfig, mergeLayers } from '../src/config/layered.js';
import { silentLogger } from '../src/core/logger.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('LayeredConfig', () => {
  it('resolves global -> account -> kind -> conversation', () => {
    const config = new LayeredConfig({
      layers: {
        global: { a: 1, b: { x: 1 }, list: [1, 2] },
        byAccount: { '10001': { a: 2, b: { y: 2 } } },
        byKind: { '10001:group': { b: { z: 3 } }, private: { onlyPrivate: true } },
        byConversation: { '10001/group/907906577': { a: 9 } }
      }
    });

    expect(config.resolve({ accountId: '10001', kind: 'group', peerId: '907906577' })).toEqual({
      a: 9,
      b: { x: 1, y: 2, z: 3 },
      list: [1, 2]
    });

    expect(config.resolve({ accountId: '10002', kind: 'private', peerId: '1' })).toEqual({
      a: 1,
      b: { x: 1 },
      list: [1, 2],
      onlyPrivate: true
    });
  });

  it('replaces arrays instead of merging them', () => {
    const merged = mergeLayers({ list: [1, 2, 3], nested: { keep: true } }, { list: [9] });
    expect(merged).toEqual({ list: [9], nested: { keep: true } });
  });

  it('does not leak mutations through snapshot()', () => {
    const config = new LayeredConfig({ layers: { global: { nested: { value: 1 } } } });
    const snapshot = config.snapshot();
    snapshot.global.nested = { value: 99 };
    expect(config.resolve({ accountId: '1', kind: 'private', peerId: '2' })).toEqual({ nested: { value: 1 } });
  });

  it('serializes concurrent writes into one valid file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-config-'));
    roots.push(root);
    const file = path.join(root, 'config.json');
    const config = await LayeredConfig.load(file, silentLogger());

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => config.setGlobal({ [`key${index}`]: index }))
    );

    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { global: Record<string, number> };
    expect(Object.keys(raw.global)).toHaveLength(20);
    expect(Object.values(raw.global)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('starts empty when the file is missing or corrupt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-config-'));
    roots.push(root);
    const missing = await LayeredConfig.load(path.join(root, 'nope.json'), silentLogger());
    expect(missing.snapshot().global).toEqual({});

    const broken = path.join(root, 'broken.json');
    await fs.writeFile(broken, '{not json', 'utf8');
    const loaded = await LayeredConfig.load(broken, silentLogger());
    expect(loaded.snapshot()).toEqual({ global: {}, byAccount: {}, byKind: {}, byConversation: {} });
  });

  it('prefers account-specific kind over the generic kind', () => {
    const config = new LayeredConfig({
      layers: {
        byKind: {
          '10001:group': { model: 'account-kind' },
          group: { model: 'generic-kind' }
        }
      }
    });
    expect(config.resolve({ accountId: '10001', kind: 'group', peerId: '1' })).toEqual({
      model: 'account-kind'
    });
  });

  it('increments version on writes', async () => {
    const config = new LayeredConfig({ layers: { global: { a: 1 } } });
    expect(config.version).toBe(0);
    await config.setGlobal({ b: 2 });
    expect(config.version).toBe(1);
  });

  it('recovers the write chain after one failed persist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-config-'));
    roots.push(root);
    const file = path.join(root, 'config.json');
    const config = await LayeredConfig.load(file, silentLogger());
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.mkdir(tmp, { recursive: true });

    await expect(config.setGlobal({ a: 1 })).rejects.toThrow();
    await fs.rm(tmp, { recursive: true, force: true });
    await config.setGlobal({ a: 2 });

    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { global: Record<string, number> };
    expect(raw.global).toEqual({ a: 2 });
  });
});
