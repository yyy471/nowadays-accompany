import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { SnowLumaBackend } from '../src/injection/snowluma/backend.js';
import { listProfiles, readProfileTokens } from '../src/injection/snowluma/config.js';
import type { InstanceSpec } from '../src/instances/spec.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function runtimeDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-snowluma-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'config', 'runtime.json'),
    JSON.stringify({ webuiPort: 7000, webuiHost: '127.0.0.1' }),
    'utf8'
  );
  return root;
}

async function writeProfile(
  root: string,
  accountId: string,
  options: {
    http: Array<{ name: string; host: string; port: number; accessToken?: string }>;
    ws: Array<{ name: string; host: string; port: number; accessToken?: string }>;
  }
): Promise<void> {
  await fs.writeFile(
    path.join(root, 'config', `onebot_${accountId}.json`),
    JSON.stringify({ networks: { httpServers: options.http, wsServers: options.ws } }),
    'utf8'
  );
}

function spec(root: string, accountId: string): InstanceSpec {
  return { id: 'main', backend: 'snowluma', runtimeDir: root, accountId };
}

describe('SnowLuma profile parsing', () => {
  it('uses the selected server tokens instead of blindly taking the first server', async () => {
    const root = await runtimeDir();
    await writeProfile(root, '10001', {
      http: [
        { name: 'http-old', host: '127.0.0.1', port: 3999, accessToken: 'old-http' },
        { name: 'http-default', host: '127.0.0.1', port: 3000, accessToken: 'selected-http' }
      ],
      ws: [
        { name: 'ws-old', host: '127.0.0.1', port: 4000, accessToken: 'old-ws' },
        { name: 'ws-default', host: '127.0.0.1', port: 3001, accessToken: 'selected-ws' }
      ]
    });
    const profiles = await listProfiles(root);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.http.port).toBe(3000);
    expect(profiles[0]?.ws.port).toBe(3001);
    expect(await readProfileTokens(profiles[0]!)).toEqual({
      httpToken: 'selected-http',
      wsToken: 'selected-ws'
    });
  });

  it('refuses non-loopback endpoints', async () => {
    const root = await runtimeDir();
    await writeProfile(root, '10002', {
      http: [{ name: 'http-default', host: '0.0.0.0', port: 3000, accessToken: 'a' }],
      ws: [{ name: 'ws-default', host: '0.0.0.0', port: 3001, accessToken: 'b' }]
    });
    const backend = new SnowLumaBackend({ runtimeDir: root, logger: silentLogger() });
    await expect(backend.start(spec(root, '10002'))).rejects.toThrow(/not loopback/);
  });

  it('requires an access token unless tokenless mode is explicitly enabled', async () => {
    const root = await runtimeDir();
    await writeProfile(root, '10003', {
      http: [{ name: 'http-default', host: '127.0.0.1', port: 3000 }],
      ws: [{ name: 'ws-default', host: '127.0.0.1', port: 3001 }]
    });
    const backend = new SnowLumaBackend({ runtimeDir: root, logger: silentLogger() });
    await expect(backend.start(spec(root, '10003'))).rejects.toThrow(/no accessToken/);
  });
});
