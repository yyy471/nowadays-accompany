import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import { EngineeringPool } from "../../src/mcp/engineering-pool.js";
import { RoleAccess } from "../../src/application/role/role-access.js";
import { EngineeringJobs } from "../../src/storage/conversation/engineering-jobs.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";
import { APP_SCHEMA_VERSION, BUSINESS_SCHEMA_VERSION } from "../../src/storage/core/schema.js";
import { createFixture } from "../fixtures/conversation-fixture.js";

test("工程设置校验宿主会话、来源及新成员；只有显式开启修复席位绑定", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-engineering-settings-"));
  const app = createBackendApp({ ...parseBackendConfig(["--app-root", root]), hostToken: "test-host-token" }, { disableMemoryRuntime: true });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const port = await listen(app.server, 0, app.config.host);
  const url = `http://127.0.0.1:${port}/v1/engineering/settings`;
  const headers = { "x-nowadays-host-token": "test-host-token", "content-type": "application/json" };
  const put = (input: unknown) => fetch(url, { method: "PUT", headers, body: JSON.stringify(input) });
  const summary = async (response: Promise<Response>) => await (await response).json() as ReturnType<EngineeringPool["settings"]>;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: "PUT", body: "{}" })).status, 401);
  assert.equal((await fetch(url, { headers: { ...headers, origin: "https://foreign.invalid" } })).status, 403);
  assert.deepEqual(await (await fetch(url, { headers })).json(), { enabled: true, mode: "priority", allowShell: false, members: [], readiness: "empty" });
  const resources = app.services.resources;
  const seat = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const pi = resources.list("mcp")[0]!;
  const service = resources.create({ kind: "model", name: "工程一号", config: { protocol: "openai-chat", baseUrl: "http://localhost" } });
  const member = { resourceId: service.resourceId, modelName: "test", enabled: true };
  resources.replaceBindings(seat, []);
  assert.equal((await summary(put({ allowShell: true }))).allowShell, true);
  const saved = await summary(put({ members: [member], mode: "round_robin" }));
  assert.equal(saved.allowShell, true);
  assert.equal((await put({ allowShell: "true" })).status, 400);
  assert.equal(saved.readiness, "unbound");
  assert.deepEqual(resources.listBindings(seat), []);
  assert.deepEqual(saved.members, [{ ...member, resourceName: service.name, state: "ready", retryAfterSeconds: null }]);
  assert.equal((await put({ enabled: true, members: [member, member] })).status, 400);
  assert.equal((await put({ members: [{ ...member, resourceId: pi.resourceId }] })).status, 400);
  const google = resources.create({ kind: "model", name: "Google", config: { protocol: "google-gemini", baseUrl: "http://localhost" } });
  assert.equal((await put({ members: [{ ...member, resourceId: google.resourceId, modelName: "projects/test/locations/global/publishers/google/models/gemini" }] })).status, 400);
  assert.equal((await put({ members: [{ ...member, resourceId: google.resourceId, modelName: "models/gemini" }] })).status, 200);
  await put({ members: [member] });
  assert.deepEqual(resources.listBindings(seat), []);
  assert.equal((await summary(put({ enabled: true }))).readiness, "ready");
  assert.equal(resources.listBindings(seat).length, 1);
  resources.replaceBindings(seat, [{ capability: "mcp", resourceId: pi.resourceId, enabled: false }]);
  await put({ mode: "priority" });
  assert.equal(resources.listBindings(seat)[0]?.enabled, false);
  const seatStore = RoleStorage.openExisting(rolePaths(app.config.dataRoot, seat));
  try {
    seatStore.business.db.exec(`CREATE TRIGGER reject_enable BEFORE UPDATE ON role_bindings
      BEGIN SELECT RAISE(ABORT,'fixture-write-failure'); END`);
    assert.equal((await put({ enabled: true, mode: "round_robin" })).status, 500);
    assert.equal((await summary(fetch(url, { headers }))).mode, "priority");
    assert.equal(resources.listBindings(seat)[0]?.enabled, false);
    seatStore.business.db.exec("DROP TRIGGER reject_enable");
  } finally { seatStore.close(); }
  await put({ enabled: true });
  await put({ enabled: true });
  assert.deepEqual(resources.listBindings(seat).map(r => [r.resourceId, r.enabled]), [[pi.resourceId, true]]);
  resources.remove(service.resourceId);
  assert.equal((await summary(fetch(url, { headers }))).members[0]?.state, "invalid");
  assert.equal((await summary(put({ members: [] }))).readiness, "empty");
});

test("工程源冷却独立于实时维护；清空、停用后只有已签父链仍可取证续用并保护密钥", async t => {
  const { app, close } = createFixture([], { disablePresetAssistant: false });
  t.after(close);
  const access = app.roleAccess;
  const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const resources = app.services.resources;
  const { resourceId } = resources.create({ kind: "model", name: "独立工程源", secret: "sample-key",
    config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1" } });
  let clock = Date.UTC(2026, 1, 2);
  const pool = new EngineeringPool(app.appStore, resources, access, () => clock);
  const modelName = "model/A";
  pool.update({ members: [{ resourceId, modelName, enabled: true }] });
  const taskId = access.withStore(roleId, ({ business }) => business.createTask({ roleId, goal: "工程样例" }).taskId);
  const nextTask = access.withStore(roleId, ({ business }) => business.createTask({ roleId, goal: "后续样例" }).taskId);
  resources.beginMaintenance(resourceId);
  assert.equal(pool.discover(roleId, taskId), true);
  assert.equal(pool.settings().members[0]?.state, "maintenance");
  assert.throws(() => pool.allocate(roleId, taskId), { code: "PI_ENGINEERING_POOL_EXHAUSTED" });
  resources.endMaintenance(resourceId);
  assert.equal(pool.settings().readiness, "ready");
  pool.reportFailure(resourceId, modelName, "1.5");
  assert.equal(pool.settings().members[0]?.retryAfterSeconds, 180);
  pool.reportFailure(resourceId, modelName, new Date(clock + 320_000).toUTCString());
  assert.equal(pool.settings().members[0]?.retryAfterSeconds, 320);
  clock += 319_001;
  assert.equal(pool.settings().members[0]?.retryAfterSeconds, 1);
  assert.throws(() => pool.allocate(roleId, taskId), { code: "PI_ENGINEERING_POOL_EXHAUSTED" });
  clock += 999;
  const chosen = pool.allocate(roleId, taskId);
  assert.equal(chosen.allowShell, false);
  pool.update({ allowShell: true });
  assert.equal(pool.allocate(roleId, taskId).allowShell, true);
  assert.equal(chosen.allowShell, false);
  const windowId = app.services.roles.getRole(roleId).defaultWindowId!;
  access.withStore(roleId, ({ business }) => {
    const jobs = new EngineeringJobs(business.db);
    jobs.register({ jobId: "sample", roleId, taskId, windowId, modelResourceId: chosen.resourceId, modelName: chosen.modelName,
      startedAt: new Date().toISOString(), workDir: app.config.appRoot, origin: "user", title: "任务", extId: "sample" });
    jobs.settle("sample", "completed", "已收尾", new Date().toISOString());
    assert.deepEqual(business.db.prepare("SELECT task_id FROM task_resource_continuations WHERE resource_id=?").all(resourceId), []);
  });
  pool.update({ enabled: false, members: [] });
  resources.update(resourceId, { enabled: false });
  assert.equal(pool.discover(roleId, nextTask), false);
  assert.equal(pool.discover(roleId, taskId), true);
  assert.equal(pool.allocate(roleId, taskId).modelName, modelName);
  assert.deepEqual(resources.impact(resourceId).roles.map(r => r.taskIds), [[taskId]]);
  assert.equal(resources.references(resourceId).canDelete, false);
  assert.throws(() => resources.remove(resourceId), { code: "RESOURCE_IN_USE" });
  assert.throws(() => resources.update(resourceId, { secret: null }), { code: "RESOURCE_IN_USE" });
  assert.throws(() => resources.update(resourceId, { secret: null, config: {
    ...resources.get(resourceId).config, credentialRef: "env:UNAVAILABLE_ENGINEERING_CREDENTIAL",
  } }), { code: "RESOURCE_IN_USE" });
  access.withStore(roleId, ({ business }) => business.finishTask({ roleId, taskId, status: "completed", endReason: "完成" }));
  assert.equal(pool.discover(roleId, taskId), false);
  assert.equal(resources.references(resourceId).canDelete, true);
  resources.remove(resourceId);
});

test("轮询保留最近获配项的位置，停用该项后从原位置向后扫描", async t => {
  const { app, close } = createFixture([], { disablePresetAssistant: false });
  t.after(close);
  const { engineeringPool: pool, resources } = app.services;
  const seat = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const access = app.roleAccess;
  const task = () => access.withStore(seat, ({ business }) => business.createTask({ roleId: seat, goal: "轮询" }).taskId);
  const resourceId = resources.list("model")[0]!.resourceId;
  const members = ["A", "B", "C"].map(modelName => ({ resourceId, modelName, enabled: true }));
  pool.update({ mode: "round_robin", members });
  assert.equal(pool.allocate(seat, task()).modelName, "A");
  assert.equal(pool.allocate(seat, task()).modelName, "B");
  pool.update({ members: members.map(row => ({ ...row, enabled: row.modelName !== "B" })) });
  assert.equal(pool.allocate(seat, task()).modelName, "C");
  assert.equal(pool.allocate(seat, task()).modelName, "A");
});

test("Google 工程成员的合法别名共用判重、轮询位置和历史冷却", async t => {
  const { app, close } = createFixture([], { disablePresetAssistant: false });
  t.after(close);
  const { engineeringPool: pool, resources } = app.services;
  const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const access = app.roleAccess;
  const { resourceId } = resources.create({ kind: "model", name: "Google",
    config: { protocol: "google-gemini", baseUrl: "http://localhost" } });
  const flash = { resourceId, modelName: "gemini-2.5-flash", enabled: true };
  const alias = { ...flash, modelName: "models/" + flash.modelName };
  const pro = { ...flash, modelName: "gemini-2.5-pro" };
  assert.throws(() => pool.update({ members: [flash, alias] }), { code: "ENGINEERING_MEMBER_DUPLICATE" });
  const { taskId } = access.withStore(roleId, ({ business }) => business.createTask({ roleId, goal: "旧型号续用" }));
  pool.update({ mode: "round_robin", members: [alias, pro] });
  assert.equal(pool.allocate(roleId, taskId).modelName, alias.modelName);
  pool.update({ members: [flash, pro] });
  assert.equal(pool.allocate(roleId, taskId).modelName, pro.modelName);

  const windowId = app.services.roles.getRole(roleId).defaultWindowId!;
  access.withStore(roleId, ({ business }) => {
    const jobs = new EngineeringJobs(business.db);
    jobs.register({ roleId, taskId, windowId, jobId: "alias-job", origin: "user", extId: "sample", title: "别名历史",
      startedAt: new Date().toISOString(), workDir: app.config.appRoot, modelResourceId: resourceId, modelName: alias.modelName });
    jobs.settle("alias-job", "completed", "已收尾", new Date().toISOString());
  });
  pool.reportFailure(resourceId, flash.modelName, "480");
  const [summary] = pool.update({ members: [alias] }).members;
  assert.equal(summary?.modelName, alias.modelName);
  assert.equal(summary?.state, "cooldown");
  pool.update({ members: [] });
  assert.equal(pool.discover(roleId, taskId), true);
  assert.throws(() => pool.allocate(roleId, taskId), { code: "PI_ENGINEERING_POOL_EXHAUSTED" });
});

test("V14 全局与 V30 角色库迁移保留历史工程和空池默认值", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-engineering-migrate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = parseBackendConfig(["--app-root", root]);
  let app = createBackendApp(config, { disableMemoryRuntime: true });
  const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const paths = rolePaths(config.dataRoot, roleId);
  const access = app.roleAccess;
  const windowId = app.services.roles.getRole(roleId).defaultWindowId!;
  try {
    access.withStore(roleId, ({ business }) => {
      const { taskId } = business.createTask({ roleId, goal: "迁移前任务" });
      const jobs = new EngineeringJobs(business.db);
      jobs.register({ jobId: "old", roleId, taskId, windowId, origin: "user", extId: "old", title: "旧工程",
        startedAt: new Date().toISOString(), workDir: "", modelResourceId: null, modelName: null });
      jobs.settle("old", "completed", "旧回执", new Date().toISOString());
    });
  } finally { await app.close(); }
  const appV14 = new Database(config.appDatabasePath);
  try { appV14.exec("DROP TABLE engineering_settings; PRAGMA user_version = 14;"); } finally { appV14.close(); }
  const roleV30 = new Database(paths.businessDatabasePath);
  try { roleV30.exec("ALTER TABLE engineering_jobs DROP COLUMN model_resource_id; ALTER TABLE engineering_jobs DROP COLUMN model_name; PRAGMA user_version = 30;"); }
  finally { roleV30.close(); }
  app = createBackendApp(config, { disableMemoryRuntime: true });
  try {
    assert.equal(app.appStore.schemaVersion, APP_SCHEMA_VERSION);
    assert.deepEqual(app.services.engineeringPool.settings(), { enabled: true, mode: "priority", allowShell: false, members: [], readiness: "empty" });
    const store = RoleStorage.openExisting(paths);
    try {
      assert.equal(store.business.schemaVersion, BUSINESS_SCHEMA_VERSION);
      const old = new EngineeringJobs(store.business.db).find("old");
      assert.equal(old?.summary, "旧回执");
      assert.equal(old?.modelResourceId, null);
      assert.equal(old?.modelName, null);
    } finally { store.close(); }
  } finally { await app.close(); }
});


test("V15 engineering settings migrate without losing existing values", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-engineering-v15-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = parseBackendConfig(["--app-root", root]);
  let app = createBackendApp(config, { disableMemoryRuntime: true });
  await app.close();
  const db = new Database(config.appDatabasePath);
  try { db.exec(`ALTER TABLE engineering_settings DROP COLUMN allow_shell;
    UPDATE engineering_settings SET mode='round_robin', members_json='[{"resourceId":"old","modelName":"model","enabled":true}]';
    PRAGMA user_version=15;`); } finally { db.close(); }
  app = createBackendApp(config, { disableMemoryRuntime: true });
  try {
    const settings = app.services.engineeringPool.settings();
    assert.equal(settings.mode, "round_robin");
    assert.equal(settings.allowShell, false);
    assert.deepEqual(app.appStore.db.prepare("SELECT mode, members_json, allow_shell FROM engineering_settings WHERE id=1").get(),
      { mode: "round_robin", members_json: JSON.stringify([{ resourceId: "old", modelName: "model", enabled: true }]), allow_shell: 0 });
    assert.throws(() => app.appStore.db.prepare("UPDATE engineering_settings SET allow_shell=2").run());
  } finally { await app.close(); }
});

test("工程成员可选模型参数保存读取、边界校验并透传 allocate", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-engineering-limits-"));
  const app = createBackendApp({ ...parseBackendConfig(["--app-root", root]), hostToken: "test-host-token" }, { disableMemoryRuntime: true });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const port = await listen(app.server, 0, app.config.host);
  const url = `http://127.0.0.1:${port}/v1/engineering/settings`;
  const headers = { "x-nowadays-host-token": "test-host-token", "content-type": "application/json" };
  const put = (input: unknown) => fetch(url, { method: "PUT", headers, body: JSON.stringify(input) });
  const summary = async (response: Promise<Response>) => await (await response).json() as ReturnType<EngineeringPool["settings"]>;
  const seat = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const service = app.services.resources.create({ kind: "model", name: "参数成员", config: { protocol: "openai-chat", baseUrl: "http://localhost" } });
  const member = { resourceId: service.resourceId, modelName: "param", enabled: true, maxTokens: 65536, contextWindow: 400000, thinkingLevel: "medium" };
  const saved = await summary(put({ members: [member] }));
  assert.equal(saved.members[0]?.maxTokens, 65536);
  assert.equal(saved.members[0]?.contextWindow, 400000);
  assert.equal(saved.members[0]?.thinkingLevel, "medium");
  for (const invalid of [
    { maxTokens: 1023 }, { maxTokens: 131073 }, { maxTokens: 1024.5 },
    { contextWindow: 8191 }, { contextWindow: 2_000_001 }, { thinkingLevel: "max" },
  ]) {
    assert.equal((await put({ members: [{ ...member, ...invalid }] })).status, 400, JSON.stringify(invalid));
  }
  const bounded = await summary(put({ members: [{ ...member, maxTokens: 1024, contextWindow: 8192, thinkingLevel: "xhigh" }] }));
  assert.equal(bounded.members[0]?.maxTokens, 1024);
  assert.equal(bounded.members[0]?.contextWindow, 8192);
  assert.equal(bounded.members[0]?.thinkingLevel, "xhigh");
  const plain = await summary(put({ members: [{ resourceId: service.resourceId, modelName: "param", enabled: true }] }));
  assert.equal(plain.members[0]?.maxTokens, undefined);
  assert.equal(plain.members[0]?.thinkingLevel, undefined);
  await put({ members: [member] });
  const taskId = app.roleAccess.withStore(seat, ({ business }) => business.createTask({ roleId: seat, goal: "参数透传" }).taskId);
  const chosen = app.services.engineeringPool.allocate(seat, taskId);
  assert.equal(chosen.maxTokens, 65536);
  assert.equal(chosen.contextWindow, 400000);
  assert.equal(chosen.thinkingLevel, "medium");
});

test("工程近期记录返回终态、耗时、模型、摘要与步骤日志，且默认契约不变", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-engineering-recent-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-engineering-steps-"));
  const app = createBackendApp({ ...parseBackendConfig(["--app-root", root]), hostToken: "test-host-token" }, { disableMemoryRuntime: true });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const port = await listen(app.server, 0, app.config.host);
  const url = `http://127.0.0.1:${port}/v1/engineering/jobs`;
  const headers = { "x-nowadays-host-token": "test-host-token" };
  const seat = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const windowId = app.services.roles.getRole(seat).defaultWindowId!;
  const workDir = path.join(parent, "sample");
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(parent, "steps.json"), JSON.stringify({ jobId: "job-steps", updatedAt: "2026-01-01T00:00:10.000Z", steps: [
    { at: "2026-01-01T00:00:02.000Z", tool: "write", target: "index.js", isError: false, durationMs: 12 },
    { at: "2026-01-01T00:00:05.000Z", tool: "draft_test", target: "test.mjs", isError: false, durationMs: 30, exitCode: 0, tail: "ok" },
  ] }));
  app.roleAccess.withStore(seat, ({ business }) => {
    const { taskId } = business.createTask({ roleId: seat, goal: "近期记录" });
    const jobs = new EngineeringJobs(business.db);
    jobs.register({ jobId: "job-steps", roleId: seat, taskId, windowId, origin: "user", extId: "sample", title: "整理草稿",
      workDir, startedAt: "2026-01-01T00:00:00.000Z", modelResourceId: null, modelName: "model/A" });
    jobs.settle("job-steps", "failed", "测试未通过", "2026-01-01T00:00:10.000Z");
    jobs.register({ jobId: "job-timeout", roleId: seat, taskId, windowId, origin: "autonomous", extId: "sample", title: "超时工程",
      workDir: "", startedAt: "2025-12-31T23:00:00.000Z", modelResourceId: null, modelName: "model/B" });
    jobs.settle("job-timeout", "timed_out", "超过时限", "2025-12-31T23:01:00.000Z");
    jobs.register({ jobId: "job-running", roleId: seat, taskId, windowId, origin: "user", extId: "sample", title: "进行中的工程",
      workDir: "", startedAt: "2026-01-02T00:00:00.000Z", modelResourceId: null, modelName: "model/C" });
  });
  const legacy = await (await fetch(url, { headers })).json() as { items: Array<{ jobId: string }>; recent?: unknown };
  assert.deepEqual(Object.keys(legacy), ["items"]);
  assert.deepEqual(legacy.items.map(item => item.jobId), ["job-running"]);
  assert.equal((await fetch(url + "?includeRecent=1&limit=0", { headers })).status, 400);
  assert.equal((await fetch(url + "?includeRecent=1&limit=51", { headers })).status, 400);
  const body = await (await fetch(url + "?includeRecent=1&limit=10", { headers })).json() as {
    items: Array<{ jobId: string }>;
    recent: Array<{ jobId: string; status: string; modelName: string | null; summary: string; durationMs: number | null;
      steps: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(body.items.map(item => item.jobId), ["job-running"]);
  assert.deepEqual(body.recent.map(job => job.jobId), ["job-running", "job-steps", "job-timeout"]);
  const running = body.recent[0]!;
  assert.equal(running.status, "running");
  assert.equal(running.durationMs, null);
  assert.deepEqual(running.steps, []);
  const failed = body.recent[1]!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.modelName, "model/A");
  assert.equal(failed.summary, "测试未通过");
  assert.equal(failed.durationMs, 10_000);
  assert.deepEqual(failed.steps, [
    { at: "2026-01-01T00:00:02.000Z", tool: "write", target: "index.js", isError: false, durationMs: 12 },
    { at: "2026-01-01T00:00:05.000Z", tool: "draft_test", target: "test.mjs", isError: false, durationMs: 30, exitCode: 0, tail: "ok" },
  ]);
  const timedOut = body.recent[2]!;
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.modelName, "model/B");
  assert.equal(timedOut.summary, "超过时限");
  assert.equal(timedOut.durationMs, 60_000);
  assert.deepEqual(timedOut.steps, []);
});
