import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import {
  captureRoleTransfer, readRoleTransferPackage, resolveRoleTransferBindings,
  roleTransferTimelineFingerprint, stageRoleTransfer, writeRoleTransferPackage,
} from "../../src/application/transfer/role-transfer-package.js";
import { canonicalJson, sha256 } from "../../src/application/transfer/role-transfer-data.js";
import { sceneImageSettingsSchema } from "../../src/domain/scene-image-settings.js";
import { AppStore } from "../../src/storage/core/app-store.js";
import { RoleActivityStore } from "../../src/storage/role/role-activity-store.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";
import { SceneImageSettingsStore } from "../../src/storage/media/scene-image-settings-store.js";
import { readSceneReference, saveSceneReference } from "../../src/storage/media/scene-reference.js";
import { inspectImage } from "../../src/application/media/image-inspect.js";
import sharp from "sharp";

const NOW = "2026-11-20T00:00:00.000Z";
const roleInput = { displayName: "阿临", definition: { text: "喜欢下雨时读书" } };
const SOURCE_KEY = "source-model-key-717355";
const TARGET_KEY = "target-model-key-804486";
const HISTORICAL_KEY = "old-model-key-126791";
const ENV_KEY = "mcp-env-value-297411";

function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-transfer-package-"));
  return parseBackendConfig(["--app-root", root, "--port", "0"]);
}

function removeInstallation(config: ReturnType<typeof installation>): void {
  fs.rmSync(config.appRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const options = { disablePresetAssistant: true, disableMemoryRuntime: true };

test("按服饰往返两张参考图，旧包无参考表仍保留原指纹", async (t) => {
  const source = installation();
  const target = installation();
  const app = createBackendApp(source, options);
  t.after(async () => { await app.close(); removeInstallation(source); removeInstallation(target); });
  const roleId = app.services.roles.createRole(roleInput).roleId;
  const legacy = captureRoleTransfer(source, roleId);
  Reflect.deleteProperty(legacy.tables, "role_scene_references");
  assert.equal(legacy.timelineFingerprint, roleTransferTimelineFingerprint(legacy));
  const { digest: _digest, ...body } = legacy;
  const legacyPath = path.join(source.appRoot, "legacy.json");
  fs.writeFileSync(legacyPath, canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }));
  assert.equal(readRoleTransferPackage(legacyPath).timelineFingerprint, legacy.timelineFingerprint);
  const storage = RoleStorage.openExisting(rolePaths(source.dataRoot, roleId));
  const outfits = [randomUUID(), randomUUID()];
  const images = [];
  try {
    for (const [index, outfitId] of outfits.entries()) {
      storage.business.db.prepare("INSERT INTO outfits(outfit_id,role_id,name,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(outfitId, roleId, "穿搭" + index, NOW, NOW);
      const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: index ? "blue" : "red" } }).png().toBuffer();
      images.push(image);
      saveSceneReference(storage, roleId, outfitId, { fileName: "衣服.png", data: image }, await inspectImage(image, "衣服.png"));
    }
  } finally { storage.close(); }
  const current = captureRoleTransfer(source, roleId);
  assert.notEqual(current.timelineFingerprint, legacy.timelineFingerprint);
  const targetPaths = rolePaths(target.dataRoot, roleId);
  stageRoleTransfer(targetPaths, current, resolveRoleTransferBindings(target, current, {}));
  const restored = RoleStorage.openExisting(targetPaths);
  try {
    for (const [index, outfitId] of outfits.entries()) {
      assert.deepEqual(readSceneReference(restored, roleId, outfitId).data, images[index]);
      assert.throws(() => readSceneReference(restored, randomUUID(), outfitId), /参考图/);
    }
  } finally { restored.close(); }
  assert.equal(captureRoleTransfer(target, roleId).timelineFingerprint, current.timelineFingerprint);
});

test("两套安装走本地凭据，迁移历史和素材且不重放待处理消息", { timeout: 20_000 }, async (t) => {
  const source = installation();
  const target = installation();
  const requests: { authorization: string | undefined; body: string }[] = [];
  const endpoint = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({ authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"目标安装已收到。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  const endpointPort = await listen(endpoint, 0, "127.0.0.1");
  t.after(() => { endpoint.closeAllConnections(); endpoint.close(); });

  const origin = createBackendApp(source, options);
  const destination = createBackendApp(target, options);
  let targetRuntime: ReturnType<typeof createBackendApp> | undefined;
  t.after(async () => { await origin.close(); await destination.close(); await targetRuntime?.close(); });
  t.after(() => { removeInstallation(source); removeInstallation(target); });
  const role = origin.services.roles.createRole(roleInput);
  const sourceModel = origin.services.resources.create({ kind: "model", name: "来源模型", secret: SOURCE_KEY,
    config: { protocol: "openai-chat", baseUrl: "https://source-model.invalid/v1", modelName: "source-model" } });
  const mcp = origin.services.resources.create({ kind: "mcp", name: "来源 MCP",
    config: { command: "node", args: [], env: { LOCAL_SERVICE_TOKEN: ENV_KEY } } });
  const model = destination.services.resources.create({ kind: "model", name: "目标模型", secret: TARGET_KEY,
    config: { protocol: "openai-chat", baseUrl: `http://127.0.0.1:${endpointPort}/v1`, modelName: "target-model" } });
  // 故意在另一套安装中使用同一个源 ID，确认缺少映射时它不会被采用。
  destination.appStore.db.prepare(`INSERT INTO resources (resource_id,kind,name,enabled,config_json,created_at,updated_at)
    VALUES (?, 'mcp','同 ID 的目标 MCP',1,?,?,?)`).run(mcp.resourceId, '{"command":"node","args":[],"env":{}}', NOW, NOW);
  origin.services.resources.replaceBindings(role.roleId, [
    { capability: "chat_model", resourceId: sourceModel.resourceId, modelName: "source-model", enabled: true },
    { capability: "mcp", resourceId: mcp.resourceId, enabled: true },
  ]);
  origin.conversation.submitMessage(role.roleId, role.defaultWindowId, {
    content: "这是待处理但不应重放的历史输入。", submissionId: randomUUID(), sourcePlatform: "nowadays",
  });
  const originPaths = rolePaths(source.dataRoot, role.roleId);
  const roleStorage = RoleStorage.openExisting(originPaths);
  const taskId = randomUUID();
  const executionId = randomUUID();
  const toolCallId = randomUUID();
  const assetId = randomUUID();
  try {
    const { db } = roleStorage.business;
    db.prepare("UPDATE roles SET first_activation_pending = 0 WHERE role_id = ?").run(role.roleId);
    db.prepare("INSERT INTO tasks (task_id,role_id,goal,status,created_at,updated_at) VALUES (?,?,'旧办事任务','active',?,?)")
      .run(taskId, role.roleId, NOW, NOW);
    db.prepare(`INSERT INTO executions (execution_id,role_id,window_id,trigger_type,status,created_at,updated_at)
      VALUES (?,?,?,'user_message','running',?,?)`).run(executionId, role.roleId, role.defaultWindowId, NOW, NOW);
    roleStorage.checkpoint.saveCheckpoint(1, "done", {
      executionId, roleId: role.roleId, windowId: role.defaultWindowId, taskId,
      round: 1, messages: [], text: "源安装的未提交结果", lastRoundEchoOnly: false,
      pendingCalls: [], statePatch: {}, rounds: [], taskAction: null, modelCallId: null,
      wireMapping: {}, stopKind: null, successfulToolCalls: 0, progressNotes: 0,
    }, NOW);
    db.prepare("INSERT INTO execution_tasks VALUES (?,?,'initiates',?)").run(executionId, taskId, NOW);
    db.prepare(`INSERT INTO tool_calls (tool_call_id,task_id,execution_id,step_key,tool_name,args_json,status,created_at)
      VALUES (?,?,?,'prepare','app_resource_update',?,'running',?)`).run(toolCallId, taskId, executionId,
      JSON.stringify({ data: JSON.stringify({ apiKey: HISTORICAL_KEY, env: { LOCAL_SERVICE_TOKEN: ENV_KEY },
        config: { baseUrl: "https://source-model.invalid/v1" } }) }), NOW);
    db.prepare("INSERT INTO task_resource_continuations VALUES (?,?,?,NULL)").run(taskId, sourceModel.resourceId, NOW);
    db.prepare(`INSERT INTO model_calls
      (model_call_id,role_id,execution_id,task_id,resource_id,model_name,protocol,purpose,status,started_at,usage_json,raw_response_json,call_kind)
      VALUES (?,?,?,?,?,'source-model','openai-chat','user_task','succeeded',?,?,?,'primary_decision')`)
      .run(randomUUID(), role.roleId, executionId, taskId, sourceModel.resourceId, NOW,
        JSON.stringify({ inputTokens: 13, outputTokens: 8, totalTokens: 21 }),
        JSON.stringify({ text: `旧回执 ${HISTORICAL_KEY} ${SOURCE_KEY}` }));
    db.prepare(`INSERT INTO task_notes VALUES (?,?,?,?,?)`).run(randomUUID(), taskId, role.roleId, `旧笔记 ${HISTORICAL_KEY}`, NOW);
    const outfit = randomUUID();
    db.prepare("INSERT INTO outfits (outfit_id,role_id,name,created_at,updated_at,deleted_at) VALUES (?,?,'旧衣柜',?,?,?)")
      .run(outfit, role.roleId, NOW, NOW, NOW);
    db.prepare(`INSERT INTO outfit_assets (asset_id,outfit_id,role_id,usage,file_name,display_name,media_type,relative_path,created_at,deleted_at)
      VALUES (?,?,?,'home','旧图.png','旧图','image/png',?,?,?)`).run(assetId, outfit, role.roleId, `appearance/${assetId}.png`, NOW, NOW);
    fs.writeFileSync(path.join(originPaths.appearanceDir, `${assetId}.png`), "历史素材");
    fs.writeFileSync(path.join(originPaths.workspaceDir, "读书记.md"), "用户的原始 Markdown\n");
    fs.mkdirSync(path.join(originPaths.workspaceDir, "空目录"));
  } finally {
    roleStorage.close();
  }
  await origin.close();
  await destination.close();

  const snapshot = captureRoleTransfer(source, role.roleId);
  const exported = path.join(source.appRoot, "role.json");
  writeRoleTransferPackage(exported, snapshot);
  const pkg = readRoleTransferPackage(exported);
  assert.equal(pkg.digest, snapshot.digest);
  const serialized = JSON.stringify(pkg);
  for (const value of [SOURCE_KEY, TARGET_KEY, HISTORICAL_KEY, ENV_KEY, "https://source-model.invalid/v1"]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.match(serialized, /credential removed/);
  const chatBinding = pkg.bindings.find((binding) => binding.capability === "chat_model")!;
  assert.throws(() => resolveRoleTransferBindings(target, pkg, { [chatBinding.key]: mcp.resourceId }), /TARGET_KIND_MISMATCH/);
  const resolution = resolveRoleTransferBindings(target, pkg, { [chatBinding.key]: model.resourceId });
  assert.deepEqual(resolution.unresolved.map((binding) => binding.capability), ["mcp"]);
  const targetPaths = rolePaths(target.dataRoot, role.roleId);
  stageRoleTransfer(targetPaths, pkg, resolution);
  assert.equal(captureRoleTransfer(target, role.roleId).timelineFingerprint, snapshot.timelineFingerprint);
  assert.equal(fs.readFileSync(path.join(targetPaths.workspaceDir, "读书记.md"), "utf8"), "用户的原始 Markdown\n");
  assert.ok(fs.statSync(path.join(targetPaths.workspaceDir, "空目录")).isDirectory());
  assert.equal(fs.readFileSync(path.join(targetPaths.appearanceDir, `${assetId}.png`), "utf8"), "历史素材");
  const imported = RoleStorage.openExisting(targetPaths);
  try {
    const task = imported.business.getTask(role.roleId, taskId);
    assert.equal(task.status, "paused");
    assert.equal(task.usage.totalTokens, 21);
    assert.equal(imported.business.getToolCall(role.roleId, toolCallId).status, "unknown");
    assert.equal(imported.business.listResourceContinuations(role.roleId, taskId).length, 0);
    assert.deepEqual(imported.business.listRoleBindings(role.roleId).map((binding) => binding.enabled), [true, false]);
    assert.deepEqual(imported.checkpoint.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").pluck().all(),
      ["execution_checkpoints"]);
    assert.equal(imported.checkpoint.db.prepare("SELECT COUNT(*) FROM execution_checkpoints").pluck().get(), 0);
  } finally {
    imported.close();
  }
  const registry = new AppStore(target.appDatabasePath);
  try {
    registry.createRoleIndex({ roleId: role.roleId, relativeDir: `roles/${role.roleId}`,
      initPayload: { displayName: roleInput.displayName, definition: { ...roleInput.definition, payload: {} }, state: {} } });
    registry.db.prepare("UPDATE roles SET init_status = 'ready', init_payload_json = NULL WHERE role_id = ?").run(role.roleId);
    new RoleActivityStore(registry.db).markCreatedStopped(role.roleId, NOW);
  } finally {
    registry.close();
  }
  targetRuntime = createBackendApp(target, options);
  targetRuntime.services.activity.resume(role.roleId);
  assert.equal(requests.length, 0);
  const submitted = targetRuntime.conversation.submitMessage(role.roleId, role.defaultWindowId, {
    content: "目标端新消息", submissionId: randomUUID(), sourcePlatform: "nowadays",
  });
  const cutoff = Date.now() + 7000;
  while (requests.length === 0) {
    if (Date.now() >= cutoff) {
      const storage = RoleStorage.openExisting(targetPaths);
      try {
        const events = storage.business.db.prepare("SELECT event_type, payload_json FROM execution_stream_events").all();
        assert.fail(`等待真实目标请求超时 ${JSON.stringify({ waitReason: submitted.waitReason, events })}`);
      } finally { storage.close(); }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(requests[0]!.authorization, `Bearer ${TARGET_KEY}`);
  assert.match(requests[0]!.body, /target-model/);
  assert.match(requests[0]!.body, /目标端新消息/);
  assert.doesNotMatch(requests[0]!.body, /source-model|source-model-key/);
});

test("拥有有效摘要的外来指令、Windows 别名与其他角色数据同样被拒绝", async (t) => {
  const config = installation();
  const app = createBackendApp(config, options);
  t.after(async () => { await app.close(); removeInstallation(config); });
  const role = app.services.roles.createRole(roleInput);
  await app.close();
  const pkg = captureRoleTransfer(config, role.roleId);
  const file = path.join(config.appRoot, "tampered.json");
  const writeCandidate = (candidate: typeof pkg) => {
    candidate.timelineFingerprint = roleTransferTimelineFingerprint(candidate);
    const { digest: _, ...body } = candidate;
    fs.writeFileSync(file, canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }));
  };
  const foreign = structuredClone(pkg);
  foreign.tables.windows[0]!.role_id = randomUUID();
  writeCandidate(foreign);
  assert.throws(() => readRoleTransferPackage(file), /ROLE_OWNERSHIP_MISMATCH/);
  const alias = structuredClone(pkg);
  alias.files.push({ kind: "directory", path: "workspace/Memo" }, { kind: "directory", path: "workspace/memo" });
  writeCandidate(alias);
  assert.throws(() => readRoleTransferPackage(file), /DUPLICATE_FILE/);
  const escape = structuredClone(pkg);
  escape.files.push({ kind: "directory", path: "workspace/../escape" });
  writeCandidate(escape);
  assert.throws(() => readRoleTransferPackage(file), /UNSAFE_PATH/);
  const externalSchema = structuredClone(pkg);
  Object.assign(externalSchema.tables, { task_resource_continuations: [] });
  writeCandidate(externalSchema);
  assert.throws(() => readRoleTransferPackage(file), /TABLE_INVALID/);
  const paths = rolePaths(config.dataRoot, role.roleId);
  try {
    fs.symlinkSync(config.appRoot, path.join(paths.workspaceDir, "outside"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.diagnostic("当前 Windows 沙箱拒绝建立目录链接，已执行包中路径越界和别名拒绝检查。");
    return;
  }
  assert.throws(() => captureRoleTransfer(config, role.roleId), /UNSAFE_PATH/);
});

test("迁移筛除 MCP 环境与密钥副本，保留普通文字及其引用的网址", async (t) => {
  const config = installation();
  const app = createBackendApp(config, options);
  t.after(async () => { await app.close(); removeInstallation(config); });
  const evidenceUrl = "https://example.test/documentation";
  const ordinaryFact = `development 与 false 的文档是 ${evidenceUrl}`;
  const historicalEnvKey = "historic-mcp-156251";
  const enabledEnv = { DEBUG: "false", NODE_ENV: "development", CUSTOM_ACCESS_TOKEN: ENV_KEY };
  const role = app.services.roles.createRole(roleInput);
  app.services.resources.create({ kind: "model", name: "记录使用的网页地址",
    config: { protocol: "openai-chat", baseUrl: evidenceUrl } });
  app.services.resources.create({ kind: "mcp", name: "来源 MCP", config: { command: "node", args: [], env: enabledEnv } });
  app.conversation.submitMessage(role.roleId, role.defaultWindowId, {
    content: ordinaryFact, submissionId: randomUUID(), sourcePlatform: "nowadays",
  });
  const paths = rolePaths(config.dataRoot, role.roleId);
  fs.writeFileSync(path.join(paths.workspaceDir, "development.md"), ordinaryFact);
  const storage = RoleStorage.openExisting(paths);
  try {
    const { db } = storage.business;
    const taskId = randomUUID();
    const executionId = randomUUID();
    db.prepare("INSERT INTO tasks (task_id,role_id,goal,status,created_at,updated_at) VALUES (?,?,?,'completed',?,?)")
      .run(taskId, role.roleId, ordinaryFact, NOW, NOW);
    db.prepare(`INSERT INTO executions (execution_id,role_id,window_id,trigger_type,status,created_at,updated_at)
      VALUES (?,?,?,'user_message','completed',?,?)`).run(executionId, role.roleId, role.defaultWindowId, NOW, NOW);
    db.prepare(`INSERT INTO tool_calls (tool_call_id,task_id,execution_id,step_key,tool_name,args_json,status,created_at)
      VALUES (?,?,?,'save','app_resource_update',?,'success',?)`).run(randomUUID(), taskId, executionId,
      JSON.stringify({ config: { baseUrl: evidenceUrl, env: { NODE_ENV: "development", HISTORIC_API_KEY: historicalEnvKey } } }), NOW);
    db.prepare(`INSERT INTO task_notes VALUES (?,?,?,?,?)`).run(randomUUID(), taskId, role.roleId, ordinaryFact, NOW);
    db.prepare(`INSERT INTO task_notes VALUES (?,?,?,?,?)`).run(randomUUID(), taskId, role.roleId, `凭据副本 ${ENV_KEY} ${historicalEnvKey}`, NOW);
  } finally { storage.close(); }
  await app.close();
  const pkg = captureRoleTransfer(config, role.roleId);
  assert.equal(pkg.tables.messages[0]?.content, ordinaryFact);
  assert.equal(pkg.tables.tasks[0]?.goal, ordinaryFact);
  assert.ok(pkg.tables.task_notes.some((row) => row.note === ordinaryFact));
  assert.ok(pkg.tables.task_notes.some((row) => row.note === "凭据副本 [credential removed] [credential removed]"));
  assert.doesNotMatch(String(pkg.tables.tool_calls[0]?.args_json), /development|documentation|HISTORIC_API_KEY/);
  const note = pkg.files.find((entry) => entry.path === "workspace/development.md");
  assert.ok(note?.kind === "file");
  assert.equal(Buffer.from(note.data, "base64").toString(), ordinaryFact);
  assert.doesNotMatch(JSON.stringify(pkg), new RegExp(`${ENV_KEY}|${historicalEnvKey}`));
});

test("角色选择的生图模型随未映射及没有全局模型名的服务往返", async (t) => {
  const source = installation();
  const unmapped = installation();
  const target = installation();
  const origin = createBackendApp(source, options);
  const destination = createBackendApp(target, options);
  t.after(async () => {
    await origin.close(); await destination.close();
    removeInstallation(source); removeInstallation(unmapped); removeInstallation(target);
  });
  const role = origin.services.roles.createRole(roleInput);
  const inputService = origin.services.imageServices.create({ name: "来源生图服务",
    config: { protocol: "comfyui", baseUrl: "https://source-image.invalid", modelName: "unused-source-default.safetensors" } });
  const targetService = destination.services.imageServices.create({ name: "目标生图服务",
    config: { protocol: "comfyui", baseUrl: "https://target-image.invalid" } });
  const roleModel = "checkpoints/role-choice.safetensors";
  origin.services.sceneImageSettings.save(role.roleId, sceneImageSettingsSchema.parse({
    serviceId: inputService.serviceId, modelType: "text2img", modelPath: roleModel, basePrompt: "a library",
  }));
  await origin.close(); await destination.close();
  const sourcePackage = captureRoleTransfer(source, role.roleId);
  const imageBinding = sourcePackage.bindings.find((item) => item.capability === "image")!;
  assert.equal(imageBinding.modelName, roleModel);
  assert.doesNotMatch(JSON.stringify(sourcePackage), /source-image\.invalid|unused-source-default/);

  const unmappedPaths = rolePaths(unmapped.dataRoot, role.roleId);
  stageRoleTransfer(unmappedPaths, sourcePackage, resolveRoleTransferBindings(unmapped, sourcePackage));
  const roundTrip = captureRoleTransfer(unmapped, role.roleId);
  assert.equal(roundTrip.bindings.find((item) => item.capability === "image")?.modelName, roleModel);
  const targetPaths = rolePaths(target.dataRoot, role.roleId);
  stageRoleTransfer(targetPaths, roundTrip,
    resolveRoleTransferBindings(target, roundTrip, { [imageBinding.key]: targetService.serviceId }));
  const imported = RoleStorage.openExisting(targetPaths);
  try {
    const settings = new SceneImageSettingsStore(imported.business.db, role.roleId).get();
    assert.equal(settings?.serviceId, targetService.serviceId);
    assert.equal(settings?.modelPath, roleModel);
  } finally { imported.close(); }
  const targetPackage = captureRoleTransfer(target, role.roleId);
  assert.equal(targetPackage.bindings.find((item) => item.capability === "image")?.modelName, roleModel);
  assert.equal(targetPackage.timelineFingerprint, sourcePackage.timelineFingerprint);
});
