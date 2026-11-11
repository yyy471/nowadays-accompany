import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { configFetch } from "./config-write.js";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { createFixture, deferred, type Fixture } from "./p2-05-fixture.js";

/**
 * 252 第三包定向用例：角色删除的两条数据路径。
 * 保留路径只移除角色索引，角色目录与受管素材保留；清理路径连同角色目录
 * 一并删除。两条路径都保留用户源目录与源文件（后端不保存源路径）。
 */

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  base: string,
  method: string,
  route: string,
): Promise<ApiResult> {
  const response = await fetch(`${base}${route}`, { method });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
  };
}

function errorOf(result: ApiResult): { code: string } {
  const error = result.body.error as { code: string } | undefined;
  assert.ok(error, `响应不是结构化错误：${JSON.stringify(result.body)}`);
  return error;
}

async function start(fixture: Fixture): Promise<string> {
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

function deleteRole(
  base: string,
  roleId: string,
  keepHistory: "1" | "0",
): Promise<Response> {
  return configFetch(
    `${base}/v1/roles/${roleId}?keepHistory=${keepHistory}`,
    { method: "DELETE" },
  );
}

function secondRole(fixture: Fixture, name: string): string {
  return fixture.app.services.roles.createRole({
    displayName: name,
    definition: { text: `${name}的设定` },
  }).roleId;
}

test("保留记忆与对话数据：移除角色但保留角色目录", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = secondRole(fixture, "保留角色");
    const paths = rolePaths(fixture.app.config.dataRoot, roleId);
    assert.ok(fs.existsSync(paths.roleDir));

    // 运行中的角色不能删除配置与数据。
    const blocked = await api(
      base,
      "DELETE",
      `/v1/roles/${roleId}?keepHistory=1`,
    );
    assert.equal(blocked.status, 409);
    assert.equal(errorOf(blocked).code, "ROLE_NOT_STOPPED");

    const removed = await deleteRole(base, roleId, "1");
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), {
      roleId,
      keepHistory: true,
      filesRemoved: false,
    });
    assert.equal((await api(base, "GET", `/v1/roles/${roleId}`)).status, 404);
    const listed = (await api(base, "GET", "/v1/roles")).body.items as Array<{
      roleId: string;
    }>;
    assert.equal(listed.some((item) => item.roleId === roleId), false);
    assert.equal(fixture.app.appStore.listRoleIndexes().length, 1);

    // 保留路径：角色目录、业务库与受管素材原样留在磁盘上。
    assert.ok(fs.existsSync(paths.roleDir));
    assert.ok(fs.existsSync(paths.businessDatabasePath));
    assert.ok(fs.existsSync(paths.appearanceDir));
  } finally {
    await fixture.close();
  }
});

test("一并删除：移除角色并清理角色目录", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = secondRole(fixture, "清理角色");
    const paths = rolePaths(fixture.app.config.dataRoot, roleId);

    const removed = await deleteRole(base, roleId, "0");
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), {
      roleId,
      keepHistory: false,
      filesRemoved: true,
    });
    assert.equal((await api(base, "GET", `/v1/roles/${roleId}`)).status, 404);
    assert.equal(fs.existsSync(paths.roleDir), false);
    assert.equal(fixture.app.appStore.listRoleIndexes().length, 1);
  } finally {
    await fixture.close();
  }
});

test("至少保留一个角色", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const paths = rolePaths(fixture.app.config.dataRoot, fixture.roleId);
    const rejected = await deleteRole(base, fixture.roleId, "0");
    assert.equal(rejected.status, 409);
    const body = (await rejected.json()) as { error: { code: string } };
    assert.equal(body.error.code, "LAST_ROLE_REQUIRED");
    assert.equal(fixture.app.appStore.listRoleIndexes().length, 1);
    assert.ok(fs.existsSync(paths.roleDir));

    const stopped = await api(
      base,
      "POST",
      `/v1/roles/${fixture.roleId}/activity/stop`,
    );
    assert.equal(stopped.status, 200);
    const missing = await api(base, "DELETE", `/v1/roles/${fixture.roleId}`);
    assert.equal(missing.status, 400);
    assert.equal(errorOf(missing).code, "KEEP_HISTORY_REQUIRED");
    const invalid = await api(
      base,
      "DELETE",
      `/v1/roles/${fixture.roleId}?keepHistory=maybe`,
    );
    assert.equal(invalid.status, 400);
  } finally {
    await fixture.close();
  }
});

test("清理中断后可由删除重试或启动恢复收敛", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  const config = fixture.app.config;
  try {
    const base = await start(fixture);

    // 模拟决策已提交、目录尚未删除：索引与活动记录已移除，目录仍在。
    const retriedId = secondRole(fixture, "重试角色");
    fixture.app.appStore.db.transaction(() => {
      fixture.app.appStore.recordRoleDeletion(
        retriedId,
        new Date().toISOString(),
      );
      fixture.app.appStore.deleteRole(retriedId);
    })();
    const retriedDir = rolePaths(config.dataRoot, retriedId).roleDir;
    assert.ok(fs.existsSync(retriedDir));
    const retried = await api(
      base,
      "DELETE",
      `/v1/roles/${retriedId}?keepHistory=0`,
    );
    assert.equal(retried.status, 200);
    assert.equal((retried.body as { filesRemoved: boolean }).filesRemoved, true);
    assert.equal(fs.existsSync(retriedDir), false);
    assert.deepEqual(fixture.app.appStore.listRoleDeletions(), []);

    // 模拟进程在提交后退出：启动恢复继续删除目录。
    const pendingId = secondRole(fixture, "启动恢复角色");
    fixture.app.appStore.db.transaction(() => {
      fixture.app.appStore.recordRoleDeletion(
        pendingId,
        new Date().toISOString(),
      );
      fixture.app.appStore.deleteRole(pendingId);
    })();
    const pendingDir = rolePaths(config.dataRoot, pendingId).roleDir;
    assert.ok(fs.existsSync(pendingDir));
    await fixture.app.close();

    const reopened = createBackendApp(config, {
      disableMemoryRuntime: true,
      modelPortFactory: () => fixture.model,
    });
    try {
      assert.equal(fs.existsSync(pendingDir), false);
      assert.deepEqual(reopened.appStore.listRoleDeletions(), []);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

test("并发删除不会删到零个角色", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const second = secondRole(fixture, "并发角色");
    for (const roleId of [fixture.roleId, second]) {
      const stopped = await api(
        base,
        "POST",
        `/v1/roles/${roleId}/activity/stop`,
      );
      assert.equal(stopped.status, 200);
    }
    const [first, other] = await Promise.all([
      api(base, "DELETE", `/v1/roles/${fixture.roleId}?keepHistory=1`),
      api(base, "DELETE", `/v1/roles/${second}?keepHistory=1`),
    ]);
    assert.deepEqual(
      [first.status, other.status].sort((a, b) => a - b),
      [200, 409],
    );
    const rejected = first.status === 409 ? first : other;
    assert.equal(errorOf(rejected).code, "LAST_ROLE_REQUIRED");
    assert.equal(fixture.app.appStore.listRoleIndexes().length, 1);
  } finally {
    await fixture.close();
  }
});

test("清理记录写入失败不阻断已接受的删除", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = secondRole(fixture, "收尾角色");
    const dir = rolePaths(fixture.app.config.dataRoot, roleId).roleDir;
    const stopped = await api(
      base,
      "POST",
      `/v1/roles/${roleId}/activity/stop`,
    );
    assert.equal(stopped.status, 200);

    const db = fixture.app.appStore.db;
    db.exec(
      "CREATE TRIGGER review_fail_role_clear BEFORE DELETE ON role_deletions " +
        "BEGIN SELECT RAISE(ABORT, 'injected cleanup marker failure'); END",
    );
    try {
      const removed = await api(
        base,
        "DELETE",
        `/v1/roles/${roleId}?keepHistory=0`,
      );
      assert.equal(removed.status, 200);
      assert.equal(
        (removed.body as { filesRemoved: boolean }).filesRemoved,
        true,
      );
      assert.equal(fs.existsSync(dir), false);
      assert.equal(
        fixture.app.appStore.listRoleDeletions().includes(roleId),
        true,
      );

      // 故障期间重试同一删除仍按实际结果返回成功。
      const retried = await api(
        base,
        "DELETE",
        `/v1/roles/${roleId}?keepHistory=0`,
      );
      assert.equal(retried.status, 200);
      assert.equal(
        fixture.app.appStore.listRoleDeletions().includes(roleId),
        true,
      );
    } finally {
      db.exec("DROP TRIGGER IF EXISTS review_fail_role_clear");
    }

    const retried = await api(
      base,
      "DELETE",
      `/v1/roles/${roleId}?keepHistory=0`,
    );
    assert.equal(retried.status, 200);
    assert.deepEqual(fixture.app.appStore.listRoleDeletions(), []);
  } finally {
    await fixture.close();
  }
});

test("角色删除等待在途配置写入结束后才执行", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    secondRole(fixture, "保底角色");
    const target = fixture.roleId;
    const paths = rolePaths(fixture.app.config.dataRoot, target);
    const stopped = await api(
      base,
      "POST",
      `/v1/roles/${target}/activity/stop`,
    );
    assert.equal(stopped.status, 200);

    // 模拟一次在途的配置写入（例如图片解码中的上传）持有角色写入锁。
    const gate = deferred<void>();
    const held = fixture.app.services.activity.guardRole(
      target,
      () => gate.promise,
    );
    const deleting = api(
      base,
      "DELETE",
      `/v1/roles/${target}?keepHistory=0`,
    );
    const early = await Promise.race([
      deleting,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 150),
      ),
    ]);
    assert.equal(early, undefined, "在途配置写入结束前不得接受删除");

    gate.resolve();
    await held;
    const removed = await deleting;
    assert.equal(removed.status, 200);
    assert.equal(
      (removed.body as { filesRemoved: boolean }).filesRemoved,
      true,
    );
    assert.equal((await api(base, "GET", `/v1/roles/${target}`)).status, 404);
    assert.equal(fs.existsSync(paths.roleDir), false);
    assert.equal(fixture.app.appStore.listRoleIndexes().length, 1);
  } finally {
    await fixture.close();
  }
});
