import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '../src/core/core.js';
import { createCore } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import {
  SNOWLUMA_MANAGEMENT_CREDENTIAL_REF,
  SnowLumaManager
} from '../src/injection/snowluma/manager.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { BackendStatus, InjectionBackend, ProbeReport, RuntimeEndpoints } from '../src/injection/contract.js';
import { createTestCore } from './helpers.js';

const roots: string[] = [];
const cores: Core[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
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

interface FakeOptions {
  uin?: string;
  probeInfo?: unknown;
  probeFails?: boolean;
  version?: string;
  hookAutoLoad?: boolean;
  consentRequired?: boolean;
  needsTotp?: boolean;
  wrongPassword?: boolean;
}

interface FakeManagement {
  url: string;
  loginCount(): number;
  loadCount(): number;
  unloadCount(): number;
  expireTokens(): void;
}

async function fakeManagement(options: FakeOptions = {}): Promise<FakeManagement> {
  let activeToken: string | undefined;
  let logins = 0;
  let loads = 0;
  let unloads = 0;
  let tokenGeneration = 0;
  const process = {
    pid: 4242,
    name: 'QQ.exe',
    path: 'C:/Program Files/Tencent/QQ/QQ.exe',
    injected: false,
    connected: false,
    loggedIn: true,
    uin: options.uin ?? '10001',
    status: 'ready',
    error: null,
    method: null
  };
  const server = http.createServer((request, response) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const url = request.url ?? '/';
    if (request.method === 'POST' && url === '/api/login') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        if (options.needsTotp) return send(200, { success: false, needsTotp: true });
        if (options.wrongPassword) return send(401, { success: false, message: '密码错误' });
        logins += 1;
        tokenGeneration += 1;
        activeToken = `token-${tokenGeneration}`;
        send(200, { success: true, token: activeToken, mustChangePassword: false });
      });
      return;
    }
    const auth = request.headers.authorization;
    if (!activeToken || auth !== `Bearer ${activeToken}`) {
      return send(401, { status: 'failed', message: 'Token expired or invalid' });
    }
    if (options.consentRequired) {
      return send(403, { success: false, message: '请先阅读并同意用户协议与隐私政策', consentRequired: true });
    }
    if (request.method === 'GET' && url === '/api/processes') {
      return send(200, { list: [process] });
    }
    if (request.method === 'POST' && url === '/api/processes/4242/load') {
      loads += 1;
      process.injected = true;
      process.connected = true;
      return send(200, { success: true, process });
    }
    if (request.method === 'POST' && url === '/api/processes/4242/unload') {
      unloads += 1;
      process.injected = false;
      process.connected = false;
      return send(200, { success: true, process });
    }
    if (request.method === 'POST' && url === '/api/processes/4242/refresh') {
      return send(200, { success: true, process });
    }
    if (request.method === 'GET' && url === '/api/processes/4242/probe-login') {
      if (options.probeFails) return send(503, { message: 'probe unavailable' });
      return send(200, { info: options.probeInfo ?? { uin: 10001, nickname: 'tester' } });
    }
    send(404, { message: 'not found' });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake management failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    loginCount: () => logins,
    loadCount: () => loads,
    unloadCount: () => unloads,
    expireTokens: () => {
      activeToken = undefined;
    }
  };
}

async function runtimeDir(options: FakeOptions = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-snowluma-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'snowluma', version: options.version ?? '1.14.19' }, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(root, 'config', 'runtime.json'),
    `${JSON.stringify(
      { webuiHost: '127.0.0.1', webuiPort: 5099, hookAutoLoad: options.hookAutoLoad === true, webuiTls: { enabled: false } },
      null,
      2
    )}\n`
  );
  return root;
}

class LoopbackBackend implements InjectionBackend {
  readonly kind = 'snowluma';
  readonly capabilities = { launch: false, attach: true, multiInstance: true };

  async probe(): Promise<ProbeReport> {
    return { backend: this.kind, ok: true, warnings: [], instances: [] };
  }
  async start(): Promise<RuntimeEndpoints> {
    return { httpBaseUrl: 'http://127.0.0.1:3300', wsUrl: 'ws://127.0.0.1:3301' };
  }
  async stop(): Promise<void> {}
  async status(): Promise<BackendStatus> {
    return { running: true };
  }
}

async function managerFor(options: FakeOptions = {}): Promise<{
  manager: SnowLumaManager;
  vault: MemoryCredentialVault;
  fake: FakeManagement;
}> {
  const fake = await fakeManagement(options);
  const vault = new MemoryCredentialVault();
  await vault.set(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF, 'secret');
  const dir = await runtimeDir(options);
  const manager = new SnowLumaManager({
    vault,
    logger: silentLogger('snowluma-test'),
    settings: { runtimeDir: dir, baseUrl: fake.url }
  });
  return { manager, vault, fake };
}

describe('snowluma management client', () => {
  it('shows pre-injection identity hints without binding an account or loading QQ', async () => {
    const { manager, fake } = await managerFor({ uin: '0', probeInfo: { uin: '10002', nickName: '青禾', identityKnown: true } });
    const probe = vi.spyOn(manager, 'probeLogin');
    const [process] = await manager.listProcesses({ probeIdentity: true });
    expect(process).toMatchObject({ pid: 4242, nickname: '青禾', accountHint: { uin: '10002', nickname: '青禾' } });
    expect(process?.uin).toBeUndefined();
    expect(process?.injected).toBe(false);
    await manager.listProcesses({ probeIdentity: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fake.loadCount()).toBe(0);
  });

  it('does not replace a connected identity with a conflicting probe hint', async () => {
    const { manager } = await managerFor({ probeInfo: { uin: '10002', nickName: 'another account', identityKnown: true } });
    const [process] = await manager.listProcesses({ probeIdentity: true });
    expect(process?.uin).toBe('10001');
    expect(process?.accountHint).toBeUndefined();
    expect(process?.nickname).toBeUndefined();
  });

  it.each([
    { probeInfo: { uin: '0', nickName: 'invalid' } },
    { probeInfo: { uin: '10002', nickName: 'unknown', identityKnown: false } },
    { probeFails: true }
  ])('keeps an unidentified QQ visible when probing fails or is invalid: %j', async (options) => {
    const { manager } = await managerFor({ uin: '0', ...options });
    const processes = await manager.listProcesses({ probeIdentity: true });
    expect(processes).toHaveLength(1);
    expect(processes[0]?.uin).toBeUndefined();
    expect(processes[0]?.accountHint).toBeUndefined();
  });

  it('logs in, lists processes and never exposes the password', async () => {
    const { manager, fake } = await managerFor();
    const processes = await manager.listProcesses();
    expect(fake.loginCount()).toBe(1);
    expect(processes).toEqual([
      {
        pid: 4242,
        name: 'QQ.exe',
        path: 'C:/Program Files/Tencent/QQ/QQ.exe',
        injected: false,
        connected: false,
        loggedIn: true,
        uin: '10001',
        status: 'ready'
      }
    ]);
    expect(JSON.stringify(processes)).not.toContain('secret');
    const status = await manager.status();
    expect(status).toMatchObject({
      configured: true,
      compatible: true,
      passwordConfigured: true,
      authenticated: true,
      autoLoadEnabled: false,
      owner: 'external'
    });
  });

  it('re-authenticates once after the management token expires', async () => {
    const { manager, fake } = await managerFor();
    await manager.listProcesses();
    fake.expireTokens();
    await expect(manager.listProcesses()).resolves.toHaveLength(1);
    expect(fake.loginCount()).toBe(2);
  });

  it('maps login and consent failures to stable codes', async () => {
    const wrong = await managerFor({ wrongPassword: true });
    await expect(wrong.manager.listProcesses()).rejects.toMatchObject({ code: 'snowluma_auth_failed' });
    expect(JSON.stringify(await wrong.manager.status().catch(() => null))).not.toContain('secret');

    const consent = await managerFor({ consentRequired: true });
    await expect(consent.manager.listProcesses()).rejects.toMatchObject({ code: 'snowluma_consent_required' });

    const totp = await managerFor({ needsTotp: true });
    await expect(totp.manager.listProcesses()).rejects.toMatchObject({ code: 'snowluma_totp_required' });
  });

  it('reports an unavailable runtime and refuses process access without side effects', async () => {
    const manager = new SnowLumaManager({
      vault: new MemoryCredentialVault(),
      logger: silentLogger('snowluma-missing')
    });
    await expect(manager.status()).resolves.toMatchObject({
      configured: false,
      compatible: false,
      running: false,
      authenticated: false,
      owner: 'external'
    });
    await expect(manager.listProcesses()).rejects.toMatchObject({ code: 'snowluma_runtime_unavailable' });
  });

  it('blocks mutations when version is incompatible or auto-load is enabled', async () => {
    const old = await managerFor({ version: '1.13.0' });
    await expect(old.manager.listProcesses()).rejects.toMatchObject({ code: 'snowluma_version_incompatible' });

    const auto = await managerFor({ hookAutoLoad: true });
    await expect(auto.manager.listProcesses()).resolves.toHaveLength(1);
    await expect(auto.manager.load(4242)).rejects.toMatchObject({ code: 'snowluma_autoload_enabled' });
    expect(auto.fake.loadCount()).toBe(0);
  });

  it('performs load, refresh, probe-login and unload only on explicit calls', async () => {
    const { manager, fake } = await managerFor();
    const loaded = await manager.load(4242);
    expect(loaded).toMatchObject({ pid: 4242, injected: true, connected: true });
    expect(fake.loadCount()).toBe(1);
    expect(await manager.probeLogin(4242)).toEqual({ uin: '10001', nickname: 'tester' });
    await manager.refresh(4242);
    const unloaded = await manager.unload(4242);
    expect(unloaded).toMatchObject({ pid: 4242, injected: false });
  });
});

describe('snowluma control API', () => {
  it('stores settings/password write-only and lists processes without injecting', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-snowluma-api-'));
    roots.push(root);
    const fake = await fakeManagement();
    const dir = await runtimeDir();
    const vault = new MemoryCredentialVault();
    const uiDir = path.join(root, 'ui');
    await fs.mkdir(uiDir, { recursive: true });
    await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><div id="root">ui</div>', 'utf8');
    const core = await createCore({
      dataRoot: root,
      instances: [],
      lockDataRoot: false,
      credentialVault: vault,
      api: { enabled: true, host: '127.0.0.1', port: 0, token: 'api-token', uiDir },
      logger: silentLogger('snowluma-api')
    });
    cores.push(core);
    await core.start();
    const base = core.status().apiUrl!;
    const headers = { authorization: 'Bearer api-token', 'content-type': 'application/json' };

    const saved = await fetch(`${base}/injection/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ runtimeDir: dir, baseUrl: fake.url, password: 'secret' })
    });
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain('secret');
    expect(savedText).toContain('"credentialConfigured":true');
    expect(await vault.get(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF)).toBe('secret');

    const processes = await fetch(`${base}/injection/processes`, { headers });
    expect(processes.status).toBe(200);
    const body = (await processes.json()) as { processes: Array<{ pid: number; injected: boolean }> };
    expect(body.processes).toEqual([expect.objectContaining({ pid: 4242, injected: false })]);
    expect(fake.loadCount()).toBe(0);

    const runtime = await fetch(`${base}/injection/runtime`, { headers });
    expect(runtime.status).toBe(200);
    const runtimeBody = (await runtime.json()) as { runtime: { authenticated: boolean; compatible: boolean } };
    expect(runtimeBody.runtime).toMatchObject({ authenticated: true, compatible: true });

    const cleared = await fetch(`${base}/injection/password`, { method: 'DELETE', headers });
    expect(cleared.status).toBe(200);
    expect(await vault.has(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF)).toBe(false);
  });

  it('injects on explicit request, binds the slot, and separates stop from unload', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-manual-inject-'));
    roots.push(root);
    const fake = await fakeManagement();
    const dir = await runtimeDir();
    const vault = new MemoryCredentialVault();
    const channels = new Map<string, FakeChannel>();
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [{ id: 'slot-a', backend: 'snowluma', runtimeDir: dir, restart: { enabled: false } }],
        manualStartOnly: true,
        backendFactory: () => new LoopbackBackend(),
        channelFactory: (context) => {
          const channel = new FakeChannel(context, { selfId: context.spec.accountId });
          channels.set(context.instanceId, channel);
          return channel;
        },
        credentialVault: vault,
        api: { enabled: true, host: '127.0.0.1', port: 0, token: 'api-token' },
        logger: silentLogger('manual-inject')
      },
      ['10001']
    );
    cores.push(core);
    await core.start();
    expect(core.status().instances[0]?.state).toBe('stopped');
    await core.setInjectionSettings({ runtimeDir: dir, baseUrl: fake.url }, 'secret');

    const identity = { pid: 4242, path: 'C:/Program Files/Tencent/QQ/QQ.exe' };
    const operation = await core.injectAndListen({
      slotId: 'slot-a',
      identity,
      expectedAccountId: '10001'
    });
    expect(operation).toMatchObject({ state: 'succeeded', result: { uin: '10001' } });
    expect(core.slotSpecs()[0]).toMatchObject({ id: 'slot-a', accountId: '10001' });
    expect(core.status().instances[0]).toMatchObject({ accountId: '10001', state: 'online' });
    expect(channels.size).toBe(1);
    expect(fake.loadCount()).toBe(1);

    const base = core.status().apiUrl!;
    const headers = { authorization: 'Bearer api-token', 'content-type': 'application/json' };
    const queried = await fetch(`${base}/injection/operations/${operation.id}`, { headers });
    expect(queried.status).toBe(200);
    expect(((await queried.json()) as { operation: { state: string } }).operation.state).toBe('succeeded');

    await core.stopInstance('slot-a');
    expect(core.status().instances[0]?.state).toBe('stopped');
    expect(fake.unloadCount()).toBe(0);

    const listened = await fetch(`${base}/injection/processes/4242/listen`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slotId: 'slot-a', identity })
    });
    expect(listened.status).toBe(200);
    const listenBody = (await listened.json()) as { ok: boolean; operation: { action: string; state: string } };
    expect(listenBody.ok).toBe(true);
    expect(listenBody.operation).toMatchObject({ action: 'listen', state: 'succeeded' });
    expect(fake.loadCount()).toBe(1);

    const unloaded = await fetch(`${base}/injection/processes/4242/unload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slotId: 'slot-a', identity })
    });
    expect(unloaded.status).toBe(200);
    expect(((await unloaded.json()) as { ok: boolean }).ok).toBe(true);
    expect(fake.unloadCount()).toBe(1);
    expect(core.status().instances[0]?.state).toBe('stopped');

    const invalid = await fetch(`${base}/injection/processes/4242/inject-and-listen`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slotId: 'slot-a' })
    });
    expect(invalid.status).toBe(400);
  });

  it('restores slots without starting or injecting them in manual-only mode', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-manual-only-'));
    roots.push(root);
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
      lockDataRoot: false,
      manualStartOnly: true,
      logger: silentLogger('manual-only')
    });
    cores.push(core);
    await core.start();
    expect(core.status().instances[0]).toMatchObject({ state: 'stopped' });
  });
});
