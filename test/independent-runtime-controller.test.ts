import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SnowLumaRuntimeController } from '../src/injection/snowluma/runtime.js';
import type { SnowLumaRuntimeStatus } from '../src/injection/snowluma/manager.js';
import { silentLogger } from '../src/core/logger.js';
import { waitFor } from './phase1-helpers.js';

const roots: string[] = [];
const controllers: SnowLumaRuntimeController[] = [];
afterEach(async () => {
  await Promise.allSettled(controllers.splice(0).map((controller) => controller.stop()));
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'accompany-runtime-review-'))) throw new Error('unexpected test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

class ReviewChild extends EventEmitter {
  pid = 9999;
  exitCode: number | null = null;
  kills = 0;
  kill() { this.kills++; this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, null)); return true; }
  unref() { return this; }
}

async function setup(options: { externallyRunning?: boolean; neverReady?: boolean; nodeVersion?: () => Promise<string> } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-runtime-review-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.14.19' }));
  await fs.writeFile(path.join(root, 'config', 'runtime.json'), JSON.stringify({ webuiPort: 5099, webuiHost: '127.0.0.1', hookAutoLoad: false }));
  await fs.writeFile(path.join(root, 'node.exe'), 'test fixture only');
  await fs.writeFile(path.join(root, 'index.mjs'), '// test fixture only');
  const child = new ReviewChild();
  let spawned = 0;
  let spawnOptions: Record<string, unknown> = {};
  const manager = {
    settings: () => ({ runtimeDir: root }),
    status: async () => ({ configured: true, compatible: true, running: options.externallyRunning || (spawned > 0 && !options.neverReady), authenticated: true, passwordConfigured: true, consentRequired: false, autoLoadEnabled: false, autoLoadKnown: true, owner: 'external', supportedVersion: '1.14.x' }) as SnowLumaRuntimeStatus,
    listProcesses: async () => []
  };
  const controller = new SnowLumaRuntimeController({
    manager, logger: silentLogger('runtime-review'), platform: 'win32',
    env: { SNOWLUMA_HOOK_AUTOLOAD_ALL: '1' },
    spawnImpl: ((_exe: string, _args: string[], config: Record<string, unknown>) => { spawned++; spawnOptions = config; return child as unknown as ChildProcess; }) as typeof spawn,
    nodeVersion: options.nodeVersion ?? (async () => 'v22.14.0'),
    startupTimeoutMs: 5, pollIntervalMs: 1, stopTimeoutMs: 5
  });
  controllers.push(controller);
  return { controller, child, spawned: () => spawned, spawnOptions: () => spawnOptions };
}

describe('independent SnowLuma service ownership acceptance', () => {
  it('reuses an external service without spawning or terminating it', async () => {
    const h = await setup({ externallyRunning: true });
    await h.controller.ensureStarted();
    expect(h.controller.status().owner).toBe('external');
    await h.controller.stop();
    expect(h.spawned()).toBe(0);
    expect(h.child.kills).toBe(0);
  });

  it('retains ownership on repeated readiness checks and hides the child console', async () => {
    const h = await setup();
    await h.controller.ensureStarted();
    expect(h.controller.status().owner).toBe('managed');
    await h.controller.ensureStarted();
    expect(h.controller.status().owner).toBe('managed');
    expect(h.spawned()).toBe(1);
    expect(h.spawnOptions()).toMatchObject({ windowsHide: true, shell: false, env: { SNOWLUMA_HOOK_AUTOLOAD_ALL: '0' } });
    await h.controller.stop();
    expect(h.child.kills).toBe(1);
  });

  it('cleans up a child that never exposes its management service', async () => {
    const h = await setup({ neverReady: true });
    await h.controller.ensureStarted();
    expect(h.controller.status().state).toBe('error');
    expect(h.child.kills).toBe(1);
  });

  it('cancels startup before spawning when quit occurs during Node validation', async () => {
    let release!: (version: string) => void;
    let entered = false;
    const version = new Promise<string>((resolve) => { release = resolve; });
    const h = await setup({ nodeVersion: () => { entered = true; return version; } });
    const starting = h.controller.ensureStarted();
    await waitFor(() => entered);
    const stopping = h.controller.stop();
    release('v22.14.0');
    await Promise.all([starting, stopping]);
    expect(h.spawned()).toBe(0);
  });
});
