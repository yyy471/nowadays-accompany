import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../src/domain/errors.js';
import { createFixture } from '../fixtures/conversation-fixture.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('three role stops are issued before delayed confirmations', async () => {
  const fixture = createFixture([], { disablePresetAssistant: true });
  try {
    const { app, roleId } = fixture;
    const ids = [roleId, ...[1, 2].map(i => app.services.roles.createRole({ displayName: `role ${i}`, definition: { text: 'test' } }).roleId)];
    const activity = app.services.activity;
    for (const id of ids) if (activity.view(id).state === 'stopped') activity.resume(id);
    const events: string[] = [];
    activity.attachRuntime({
      isRunning: () => true,
      stopExchanges: id => { events.push(`request:${id}`); setTimeout(() => { events.push(`confirm:${id}`); activity.gate.confirmStop(id, null); }, 1000); },
    });
    const start = performance.now();
    const result = await app.services.resources.pauseRoles!([...ids, ids[0]!]);
    const elapsed = performance.now() - start;
    assert.deepEqual(result.pausedRoleIds, ids);
    assert.deepEqual(events.slice(0, 3), ids.map(id => `request:${id}`));
    assert.equal(events.length, 6);
    assert.ok(elapsed >= 950 && elapsed < 2000, `elapsed=${elapsed}`);
    console.log(`BUG-04 three roles elapsed_ms=${elapsed.toFixed(3)} events=${JSON.stringify(events)}`);
  } finally { await fixture.close(); }
});

test('partial timeout reports only confirmed initiated roles', async () => {
  const fixture = createFixture([], { disablePresetAssistant: true });
  try {
    const { app, roleId } = fixture;
    const second = app.services.roles.createRole({ displayName: 'second', definition: { text: 'test' } }).roleId;
    const activity = app.services.activity;
    for (const id of [roleId, second]) if (activity.view(id).state === 'stopped') activity.resume(id);
    activity.attachRuntime({ isRunning: () => true, stopExchanges: id => { if (id === roleId) setTimeout(() => activity.gate.confirmStop(id, null), 10); } });
    await assert.rejects(activity.pauseRoles([roleId, second], 80), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(error.details && typeof error.details === 'object');
      const details = error.details as Record<string, unknown>;
      assert.equal(error.code, 'ROLES_NOT_STOPPED');
      assert.deepEqual(details.pausedRoleIds, [roleId]);
      assert.deepEqual(details.roles, [{ roleId: second, state: 'stopping', running: true }]);
      return true;
    });
  } finally { await fixture.close(); }
});

test('media maintenance wakes only after last matching claim', async () => {
  const fixture = createFixture([], { disablePresetAssistant: true });
  try {
    const media = fixture.app.services.mediaMaintenance;
    const releaseA = media.claim('voice', 'a', 'one');
    const releaseA2 = media.claim('voice', 'a', 'two');
    const releaseB = media.claim('voice', 'b', 'three');
    let doneA = false, doneB = false;
    const a = media.update('voice', 'a', true, () => { doneA = true; });
    const b = media.update('voice', 'b', true, () => { doneB = true; });
    releaseA();
    releaseA();
    await delay(0);
    assert.equal(doneA, false);
    assert.equal(doneB, false);
    releaseA2();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(doneA, true);
    await a; assert.equal(doneB, false);
    releaseB();
    await b;
    assert.equal(doneB, true);
  } finally { await fixture.close(); }
});


test('stop initiation failure preserves error and still requests later roles', async () => {
  const fixture = createFixture([], { disablePresetAssistant: true });
  try {
    const { app, roleId } = fixture;
    const second = app.services.roles.createRole({ displayName: 'second', definition: { text: 'test' } }).roleId;
    const activity = app.services.activity;
    for (const id of [roleId, second]) if (activity.view(id).state === 'stopped') activity.resume(id);
    const original = activity.requestStop.bind(activity);
    activity.requestStop = id => { if (id === roleId) throw new AppError(409, 'INJECTED', 'injected'); return original(id); };
    await assert.rejects(app.services.resources.pauseRoles!([roleId, second]), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(error.details && typeof error.details === 'object');
      const details = error.details as Record<string, unknown>;
      assert.equal(error.code, 'INJECTED');
      assert.deepEqual(details.pausedRoleIds, [second]);
      return true;
    });
    assert.equal(activity.view(second).state, 'stopped');
  } finally { await fixture.close(); }
});

test('media timeout reports busy roles and releases maintenance for retry', async t => {
  const fixture = createFixture([], { disablePresetAssistant: true });
  try {
    const media = fixture.app.services.mediaMaintenance;
    const release = media.claim('voice', 'timeout', 'busy-role');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const update = media.update('voice', 'timeout', true, () => 1);
    const rejected = assert.rejects(update, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(error.details && typeof error.details === 'object');
      const details = error.details as Record<string, unknown>;
      assert.equal(error.code, 'MEDIA_SERVICE_MAINTENANCE');
      assert.deepEqual(details.roleIds, ['busy-role']);
      return true;
    });
    t.mock.timers.tick(20_000);
    await rejected;
    release();
    assert.equal((await media.update('voice', 'timeout', true, () => 2)).value, 2);
  } finally { t.mock.timers.reset(); await fixture.close(); }
});

