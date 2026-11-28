import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths, type BackendConfig } from "../../src/bootstrap/config.js";
import { RoleTransferHttpService } from "../../src/application/transfer/role-transfer-service.js";
import { AppError } from "../../src/domain/errors.js";

/**
 * 409 UX-05：角色工作空间 Markdown 笔记只读浏览与运行态单角色迁移接口。
 * 全部用例走真实 HTTP，确认运行中导出被停机租约拒绝、停机导出不触发
 * INSTALLATION_BUSY，以及新机预检／映射／导入与分化选择闭环。
 */

const options = { disableMemoryRuntime: true, disablePresetAssistant: true };
const backend = fileURLToPath(new URL("../../", import.meta.url));

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(base: string, method: string, route: string, body?: unknown): Promise<ApiResult> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>) };
}

function errorOf(result: ApiResult): { code: string; details?: Record<string, unknown> } {
  const error = result.body.error as { code: string; details?: Record<string, unknown> } | undefined;
  assert.ok(error, `响应不是结构化错误：${JSON.stringify(result.body)}`);
  return error;
}

function installation(t: TestContext, label: string): BackendConfig {
  const resultRoot = process.env.P1_REVIEW_TMP_ROOT ?? path.resolve(backend, "../../test-results/backend-acceptance");
  fs.mkdirSync(resultRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(resultRoot, `${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return parseBackendConfig(["--app-root", root, "--port", "0"]);
}

/** 迁移包必须放在安装目录之外：测试统一用独立兄弟目录承载。 */
function exportDir(t: TestContext): string {
  const resultRoot = process.env.P1_REVIEW_TMP_ROOT ?? path.resolve(backend, "../../test-results/backend-acceptance");
  fs.mkdirSync(resultRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(resultRoot, "transfer-packets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return dir;
}

function start(app: ReturnType<typeof createBackendApp>): Promise<string> {
  return listen(app.server, 0, "127.0.0.1").then((port) => `http://127.0.0.1:${port}`);
}

test("工作空间笔记只读浏览：过滤扩展名、递归排序、越界与大文件限制", async (t) => {
  const config = installation(t, "workspace");
  const app = createBackendApp(config, options);
  try {
    const base = await start(app);
    const role = app.services.roles.createRole({ displayName: "笔记角色", definition: { text: "记录日常。" } });
    const workspace = rolePaths(config.dataRoot, role.roleId).workspaceDir;
    fs.mkdirSync(path.join(workspace, "日记", "第二章"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "日常.md"), "# 日常\n今天的记录");
    fs.writeFileSync(path.join(workspace, "计划.markdown"), "两周计划");
    fs.writeFileSync(path.join(workspace, "日记", "第二章", "片段.MD"), "大小写扩展名也应识别");
    fs.writeFileSync(path.join(workspace, "备注.txt"), "不是笔记");
    fs.writeFileSync(path.join(workspace, ".隐藏.md"), "隐藏项不展示");
    fs.writeFileSync(path.join(workspace, "超大.md"), Buffer.alloc(512 * 1024 + 1, 0x61));
    const describe = (relative: string, iso: string) =>
      fs.utimesSync(path.join(workspace, relative), new Date(iso), new Date(iso));
    describe("日常.md", "2026-01-02T00:00:00.000Z");
    describe("计划.markdown", "2026-02-01T00:00:00.000Z");
    describe("日记/第二章/片段.MD", "2026-03-01T00:00:00.000Z");
    describe("超大.md", "2026-01-01T00:00:00.000Z");

    const listed = await api(base, "GET", `/v1/roles/${role.roleId}/workspace/notes`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const items = listed.body.items as Array<{ relativePath: string; name: string; sizeBytes: number; updatedAt: string }>;
    assert.deepEqual(items.map((item) => item.relativePath), [
      "日记/第二章/片段.MD",
      "计划.markdown",
      "日常.md",
      "超大.md",
    ]);
    assert.equal(items[0]?.name, "片段.MD");
    assert.equal(items[3]?.sizeBytes, 512 * 1024 + 1);
    assert.equal(items[0]?.updatedAt, "2026-03-01T00:00:00.000Z");

    const read = await api(base, "GET", `/v1/roles/${role.roleId}/workspace/note?path=${encodeURIComponent("日常.md")}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const note = read.body.note as { relativePath: string; name: string; content: string; sizeBytes: number };
    assert.equal(note.relativePath, "日常.md");
    assert.equal(note.name, "日常.md");
    assert.equal(note.content, "# 日常\n今天的记录");

    const nested = await api(base, "GET",
      `/v1/roles/${role.roleId}/workspace/note?path=${encodeURIComponent("日记/第二章/片段.MD")}`);
    assert.equal(nested.status, 200);
    assert.equal((nested.body.note as { content: string }).content, "大小写扩展名也应识别");

    for (const invalid of ["../app.sqlite", "日记/../日常.md", "/etc/passwd", "C:/secret.md", "备注.txt"]) {
      const rejected = await api(base, "GET",
        `/v1/roles/${role.roleId}/workspace/note?path=${encodeURIComponent(invalid)}`);
      assert.equal(rejected.status, 400, `应当拒绝越界路径 ${invalid}`);
      assert.equal(errorOf(rejected).code, "WORKSPACE_NOTE_PATH_INVALID");
    }

    const missingQuery = await api(base, "GET", `/v1/roles/${role.roleId}/workspace/note`);
    assert.equal(missingQuery.status, 400);
    assert.equal(errorOf(missingQuery).code, "INVALID_QUERY");

    const missing = await api(base, "GET",
      `/v1/roles/${role.roleId}/workspace/note?path=${encodeURIComponent("不存在.md")}`);
    assert.equal(missing.status, 404);
    assert.equal(errorOf(missing).code, "WORKSPACE_NOTE_NOT_FOUND");

    const tooLarge = await api(base, "GET",
      `/v1/roles/${role.roleId}/workspace/note?path=${encodeURIComponent("超大.md")}`);
    assert.equal(tooLarge.status, 413);
    assert.equal(errorOf(tooLarge).code, "WORKSPACE_NOTE_TOO_LARGE");

    const dir = await api(base, "GET", `/v1/roles/${role.roleId}/workspace/path`);
    assert.equal(dir.status, 200);
    assert.equal(dir.body.path, fs.realpathSync(workspace));
  } finally {
    await app.close();
  }
});

test("HTTP 迁移：运行中导出 409，停机导出后新机预检映射并导入且默认停机", async (t) => {
  const source = installation(t, "transfer-source");
  const target = installation(t, "transfer-target");
  const sourceApp = createBackendApp(source, options);
  const targetApp = createBackendApp(target, options);
  try {
    const sourceBase = await start(sourceApp);
    const targetBase = await start(targetApp);
    const role = sourceApp.services.roles.createRole({ displayName: "迁移角色", definition: { text: "保持自己的经历。" } });
    const model = sourceApp.services.resources.create({ kind: "model", name: "源模型",
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:2", modelName: "source" } });
    sourceApp.services.resources.replaceBindings(role.roleId, [
      { capability: "chat_model", resourceId: model.resourceId, modelName: "source", enabled: true },
    ]);
    const packet = path.join(exportDir(t), "role.json");

    // 新建角色默认停机；恢复活动后导出必须被停机租约拒绝。
    assert.equal((await api(sourceBase, "POST", `/v1/roles/${role.roleId}/activity/resume`)).status, 200);
    const running = await api(sourceBase, "POST", `/v1/roles/${role.roleId}/transfer/export`, { file: packet });
    assert.equal(running.status, 409);
    assert.equal(errorOf(running).code, "ROLE_NOT_STOPPED");
    assert.equal(fs.existsSync(packet), false);

    assert.equal((await api(sourceBase, "POST", `/v1/roles/${role.roleId}/activity/stop`)).status, 200);
    const exported = await api(sourceBase, "POST", `/v1/roles/${role.roleId}/transfer/export`, { file: packet });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const result = exported.body.result as { file: string; digest: string; bindings: Array<{ key: string }> };
    assert.equal(result.file, path.resolve(packet));
    assert.equal(fs.existsSync(packet), true);
    assert.equal(result.bindings.length, 1);

    const targetModel = targetApp.services.resources.create({ kind: "model", name: "目标模型",
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:3", modelName: "target" } });

    const first = await api(targetBase, "POST", "/v1/role-transfers/preflight", { file: packet });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const preview = first.body.preview as {
      relation: string; displayName: string | null; localActivityState: string | null;
      bindings: unknown; unresolved: unknown[]; token: string;
    };
    assert.equal(preview.relation, "new");
    assert.equal(preview.displayName, "迁移角色");
    assert.equal(preview.localActivityState, null);
    assert.deepEqual(preview.bindings, result.bindings);
    assert.equal(preview.unresolved.length, 1);

    const mapping = { [result.bindings[0]!.key]: targetModel.resourceId };
    const mapped = await api(targetBase, "POST", "/v1/role-transfers/preflight", { file: packet, mapping });
    assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
    const mappedPreview = mapped.body.preview as { token: string; unresolved: unknown[] };
    assert.equal(mappedPreview.unresolved.length, 0);

    const applied = await api(targetBase, "POST", "/v1/role-transfers/apply", {
      file: packet, token: mappedPreview.token, mapping,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal((applied.body.result as { outcome: string }).outcome, "published");

    const activity = await api(targetBase, "GET", `/v1/roles/${role.roleId}/activity`);
    assert.equal(activity.status, 200);
    assert.equal((activity.body.activity as { state: string }).state, "stopped");

    // 已存在的角色再次预检应带出本机活动状态，且时间线一致。
    const repeated = await api(targetBase, "POST", "/v1/role-transfers/preflight", { file: packet, mapping });
    const repeatedPreview = repeated.body.preview as { relation: string; localActivityState: string | null };
    assert.equal(repeatedPreview.relation, "same");
    assert.equal(repeatedPreview.localActivityState, "stopped");
  } finally {
    await targetApp.close();
    await sourceApp.close();
  }
});

test("HTTP 迁移：本机与迁移包分化时要求显式选择，可保留本机或覆盖采用", async (t) => {
  const source = installation(t, "diverge-source");
  const target = installation(t, "diverge-target");
  const sourceApp = createBackendApp(source, options);
  const targetApp = createBackendApp(target, options);
  try {
    const sourceBase = await start(sourceApp);
    const targetBase = await start(targetApp);
    const role = sourceApp.services.roles.createRole({ displayName: "分化角色", definition: { text: "各自经历。" } });
    const roleId = role.roleId;
    const windowId = role.defaultWindowId!;
    const send = (app: ReturnType<typeof createBackendApp>, content: string) =>
      app.conversation.submitMessage(roleId, windowId, {
        content, sourcePlatform: "nowadays", submissionId: randomUUID(),
      });

    send(sourceApp, "共同生活的第一天");
    const packets = exportDir(t);
    const baseline = path.join(packets, "base.json");
    assert.equal((await api(sourceBase, "POST", `/v1/roles/${roleId}/transfer/export`, { file: baseline })).status, 200);
    const firstPreflight = await api(targetBase, "POST", "/v1/role-transfers/preflight", { file: baseline });
    assert.equal(firstPreflight.status, 200, JSON.stringify(firstPreflight.body));
    const firstPreview = firstPreflight.body.preview as { relation: string; token: string };
    assert.equal(firstPreview.relation, "new");
    const imported = await api(targetBase, "POST", "/v1/role-transfers/apply", {
      file: baseline, token: firstPreview.token,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal((imported.body.result as { outcome: string }).outcome, "published");

    // 两边从同一基线各自新增用户消息，形成分化时间线。
    send(sourceApp, "在源机的新经历");
    send(targetApp, "在目标机的新经历");
    const branch = path.join(packets, "branch.json");
    assert.equal((await api(sourceBase, "POST", `/v1/roles/${roleId}/transfer/export`, { file: branch })).status, 200);

    const preflight = await api(targetBase, "POST", "/v1/role-transfers/preflight", { file: branch });
    assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
    const preview = preflight.body.preview as {
      relation: string; requiresChoice: boolean; token: string; localActivityState: string | null;
    };
    assert.equal(preview.relation, "diverged");
    assert.equal(preview.requiresChoice, true);
    assert.equal(preview.localActivityState, "stopped");

    const missingChoice = await api(targetBase, "POST", "/v1/role-transfers/apply", {
      file: branch, token: preview.token,
    });
    assert.equal(missingChoice.status, 409);
    assert.equal(errorOf(missingChoice).code, "ROLE_TRANSFER_CHOICE_REQUIRED");

    const keepLocal = await api(targetBase, "POST", "/v1/role-transfers/apply", {
      file: branch, token: preview.token, choice: "local",
    });
    assert.equal(keepLocal.status, 200, JSON.stringify(keepLocal.body));
    assert.equal((keepLocal.body.result as { outcome: string }).outcome, "kept-local");

    const overwrite = await api(targetBase, "POST", "/v1/role-transfers/apply", {
      file: branch, token: preview.token, choice: "package",
    });
    assert.equal(overwrite.status, 200, JSON.stringify(overwrite.body));
    assert.equal((overwrite.body.result as { outcome: string }).outcome, "published");

    const activity = await api(targetBase, "GET", `/v1/roles/${roleId}/activity`);
    assert.equal(activity.status, 200);
    assert.equal((activity.body.activity as { state: string }).state, "stopped");
  } finally {
    await targetApp.close();
    await sourceApp.close();
  }
});

test("HTTP 迁移：导出拒绝应用目录内路径与非 JSON 扩展名", async (t) => {
  const source = installation(t, "export-path-source");
  const app = createBackendApp(source, options);
  try {
    const base = await start(app);
    const role = app.services.roles.createRole({ displayName: "路径角色", definition: { text: "拒绝越界。" } });
    // 预置真实安装中常见的子目录，验证它们同样属于受管区域。
    for (const directory of ["secrets", "extensions"]) {
      fs.mkdirSync(path.join(source.appRoot, directory), { recursive: true });
    }
    const packets = exportDir(t);
    const candidates: Array<[string, string]> = [
      [path.join(source.appRoot, "role.json"), "ROLE_TRANSFER_PACKAGE_IN_MANAGED_DIRECTORY"],
      [path.join(source.appRoot, "data", "app.sqlite"), "ROLE_TRANSFER_PACKAGE_EXTENSION_INVALID"],
      [path.join(source.appRoot, "secrets", "x.json"), "ROLE_TRANSFER_PACKAGE_IN_MANAGED_DIRECTORY"],
      [path.join(source.appRoot, "extensions", "x.json"), "ROLE_TRANSFER_PACKAGE_IN_MANAGED_DIRECTORY"],
      [path.join(packets, "out.txt"), "ROLE_TRANSFER_PACKAGE_EXTENSION_INVALID"],
    ];
    for (const [file, code] of candidates) {
      const rejected = await api(base, "POST", `/v1/roles/${role.roleId}/transfer/export`, { file });
      assert.equal(rejected.status, 400, `${file}: ${JSON.stringify(rejected.body)}`);
      assert.equal(errorOf(rejected).code, code, file);
    }
  } finally {
    await app.close();
  }
});

test("HTTP 迁移：预检拒绝超过体积上限的迁移包并返回 413", async (t) => {
  const source = installation(t, "oversized-source");
  const target = installation(t, "oversized-target");
  const sourceApp = createBackendApp(source, options);
  const targetApp = createBackendApp(target, options);
  try {
    const sourceBase = await start(sourceApp);
    const role = sourceApp.services.roles.createRole({ displayName: "大包角色", definition: { text: "体积上限。" } });
    const packet = path.join(exportDir(t), "role.json");
    const exported = await api(sourceBase, "POST", `/v1/roles/${role.roleId}/transfer/export`, { file: packet });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.ok(fs.statSync(packet).size > 64);

    // 直接构造带小上限的服务实例，验证预检在读取内容前就拒绝超大包。
    const service = new RoleTransferHttpService({
      config: target,
      appStore: targetApp.appStore,
      roleAccess: targetApp.roleAccess,
      activity: targetApp.services.activity,
      feedEvents: targetApp.services.feedEvents,
      maxPackageBytes: 64,
    });
    await assert.rejects(service.preflightImport(packet), (error: unknown) => {
      if (!(error instanceof AppError)) throw error;
      assert.equal(error.status, 413);
      assert.equal(error.code, "ROLE_TRANSFER_PACKAGE_TOO_LARGE");
      return true;
    });
  } finally {
    await targetApp.close();
    await sourceApp.close();
  }
});
