import { ExtensionHost } from "../../src/application/extensions/extension-host.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { applyRoleTransfer, exportRoleTransfer, preflightRoleTransfer } from "../../src/application/transfer/role-transfer.js";
import { readRoleTransferPackage, roleTransferTimelineFingerprint, roleTransferWithAncestors, writeRoleTransferPackage } from "../../src/application/transfer/role-transfer-package.js";
import { createBackendApp } from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths, type BackendConfig } from "../../src/bootstrap/config.js";

import { EngineeringJobs } from "../../src/storage/conversation/engineering-jobs.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";

const options = { disableMemoryRuntime: true, disablePresetAssistant: true };
const backend = fileURLToPath(new URL("../../", import.meta.url));

function installation(t: TestContext): BackendConfig {
  const resultRoot = process.env.P1_REVIEW_TMP_ROOT ?? path.resolve(backend, "../../test-results/backend-acceptance");
  fs.mkdirSync(resultRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(resultRoot, "role-transfer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return parseBackendConfig(["--app-root", root, "--port", "0"]);
}

async function createRole(config: BackendConfig) {
  const app = createBackendApp(config, options);
  try {
    return app.services.roles.createRole({ displayName: "迁移角色", definition: { text: "保持自己的经历。" } });
  } finally {
    await app.close();
  }
}

function transfer(config: BackendConfig, file: string): void {
  const preview = preflightRoleTransfer(config, file);
  assert.equal(applyRoleTransfer(config, file, preview.token).outcome, "published");
}

function note(config: BackendConfig, roleId: string, name: string): string {
  return path.join(rolePaths(config.dataRoot, roleId).workspaceDir, name);
}

function cli(config: BackendConfig, command: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli/role-transfer.ts",
    command, "--app-root", config.appRoot, ...args], { cwd: backend, encoding: "utf8" });
}

test("本地 CLI 与正常后端争用安装锁，异常启动后释放，进程退出后可重用", async (t) => {
  const source = installation(t);
  const target = installation(t);
  const role = await createRole(source);
  const packet = path.join(source.appRoot, "role.json");
  const active = createBackendApp(source, options);
  active.roleAccess.withStore(role.roleId, storage => { storage.business.db.prepare("SELECT 1").get(); storage.checkpoint.db.prepare("SELECT 1").get(); });
  try {
    const response = cli(source, "export", "--role", role.roleId, "--out", packet);
    assert.equal(response.status, 1);
    assert.equal(JSON.parse(response.stderr).error.code, "INSTALLATION_BUSY");
    assert.equal(fs.existsSync(packet), false);
    assert.throws(() => createBackendApp(source, options), /INSTALLATION_BUSY/);
  } finally {
    await active.close();
  }
  const exported = cli(source, "export", "--role", role.roleId, "--out", packet);
  assert.equal(exported.status, 0, exported.stderr);
  const preflight = cli(target, "preflight", "--in", packet);
  assert.equal(preflight.status, 0, preflight.stderr);
  const { token, relation } = JSON.parse(preflight.stdout);
  assert.equal(relation, "new");
  const applied = cli(target, "apply", "--in", packet, "--token", String(token));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).outcome, "published");

  const broken = installation(t);
  fs.mkdirSync(broken.dataRoot);
  fs.writeFileSync(broken.appDatabasePath, "broken");
  assert.throws(() => createBackendApp(broken, options), /not a database/i);
  fs.unlinkSync(broken.appDatabasePath);
  const repaired = createBackendApp(broken, options);
  await repaired.close();
});

test("共同基线区分相同、前进、分化和未知，选择保留本机或采用包", async (t) => {
  const a = installation(t);
  const b = installation(t);
  const role = await createRole(a);
  const id = role.roleId;
  const baseline = path.join(a.appRoot, "base.json");
  const ahead = path.join(b.appRoot, "ahead.json");
  const branch = path.join(b.appRoot, "branch.json");
  fs.writeFileSync(note(a, id, "共同.md"), "共同事实");
  exportRoleTransfer(a, id, baseline);
  transfer(b, baseline);
  const initial = preflightRoleTransfer(b, baseline);
  assert.equal(initial.relation, "same");
  assert.equal(applyRoleTransfer(b, baseline, initial.token, {}, "package").outcome, "unchanged");

  fs.writeFileSync(note(b, id, "第一份.md"), "只有 B 新增");
  assert.equal(preflightRoleTransfer(b, baseline).relation, "local-ahead");
  exportRoleTransfer(b, id, ahead);
  assert.equal(preflightRoleTransfer(a, ahead).relation, "package-ahead");

  const unchanged = preflightRoleTransfer(a, ahead);
  fs.writeFileSync(note(a, id, "A.md"), "A 已新增");
  assert.throws(() => applyRoleTransfer(a, ahead, unchanged.token), /ROLE_TRANSFER_PREFLIGHT_STALE/);
  fs.writeFileSync(note(b, id, "B.md"), "B 又新增");
  exportRoleTransfer(b, id, branch);
  const branchBytes = fs.readFileSync(branch);
  const divergent = preflightRoleTransfer(a, branch);
  assert.equal(divergent.relation, "diverged");
  assert.equal(divergent.requiresChoice, true);
  assert.throws(() => applyRoleTransfer(a, branch, divergent.token), /ROLE_TRANSFER_CHOICE_REQUIRED/);
  assert.equal(applyRoleTransfer(a, branch, divergent.token, {}, "local").outcome, "kept-local");
  assert.equal(fs.readFileSync(note(a, id, "A.md"), "utf8"), "A 已新增");
  assert.equal(preflightRoleTransfer(a, branch).token, divergent.token);

  // 篡改祖先声明也不能自动覆盖本机独有事实。
  const forged = path.join(b.appRoot, "forged.json");
  const candidate = readRoleTransferPackage(branch);
  const local = path.join(a.appRoot, "local.json");
  exportRoleTransfer(a, id, local);
  const localPackage = readRoleTransferPackage(local);
  writeRoleTransferPackage(forged, roleTransferWithAncestors(candidate, [localPackage.timelineFingerprint]));
  const unknown = preflightRoleTransfer(a, forged);
  assert.equal(unknown.relation, "unknown");
  assert.throws(() => applyRoleTransfer(a, forged, unknown.token), /ROLE_TRANSFER_CHOICE_REQUIRED/);

  assert.equal(applyRoleTransfer(a, branch, divergent.token, {}, "package").outcome, "published");
  assert.deepEqual(fs.readFileSync(branch), branchBytes);
  assert.equal(fs.existsSync(note(a, id, "A.md")), false);
  assert.equal(fs.readFileSync(note(a, id, "B.md"), "utf8"), "B 又新增");
  const repeated = preflightRoleTransfer(a, branch);
  assert.equal(repeated.relation, "same");
  assert.equal(applyRoleTransfer(a, branch, repeated.token, {}, "package").outcome, "unchanged");
});

test("同名笔记改写与目标映射版本变更使旧预检失效", async (t) => {
  const a = installation(t);
  const b = installation(t);
  const origin = createBackendApp(a, options);
  let roleId: string;
  try {
    const role = origin.services.roles.createRole({ displayName: "同步", definition: { text: "我是自己" } });
    roleId = role.roleId;
    const model = origin.services.resources.create({ kind: "model", name: "源模型",
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:2", modelName: "source" } });
    origin.services.resources.replaceBindings(roleId, [
      { capability: "chat_model", resourceId: model.resourceId, modelName: "source", enabled: true },
    ]);
  } finally {
    await origin.close();
  }
  const destination = createBackendApp(b, options);
  let targetId: string;
  try {
    targetId = destination.services.resources.create({ kind: "model", name: "目标模型",
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:3", modelName: "target" } }).resourceId;
  } finally {
    await destination.close();
  }
  const packet = path.join(a.appRoot, "role.json");
  fs.writeFileSync(note(a, roleId, "相同.md"), "旧内容");
  const exported = exportRoleTransfer(a, roleId, packet);
  const mapping = { [exported.bindings[0]!.key]: targetId };
  const first = preflightRoleTransfer(b, packet, mapping);
  const changed = new Database(b.appDatabasePath);
  changed.prepare("UPDATE resources SET updated_at = '2026-11-20T12:30:00Z' WHERE resource_id = ?").run(targetId);
  changed.close();
  assert.throws(() => applyRoleTransfer(b, packet, first.token, mapping), /ROLE_TRANSFER_PREFLIGHT_STALE/);
  let latest = preflightRoleTransfer(b, packet, mapping);
  applyRoleTransfer(b, packet, latest.token, mapping);
  latest = preflightRoleTransfer(b, packet, mapping);
  fs.writeFileSync(note(b, roleId, "相同.md"), "新内容");
  assert.throws(() => applyRoleTransfer(b, packet, latest.token, mapping), /ROLE_TRANSFER_PREFLIGHT_STALE/);
  assert.equal(preflightRoleTransfer(b, packet, mapping).relation, "unknown");
});

test("笔记已改写时按两边各自新增的用户消息识别分化", async (t) => {
  const a = installation(t);
  const b = installation(t);
  const { roleId, defaultWindowId } = await createRole(a);
  async function send(config: BackendConfig, content: string) {
    const app = createBackendApp(config, options);
    try {
      app.conversation.submitMessage(roleId, defaultWindowId,
        { content, sourcePlatform: "nowadays", submissionId: randomUUID() });
    } finally {
      await app.close();
    }
  }
  await send(a, "共同生活的第一天");
  fs.writeFileSync(note(a, roleId, "日记.md"), "第一天");
  const common = path.join(a.appRoot, "common.json");
  exportRoleTransfer(a, roleId, common);
  transfer(b, common);
  await send(a, "在 A 的新经历");
  await send(b, "在 B 的新经历");
  fs.writeFileSync(note(a, roleId, "日记.md"), "A 写了不同的内容");
  const later = path.join(a.appRoot, "later.json");
  exportRoleTransfer(a, roleId, later);
  const preview = preflightRoleTransfer(b, later);
  assert.equal(preview.relation, "diverged");
  assert.equal(preview.requiresChoice, true);
});

test("保留的孤留历史参与预检，待删、未初始化、不同预置身份和危险路径均拒绝", async (t) => {
  const a = installation(t);
  const b = installation(t);
  const role = await createRole(a);
  const packet = path.join(a.appRoot, "old.json");
  exportRoleTransfer(a, role.roleId, packet);
  transfer(b, packet);
  const local = createBackendApp(b, options);
  try {
    local.appStore.deleteRole(role.roleId);
  } finally {
    await local.close();
  }
  const orphan = preflightRoleTransfer(b, packet);
  assert.equal(orphan.relation, "same");
  assert.equal(orphan.registered, false);
  assert.equal(orphan.requiresChoice, true);
  assert.equal(applyRoleTransfer(b, packet, orphan.token, {}, "local").outcome, "kept-local");
  applyRoleTransfer(b, packet, orphan.token, {}, "package");

  const app = createBackendApp(b, options);
  app.appStore.recordRoleDeletion(role.roleId, new Date().toISOString());
  await app.close();
  assert.throws(() => preflightRoleTransfer(b, packet), /ROLE_TRANSFER_ROLE_PENDING_DELETION/);
  const raw = new Database(b.appDatabasePath);
  raw.prepare("DELETE FROM role_deletions WHERE role_id = ?").run(role.roleId);
  raw.prepare("UPDATE roles SET init_status = 'initializing' WHERE role_id = ?").run(role.roleId);
  raw.close();
  assert.throws(() => preflightRoleTransfer(b, packet), /ROLE_TRANSFER_ROLE_NOT_READY/);
  assert.throws(() => exportRoleTransfer(a, role.roleId, note(a, role.roleId, "pkg.json")), /ROLE_TRANSFER_PACKAGE_IN_MANAGED_DIRECTORY/);

  const originPreset = createBackendApp(a, { disableMemoryRuntime: true });
  const destinationPreset = createBackendApp(b, { disableMemoryRuntime: true });
  const presetId = originPreset.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  assert.notEqual(presetId, destinationPreset.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId);
  await originPreset.close();
  await destinationPreset.close();
  const presetPacket = path.join(a.appRoot, "preset.json");
  exportRoleTransfer(a, presetId, presetPacket);
  assert.throws(() => preflightRoleTransfer(b, presetPacket), /ROLE_TRANSFER_PRESET_KEY_IN_USE/);
});

test("进程在换名各阶段退出时，下一次正常启动恢复到完整角色库", { timeout: 60_000 }, async (t) => {
  const source = installation(t);
  const role = await createRole(source);
  const base = path.join(source.appRoot, "base.json");
  const newer = path.join(source.appRoot, "new.json");
  const roleId = role.roleId;
  exportRoleTransfer(source, roleId, base);
  fs.writeFileSync(note(source, roleId, "新增.md"), "未来");
  exportRoleTransfer(source, roleId, newer);
  const script = `
    import { applyRoleTransfer } from "./src/application/transfer/role-transfer.ts";
    import { parseBackendConfig } from "./src/bootstrap/config.ts";
    const [root, file, token, point] = process.argv.slice(1);
    applyRoleTransfer(parseBackendConfig(["--app-root", root]), file, token, {}, undefined,
      (name) => {
        if (point.startsWith("rollback-") && name === "package-renamed") throw new Error("force rollback");
        if (name === point) process.exit(77);
      });
  `;
  for (const point of ["staged", "prepared", "local-renamed", "package-renamed", "rollback-unpublished", "rollback-restored", "committed"]) {
    const target = installation(t);
    transfer(target, base);
    const preview = preflightRoleTransfer(target, newer);
    assert.equal(preview.relation, "package-ahead");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      script, target.appRoot, newer, preview.token, point], { cwd: backend, encoding: "utf8" });
    assert.equal(result.status, 77, `${point}: ${result.stderr}`);

    const app = createBackendApp(target, options);
    try {
      assert.equal(app.services.roles.getRole(roleId).roleId, roleId);
      assert.equal(fs.existsSync(note(target, roleId, "新增.md")), point === "committed");
      assert.deepEqual(app.appStore.db.prepare("SELECT * FROM role_transfer_publication").all(), []);
      assert.deepEqual(fs.readdirSync(path.join(target.dataRoot, ".role-transfer")), []);
    } finally {
      await app.close();
    }
  }
  for (const point of ["package-renamed", "committed"]) {
    const target = installation(t);
    const preview = preflightRoleTransfer(target, newer);
    assert.equal(preview.relation, "new");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      script, target.appRoot, newer, preview.token, point], { cwd: backend, encoding: "utf8" });
    assert.equal(result.status, 77, `${point}: ${result.stderr}`);

    const app = createBackendApp(target, options);
    try {
      const committed = point === "committed";
      assert.equal(Boolean(app.appStore.getRoleIndex(roleId)), committed);
      assert.equal(fs.existsSync(rolePaths(target.dataRoot, roleId).roleDir), committed);
      assert.deepEqual(app.appStore.db.prepare("SELECT * FROM role_transfer_publication").all(), []);
    } finally {
      await app.close();
    }
  }
});

test("迁入主角色的工程历史不能续用或锁住目标机的同 ID 模型", async t => {
  const source = installation(t), target = installation(t);
  const origin = createBackendApp(source, { ...options, disablePresetAssistant: false });
  const roleId = origin.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const modelName = "source-model";
  const { resourceId } = origin.services.resources.create({ kind: "model", name: "源机服务",
    config: { protocol: "openai-chat", baseUrl: "http://localhost" } });
  let taskId: string;
  const jobId = randomUUID();
  const store = RoleStorage.openExisting(rolePaths(source.dataRoot, roleId));
  try {
    const windowId = origin.services.roles.getRole(roleId).defaultWindowId!;
    taskId = store.business.createTask({ roleId, goal: "工程回执" }).taskId;
    const jobs = new EngineeringJobs(store.business.db);
    jobs.register({ roleId, taskId, windowId, jobId, modelResourceId: resourceId, modelName,
      workDir: source.appRoot, title: "源机工程", extId: "sample", startedAt: new Date().toISOString(), origin: "user" });
    jobs.settle(jobId, "completed", "源机回执", new Date().toISOString());
    store.business.pauseTask({ roleId, taskId, waitReason: "AWAITING_ENGINEERING_JOB", endReason: "等工程" });
  } finally { store.close(); await origin.close(); }
  const packet = path.join(source.appRoot, "seat.json");
  exportRoleTransfer(source, roleId, packet);
  transfer(target, packet);
  const destination = createBackendApp(target, options);
  try {
    destination.appStore.createResource({ resourceId, kind: "model", name: "目标机服务", enabled: true,
      config: { protocol: "openai-chat", baseUrl: "http://localhost" } });
    const { engineeringPool: pool, resources } = destination.services;
    assert.equal(pool.update({ enabled: true, members: [] }).readiness, "empty");
    assert.deepEqual(await destination.services.pi.tools(roleId, taskId), []);
    assert.throws(() => pool.allocate(roleId, taskId), { code: "PI_ENGINEERING_POOL_EXHAUSTED" });
    assert.equal(resources.references(resourceId).canDelete, true);
    resources.remove(resourceId);
    const imported = RoleStorage.openExisting(rolePaths(target.dataRoot, roleId));
    try {
      const history = new EngineeringJobs(imported.business.db).find(jobId);
      assert.equal(history?.modelResourceId, resourceId);
      assert.equal(history?.modelName, modelName);
      assert.equal(history?.summary, "源机回执");
    } finally { imported.close(); }
  } finally { await destination.close(); }
});

test("工程迁移保留回执，收敛在途作业和旧包悬空等待", async t => {
  const source = installation(t), target = installation(t), legacy = installation(t);
  const { roleId, defaultWindowId: windowId } = await createRole(source);
  const store = RoleStorage.openExisting(rolePaths(source.dataRoot, roleId));
  const tasks: string[] = [], ids = [randomUUID(), randomUUID()];
  try {
    const jobs = new EngineeringJobs(store.business.db);
    for (const id of ids) {
      const { taskId } = store.business.createTask({ roleId, goal: "迁移样例" });
      tasks.push(taskId);
      jobs.register({ roleId, jobId: id, windowId, taskId, workDir: source.appRoot, title: "样例", extId: "sample",
        startedAt: new Date().toISOString(), origin: "user", modelResourceId: "engineering-service", modelName: "pool-model" });
      store.business.pauseTask({ roleId, taskId, waitReason: "AWAITING_ENGINEERING_JOB", endReason: "等工程" });
    }
    jobs.settle(ids[0]!, "completed", "结果已存档", new Date().toISOString());
  } finally { store.close(); }
  const file = path.join(source.appRoot, "engineering.json");
  exportRoleTransfer(source, roleId, file);
  transfer(target, file);
  const imported = RoleStorage.openExisting(rolePaths(target.dataRoot, roleId));
  try {
    const jobs = new EngineeringJobs(imported.business.db);
    assert.deepEqual(jobs.nextDelivery(), { windowId, taskId: tasks[0] });
    assert.equal(jobs.find(ids[1]!)?.status, "interrupted_unknown");
    assert.equal(jobs.find(ids[0]!)?.workDir, "");
    assert.equal(jobs.find(ids[0]!)?.modelResourceId, "engineering-service");
    assert.equal(jobs.find(ids[0]!)?.modelName, "pool-model");
    assert.equal(imported.business.getTask(roleId, tasks[1]!).waitReason, "ROLE_TRANSFER_INTERRUPTED");
    const { executionId } = imported.business.createExecution({ roleId, windowId, triggerType: "user_message" });
    assert.equal(jobs.claim(tasks[0]!, executionId), 1);
    assert.match(JSON.stringify(jobs.receipts(tasks[0]!, executionId)), /结果已存档/);
  } finally { imported.close(); }
  const pkg = readRoleTransferPackage(file);
  for (const row of pkg.tables.engineering_jobs) {
    Reflect.deleteProperty(row, "model_resource_id");
    Reflect.deleteProperty(row, "model_name");
  }
  const v30File = path.join(source.appRoot, "jobs-v30.json");
  pkg.timelineFingerprint = roleTransferTimelineFingerprint(pkg);
  writeRoleTransferPackage(v30File, roleTransferWithAncestors(pkg, []));
  const v30 = installation(t);
  transfer(v30, v30File);
  assert.equal(preflightRoleTransfer(v30, v30File).relation, "same");
  const oldJobs = RoleStorage.openExisting(rolePaths(v30.dataRoot, roleId));
  try {
    const job = new EngineeringJobs(oldJobs.business.db).find(ids[0]!);
    assert.equal(job?.modelResourceId, null);
    assert.equal(job?.modelName, null);
  } finally { oldJobs.close(); }
  Reflect.deleteProperty(pkg.tables, "engineering_jobs");
  Reflect.deleteProperty(pkg.tables, "engineering_wakes");
  const oldFile = path.join(source.appRoot, "legacy.json");
  pkg.timelineFingerprint = roleTransferTimelineFingerprint(pkg);
  writeRoleTransferPackage(oldFile, roleTransferWithAncestors(pkg, []));
  transfer(legacy, oldFile);
  assert.equal(preflightRoleTransfer(legacy, oldFile).relation, "same");
  const old = RoleStorage.openExisting(rolePaths(legacy.dataRoot, roleId));
  try { assert.equal(old.business.getTask(roleId, tasks[0]!).waitReason, "ROLE_TRANSFER_INTERRUPTED"); }
  finally { old.close(); }
});

test("startup assembly failure drains warmed role storage before releasing installation lock", async (t) => {
  const source = installation(t);
  const role = await createRole(source);
  const originalRestore = ExtensionHost.prototype.restore;
  const originalOpen = RoleStorage.openExisting;
  let opens = 0;
  RoleStorage.openExisting = (...args) => { opens++; return originalOpen(...args); };
  ExtensionHost.prototype.restore = () => { throw new Error("INJECTED_ASSEMBLY_FAILURE"); };
  try {
    assert.throws(() => createBackendApp(source, options), /INJECTED_ASSEMBLY_FAILURE/);
    assert.ok(opens > 0, "startup must warm role storage before the fault");
  } finally {
    RoleStorage.openExisting = originalOpen;
    ExtensionHost.prototype.restore = originalRestore;
  }
  const packet = path.join(source.appRoot, "after-startup-failure.json");
  assert.throws(() => exportRoleTransfer(source, role.roleId, packet), /INSTALLATION_BUSY/);
  await new Promise<void>(resolve => setImmediate(resolve));
  exportRoleTransfer(source, role.roleId, packet);
  assert.ok(fs.existsSync(packet));
  const reopened = createBackendApp(source, options);
  await reopened.close();
});
