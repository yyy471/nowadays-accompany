import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceSupervisor } from '../src/instances/supervisor.js';
import { QqInstance } from '../src/instances/instance.js';
import { FakeInjectionBackend, type FakeBackendOptions } from '../src/injection/fake.js';
import { FakeChannel } from '../src/channels/fake.js';
import { JsonlStore } from '../src/storage/jsonl-store.js';
import { TypedEventBus } from '../src/core/bus.js';
import type { CoreEvents } from '../src/core/events.js';
import { silentLogger } from '../src/core/logger.js';
import { normalizeSpec, type InstanceSpec, type NormalizedInstanceSpec } from '../src/instances/spec.js';

const roots: string[] = [];
const supervisors: InstanceSupervisor[] = [];
const stores: JsonlStore[] = [];

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
  await Promise.allSettled(stores.splice(0).map((store) => store.dispose()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup(specs: InstanceSpec[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-supervisor-'));
  roots.push(root);
  const bus = new TypedEventBus<CoreEvents>();
  const logger = silentLogger('supervisor');
  const errors: CoreEvents['instance:error'][] = [];
  bus.on('instance:error', (event) => errors.push(event));

  const supervisor = new InstanceSupervisor({
    bus,
    logger,
    createInstance: (spec: NormalizedInstanceSpec) => {
      let instance: QqInstance | undefined;
      const backend = new FakeInjectionBackend((spec.backendOptions ?? {}) as FakeBackendOptions, (error) =>
        instance?.handleExternalFailure(error)
      );
      const store = new JsonlStore({ root: path.join(root, spec.id), logger: silentLogger() });
      stores.push(store);
      instance = new QqInstance({
        spec,
        backend,
        createChannel: (endpoints, handlers) =>
          new FakeChannel({ spec, instanceId: spec.id, endpoints, logger: silentLogger(), ...handlers }),
        resolveStore: () => store,
        bus,
        logger: silentLogger(spec.id)
      });
      return instance;
    }
  });
  supervisors.push(supervisor);
  for (const spec of specs) supervisor.add(spec);
  return { supervisor, bus, errors, root };
}

describe('InstanceSupervisor', () => {
  it('starts every instance independently and isolates failures', async () => {
    const { supervisor } = await setup([
      { id: 'a', backend: 'fake', accountId: '10001' },
      { id: 'b', backend: 'fake', accountId: '10002', backendOptions: { failOnStart: true }, restart: { enabled: false } }
    ]);

    const result = await supervisor.startAll();
    expect(result.started).toEqual(['a']);
    expect(result.failed.map((item) => item.id)).toEqual(['b']);

    const statuses = supervisor.list();
    expect(statuses.find((item) => item.id === 'a')?.state).toBe('online');
    expect(statuses.find((item) => item.id === 'b')?.state).toBe('failed');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(supervisor.list().find((item) => item.id === 'a')?.state).toBe('online');
  });

  it('restarts only the failed instance and gives up after the policy limit', async () => {
    const { supervisor, errors } = await setup([
      { id: 'ok', backend: 'fake', accountId: '10001' },
      {
        id: 'bad',
        backend: 'fake',
        accountId: '10002',
        backendOptions: { failOnStart: true },
        restart: { enabled: true, maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 }
      }
    ]);

    await supervisor.startAll();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors.some((event) => event.instanceId === 'bad' && event.code === 'restart_exhausted')).toBe(true);
    expect(supervisor.list().find((item) => item.id === 'ok')?.state).toBe('online');
    expect(supervisor.list().find((item) => item.id === 'bad')?.state).toBe('failed');
    expect(supervisor.list().find((item) => item.id === 'bad')?.restartAttempts).toBeGreaterThanOrEqual(3);
  });

  it('recovers an instance whose runtime crashes after start', async () => {
    const { supervisor, bus } = await setup([
      {
        id: 'flaky',
        backend: 'fake',
        accountId: '10003',
        backendOptions: { crashAfterMs: 20 },
        restart: { enabled: true, maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 }
      }
    ]);
    const states: string[] = [];
    bus.on('instance:state', (event) => states.push(event.to));

    await supervisor.startAll();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(states.filter((state) => state === 'failed').length).toBeGreaterThanOrEqual(1);
    expect(states.filter((state) => state === 'online').length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent when stopping twice or stopping an unknown id', async () => {
    const { supervisor } = await setup([{ id: 'a', backend: 'fake', accountId: '10001' }]);
    await supervisor.startAll();
    await supervisor.stopAll();
    await supervisor.stopAll();
    await supervisor.stop('missing');
    expect(supervisor.list()[0]?.state).toBe('stopped');
  });

  it('refuses duplicate ids and unknown specs', async () => {
    const { supervisor } = await setup([{ id: 'a', backend: 'fake' }]);
    expect(() => supervisor.add({ id: 'a', backend: 'fake' })).toThrow(/duplicate/);
    expect(normalizeSpec({ id: 'b', backend: 'fake' }).restart.enabled).toBe(true);
    await expect(supervisor.start('nope')).rejects.toThrow(/unknown instance/);
  });

  it('serializes concurrent start and stop without getting stuck', async () => {
    const { supervisor } = await setup([{ id: 'a', backend: 'fake', accountId: '10001' }]);
    await supervisor.startAll();
    await Promise.allSettled([supervisor.start('a'), supervisor.stop('a')]);
    expect(supervisor.list()[0]?.state).toBe('stopped');
  });
});
