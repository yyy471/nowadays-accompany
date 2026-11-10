import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { AppStore } from "../src/storage/app-store.js";
import { RoleStore } from "../src/storage/role-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import { openAppDatabase } from "../src/storage/schema.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p1-02-"));
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

async function requestRole(
  app: ReturnType<typeof createBackendApp>,
  roleId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!app.server.listening) {
    await listen(app.server, 0, app.config.host);
  }
  const address = app.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("SERVER_ADDRESS_UNAVAILABLE");
  }
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/roles/${roleId}`,
    {
    signal: AbortSignal.timeout(5000),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code?: string } | undefined)?.code ?? "";
}

function moveDatabaseFiles(target: string, backup: string): void {
  fs.renameSync(target, backup);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${target}${suffix}`)) {
      fs.renameSync(`${target}${suffix}`, `${backup}${suffix}`);
    }
  }
}

function restoreDatabaseFiles(target: string, backup: string): void {
  fs.renameSync(backup, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${backup}${suffix}`)) {
      fs.renameSync(`${backup}${suffix}`, `${target}${suffix}`);
    }
  }
}

test("app and role stores initialize, persist and reopen", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  let role: RoleStorage | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
    assert.equal(config.appRoot, path.resolve(root));
    assert.equal(config.dataRoot, path.join(path.resolve(root), "data"));

    app = createBackendApp(config);
    assert.equal(app.appStore.schemaVersion, 3);
    assert.equal(app.appStore.db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(app.appStore.db.pragma("journal_mode", { simple: true }), "wal");
    assert.deepEqual(tableNames(app.appStore.db), [
      "model_test_calls",
      "resource_secrets",
      "resources",
      "roles",
    ]);

    const paths = rolePaths(config.dataRoot, randomUUID());
    role = new RoleStorage(paths);
    assert.equal(role.business.schemaVersion, 13);
    assert.equal(role.checkpoint.schemaVersion, 1);
    assert.ok(fs.existsSync(paths.workspaceDir));
    const businessTables = tableNames(role.business.db);
    assert.ok(businessTables.includes("messages"));
    assert.ok(businessTables.includes("tool_call_mode_events"));
    assert.ok(businessTables.includes("task_resource_continuations"));

    role.close();
    role = undefined;
    await app.close();
    app = undefined;

    const reopenedApp = new AppStore(config.appDatabasePath);
    const reopenedRole = new RoleStorage(paths);
    try {
      assert.equal(reopenedApp.schemaVersion, 3);
      assert.equal(reopenedRole.business.schemaVersion, 13);
      assert.equal(reopenedRole.checkpoint.schemaVersion, 1);
      assert.ok(fs.existsSync(paths.businessDatabasePath));
      assert.ok(fs.existsSync(paths.executionDatabasePath));
    } finally {
      reopenedRole.close();
      reopenedApp.close();
    }
  } finally {
    role?.close();
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("health endpoint uses the shared local HTTP server", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root]);
    app = createBackendApp(config);
    const port = await listen(app.server, 0, config.host);
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", version: "0.1.0" });

    const missing = await fetch(`http://127.0.0.1:${port}/v1/unknown`);
    assert.equal(missing.status, 404);
    const payload = (await missing.json()) as {
      error?: { code?: string };
    };
    assert.equal(payload.error?.code, "NOT_FOUND");
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported schema version is rejected instead of migrated", () => {
  const root = tempRoot();
  try {
    const dbPath = path.join(root, "app.sqlite");
    const db = new Database(dbPath);
    db.pragma("user_version = 99");
    db.close();
    assert.throws(
      () => openAppDatabase(dbPath),
      /SCHEMA_VERSION_UNSUPPORTED/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ready role with missing storage reports an error without recreating files", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
    app = createBackendApp(config);
    const role = app.services.roles.createRole({
      displayName: "缺失存储",
      definition: { text: "验证" },
    });
    const paths = rolePaths(config.dataRoot, role.roleId);
    await app.close();
    app = undefined;

    const scenarios = [
      { label: "business", target: paths.businessDatabasePath },
      { label: "execution", target: paths.executionDatabasePath },
    ];
    for (const scenario of scenarios) {
      const backup = `${scenario.target}.review-backup`;
      moveDatabaseFiles(scenario.target, backup);
      const reopened = createBackendApp(config);
      try {
        const result = await requestRole(reopened, role.roleId);
        assert.equal(result.status, 500, scenario.label);
        assert.equal(errorCode(result.body), "STORAGE_ERROR", scenario.label);
        assert.equal(fs.existsSync(scenario.target), false, scenario.label);
        assert.equal(fs.existsSync(backup), true, scenario.label);
        assert.equal(
          reopened.appStore.getRoleIndex(role.roleId)?.initStatus,
          "ready",
        );
      } finally {
        await reopened.close();
        restoreDatabaseFiles(scenario.target, backup);
      }
    }

    const healthy = createBackendApp(config);
    try {
      const result = await requestRole(healthy, role.roleId);
      assert.equal(result.status, 200);
    } finally {
      await healthy.close();
    }
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty or incomplete role database is not silently initialized", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
    app = createBackendApp(config);
    const role = app.services.roles.createRole({
      displayName: "空库角色",
      definition: { text: "验证" },
    });
    const paths = rolePaths(config.dataRoot, role.roleId);
    await app.close();
    app = undefined;

    const backup = `${paths.businessDatabasePath}.review-backup`;
    moveDatabaseFiles(paths.businessDatabasePath, backup);
    fs.writeFileSync(paths.businessDatabasePath, "");

    const reopened = createBackendApp(config);
    try {
      const result = await requestRole(reopened, role.roleId);
      assert.equal(result.status, 500);
      assert.equal(errorCode(result.body), "STORAGE_ERROR");
      const db = new Database(paths.businessDatabasePath, { readonly: true });
      try {
        assert.equal(db.pragma("user_version", { simple: true }), 0);
        assert.deepEqual(tableNames(db), []);
      } finally {
        db.close();
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("index predicate string literals are compared exactly", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
    app = createBackendApp(config);
    const samples = [
      {
        name: "keyword-format-control",
        predicate: "where CAPABILITY = 'chat_model'",
        expected: 200,
      },
      {
        name: "changed-literal-case",
        predicate: "WHERE capability = 'CHAT_MODEL'",
        expected: 500,
      },
      {
        name: "changed-literal-whitespace",
        predicate: "WHERE capability = 'chat_model '",
        expected: 500,
      },
      {
        name: "changed-literal-parentheses",
        predicate: "WHERE capability = 'chat_(model)'",
        expected: 500,
      },
    ];
    const roles = samples.map((sample) =>
      app?.services.roles.createRole({
        displayName: sample.name,
        definition: { text: "验证" },
      }),
    );
    await app.close();
    app = undefined;

    for (const [index, sample] of samples.entries()) {
      const role = roles[index];
      assert.ok(role);
      const paths = rolePaths(config.dataRoot, role.roleId);
      const store = new RoleStore(paths.businessDatabasePath, {
        create: false,
      });
      store.db.exec(
        `DROP INDEX idx_role_single_chat_model; CREATE UNIQUE INDEX idx_role_single_chat_model ON role_bindings(role_id) ${sample.predicate};`,
      );
      store.close();
    }

    const reopened = createBackendApp(config);
    try {
      for (const [index, sample] of samples.entries()) {
        const role = roles[index];
        assert.ok(role);
        const result = await requestRole(reopened, role.roleId);
        assert.equal(result.status, sample.expected, sample.name);
        if (sample.expected === 500) {
          assert.equal(errorCode(result.body), "STORAGE_ERROR");
        }
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("role database missing required columns is rejected", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
    app = createBackendApp(config);
    const role = app.services.roles.createRole({
      displayName: "缺列角色",
      definition: { text: "验证" },
    });
    const paths = rolePaths(config.dataRoot, role.roleId);
    await app.close();
    app = undefined;

    const db = new Database(paths.businessDatabasePath);
    db.exec("ALTER TABLE tool_results DROP COLUMN reconciled_at");
    db.close();

    const reopened = createBackendApp(config);
    try {
      const result = await requestRole(reopened, role.roleId);
      assert.equal(result.status, 500);
      assert.equal(errorCode(result.body), "STORAGE_ERROR");
    } finally {
      await reopened.close();
    }
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing or wrongly defined required indexes are rejected", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
    app = createBackendApp(config);
    const missingIndexRole = app.services.roles.createRole({
      displayName: "缺索引",
      definition: { text: "验证" },
    });
    const wrongIndexRole = app.services.roles.createRole({
      displayName: "错索引",
      definition: { text: "验证" },
    });
    const suffixIndexRole = app.services.roles.createRole({
      displayName: "谓词附加条件",
      definition: { text: "验证" },
    });
    const healthyRole = app.services.roles.createRole({
      displayName: "正常角色",
      definition: { text: "验证" },
    });
    const missingPaths = rolePaths(config.dataRoot, missingIndexRole.roleId);
    const wrongPaths = rolePaths(config.dataRoot, wrongIndexRole.roleId);
    const suffixPaths = rolePaths(config.dataRoot, suffixIndexRole.roleId);
    await app.close();
    app = undefined;

    const missingStore = new RoleStore(missingPaths.businessDatabasePath);
    missingStore.db.exec(
      "DROP INDEX idx_messages_window_submission; DROP INDEX idx_role_single_chat_model;",
    );
    missingStore.close();

    const wrongStore = new RoleStore(wrongPaths.businessDatabasePath);
    wrongStore.db.exec(
      "DROP INDEX idx_messages_window_submission; CREATE INDEX idx_messages_window_submission ON messages(window_id, submission_id);",
    );
    wrongStore.close();

    const suffixStore = new RoleStore(suffixPaths.businessDatabasePath);
    suffixStore.db.exec(
      "DROP INDEX idx_role_single_chat_model; CREATE UNIQUE INDEX idx_role_single_chat_model ON role_bindings(role_id) WHERE capability = 'chat_model' AND 0;",
    );
    suffixStore.close();

    const reopened = createBackendApp(config);
    try {
      const missing = await requestRole(reopened, missingIndexRole.roleId);
      assert.equal(missing.status, 500);
      assert.equal(errorCode(missing.body), "STORAGE_ERROR");

      const wrong = await requestRole(reopened, wrongIndexRole.roleId);
      assert.equal(wrong.status, 500);
      assert.equal(errorCode(wrong.body), "STORAGE_ERROR");

      const suffix = await requestRole(reopened, suffixIndexRole.roleId);
      assert.equal(suffix.status, 500);
      assert.equal(errorCode(suffix.body), "STORAGE_ERROR");

      const healthy = await requestRole(reopened, healthyRole.roleId);
      assert.equal(healthy.status, 200);
    } finally {
      await reopened.close();
    }
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
