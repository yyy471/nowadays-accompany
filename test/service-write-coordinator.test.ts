import { expect, it } from 'vitest';
import { createServiceWriteCoordinator } from '../desktop/renderer/src/lib/service-write-coordinator.js';

it('awards the provider lock to the first dirty editor and passes it on release', () => {
  const coordinator = createServiceWriteCoordinator();
  coordinator.setIntents('advanced', ['shared']);
  coordinator.setIntents('models', ['shared']);
  expect(coordinator.getSnapshot().locks).toEqual({ shared: 'advanced' });
  expect(coordinator.begin('shared', 'models')).toBe(false);
  expect(coordinator.begin('shared', 'advanced')).toBe(true);
  expect(coordinator.getSnapshot().writes).toEqual({ shared: 'advanced' });
  expect(coordinator.begin('shared', 'advanced')).toBe(false);
  coordinator.end('shared', 'advanced');
  expect(coordinator.getSnapshot().writes).toEqual({});

  coordinator.setIntents('advanced', []);
  expect(coordinator.getSnapshot().locks).toEqual({ shared: 'models' });
  expect(coordinator.begin('shared', 'models')).toBe(true);
});

it('keeps providers independent and preserves an intent sequence across repeats', () => {
  const coordinator = createServiceWriteCoordinator();
  coordinator.setIntents('models', ['a']);
  coordinator.setIntents('advanced', ['b']);
  coordinator.setIntents('models', ['a']);
  expect(coordinator.getSnapshot().locks).toEqual({ a: 'models', b: 'advanced' });
  expect(coordinator.begin('a', 'models')).toBe(true);
  expect(coordinator.begin('b', 'models')).toBe(false);
  coordinator.setIntents('models', ['b']);
  expect(coordinator.getSnapshot().locks).toEqual({ b: 'advanced' });
});

it('blocks a second in-flight writer even when no draft lock exists', () => {
  const coordinator = createServiceWriteCoordinator();
  expect(coordinator.begin('shared', 'models')).toBe(true);
  expect(coordinator.begin('shared', 'advanced')).toBe(false);
  coordinator.end('shared', 'models');
  expect(coordinator.begin('shared', 'advanced')).toBe(true);
});

it('treats prototype-named service ids as free when no own lock or write exists', () => {
  const coordinator = createServiceWriteCoordinator();
  const initial = coordinator.getSnapshot();
  for (const id of ['constructor', 'toString']) {
    expect(Object.hasOwn(initial.locks, id)).toBe(false);
    expect(Object.hasOwn(initial.writes, id)).toBe(false);
    expect(initial.locks[id]).toBeUndefined();
    expect(initial.writes[id]).toBeUndefined();
    expect(coordinator.begin(id, 'models')).toBe(true);
  }
  expect(Object.hasOwn(coordinator.getSnapshot().writes, 'constructor')).toBe(true);
  expect(coordinator.begin('constructor', 'advanced')).toBe(false);
  coordinator.end('constructor', 'models');
  expect(Object.hasOwn(coordinator.getSnapshot().writes, 'constructor')).toBe(false);
  expect(coordinator.begin('constructor', 'advanced')).toBe(true);
});

it('locks and releases prototype-named service ids by ownership', () => {
  const coordinator = createServiceWriteCoordinator();
  coordinator.setIntents('models', ['constructor']);
  expect(coordinator.getSnapshot().locks.constructor).toBe('models');
  expect(coordinator.begin('constructor', 'advanced')).toBe(false);
  expect(coordinator.begin('constructor', 'models')).toBe(true);
  coordinator.end('constructor', 'models');
  coordinator.setIntents('models', []);
  expect(coordinator.getSnapshot().locks.constructor).toBeUndefined();
  expect(coordinator.begin('constructor', 'advanced')).toBe(true);
  coordinator.end('constructor', 'advanced');
});

it('notifies subscribers only when the snapshot changes', () => {
  const coordinator = createServiceWriteCoordinator();
  let calls = 0;
  const unsubscribe = coordinator.subscribe(() => { calls += 1; });
  coordinator.setIntents('models', ['a']);
  coordinator.setIntents('models', ['a']);
  coordinator.setIntents('models', []);
  unsubscribe();
  coordinator.setIntents('models', ['b']);
  expect(calls).toBe(2);
});
