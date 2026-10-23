import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import {
  ManualInjectionService,
  type ManualInjectionHost
} from '../src/injection/manual.js';
import type { SnowLumaManager, SnowLumaProcess } from '../src/injection/snowluma/manager.js';
import type { InstanceSpec, InstanceStatus } from '../src/instances/spec.js';

interface Counters {
  load: number;
  unload: number;
  refresh: number;
  start: number;
  stop: number;
  rebind: string[];
  remembered: string[];
  forgotten: string[];
}

const PROCESS_PATH = 'C:/Program Files/Tencent/QQ/QQ.exe';

function harness(
  initial: Partial<SnowLumaProcess> = {},
  options: {
    accountId?: string;
    loginTimeoutMs?: number;
    extraProcesses?: SnowLumaProcess[];
    desiredState?: 'running' | 'stopped';
  } = {}
): {
  service: ManualInjectionService;
  process: SnowLumaProcess;
  counters: Counters;
  spec: () => InstanceSpec;
  state: () => InstanceStatus['state'];
  owners: Map<string, string>;
} {
  const process: SnowLumaProcess = {
    pid: 4242,
    path: PROCESS_PATH,
    injected: false,
    connected: false,
    loggedIn: false,
    status: 'ready',
    ...initial
  };
  const counters: Counters = { load: 0, unload: 0, refresh: 0, start: 0, stop: 0, rebind: [], remembered: [], forgotten: [] };
  const manager = {
    async listProcesses() {
      return [{ ...process }, ...(options.extraProcesses ?? [])];
    },
    async load() {
      counters.load += 1;
      process.injected = true;
      process.connected = true;
      return { ...process };
    },
    async unload() {
      counters.unload += 1;
      process.injected = false;
      process.connected = false;
      return { ...process };
    },
    async refresh() {
      counters.refresh += 1;
      return { ...process };
    },
    async probeLogin() {
      return process.uin ? { uin: process.uin } : {};
    }
  } as unknown as SnowLumaManager;

  let spec: InstanceSpec = {
    id: 'slot-a',
    backend: 'snowluma',
    runtimeDir: 'C:/SnowLuma',
    ...(options.accountId ? { accountId: options.accountId } : {})
  };
  let state: InstanceStatus['state'] = 'stopped';
  const desiredState = options.desiredState ?? 'running';
  const owners = new Map<string, string>();
  const host: ManualInjectionHost = {
    slot: (id) => (id === spec.id ? spec : undefined),
    resumeCandidates: () => [spec],
    accountOwner: (accountId) => owners.get(accountId),
    instanceStatus: () => ({
      id: 'slot-a',
      ...(spec.accountId ? { accountId: spec.accountId } : {}),
      backend: 'snowluma',
      desiredState,
      state,
      selfIds: [],
      connected: state === 'online',
      restartAttempts: 0
    }),
    startSlot: async () => {
      counters.start += 1;
      state = 'online';
    },
    stopSlot: async () => {
      counters.stop += 1;
      state = 'stopped';
    },
    rebindSlot: async (_id, accountId) => {
      counters.rebind.push(accountId);
      spec = { ...spec, accountId };
    },
    rememberListening: async (slotId, accountId) => {
      counters.remembered.push(`${slotId}:${accountId}`);
    },
    forgetListening: async (slotId) => {
      counters.forgotten.push(slotId);
    }
  };
  const service = new ManualInjectionService({
    manager,
    host,
    logger: silentLogger('manual-injection-test'),
    loginTimeoutMs: options.loginTimeoutMs ?? 100,
    loginPollMs: 5
  });
  return { service, process, counters, spec: () => spec, state: () => state, owners };
}

const identity = { pid: 4242, path: PROCESS_PATH };

describe('manual injection service', () => {
  it('loads once, waits for login and binds the unbound slot to the discovered account', async () => {
    const h = harness({ uin: '10001' });
    const operation = await h.service.injectAndListen({
      slotId: 'slot-a',
      identity,
      expectedAccountId: '10001'
    });
    expect(operation).toMatchObject({
      action: 'inject-and-listen',
      state: 'succeeded',
      result: { uin: '10001' }
    });
    expect(h.counters.load).toBe(1);
    expect(h.counters.rebind).toEqual(['10001']);
    expect(h.counters.start).toBe(1);
    expect(h.counters.remembered).toEqual(['slot-a:10001']);
    expect(h.spec().accountId).toBe('10001');

    const repeated = await h.service.injectAndListen({
      slotId: 'slot-a',
      identity,
      expectedAccountId: '10001'
    });
    expect(repeated.id).not.toBe(operation.id);
    expect(repeated.state).toBe('succeeded');
    expect(h.counters.load).toBe(1);
    expect(h.counters.start).toBe(1);
    expect(h.service.operation(operation.id)).toMatchObject({ state: 'succeeded' });
  });

  it('only loads the process the user selected', async () => {
    const other: SnowLumaProcess = {
      pid: 5252,
      path: 'C:/Other/QQ.exe',
      injected: false,
      connected: false,
      loggedIn: true,
      uin: '10002',
      status: 'ready'
    };
    const h = harness({ uin: '10001' }, { extraProcesses: [other] });
    const operation = await h.service.injectAndListen({ slotId: 'slot-a', identity });
    expect(operation.state).toBe('succeeded');
    expect(h.counters.load).toBe(1);
    expect(other.injected).toBe(false);
    expect(h.spec().accountId).toBe('10001');
  });

  it('loads again after an explicit unload', async () => {
    const h = harness({ uin: '10001' });
    await h.service.injectAndListen({ slotId: 'slot-a', identity });
    const unloaded = await h.service.unload({ slotId: 'slot-a', identity });
    expect(unloaded.state).toBe('succeeded');
    const injected = await h.service.injectAndListen({ slotId: 'slot-a', identity });
    expect(injected).toMatchObject({ state: 'succeeded', result: { uin: '10001' } });
    expect(h.counters.load).toBe(2);
  });

  it('merges concurrent clicks for the same process into one operation', async () => {
    const h = harness({ uin: '10001' });
    const [first, second] = await Promise.all([
      h.service.injectAndListen({ slotId: 'slot-a', identity }),
      h.service.injectAndListen({ slotId: 'slot-a', identity })
    ]);
    expect(first.id).toBe(second.id);
    expect(h.counters.load).toBe(1);
    expect(h.counters.start).toBe(1);
  });

  it('revalidates the process identity even when the slot is already listening', async () => {
    const h = harness({ uin: '10001' });
    await h.service.injectAndListen({ slotId: 'slot-a', identity });
    const stale = await h.service.injectAndListen({
      slotId: 'slot-a',
      identity: { pid: 4242, path: 'C:/Other/QQ.exe' }
    });
    expect(stale).toMatchObject({ state: 'failed', error: { code: 'injection_process_stale' } });
    expect(h.counters.load).toBe(1);
  });

  it('rejects a reused pid whose executable path changed', async () => {
    const h = harness({ uin: '10001' });
    const operation = await h.service.injectAndListen({
      slotId: 'slot-a',
      identity: { pid: 4242, path: 'C:/Other/QQ.exe' }
    });
    expect(operation).toMatchObject({
      state: 'failed',
      error: { code: 'injection_process_stale' }
    });
    expect(h.counters.load).toBe(0);
    expect(h.counters.start).toBe(0);
  });

  it('rejects a process that disappeared since discovery', async () => {
    const h = harness({ uin: '10001' });
    const operation = await h.service.injectAndListen({
      slotId: 'slot-a',
      identity: { pid: 9999, path: PROCESS_PATH }
    });
    expect(operation).toMatchObject({ state: 'failed', error: { code: 'injection_process_stale' } });
    expect(h.counters.load).toBe(0);
  });

  it('listens to an externally injected process without loading it again', async () => {
    const external = harness({ uin: '10001', injected: true, connected: true });
    const operation = await external.service.listen({ slotId: 'slot-a', identity });
    expect(operation).toMatchObject({ state: 'succeeded', result: { uin: '10001' } });
    expect(external.counters.load).toBe(0);
    expect(external.counters.start).toBe(1);

    const notLoaded = harness({ uin: '10001' });
    const rejected = await notLoaded.service.listen({ slotId: 'slot-a', identity });
    expect(rejected).toMatchObject({ state: 'failed', error: { code: 'injection_not_loaded' } });
    expect(notLoaded.counters.load).toBe(0);
    expect(notLoaded.counters.start).toBe(0);
  });

  it('refuses an account mismatch before injecting or binding', async () => {
    const h = harness({ uin: '10002' });
    const operation = await h.service.injectAndListen({
      slotId: 'slot-a',
      identity,
      expectedAccountId: '10001'
    });
    expect(operation).toMatchObject({
      state: 'failed',
      error: { code: 'injection_identity_mismatch' }
    });
    expect(h.counters.load).toBe(0);
    expect(h.counters.rebind).toEqual([]);
    expect(h.counters.start).toBe(0);
  });

  it('refuses to bind an account already leased by another slot', async () => {
    const h = harness({ uin: '10001' });
    h.owners.set('10001', 'slot-b');
    const operation = await h.service.injectAndListen({ slotId: 'slot-a', identity });
    expect(operation).toMatchObject({
      state: 'failed',
      error: { code: 'injection_account_in_use' }
    });
    expect(h.counters.rebind).toEqual([]);
    expect(h.counters.start).toBe(0);
  });

  it('keeps a slot bound to its existing account', async () => {
    const h = harness({ uin: '10002' }, { accountId: '10001' });
    const operation = await h.service.injectAndListen({
      slotId: 'slot-a',
      identity,
      expectedAccountId: '10002'
    });
    expect(operation).toMatchObject({
      state: 'failed',
      error: { code: 'injection_identity_mismatch' }
    });
    expect(h.counters.rebind).toEqual([]);
    expect(h.spec().accountId).toBe('10001');
  });

  it('waits for login and does not bind when the account is still unknown', async () => {
    const h = harness();
    const failed = await h.service.injectAndListen({ slotId: 'slot-a', identity },);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'injection_login_timeout' } });
    expect(h.counters.rebind).toEqual([]);
    expect(h.counters.start).toBe(0);

    h.process.uin = '10001';
    const retried = await h.service.injectAndListen({ slotId: 'slot-a', identity });
    expect(retried).toMatchObject({ state: 'succeeded', result: { uin: '10001' } });
    expect(retried.id).not.toBe(failed.id);
    expect(h.counters.load).toBe(1);
    expect(h.counters.rebind).toEqual(['10001']);
  });

  it('stops listening before an explicit unload and verifies the account', async () => {
    const h = harness({ uin: '10001', injected: true, connected: true });
    await h.service.listen({ slotId: 'slot-a', identity });
    expect(h.state()).toBe('online');
    const unloaded = await h.service.unload({ slotId: 'slot-a', identity });
    expect(unloaded.state).toBe('succeeded');
    expect(h.counters.stop).toBe(1);
    expect(h.counters.unload).toBe(1);
    expect(h.counters.forgotten).toEqual(['slot-a']);
    expect(h.state()).toBe('stopped');

    const mismatch = harness({ uin: '10002', injected: true, connected: true }, { accountId: '10001' });
    const rejected = await mismatch.service.unload({ slotId: 'slot-a', identity });
    expect(rejected).toMatchObject({ state: 'failed', error: { code: 'injection_identity_mismatch' } });
    expect(mismatch.counters.unload).toBe(0);
  });

  it('resumes only an already injected process whose account matches', async () => {
    const h = harness({ uin: '10001', injected: true, connected: true }, { accountId: '10001' });
    const result = await h.service.resume();
    expect(result).toMatchObject({
      attempted: 1,
      resumed: [{ slotId: 'slot-a', accountId: '10001', uin: '10001' }],
      skipped: []
    });
    expect(h.counters.load).toBe(0);
    expect(h.counters.start).toBe(1);
    expect(h.state()).toBe('online');
  });

  it('exposes the same resumable candidates used by resume', () => {
    const resumable = harness({ uin: '10001' }, { accountId: '10001' });
    expect(resumable.service.resumeCandidates()).toEqual([{ slotId: 'slot-a', accountId: '10001' }]);

    const stopped = harness(
      { uin: '10001' },
      { accountId: '10001', desiredState: 'stopped' }
    );
    expect(stopped.service.resumeCandidates()).toEqual([]);

    const unbound = harness({ uin: '10001' });
    expect(unbound.service.resumeCandidates()).toEqual([]);
  });

  it('skips a matching process that is not injected', async () => {
    const h = harness({ uin: '10001' }, { accountId: '10001' });
    const result = await h.service.resume();
    expect(result).toMatchObject({
      attempted: 1,
      resumed: [],
      skipped: [{ slotId: 'slot-a', accountId: '10001', reason: 'not_injected' }]
    });
    expect(h.counters.load).toBe(0);
    expect(h.counters.start).toBe(0);
  });

  it('does not resume a slot whose desired state is stopped', async () => {
    const h = harness(
      { uin: '10001', injected: true, connected: true },
      { accountId: '10001', desiredState: 'stopped' }
    );
    const result = await h.service.resume();
    expect(result).toEqual({ attempted: 0, resumed: [], skipped: [] });
    expect(h.counters.start).toBe(0);
  });

  it('does not resume when no logged-in process owns the slot account', async () => {
    const h = harness({ uin: '10002', injected: true, connected: true }, { accountId: '10001' });
    const result = await h.service.resume();
    expect(result.skipped[0]).toMatchObject({ slotId: 'slot-a', reason: 'process_not_found' });
    expect(h.counters.start).toBe(0);
  });

  it('does not unload when refresh or unload targets an unknown slot', async () => {
    const h = harness({ uin: '10001' });
    const refreshed = await h.service.refresh({ slotId: 'missing', identity });
    expect(refreshed).toMatchObject({ state: 'failed', error: { code: 'injection_slot_not_found' } });
    const unloaded = await h.service.unload({ slotId: 'missing', identity });
    expect(unloaded).toMatchObject({ state: 'failed', error: { code: 'injection_slot_not_found' } });
    expect(h.counters.refresh).toBe(0);
    expect(h.counters.unload).toBe(0);
  });
});
