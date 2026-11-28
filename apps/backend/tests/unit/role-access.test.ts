import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RoleAccess } from "../../src/application/role/role-access.js";
import { rolePaths } from "../../src/bootstrap/config.js";
import { AppStore } from "../../src/storage/core/app-store.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";

interface Fixture {
  access: RoleAccess;
  roleId: string;
  dataRoot: string;
}

function setup(t: import("node:test").TestContext): Fixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-role-access-"));
  const appStore = new AppStore(path.join(dataRoot, "app.sqlite"));
  const roleId = randomUUID();
  appStore.createRoleIndex({
    roleId,
    relativeDir: `roles/${roleId}`,
    initPayload: {
      displayName: "测试角色",
      definition: { text: "测试角色定义", payload: {} },
      state: {},
    },
  });
  appStore.markRoleReady(roleId);
  // 用 initialize 模式建出角色目录与两个数据库，再关闭，模拟真实上线后的落盘状态。
  new RoleStorage(rolePaths(dataRoot, roleId)).close();
  const access = new RoleAccess(appStore, dataRoot);
  t.after(async () => {
    await access.closeAll();
    appStore.close();
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { access, roleId, dataRoot };
}

function sqliteError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

test("withStore replaces a handle whose business database was closed externally", (t) => {
  const { access, roleId } = setup(t);
  const first = access.withStore(roleId, (storage) => storage);
  assert.equal(first.isHealthy, true);

  first.business.db.close();
  assert.equal(first.isHealthy, false);

  const result = access.withStore(roleId, (storage) => {
    assert.equal(storage.isHealthy, true);
    return storage.business.db.prepare("SELECT 1 AS ok").get() as { ok: number };
  });
  assert.equal(result.ok, 1);

  const second = access.withStore(roleId, (storage) => storage);
  assert.notEqual(second, first);
  assert.equal(second.isHealthy, true);
  assert.equal(second.isClosed, false);
});

test("withStore reopens a handle closed through RoleStorage.close", (t) => {
  const { access, roleId } = setup(t);
  const first = access.withStore(roleId, (storage) => storage);
  first.close();
  assert.equal(first.isClosed, true);
  assert.equal(first.isHealthy, false);

  const second = access.withStore(roleId, (storage) => {
    assert.equal(storage.isHealthy, true);
    return storage;
  });
  assert.notEqual(second, first);
  assert.equal(second.isClosed, false);
  assert.equal(second.isHealthy, true);
});

test("withStore evicts the pooled handle after a fatal SQLITE_IOERR", (t) => {
  const { access, roleId } = setup(t);
  const first = access.withStore(roleId, (storage) => storage);

  assert.throws(
    () =>
      access.withStore(roleId, () => {
        throw sqliteError("disk I/O error", "SQLITE_IOERR");
      }),
    /disk I\/O error/,
  );

  const second = access.withStore(roleId, (storage) => storage);
  assert.notEqual(second, first);
  assert.equal(first.isClosed, true);
  assert.equal(second.isHealthy, true);
});

test("withStoreAsync evicts the pooled handle after a fatal SQLITE_CORRUPT", async (t) => {
  const { access, roleId } = setup(t);
  const first = await access.withStoreAsync(roleId, async (storage) => storage);

  await assert.rejects(
    access.withStoreAsync(roleId, async () => {
      throw sqliteError("database disk image is malformed", "SQLITE_CORRUPT");
    }),
    /database disk image is malformed/,
  );

  const second = await access.withStoreAsync(roleId, async (storage) => storage);
  assert.notEqual(second, first);
  assert.equal(first.isClosed, true);
  assert.equal(second.isHealthy, true);
});

test("non-fatal errors keep the healthy pooled handle", (t) => {
  const { access, roleId } = setup(t);
  const first = access.withStore(roleId, (storage) => storage);

  assert.throws(
    () =>
      access.withStore(roleId, () => {
        throw new Error("BUSINESS_RULE");
      }),
    /BUSINESS_RULE/,
  );

  const second = access.withStore(roleId, (storage) => storage);
  assert.equal(second, first);
  assert.equal(second.isHealthy, true);
});
