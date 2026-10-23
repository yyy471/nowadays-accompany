import { describe, expect, it } from 'vitest';
import { BackendError } from '../src/core/errors.js';
import { silentLogger } from '../src/core/logger.js';
import { AccountLeases } from '../src/instances/account-leases.js';
import { RuntimeRegistry } from '../src/instances/runtime-registry.js';
import { normalizeSpec, type InstanceSpec } from '../src/instances/spec.js';
import type { BackendStatus, InjectionBackend, ProbeReport, RuntimeEndpoints } from '../src/injection/contract.js';

class TestBackend implements InjectionBackend {
  readonly kind = 'test';
  readonly capabilities = { launch: true, attach: true, multiInstance: true };
  readonly failingAccounts = new Set<string>();
  starts = 0;
  disposes = 0;

  async probe(): Promise<ProbeReport> {
    return { backend: this.kind, ok: true, warnings: [], instances: [] };
  }

  async start(spec: InstanceSpec): Promise<RuntimeEndpoints> {
    this.starts += 1;
    if (spec.accountId && this.failingAccounts.has(spec.accountId)) {
      throw new BackendError('test_failed', `test backend failed for ${spec.accountId}`);
    }
    return { httpBaseUrl: 'http://127.0.0.1:38080', wsUrl: 'ws://127.0.0.1:38081' };
  }

  async stop(): Promise<void> {}

  async status(): Promise<BackendStatus> {
    return { running: true };
  }

  async dispose(): Promise<void> {
    this.disposes += 1;
  }
}

function setup(): {
  registry: RuntimeRegistry;
  backend: TestBackend;
  specA: ReturnType<typeof normalizeSpec>;
  specB: ReturnType<typeof normalizeSpec>;
  now: () => number;
  advance: (ms: number) => void;
  factoryCalls: () => number;
} {
  let clock = 1_000;
  const backend = new TestBackend();
  let calls = 0;
  const registry = new RuntimeRegistry({
    backendFactory: () => {
      calls += 1;
      return backend;
    },
    logger: silentLogger(),
    now: () => clock
  });
  const specA = normalizeSpec({
    id: 'a',
    backend: 'snowluma',
    runtimeDir: 'C:/accompany-runtime-shared',
    accountId: '10001'
  });
  const specB = normalizeSpec({
    id: 'b',
    backend: 'snowluma',
    runtimeDir: 'C:/accompany-runtime-shared',
    accountId: '10002'
  });
  return {
    registry,
    backend,
    specA,
    specB,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    factoryCalls: () => calls
  };
}

describe('RuntimeRegistry', () => {
  it('shares one backend per runtime and releases it when the last session leaves', async () => {
    const { registry, backend, specA, specB, factoryCalls } = setup();
    const leaseA = registry.acquire(specA, { logger: silentLogger() });
    const leaseB = registry.acquire(specB, { logger: silentLogger() });
    expect(factoryCalls()).toBe(1);
    expect(leaseA.key).toBe(leaseB.key);
    await leaseA.start(specA);
    await leaseB.start(specB);
    expect(backend.starts).toBe(2);

    await leaseA.release();
    expect(backend.disposes).toBe(0);
    await leaseB.release();
    expect(backend.disposes).toBe(1);
  });

  it('keeps circuit breakers per account on a shared runtime', async () => {
    const { registry, backend, specA, specB, advance } = setup();
    backend.failingAccounts.add('10001');
    const leaseA = registry.acquire(specA, { logger: silentLogger() });
    const leaseB = registry.acquire(specB, { logger: silentLogger() });

    await expect(leaseA.start(specA)).rejects.toThrow(/test backend failed/);
    expect(registry.canAttempt(leaseA.key, '10001')).toBe(false);
    expect(registry.canAttempt(leaseA.key, '10002')).toBe(true);

    await expect(leaseB.start(specB)).resolves.toBeDefined();
    advance(600);
    expect(registry.canAttempt(leaseA.key, '10001')).toBe(true);

    await Promise.all([leaseA.release(), leaseB.release()]);
  });
});

describe('AccountLeases', () => {
  it('refuses to let two instances own the same account', () => {
    const leases = new AccountLeases();
    leases.acquire('10001', 'a');
    expect(() => leases.acquire('10001', 'b')).toThrow(/already owned/);
    expect(() => leases.acquire('10001', 'a')).not.toThrow();
    leases.release('10001', 'a');
    expect(() => leases.acquire('10001', 'b')).not.toThrow();
  });
});
