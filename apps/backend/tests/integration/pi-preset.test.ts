import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createBackendApp } from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import { loadAgentTools } from "../../src/application/conversation/agent-tools.js";
import { RoleAccess } from "../../src/application/role/role-access.js";
import { seedEngineeringPool } from "../fixtures/engineering-pool.js";
import { isAdminSeat } from "../../src/domain/admin-seat.js";
import { SkillLibrary } from "../../src/skills/skill-library.js";
import { ManagedPi } from "../../src/mcp/managed-pi.js";
import { managedPiCommand, resolvePiEntry } from "../../src/mcp/client.js";
import { createFixture, withStorage } from "../fixtures/conversation-fixture.js";
import { seedLegacyPresetAssistant } from "../fixtures/legacy-role-fixture.js";

test("首次预置启用主角色绑定，重复启动保留关闭、解绑和全局停用", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-pi-preset-"));
  const config = parseBackendConfig(["--app-root", root]);
  const open = () => createBackendApp(config, { disableMemoryRuntime: true });
  let app = open();
  try {
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const [pi] = app.services.resources.list("mcp");
    assert.ok(pi?.adminSeatOnly && pi.enabled);
    const binding = { resourceId: pi.resourceId, capability: "mcp" as const };
    for (const expected of [true, false, null]) {
      await app.close();
      app = open();
      assert.deepEqual(app.services.resources.list("mcp").map(r => r.resourceId), [pi.resourceId]);
      const bindings = app.services.resources.listBindings(id);
      assert.deepEqual(bindings.map(b => [b.resourceId, b.enabled]), expected === null ? [] : [[pi.resourceId, expected]]);
      if (expected === true) app.services.resources.replaceBindings(id, [{ ...binding, enabled: false }]);
      if (expected === false) {
        app.services.resources.replaceBindings(id, []);
        app.services.resources.update(pi.resourceId, { enabled: false });
      }
    }
    assert.equal(app.services.resources.get(pi.resourceId).enabled, false);
    app.services.resources.remove(pi.resourceId);
    await app.close();
    app = open();
    assert.deepEqual(app.services.resources.list("mcp").map(r => r.enabled), [false]);
    assert.deepEqual(app.services.resources.listBindings(id), []);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("V12 老库首次引入 Pi 时为已有主角色补绑，保留原有资源绑定", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-pi-v12-"));
  const config = parseBackendConfig(["--app-root", root]);
  let app = createBackendApp(config, { disableMemoryRuntime: true, disablePresetAssistant: true });
  try {
    seedLegacyPresetAssistant(config);
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    app.services.roles.initializeRole(id);
    const other = app.services.resources.create({ name: "已有技能", kind: "skill", config: { sourcePath: "skills" } });
    app.services.resources.replaceBindings(id, [{ resourceId: other.resourceId, capability: "skill" }]);
    await app.close();
    const legacy = new Database(config.appDatabasePath);
    try { legacy.exec("DROP TABLE builtin_resource_seeds"); legacy.pragma("user_version = 12"); }
    finally { legacy.close(); }
    app = createBackendApp(config, { disableMemoryRuntime: true });
    const [pi] = app.services.resources.list("mcp");
    assert.deepEqual(app.services.resources.listBindings(id).map(b => [b.resourceId, b.enabled]),
      [[pi!.resourceId, true], [other.resourceId, true]]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("老库已有自定义名称的托管 Pi，升级保留原资源和已解绑的主角色", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-pi-upgrade-"));
  const config = parseBackendConfig(["--app-root", root]);
  let app = createBackendApp(config, { disableMemoryRuntime: true, disablePresetAssistant: true });
  try {
    seedLegacyPresetAssistant(config);
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    app.services.roles.initializeRole(id);
    const pi = app.services.resources.create({ kind: "mcp", name: "我的工程", config: { command: managedPiCommand, args: [], env: {} } });
    app.services.resources.replaceBindings(id, [{ capability: "mcp", resourceId: pi.resourceId }]);
    app.services.resources.replaceBindings(id, []);
    await app.close();
    app = createBackendApp(config, { disableMemoryRuntime: true });
    assert.deepEqual(app.services.resources.list("mcp"), [pi]);
    assert.deepEqual(app.services.resources.listBindings(id), []);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("普通角色即使残留绑定或续用权也不可发现、借用或派发 Pi", async () => {
  const f = createFixture([], { disablePresetAssistant: false });
  try {
    const { app, roleId } = f;
    const adminId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const id = app.services.resources.list("mcp")[0]!.resourceId;
    const binding = { capability: "mcp" as const, resourceId: id, enabled: true };
    assert.throws(() => app.services.resources.replaceBindings(roleId, [binding]), { code: "PI_ADMIN_SEAT_REQUIRED", status: 403 });
    withStorage(f, storage => storage.business.ensureMcpBinding(roleId, id));
    assert.ok(!app.services.resources.listBindings(roleId).some(b => b.resourceId === id));
    assert.deepEqual(app.services.resources.references(id).references.map(ref => ref.roleId), [adminId]);
    const access = new RoleAccess(app.appStore, app.config.dataRoot);
    const catalog = await loadAgentTools({ roleId, appStore: app.appStore, roleAccess: access, memory: app.services.memory,
      continuationResourceIds: [id], appRoot: f.root, workspaceDir: rolePaths(app.config.dataRoot, roleId).workspaceDir });
    try { assert.ok(!catalog.tools.some(t => t.name.includes("pi_task_"))); } finally { await catalog.close(); }
    const model = app.services.resources.create({ name: "工程", kind: "model", config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1" } });
    seedEngineeringPool(app, model.resourceId);
    const pi = new ManagedPi(app.services.modelProxy, app.services.toolProxy, app.services.engineeringPool,
      app.services.extensions.work, () => 0, () => true, id => isAdminSeat(access.getIndex(id).builtinKey), access, () => [adminId], () => {});
    try {
      await assert.rejects(pi.tools(roleId), { code: "PI_ADMIN_SEAT_REQUIRED" });
      const [tool] = await pi.tools(adminId);
      await assert.rejects(tool!.execute({}, { roleId, windowId: "", taskId: null, executionId: "", signal: new AbortController().signal }),
        { code: "PI_ADMIN_SEAT_REQUIRED" });
    } finally { await pi.close(); }
  } finally { await f.close(); }
});

test("后端独立入口优先读取显式 Pi 根目录", t => {
  const root = path.resolve(os.tmpdir(), "packaged resources", "pi-mcp");
  const previous = process.env.NOWADAYS_PI_MCP_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.NOWADAYS_PI_MCP_ROOT;
    else process.env.NOWADAYS_PI_MCP_ROOT = previous;
  });
  process.env.NOWADAYS_PI_MCP_ROOT = root;
  assert.equal(resolvePiEntry(), path.join(root, "src", "server.mjs"));
});

test("播种合并历史重复 Pi 的绑定与续用权，停用优先", async () => {
  const f = createFixture([], { disablePresetAssistant: false });
  try {
    const { app } = f;
    const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const [first] = app.services.resources.list("mcp");
    const config = { command: managedPiCommand, env: {}, args: [] };
    const duplicate = app.appStore.createResource({ resourceId: "duplicate", kind: "mcp", config, name: "旧项", enabled: false });
    const task = withStorage({ ...f, roleId }, ({ business }) => {
      business.replaceRoleBindings(roleId, [first!, duplicate].map(r => ({ capability: "mcp", resourceId: r.resourceId,
        modelName: null, enabled: r !== duplicate })));
      const task = business.createTask({ roleId, goal: "原任务" });
      business.grantResourceContinuation({ roleId, taskId: task.taskId, resourceId: duplicate.resourceId });
      return task;
    });
    app.services.resources.ensureManagedPi(roleId);
    assert.deepEqual(app.services.resources.list("mcp").map(r => [r.resourceId, r.enabled]), [[first!.resourceId, false]]);
    assert.deepEqual(app.services.resources.listBindings(roleId).map(r => [r.resourceId, r.enabled]), [[first!.resourceId, false]]);
    assert.deepEqual(withStorage({ ...f, roleId }, ({ business }) =>
      business.listResourceContinuations(roleId, task.taskId).map(r => r.resourceId)), [first!.resourceId]);
    assert.equal(app.services.resources.create({ kind: "mcp", name: "再添加", config }).resourceId, first!.resourceId);
  } finally { await f.close(); }
});

test("枚举 Skill 时跳过单个故障包，健康包仍可读取", async t => {
  const f = createFixture([]);
  try {
    const root = path.join(f.root, "skills");
    fs.mkdirSync(path.join(root, "good"), { recursive: true });
    fs.writeFileSync(path.join(root, "good", "SKILL.md"), "健康技能");
    const broken = path.join(root, "broken", "SKILL.md");
    fs.mkdirSync(path.dirname(broken));
    fs.writeFileSync(broken, "故障注入样例");
    const read = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
      if (args[0] === broken) throw Error("TEST_SKILL_UNREADABLE");
      return read(...args);
    });
    const skill = f.app.services.resources.create({ kind: "skill", name: "样例", config: { sourcePath: root } });
    f.app.services.resources.replaceBindings(f.roleId, [{ capability: "skill", resourceId: skill.resourceId }]);
    const catalog = await loadAgentTools({ roleId: f.roleId, appStore: f.app.appStore, memory: f.app.services.memory,
      roleAccess: new RoleAccess(f.app.appStore, f.app.config.dataRoot), appRoot: f.root,
      workspaceDir: rolePaths(f.app.config.dataRoot, f.roleId).workspaceDir });
    try {
      assert.deepEqual(catalog.skillBriefs.map(s => s.name), ["good"]);
      assert.ok(catalog.warnings.some(w => w.includes("broken")));
      assert.equal(new SkillLibrary(root).read("good").body, "健康技能");
    } finally { await catalog.close(); }
  } finally { await f.close(); }
});
