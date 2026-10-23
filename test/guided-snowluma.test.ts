import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';

const roots: string[] = [];
const cores: Core[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nowadays-guided-')) throw new Error('unexpected fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(options: { password?: string; consent?: boolean; autoLoad?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-guided-'));
  roots.push(root);
  const runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(path.join(runtimeDir, 'config'), { recursive: true });
  await fs.writeFile(path.join(runtimeDir, 'package.json'), JSON.stringify({ version: '1.14.19' }));
  let logins = 0;
  let reads = 0;
  let writes = 0;
  let spawns = 0;
  const server = http.createServer(async (request, response) => {
    const send = (code: number, body: unknown) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url === '/api/login') {
      logins++;
      let body = ''; for await (const part of request) body += part;
      if (options.consent) return send(403, { consentRequired: true });
      return JSON.parse(body).password === 'fixture-password'
        ? send(200, { success: true, token: 'fixture-token' }) : send(401, { message: '管理密码错误' });
    }
    if (request.url === '/api/processes' && request.headers.authorization === 'Bearer fixture-token') {
      reads++;
      return send(200, { list: [{ pid: 4141, name: 'QQ.exe', injected: false, connected: false, loggedIn: true, uin: '10001', status: 'ready' }] });
    }
    writes++; send(400, {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const runtimeFile = path.join(runtimeDir, 'config', 'runtime.json');
  const runtimeText = JSON.stringify({ webuiHost: '127.0.0.1', webuiPort: port, hookAutoLoad: options.autoLoad ?? false });
  await fs.writeFile(runtimeFile, runtimeText);
  const core = await createCore({
    dataRoot: path.join(root, 'data'), instances: [], manualStartOnly: true, autoStartSnowLuma: false,
    snowLumaRuntimeOptions: { spawnImpl: (() => { spawns++; throw new Error('must never launch a runtime'); }) as never },
    credentialVault: new MemoryCredentialVault(), logger: silentLogger('guided-test'),
    api: { enabled: true, host: '127.0.0.1', port: 0, token: 'guided-only' }
  });
  cores.push(core); await core.start();
  await core.setInjectionSettings({ runtimeDir }, options.password ?? 'fixture-password');
  const post = async (route = '/injection/connection/test') => {
    const response = await fetch(`${core.status().apiUrl}${route}`, { method: 'POST', headers: { authorization: 'Bearer guided-only' } });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { core, server, post, runtimeFile, runtimeText, counts: () => ({ logins, reads, writes, spawns }) };
}

describe('guided external SnowLuma connection', () => {
  it('authenticates a real management request without spawning, injecting, or changing official files', async () => {
    const h = await fixture();
    const result = await h.post();
    expect(result).toMatchObject({ status: 200, body: { ok: true, processCount: 1, runtime: { authenticated: true, owner: 'external', startupState: 'external' } } });
    expect(h.counts()).toEqual({ logins: 1, reads: 1, writes: 0, spawns: 0 });
    expect(h.core.slotSpecs()).toHaveLength(0);
    expect(await fs.readFile(h.runtimeFile, 'utf8')).toBe(h.runtimeText);
    await h.core.stop();
    expect(h.server.listening).toBe(true);
  });
  it('does not report a bad password as a successful connection', async () => {
    const h = await fixture({ password: 'wrong-password' });
    const result = await h.post();
    expect(result.status).not.toBe(200);
    expect(result.body.code).toBe('snowluma_auth_failed');
    expect(h.counts().reads).toBe(0);
    expect(h.counts().spawns).toBe(0);
  });
  it('keeps official agreement acceptance in the official initialization flow', async () => {
    const h = await fixture({ consent: true });
    const result = await h.post();
    expect(result.status).not.toBe(200);
    expect(result.body.code).toBe('snowluma_consent_required');
    expect((await h.core.injectionStatus()).consentRequired).toBe(true);
    expect(h.counts().writes).toBe(0);
  });
  it('blocks connection readiness while automatic injection is enabled', async () => {
    const h = await fixture({ autoLoad: true });
    const result = await h.post();
    expect(result.body.code).toBe('snowluma_autoload_invalid');
    expect(h.counts().logins).toBe(0);
  });
  it('asks users to start an offline service instead of launching it', async () => {
    const h = await fixture();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
    const result = await h.post();
    expect(result.body.code).toBe('snowluma_unreachable');
    expect(h.counts().spawns).toBe(0);
  });
  it('rejects the legacy managed-start endpoint in external mode', async () => {
    const h = await fixture();
    const result = await h.post('/injection/runtime/retry');
    expect(result.status).not.toBe(200);
    expect(result.body.code).toBe('snowluma_managed_disabled');
    expect(h.counts().spawns).toBe(0);
  });
});
