import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import type { InjectionBackend } from '../src/injection/contract.js';
import { waitFor } from './phase1-helpers.js';

// Independent acceptance: use a real loopback management HTTP fixture, never user QQ/runtime.
const cores: Core[] = [];
const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.(); server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.join(os.tmpdir(), 'accompany-dynamic-review-'))) throw new Error('unexpected test cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

async function fixture(options: { autoStart?: boolean; pollMs?: number; resume?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-dynamic-review-'));
  roots.push(root);
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(path.join(runtime, 'config'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'snowluma', version: '1.14.19' }));
  let loads = 0;
  let unavailable = false;
  const processes = [
    { pid: 4242, name: 'QQ.exe', path: 'C:/QQ/QQ.exe', injected: false, connected: false, loggedIn: true, uin: '10001', status: 'ready' },
    { pid: 4343, name: 'QQ.exe', path: 'C:/QQ/QQ.exe', injected: false, connected: false, loggedIn: true, uin: '10002', status: 'ready' }
  ];
  const server = http.createServer((request, response) => {
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    const url = request.url ?? '';
    if (url === '/api/login') { request.resume(); return send(200, { success: true, token: 'fixture-only' }); }
    if (url === '/api/processes') return unavailable ? send(503, { message: 'fixture transient failure' }) : send(200, { list: processes });
    const match = /^\/api\/processes\/(\d+)\/(load|unload|probe-login|refresh)$/.exec(url);
    const proc = processes.find((item) => item.pid === Number(match?.[1]));
    if (!match || !proc) return send(404, { success: false });
    if (match[2] === 'probe-login') return send(200, { success: true, info: { uin: proc.uin, nickname: 'fixture' } });
    if (match[2] === 'load') { loads += 1; proc.injected = true; proc.connected = true; }
    if (match[2] === 'unload') { proc.injected = false; proc.connected = false; }
    return send(200, { success: true, process: proc });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await fs.writeFile(path.join(runtime, 'config', 'runtime.json'), JSON.stringify({ webuiHost: '127.0.0.1', webuiPort: port, hookAutoLoad: false }));
  const start = async () => {
    const backend: InjectionBackend = {
      kind: 'snowluma', capabilities: { launch: false, attach: true, multiInstance: true },
      probe: async () => ({ backend: 'snowluma', ok: true, warnings: [], instances: [] }),
      start: async () => ({ httpBaseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1' }),
      stop: async () => {}, status: async () => ({ running: true })
    };
    const core = await createCore({
      dataRoot: root, instances: [], persistSlots: true, manualStartOnly: true,
      autoStartSnowLuma: options.autoStart ?? false,
      ...(options.pollMs ? { injectionPollIntervalMs: options.pollMs } : {}),
      avatarFetchImpl: (async () => new Response(Buffer.from('process-avatar'), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })) as typeof fetch,
      backendFactory: () => backend,
      channelFactory: (context) => new FakeChannel(context, { selfId: context.spec.accountId }),
      api: { enabled: true, host: '127.0.0.1', port: 0, token: 'dynamic-review-only' },
      credentialVault: new MemoryCredentialVault(), logger: silentLogger('dynamic-independent')
    });
    cores.push(core);
    await core.start();
    await core.setInjectionSettings({
      runtimeDir: runtime,
      baseUrl: `http://127.0.0.1:${port}`,
      ...(options.resume ? { resumeLastListen: true } : {})
    }, 'fixture-secret');
    return core;
  };
  const core = await start();
  return { core, root, runtime, start, processes, loads: () => loads, fail: (value: boolean) => { unavailable = value; } };
}

const identity = (pid = 4242) => ({ pid, path: 'C:/QQ/QQ.exe' });

describe('independent dynamic QQ connection acceptance', () => {
  it('reports missing auto-load configuration as unknown and refuses injection', async () => {
    const h = await fixture();
    const file = path.join(h.runtime, 'config', 'runtime.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    delete config.hookAutoLoad;
    await fs.writeFile(file, JSON.stringify(config));
    expect((await h.core.injectionStatus()).autoLoadKnown).toBe(false);
    expect(await h.core.injectAndListen({ identity: identity() })).toMatchObject({ state: 'failed', error: { code: 'snowluma_autoload_unknown' } });
    expect(h.loads()).toBe(0);
    expect(h.core.slotSpecs()).toHaveLength(0);
  });
  it('reuses a running management service during automatic startup without injecting QQ', async () => {
    const h = await fixture({ autoStart: true });
    await waitFor(async () => (await h.core.injectionStatus()).startupState === 'external');
    expect(h.loads()).toBe(0);
    expect(h.core.slotSpecs()).toHaveLength(0);
  });
  it('discovers QQ processes without creating slots or injecting', async () => {
    const h = await fixture();
    expect(await h.core.injectionProcesses()).toHaveLength(2);
    expect(h.core.slotSpecs()).toHaveLength(0);
    expect(h.loads()).toBe(0);
  });

  it('resolves QQ avatars for process cards through the shared avatar pipeline', async () => {
    const h = await fixture();
    const processes = await h.core.injectionProcesses({ avatars: true });
    const expected = `data:image/png;base64,${Buffer.from('process-avatar').toString('base64')}`;
    expect(processes.map((process) => process.avatarDataUrl)).toEqual([expected, expected]);
  });

  it('accepts a process-only request and merges duplicate clicks into one real-account host', async () => {
    const h = await fixture();
    const [first, second] = await Promise.all([
      h.core.injectAndListen({ identity: identity() }),
      h.core.injectAndListen({ identity: identity() })
    ]);
    expect(first.state).toBe('succeeded');
    expect(second.state).toBe('succeeded');
    expect(h.loads()).toBe(1);
    expect(h.core.slotSpecs()).toHaveLength(1);
    expect(h.core.status().instances).toEqual([expect.objectContaining({ accountId: '10001', state: 'online' })]);
  });

  it('accepts the ordinary process-only REST action without a slot form', async () => {
    const h = await fixture();
    const response = await fetch(`${h.core.status().apiUrl}/injection/processes/4242/inject-and-listen`, {
      method: 'POST', headers: { authorization: 'Bearer dynamic-review-only', 'content-type': 'application/json' },
      body: JSON.stringify({ identity: identity() })
    });
    expect(response.ok).toBe(true);
    const body = await response.json() as { operation: { state: string } };
    expect(body.operation.state).toBe('succeeded');
    expect(h.core.status().instances[0]?.accountId).toBe('10001');
    const id = h.core.status().instances[0]!.id;
    const stopped = await fetch(`${h.core.status().apiUrl}/instances/${id}/stop`, {
      method: 'POST', headers: { authorization: 'Bearer dynamic-review-only' }
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ ok: true, removed: true, instance: null });
    expect(h.core.slotSpecs()).toHaveLength(0);
  });

  it('connects two accounts independently and preserves existing local account data', async () => {
    const h = await fixture();
    for (const id of ['10001', '10002']) {
      const dir = path.join(h.root, 'accounts', id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'display.json'), JSON.stringify({ version: 1, nickname: `saved-${id}`, signature: 'saved-signature' }));
    }
    const results = await Promise.all([h.core.injectAndListen({ identity: identity() }), h.core.injectAndListen({ identity: identity(4343) })]);
    expect(results.map((result) => result.state)).toEqual(['succeeded', 'succeeded']);
    expect(h.core.status().instances.map((item) => item.accountId).sort()).toEqual(['10001', '10002']);
    expect((await h.core.getAccountDisplay('10001')).nickname).toBe('saved-10001');
    expect((await h.core.getAccountDisplay('10002')).nickname).toBe('saved-10002');
    expect(h.loads()).toBe(2);
  });

  it('does not restore listening or inject when the application restarts', async () => {
    const h = await fixture();
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    await h.core.saveAccountDisplay('10001', { nickname: 'retained', signature: 'retained' });
    await h.core.stop();
    const restarted = await h.start();
    expect(restarted.status().instances.every((item) => item.state === 'stopped')).toBe(true);
    expect(restarted.diagnostics().desired['qq-10001']).toBeUndefined();
    expect(h.loads()).toBe(1);
    expect((await restarted.getAccountDisplay('10001')).nickname).toBe('retained');
  });

  it('restores the last listening slot after restart but listens only on an explicit resume', async () => {
    const h = await fixture({ resume: true });
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    await h.core.stop();
    h.processes[0]!.injected = true;
    h.processes[0]!.connected = true;
    const restarted = await h.start();
    expect(restarted.slotSpecs()).toEqual([
      expect.objectContaining({ id: 'qq-10001', accountId: '10001', backend: 'snowluma' })
    ]);
    expect(restarted.status().instances).toEqual([
      expect.objectContaining({ id: 'qq-10001', desiredState: 'running', state: 'stopped' })
    ]);
    expect(h.loads()).toBe(1);

    const result = await restarted.resumeInjectionListening();
    expect(result).toMatchObject({ attempted: 1, resumed: [{ slotId: 'qq-10001', accountId: '10001', uin: '10001' }] });
    expect(h.loads()).toBe(1);
    expect(restarted.status().instances[0]?.state).toBe('online');
  });

  it('does not restore a listening slot the user stopped before quitting', async () => {
    const h = await fixture();
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    const id = h.core.status().instances[0]!.id;
    await h.core.stopInstance(id);
    await h.core.stop();
    const restarted = await h.start();
    expect(restarted.slotSpecs()).toHaveLength(0);
  });

  it('recycles a stopped internal slot while retaining account display data', async () => {
    const h = await fixture();
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    await h.core.saveAccountDisplay('10001', { nickname: 'after-stop', signature: 'persist' });
    const id = h.core.status().instances[0]!.id;
    await h.core.stopInstance(id);
    expect(h.core.slotSpecs()).toHaveLength(0);
    expect((await h.core.getAccountDisplay('10001')).nickname).toBe('after-stop');
    expect((await h.core.listenInjection({ identity: identity() })).state).toBe('succeeded');
    expect(h.loads()).toBe(1);
    expect(h.core.status().instances[0]?.accountId).toBe('10001');
  });

  it('ignores transient management failures and recycles only after repeated successful missing-process snapshots', async () => {
    const h = await fixture();
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    await h.core.saveAccountDisplay('10001', { nickname: 'after-exit', signature: 'persist' });
    h.fail(true);
    await expect(h.core.injectionProcesses()).rejects.toThrow();
    await expect(h.core.injectionProcesses()).rejects.toThrow();
    expect(h.core.status().instances[0]?.state).toBe('online');
    h.fail(false);
    h.processes.splice(0, 1);
    await h.core.injectionProcesses();
    expect(h.core.slotSpecs()).toHaveLength(1);
    await h.core.injectionProcesses();
    expect(h.core.slotSpecs()).toHaveLength(0);
    expect((await h.core.getAccountDisplay('10001')).nickname).toBe('after-exit');
  });

  it('recycles an exited QQ while no renderer is polling', async () => {
    const h = await fixture({ pollMs: 20 });
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    h.processes.splice(0, 1);
    await waitFor(() => h.core.slotSpecs().length === 0);
    expect(h.loads()).toBe(1);
  });

  it('recycles a QQ process whose injection and protocol connection have both disappeared', async () => {
    const h = await fixture();
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    h.processes[0]!.injected = false;
    h.processes[0]!.connected = false;
    await h.core.injectionProcesses();
    expect(h.core.slotSpecs()).toHaveLength(1);
    await h.core.injectionProcesses();
    expect(h.core.slotSpecs()).toHaveLength(0);
  });

  it('drops an old account connection on same-PID account change without automatically connecting the new one', async () => {
    const h = await fixture();
    expect((await h.core.injectAndListen({ identity: identity() })).state).toBe('succeeded');
    h.processes[0]!.uin = '10003';
    await h.core.injectionProcesses();
    expect(h.core.slotSpecs()).toHaveLength(0);
    expect(h.loads()).toBe(1);
    expect((await h.core.listenInjection({ identity: identity() })).state).toBe('succeeded');
    expect(h.core.status().instances[0]?.accountId).toBe('10003');
  });

  it('replaces the old listener when the same PID changes account before a process scan', async () => {
    const h = await fixture();
    const identity = { pid: 4242, path: 'C:/QQ/QQ.exe' };
    expect((await h.core.injectAndListen({ identity })).state).toBe('succeeded');
    h.processes[0]!.uin = '10003';
    expect((await h.core.listenInjection({ identity })).state).toBe('succeeded');
    expect(h.core.slotSpecs().map((spec) => spec.accountId)).toEqual(['10003']);
    expect(h.core.status().instances.filter((item) => item.state === 'online').map((item) => item.accountId)).toEqual(['10003']);
  });
});
