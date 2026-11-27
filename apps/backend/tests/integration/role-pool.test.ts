import assert from "node:assert/strict";
import test from "node:test";
import { createFixture, deferred } from "../fixtures/conversation-fixture.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";

test("role pool reuses storage, drains leases, blocks deletion and closes", async () => {
  const fixture = createFixture([]);
  const { roleAccess } = fixture.app;
  try {
    await roleAccess.evict(fixture.roleId);
    const first = roleAccess.borrow(fixture.roleId);
    const second = roleAccess.borrow(fixture.roleId);
    assert.equal(first.storage, second.storage);
    const storage = first.storage;
    const pending = roleAccess.evict(fixture.roleId);
    assert.ok(pending);
    assert.equal(roleAccess.evict(fixture.roleId), pending);
    assert.throws(() => roleAccess.borrow(fixture.roleId));
    first.release(); first.release();
    let drained = false;
    void pending.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    second.release();
    await pending;
    assert.throws(() => storage.checkpoint, /ROLE_STORAGE_CLOSED/);
    const replacement = roleAccess.borrow(fixture.roleId);
    assert.notEqual(replacement.storage, storage);
    replacement.release();
    await roleAccess.blockAndEvict(fixture.roleId);
    assert.throws(() => roleAccess.borrow(fixture.roleId));
    roleAccess.unblock(fixture.roleId);
    assert.doesNotThrow(() => roleAccess.withStore(fixture.roleId, () => {}));
    const gate = deferred<void>();
    const inFlight = roleAccess.withStoreAsync(fixture.roleId, async () => gate.promise);
    const close = roleAccess.closeAll();
    assert.throws(() => roleAccess.borrow(fixture.roleId));
    let closed = false;
    void Promise.resolve(close).then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    gate.resolve();
    await inFlight;
    await close;
  } finally { await fixture.close(); }
});

test("multi-role borrow releases earlier leases after a failure", async () => {
  const fixture = createFixture([]);
  try {
    const access = fixture.app.roleAccess;
    assert.throws(() => access.withReadyStores([fixture.roleId, "missing"], () => {}));
    await access.evict(fixture.roleId);
    const lease = access.borrow(fixture.roleId);
    assert.ok(lease.storage instanceof RoleStorage);
    lease.release();
  } finally { await fixture.close(); }
});

test("idle timeout closes only unleased storage and restarts after borrowing", async (t) => {
  const fixture = createFixture([]);
  try {
    const access = fixture.app.roleAccess;
    await access.evict(fixture.roleId);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const lease = access.borrow(fixture.roleId);
    const db = lease.storage.business.db;
    t.mock.timers.tick(60_000);
    assert.equal(db.open, true);
    lease.release();
    t.mock.timers.tick(59_999);
    assert.equal(db.open, true);
    const again = access.borrow(fixture.roleId);
    again.release();
    t.mock.timers.tick(59_999);
    assert.equal(db.open, true);
    t.mock.timers.tick(1);
    assert.equal(db.open, false);
  } finally {
    t.mock.timers.reset();
    await fixture.close();
  }
});
