import { APP_SCHEMA_VERSION, BUSINESS_SCHEMA_VERSION } from "../../src/storage/core/schema.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import sharp from "sharp";
import { applyRoleTransfer, exportRoleTransfer, preflightRoleTransfer } from "../../src/application/transfer/role-transfer.js";
import { configFetch } from "../fixtures/config-write.js";
import { createLegacyRole, seedLegacyPresetAssistant } from "../fixtures/legacy-role-fixture.js";
import {
  ScriptedChatModel,
  createFixtureWithModel,
  deferred,
  withStorage,
} from "../fixtures/conversation-fixture.js";
import { createBackendApp, listen, type BackendApp } from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import {
  XIA_CHENG_BUILTIN_KEY,
  XIA_CHENG_DISPLAY_NAME,
} from "../../src/application/role/preset-assistant.js";
import { ScriptedMemoryModel } from "../../src/model/offline-memory.js";
import type { ModelEvent, ModelRequest } from "../../src/domain/model.js";
import { HttpModelAdapter } from "../../src/model/protocols.js";
import type { OutfitRecord } from "../../src/domain/appearance.js";
import type { TaskRecord } from "../../src/storage/role/role-store.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";

function tempRoot(prefix = "nowadays-p19-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  });
}

async function waitUntil(
  fn: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("P19_WAIT_TIMEOUT");
}

async function tinyPng(color = { r: 90, g: 150, b: 220 }): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

async function jsonApi(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function errorCodeOf(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code;
}

async function startSseServer(
  handler: (
    req: { url: string; method: string; headers: http.IncomingHttpHeaders; body: unknown },
    index: number,
  ) => { status?: number; chunks: string[] },
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let index = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = raw.length === 0 ? undefined : JSON.parse(raw);
    const result = handler(
      {
        url: req.url ?? "/",
        method: req.method ?? "GET",
        headers: req.headers,
        body: parsed,
      },
      index++,
    );
    res.writeHead(result.status ?? 200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    for (const chunk of result.chunks) {
      res.write(chunk);
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("FAILED_TO_BIND_MOCK_SERVER");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function writeTestMcpToolServer(filePath: string): void {
  const sdkDir = path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm");
  const serverUrl = pathToFileURL(path.join(sdkDir, "server/mcp.js")).href;
  const transportUrl = pathToFileURL(
    path.join(sdkDir, "server/stdio.js"),
  ).href;
  const code = `
    import { McpServer } from ${JSON.stringify(serverUrl)};
    import { StdioServerTransport } from ${JSON.stringify(transportUrl)};
    const server = new McpServer({ name: "p19-tools", version: "1.0.0" });
    server.registerTool(
      "ping",
      { inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "pong:ok" }] }),
    );
    await server.connect(new StdioServerTransport());
  `;
  fs.writeFileSync(filePath, code, "utf8");
}

test("包1：空目录启动预置夏澄（stopped/无图空态），中断恢复与重启幂等且同名普通角色并存", async () => {
  const root = tempRoot();
  const emptyPresetsDir = path.join(root, "empty-presets");
  fs.mkdirSync(emptyPresetsDir, { recursive: true });
  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    emptyPresetsDir,
    "--port",
    "0",
  ]);
  try {
    // 先模拟历史库中已存在名为「夏澄」但 builtin_key IS NULL 的普通角色。
    const legacy = createBackendApp(config, {
      disableMemoryRuntime: true,
      disablePresetAssistant: true,
    });
    const ordinarySameName = legacy.services.roles.createRole({
      displayName: XIA_CHENG_DISPLAY_NAME,
      definition: { text: "历史普通角色夏澄，应原样保留" },
    });
    await legacy.close();

    // 开启预置启动：应保留普通同名角色，并新建唯一 builtin_key='xiacheng' 实例。
    const app = createBackendApp(config, { disableMemoryRuntime: true });
    const port = await listen(app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    let xiachengId: string;
    try {
      const rolesRes = await jsonApi(baseUrl, "GET", "/v1/roles");
      assert.equal(rolesRes.status, 200);
      const items = rolesRes.body.items as Array<Record<string, unknown>>;
      assert.equal(items.length, 2);

      const ordinary = items.find((item) => item.roleId === ordinarySameName.roleId);
      assert.ok(ordinary);
      assert.equal(ordinary.isBuiltin, false);
      assert.equal(ordinary.builtinKey, null);
      assert.equal(ordinary.displayName, XIA_CHENG_DISPLAY_NAME);

      const builtin = items.find((item) => item.builtinKey === XIA_CHENG_BUILTIN_KEY);
      assert.ok(builtin);
      xiachengId = String(builtin.roleId);
      assert.notEqual(xiachengId, ordinarySameName.roleId);
      assert.equal(builtin.isBuiltin, true);
      assert.equal(builtin.displayName, XIA_CHENG_DISPLAY_NAME);
      assert.equal(builtin.status, "ready");
      assert.ok(typeof builtin.bio === "string" && builtin.bio.length > 20);

      // 初始活动状态为 stopped（与普通新建角色一致）。
      const activity = app.services.activity.view(xiachengId);
      assert.equal(activity.state, "stopped");

      // 无图预设槽位下，夏澄保持无图空态。
      assert.deepEqual(app.services.appearance.list(xiachengId).items, []);

      // 角色详情返回独立 bio 与 starter definition。
      const detail = await jsonApi(baseUrl, "GET", `/v1/roles/${xiachengId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.isBuiltin, true);
      assert.equal(detail.body.builtinKey, XIA_CHENG_BUILTIN_KEY);
      assert.equal(detail.body.bio, builtin.bio);
      assert.ok(
        ((detail.body.definition as { text: string }).text ?? "").length > 10,
      );

      // 用户修订设定正文后重启应保留，不新建第二个内置实例。
      const patched = await configFetch(
        `${baseUrl}/v1/roles/${xiachengId}/definition`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ definition: { text: "重启后仍保留的人设" } }),
        },
      );
      assert.equal(patched.status, 200);
    } finally {
      await app.close();
    }

    // 模拟初始化半途处于 initializing 状态时的幂等续跑恢复。
    const appDb = new Database(config.appDatabasePath);
    appDb
      .prepare("UPDATE roles SET init_status = 'initializing', init_payload_json = ? WHERE role_id = ?")
      .run(
        JSON.stringify({
          displayName: XIA_CHENG_DISPLAY_NAME,
          definition: { text: "恢复载荷", payload: {} },
          state: {},
          builtinKey: XIA_CHENG_BUILTIN_KEY,
          bioText: "bio",
        }),
        xiachengId,
      );
    appDb.close();

    const restarted = createBackendApp(config, { disableMemoryRuntime: true });
    try {
      const roles = restarted.services.roles.listRoles();
      assert.equal(
        roles.filter((role) => role.builtinKey === XIA_CHENG_BUILTIN_KEY).length,
        1,
      );
      const role = restarted.services.roles.getRole(xiachengId);
      assert.equal(role.roleId, xiachengId);
      assert.equal(role.definition.text, "重启后仍保留的人设");
      const oldOrdinary = restarted.services.roles.getRole(ordinarySameName.roleId);
      assert.equal(oldOrdinary.isBuiltin, false);
      assert.equal(oldOrdinary.definition.text, "历史普通角色夏澄，应原样保留");
    } finally {
      await restarted.close();
    }
  } finally {
    cleanupDir(root);
  }
});

test("包1：Schema V9/V20 无损迁移升级至 V10/V23", async () => {
  const root = tempRoot();
  const emptyPresetsDir = path.join(root, "presets");
  fs.mkdirSync(emptyPresetsDir, { recursive: true });
  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    emptyPresetsDir,
    "--port",
    "0",
  ]);
  try {
    const app = createBackendApp(config, {
      disableMemoryRuntime: true,
      disablePresetAssistant: true,
    });
    const role = app.services.roles.createRole({
      displayName: "迁移旧角色",
      definition: { text: "v20 保留数据" },
    });
    const paths = rolePaths(config.dataRoot, role.roleId);
    const outfit = await app.services.appearance.importOutfit(role.roleId, {
      name: "旧服饰",
      home: { fileName: "home.png", data: await tinyPng() },
      sprites: [],
    });
    const winId = role.defaultWindowId;
    await app.close();

    // 手动将 app.sqlite 与 business.sqlite 回退为 v9 / v20 结构并写入存量数据。
    const rawApp = new Database(config.appDatabasePath);
    rawApp.exec(`
      DROP INDEX IF EXISTS idx_app_roles_builtin_key;
      ALTER TABLE roles DROP COLUMN builtin_key;
      DROP TABLE role_transfer_snapshots;
      DROP TABLE role_transfer_selections;
      DROP TABLE role_transfer_publication;
      DROP TABLE token_usage_records;
      DROP TABLE token_usage_meta;
    `);
    rawApp.pragma("user_version = 9");
    rawApp.close();

    const rawBiz = new Database(paths.businessDatabasePath);
    rawBiz.exec(`
      DROP INDEX IF EXISTS idx_outfits_role_preset_key;
      DROP INDEX IF EXISTS idx_model_calls_task;
      ALTER TABLE roles DROP COLUMN builtin_key;
      ALTER TABLE roles DROP COLUMN bio_text;
      ALTER TABLE outfits DROP COLUMN is_preset;
      ALTER TABLE outfits DROP COLUMN preset_key;
      ALTER TABLE outfit_assets DROP COLUMN is_preset;
      ALTER TABLE tasks DROP COLUMN continuable;
      ALTER TABLE tasks DROP COLUMN wait_reason;
      ALTER TABLE tasks DROP COLUMN consecutive_failures;
      ALTER TABLE tasks DROP COLUMN consecutive_no_progress;
      ALTER TABLE model_calls DROP COLUMN task_id;
      ALTER TABLE model_calls DROP COLUMN call_kind;
    `);
    rawBiz.exec("DROP TABLE web_reading_deliveries");
    rawBiz.exec("ALTER TABLE roles DROP COLUMN first_activation_pending");
    rawBiz.pragma("user_version = 20");
    rawBiz.close();

    const upgraded = createBackendApp(config, { disableMemoryRuntime: true });
    try {
      assert.equal(upgraded.appStore.schemaVersion, APP_SCHEMA_VERSION);
      const bizStorage = RoleStorage.openExisting(paths);
      try {
        assert.equal(bizStorage.business.schemaVersion, BUSINESS_SCHEMA_VERSION);
        const migratedRole = bizStorage.business.getRole(role.roleId);
        assert.equal(migratedRole.displayName, "迁移旧角色");
        assert.equal(migratedRole.bioText, "");
        assert.equal(migratedRole.isBuiltin, false);
        const migratedOutfits = upgraded.services.appearance.list(role.roleId).items;
        assert.equal(migratedOutfits.length, 1);
        assert.equal(migratedOutfits[0]?.outfitId, outfit.outfitId);
        assert.equal(migratedOutfits[0]?.isPreset, false);
        assert.equal(migratedOutfits[0]?.presetKey, null);
        assert.equal(migratedOutfits[0]?.home?.isPreset, false);
        assert.equal(bizStorage.business.getDefaultWindow(role.roleId).windowId, winId);
      } finally {
        bizStorage.close();
      }
      // 升级同时自动预置系统默认助手夏澄，不影响旧普通角色。
      assert.ok(upgraded.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY));
    } finally {
      await upgraded.close();
    }
  } finally {
    cleanupDir(root);
  }
});

test("包1：预置外观与人物介绍可编辑，席位不可删除并独立注入管理底座", async () => {
  const root = tempRoot();
  const presetsDir = path.join(root, "presets");
  const defaultOutfitDir = path.join(presetsDir, "xiacheng", "outfits", "default");
  fs.mkdirSync(path.join(defaultOutfitDir, "sprites"), { recursive: true });
  fs.writeFileSync(
    path.join(defaultOutfitDir, "manifest.json"),
    JSON.stringify({ name: "日常常服", description: "夏澄预置常服" }),
    "utf8",
  );
  const homePng = await tinyPng({ r: 10, g: 20, b: 30 });
  const smilePng = await tinyPng({ r: 200, g: 180, b: 60 });
  fs.writeFileSync(path.join(defaultOutfitDir, "home.png"), homePng);
  fs.writeFileSync(path.join(defaultOutfitDir, "sprites", "微笑.png"), smilePng);

  const model = new ScriptedChatModel([
    [{ type: "text_delta", text: "你好，我是夏澄。" }, { type: "completed", stopReason: "stop" }],
    [{ type: "text_delta", text: "我是普通角色。" }, { type: "completed", stopReason: "stop" }],
  ]);

  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    presetsDir,
    "--port",
    "0",
  ]);
  seedLegacyPresetAssistant(config);
  const app = createBackendApp(config, {
    disableMemoryRuntime: true,
    modelPortFactory: () => model,
  });
  const port = await listen(app.server, 0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const builtin = app.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY)!;
    const ordinary = app.services.roles.createRole({
      displayName: "普通角色",
      definition: { text: "我是普通朋友" },
    });

    // 1. 预置外观已自动导入并设为初始穿着，随后通过设置写接口维护。
    const outfitsRes = await jsonApi(
      baseUrl,
      "GET",
      `/v1/roles/${builtin.roleId}/appearance/outfits`,
    );
    assert.equal(outfitsRes.status, 200);
    const outfits = outfitsRes.body.items as OutfitRecord[];
    assert.equal(outfits.length, 1);
    const presetOutfit = outfits[0]!;
    assert.equal(presetOutfit.isPreset, true);
    assert.equal(presetOutfit.name, "日常常服");
    assert.equal(presetOutfit.home?.isPreset, true);
    assert.equal(presetOutfit.sprites.length, 1);
    assert.equal(presetOutfit.sprites[0]?.displayName, "微笑");
    assert.equal(presetOutfit.sprites[0]?.isPreset, true);
    assert.equal(
      app.services.roles.getState(builtin.roleId).state.outfitId,
      presetOutfit.outfitId,
    );

    const rename = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/appearance/outfits/${presetOutfit.outfitId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "改名测试", assetNames: { [presetOutfit.home!.assetId]: "日常立绘", [presetOutfit.sprites[0]!.assetId]: "笑意" } }),
      },
    );
    assert.equal(rename.status, 200);
    const renamedOutfit = await rename.json() as OutfitRecord;
    assert.equal(renamedOutfit.home?.displayName, "日常立绘");
    assert.equal(renamedOutfit.sprites[0]?.displayName, "笑意");

    const replaceHomeForm = new FormData();
    replaceHomeForm.append(
      "home",
      new Blob([await tinyPng()], { type: "image/png" }),
      "new-home.png",
    );
    const replace = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/appearance/outfits/${presetOutfit.outfitId}/home`,
      { method: "POST", body: replaceHomeForm },
    );
    assert.equal(replace.status, 201);
    const homeId = (await replace.json() as { assetId: string }).assetId;
    const removeHome = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/appearance/outfits/${presetOutfit.outfitId}/home/${homeId}`,
      { method: "DELETE" },
    );
    assert.equal(removeHome.status, 200);
    assert.equal(app.services.appearance.getOutfit(builtin.roleId, presetOutfit.outfitId).home, null);

    const spriteForm = new FormData();
    spriteForm.append(
      "sprite",
      new Blob([await tinyPng()], { type: "image/png" }),
      "开心.png",
    );
    spriteForm.append("replaceAssetId", presetOutfit.sprites[0]!.assetId);
    const addSprite = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/appearance/outfits/${presetOutfit.outfitId}/sprites`,
      { method: "POST", body: spriteForm },
    );
    assert.equal(addSprite.status, 201);

    const replacementId = (await addSprite.json() as { assetId: string }).assetId;
    assert.deepEqual(app.services.appearance.getOutfit(builtin.roleId, presetOutfit.outfitId).sprites.map(s => s.assetId), [replacementId]);
    const deleteSprite = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/appearance/outfits/${presetOutfit.outfitId}/sprites/${replacementId}`,
      { method: "DELETE" },
    );
    assert.equal(deleteSprite.status, 200);

    const deleteLastOutfit = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/appearance/outfits/${presetOutfit.outfitId}`,
      { method: "DELETE" },
    );
    assert.equal(deleteLastOutfit.status, 409);
    assert.equal(
      errorCodeOf((await deleteLastOutfit.json()) as Record<string, unknown>),
      "LAST_OUTFIT_REQUIRED",
    );

    // 允许给夏澄新增自定义服饰并自由增删改。
    const customOutfit = await app.services.appearance.importOutfit(
      builtin.roleId,
      {
        name: "玩家自定礼服",
        home: { fileName: "dress.png", data: await tinyPng() },
        sprites: [{ fileName: "眨眼.png", data: await tinyPng() }],
      },
    );
    assert.equal(customOutfit.isPreset, false);
    assert.equal(customOutfit.home?.isPreset, false);
    const renamedCustom = await app.services.appearance.renameOutfit(
      builtin.roleId,
      customOutfit.outfitId,
      { name: "晚宴礼服" },
    );
    assert.equal(renamedCustom.name, "晚宴礼服");
    app.services.appearance.deleteOutfit(builtin.roleId, customOutfit.outfitId);

    // 2. 删除夏澄返回 409 BUILTIN_ROLE_PROTECTED；可把其他普通角色删到只剩夏澄。
    const deleteBuiltin = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}?keepHistory=0`,
      { method: "DELETE" },
    );
    assert.equal(deleteBuiltin.status, 409);
    assert.equal(
      errorCodeOf((await deleteBuiltin.json()) as Record<string, unknown>),
      "BUILTIN_ROLE_PROTECTED",
    );

    // 删掉唯一普通角色应放行，系统保留夏澄。
    const deleteOrdinary = await configFetch(
      `${baseUrl}/v1/roles/${ordinary.roleId}?keepHistory=0`,
      { method: "DELETE" },
    );
    assert.equal(deleteOrdinary.status, 200);
    assert.equal(app.services.roles.listRoles().length, 1);

    // 再次创建普通角色用于系统提示词对照。
    const ordinary2 = createLegacyRole(app, {
      displayName: "换个名字",
      definition: { text: "普通对照设定" },
    });

    // 名称、介绍与角色卡共用受保护接口及修订号，清空也是一次写入。
    const patchProfile = (fields: Record<string, unknown>) => configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/definition`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) },
    );
    const revision = app.services.roles.getRole(builtin.roleId).definitionRevision;
    const renamed = await patchProfile({
      displayName: "换个名字", bio: "新的介绍", expectedRevision: revision,
      definition: { text: "高冷简短，但绝对可靠" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(app.services.roles.getRole(builtin.roleId).bio, "新的介绍");
    const stale = await patchProfile({ bio: "", expectedRevision: revision });
    assert.equal(stale.status, 409);
    assert.equal(errorCodeOf(await stale.json() as Record<string, unknown>), "REVISION_CONFLICT");
    assert.equal(app.services.roles.getRole(builtin.roleId).bio, "新的介绍");
    assert.equal((await patchProfile({ bio: "", expectedRevision: revision + 1 })).status, 200);
    assert.equal(app.services.roles.getRole(builtin.roleId).bio, "");

    // 4. 模型、MCP/Skill、自主额度绑定开放配置；检查系统底座与可编辑人设分层生效。
    const modelRes = app.services.resources.create({
      kind: "model",
      name: "夏澄对话模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    const mcpPath = path.join(root, "mcp-ping.mjs");
    writeTestMcpToolServer(mcpPath);
    const mcpRes = app.services.resources.create({
      kind: "mcp",
      name: "测试工具",
      config: { command: process.execPath, args: [mcpPath], env: {} },
    });
    const bindRes = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/bindings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindings: [
            {
              capability: "chat_model",
              resourceId: modelRes.resourceId,
              modelName: "offline-chat",
              enabled: true,
            },
            {
              capability: "mcp",
              resourceId: mcpRes.resourceId,
              enabled: true,
            },
          ],
        }),
      },
    );
    assert.equal(bindRes.status, 200);
    app.services.resources.replaceBindings(ordinary2.roleId, [
      {
        capability: "chat_model",
        resourceId: modelRes.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);
    const budgetRes = await configFetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/autonomy/budget`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unlimited: false, dailyLimit: 50 }),
      },
    );
    assert.equal(budgetRes.status, 200);

    app.services.activity.resume(builtin.roleId);
    app.services.activity.resume(ordinary2.roleId);
    const activeWrite = await jsonApi(baseUrl, "PATCH", `/v1/roles/${builtin.roleId}/definition`, { bio: "运行中改写" });
    assert.equal(activeWrite.status, 409);
    assert.equal(errorCodeOf(activeWrite.body), "ROLE_NOT_STOPPED");
    const builtinRoleView = app.services.roles.getRole(builtin.roleId);
    await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${builtin.roleId}/windows/${builtinRoleView.defaultWindowId}/messages`,
      { content: "测试分层提示词", submissionId: randomUUID() },
    );
    await waitUntil(() => model.requests.length >= 1);

    await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${ordinary2.roleId}/windows/${ordinary2.defaultWindowId}/messages`,
      { content: "对照测试", submissionId: randomUUID() },
    );
    await waitUntil(() => model.requests.length >= 2);

    const builtinSystem = model.requests[0]!.system;
    const ordinarySystem = model.requests[1]!.system;
    assert.ok(builtinSystem.includes("系统核心能力与行为底座"));
    assert.ok(builtinSystem.includes("平台管理者「换个名字」"));
    assert.ok(builtinSystem.includes("平台管理知识"));
    assert.equal(ordinarySystem.includes("平台管理知识"), false);
    assert.ok(model.requests[0]!.tools.some(tool => tool.name.startsWith("app_")));
    assert.equal(model.requests[1]!.tools.some(tool => tool.name.startsWith("app_")), false);
    assert.ok(builtinSystem.includes("高冷简短，但绝对可靠"));
    assert.equal(ordinarySystem.includes("系统核心能力与行为底座"), false);
  } finally {
    await app.close();
    cleanupDir(root);
  }
});

test("包1：POST /v1/roles/:roleId/tasks/:taskId/cancel 可显式取消运行中与暂停中的任务", async () => {
  const root = tempRoot();
  const presetsDir = path.join(root, "empty-presets");
  fs.mkdirSync(presetsDir, { recursive: true });
  const mcpPath = path.join(root, "mcp-hang.mjs");
  writeTestMcpToolServer(mcpPath);

  const runningHold = deferred<void>();
  let callIndex = 0;
  let runningCallEntered = false;
  const model = {
    requests: [] as ModelRequest[],
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      model.requests.push(request);
      callIndex += 1;
      const pingTool = request.tools.find((tool) => tool.name.endsWith("_ping"));
      if (callIndex === 1) {
        assert.ok(pingTool);
        yield {
          type: "tool_call",
          callId: "call-1a",
          name: pingTool.name,
          arguments: {},
        };
        yield { type: "completed", stopReason: "tool_use" };
        return;
      }
      if (callIndex === 2) {
        yield {
          type: "tool_call",
          callId: "call-1b",
          name: "task_pause",
          arguments: { reason: "等待用户确认" },
        };
        yield { type: "completed", stopReason: "tool_use" };
        return;
      }
      if (callIndex === 3) {
        yield { type: "text_delta", text: "请确认后再继续。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      if (callIndex === 4) {
        assert.ok(pingTool);
        yield {
          type: "tool_call",
          callId: "call-2",
          name: pingTool.name,
          arguments: {},
        };
        yield { type: "completed", stopReason: "tool_use" };
        return;
      }
      if (callIndex === 5) {
        // 运行中任务在等待模型响应期间被取消（此时 task 已由上一步 tool_call 创建）。
        runningCallEntered = true;
        await runningHold.promise;
        yield { type: "text_delta", text: "不应提交" };
        yield { type: "completed", stopReason: "stop" };
      }
    },
  };

  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    presetsDir,
    "--port",
    "0",
  ]);
  seedLegacyPresetAssistant(config);
  const app = createBackendApp(config, {
    disableMemoryRuntime: true,
    modelPortFactory: () => model,
  });
  const port = await listen(app.server, 0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const builtin = app.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY)!;
    const role = app.services.roles.getRole(builtin.roleId);
    const modelRes = app.services.resources.create({
      kind: "model",
      name: "取消测试模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    const mcpRes = app.services.resources.create({
      kind: "mcp",
      name: "ping",
      config: { command: process.execPath, args: [mcpPath], env: {} },
    });
    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: modelRes.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
      {
        capability: "mcp",
        resourceId: mcpRes.resourceId,
        enabled: true,
      },
    ]);
    app.services.activity.resume(role.roleId);

    // 场景 A：取消处于 paused 状态的任务（支持空体 POST）。
    await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/windows/${role.defaultWindowId}/messages`,
      { content: "先暂停一个任务", submissionId: randomUUID() },
    );
    await waitUntil(
      () =>
        app.conversation.listTasks(role.roleId)[0]?.status === "paused" &&
        app.services.activity.view(role.roleId).running === false,
    );
    await app.conversation.waitForIdle(role.roleId);
    const pausedTask = app.conversation.listTasks(role.roleId)[0]!;

    const cancelPaused = await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/tasks/${pausedTask.taskId}/cancel`,
    );
    assert.equal(cancelPaused.status, 200);
    assert.equal(cancelPaused.body.status, "failed");
    assert.equal(cancelPaused.body.endReason, "USER_CANCELLED");

    // 幂等重取消返回 200；携带不同原因重试返回 409 TASK_STATE_CONFLICT。
    const cancelAgain = await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/tasks/${pausedTask.taskId}/cancel`,
      { reason: "USER_CANCELLED" },
    );
    assert.equal(cancelAgain.status, 200);

    const cancelDifferentReason = await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/tasks/${pausedTask.taskId}/cancel`,
      { reason: "DIFFERENT_REASON" },
    );
    assert.equal(cancelDifferentReason.status, 409);
    assert.equal(
      errorCodeOf(cancelDifferentReason.body),
      "TASK_STATE_CONFLICT",
    );

    // 场景 B：取消正在运行中的 active 任务（第 1 轮已建任务，第 2 轮等待模型时手动取消）。
    const win2 = app.services.roles.createWindow(role.roleId, {
      kind: "custom",
      source: "nowadays",
    });
    await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/windows/${win2.windowId}/messages`,
      { content: "运行中待取消任务", submissionId: randomUUID() },
    );
    await waitUntil(() => runningCallEntered);
    const activeTask = app.conversation
      .listTasks(role.roleId)
      .find((item) => item.status === "active");
    assert.ok(activeTask);

    const cancelActive = await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/tasks/${activeTask.taskId}/cancel`,
      { reason: "MANUAL_STOP" },
    );
    runningHold.resolve();
    assert.equal(cancelActive.status, 200);
    assert.equal(cancelActive.body.status, "failed");
    assert.equal(cancelActive.body.endReason, "MANUAL_STOP");

    await app.conversation.waitForIdle(role.roleId);
    const afterStorage = RoleStorage.openExisting(
      rolePaths(config.dataRoot, role.roleId),
    );
    try {
      const events = afterStorage.business.db
        .prepare(
          "SELECT event_type FROM execution_stream_events WHERE window_id = ? ORDER BY stream_event_id ASC",
        )
        .all(win2.windowId) as Array<{ event_type: string }>;
      assert.ok(events.some((item) => item.event_type === "task_cancelled"));
    } finally {
      afterStorage.close();
    }
  } finally {
    runningHold.resolve();
    await app.close();
    cleanupDir(root);
  }
});

test("包1：已完结（completed）任务再次调用 cancel 返回 409 TASK_STATE_CONFLICT", async () => {
  const root = tempRoot();
  const presetsDir = path.join(root, "empty-presets");
  fs.mkdirSync(presetsDir, { recursive: true });
  const mcpPath = path.join(root, "mcp-complete.mjs");
  writeTestMcpToolServer(mcpPath);

  let step = 0;
  const model = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      step += 1;
      if (step === 1) {
        const pingTool = request.tools.find((tool) => tool.name.endsWith("_ping"));
        assert.ok(pingTool);
        yield {
          type: "tool_call",
          callId: "call-done-1",
          name: pingTool.name,
          arguments: {},
        };
        yield { type: "completed", stopReason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: "任务已顺利完成。" };
      yield { type: "completed", stopReason: "stop" };
    },
  };

  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    presetsDir,
    "--port",
    "0",
  ]);
  const app = createBackendApp(config, {
    disableMemoryRuntime: true,
    disablePresetAssistant: true,
    typingMs: 10,
    modelPortFactory: () => model,
  });
  try {
    const port = await listen(app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const role = createLegacyRole(app, {
      displayName: "完结任务冲突测试",
      definition: { text: "测试" },
    });
    const modelRes = app.services.resources.create({
      kind: "model",
      name: "离线测试模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    const mcpRes = app.services.resources.create({
      kind: "mcp",
      name: "本地工具",
      config: { command: process.execPath, args: [mcpPath], env: {} },
    });
    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: modelRes.resourceId,
        modelName: "offline",
        enabled: true,
      },
      {
        capability: "mcp",
        resourceId: mcpRes.resourceId,
        enabled: true,
      },
    ]);
    app.services.activity.resume(role.roleId);

    const submit = await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/windows/${role.defaultWindowId}/messages`,
      { content: "跑完一次工具调用", submissionId: randomUUID() },
    );
    assert.equal(submit.status, 201);
    await waitUntil(() => step >= 2);
    await app.conversation.waitForIdle(role.roleId);

    const completedTask = app.conversation
      .listTasks(role.roleId)
      .find((item) => item.status === "completed");
    assert.ok(completedTask);

    const cancelCompleted = await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/tasks/${completedTask.taskId}/cancel`,
      { reason: "USER_CANCELLED" },
    );
    assert.equal(cancelCompleted.status, 409);
    assert.equal(errorCodeOf(cancelCompleted.body), "TASK_STATE_CONFLICT");
  } finally {
    await app.close();
    cleanupDir(root);
  }
});

test("包1：四协议 cachedTokens/inputTokens/outputTokens 归一化与失败调用保留 usage", async () => {
  // 1. OpenAI Chat（含 prompt_tokens_details.cached_tokens）
  const openaiChatServer = await startSseServer(() => ({
    chunks: [
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ],
  }));

  // 2. OpenAI Responses（含 input_tokens_details.cached_tokens）
  const openaiResponsesServer = await startSseServer(() => ({
    chunks: [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 200,
            output_tokens: 40,
            input_tokens_details: { cached_tokens: 50 },
          },
          output: [],
        },
      })}\n\n`,
    ],
  }));

  // 3. Anthropic Messages（非缓存 input_tokens + cache_read + cache_creation 相加，保证 cachedTokens <= inputTokens）
  //    同时覆盖：收到 message_start usage 后在流中断前也能把已收 usage 吐出供落库。
  const anthropicServer = await startSseServer((_req, index) =>
    index === 0
      ? {
          chunks: [
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                usage: {
                  input_tokens: 100,
                  cache_read_input_tokens: 400,
                  cache_creation_input_tokens: 50,
                },
              },
            })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "anth" },
            })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 60 },
            })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ],
        }
      : {
          chunks: [
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                usage: {
                  input_tokens: 70,
                  cache_read_input_tokens: 30,
                },
              },
            })}\n\n`,
            `event: error\ndata: ${JSON.stringify({ type: "error" })}\n\n`,
          ],
        },
  );

  // 4. Google Gemini（promptTokenCount 已含 cachedContentTokenCount）
  const geminiServer = await startSseServer(() => ({
    chunks: [
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "gem" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 150,
          cachedContentTokenCount: 90,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 10,
        },
      })}\n\n`,
    ],
  }));

  try {
    const collect = async (
      adapter: HttpModelAdapter,
    ): Promise<{ events: ModelEvent[]; error?: unknown }> => {
      const events: ModelEvent[] = [];
      try {
        for await (const event of adapter.stream({
          modelName: "m",
          system: "s",
          messages: [{ role: "user", content: "u" }],
          tools: [],
        })) {
          events.push(event);
        }
        return { events };
      } catch (error) {
        return { events, error };
      }
    };

    const chatRes = await collect(
      new HttpModelAdapter(
        { protocol: "openai-chat", baseUrl: openaiChatServer.baseUrl },
        "sk",
      ),
    );
    assert.deepEqual(chatRes.events.find((e) => e.type === "usage"), {
      type: "usage",
      inputTokens: 120,
      cachedTokens: 80,
      outputTokens: 30,
    });

    const respRes = await collect(
      new HttpModelAdapter(
        {
          protocol: "openai-responses",
          baseUrl: openaiResponsesServer.baseUrl,
        },
        "sk",
      ),
    );
    assert.deepEqual(respRes.events.find((e) => e.type === "usage"), {
      type: "usage",
      inputTokens: 200,
      cachedTokens: 50,
      outputTokens: 40,
    });

    const anthAdapter = new HttpModelAdapter(
      { protocol: "anthropic-messages", baseUrl: anthropicServer.baseUrl },
      "sk",
    );
    const anthOk = await collect(anthAdapter);
    const anthUsage = anthOk.events.find((e) => e.type === "usage") as
      | Extract<ModelEvent, { type: "usage" }>
      | undefined;
    assert.deepEqual(anthUsage, {
      type: "usage",
      inputTokens: 550,
      cachedTokens: 400,
      cacheCreationTokens: 50,
      outputTokens: 60,
    });
    assert.ok((anthUsage?.cachedTokens ?? 0) <= (anthUsage?.inputTokens ?? 0));

    // 上游中途失败前若已有 usage，必须随流抛出前吐出，避免 AgentGraph 丢弃。
    const anthFail = await collect(anthAdapter);
    assert.ok(anthFail.error);
    assert.deepEqual(anthFail.events.find((e) => e.type === "usage"), {
      type: "usage",
      inputTokens: 100,
      cachedTokens: 30,
    });

    const geminiRes = await collect(
      new HttpModelAdapter(
        { protocol: "google-gemini", baseUrl: geminiServer.baseUrl },
        "AIza-test",
      ),
    );
    assert.deepEqual(geminiRes.events.find((e) => e.type === "usage"), {
      type: "usage",
      inputTokens: 150,
      cachedTokens: 90,
      outputTokens: 30,
    });
  } finally {
    await Promise.all([
      openaiChatServer.close(),
      openaiResponsesServer.close(),
      anthropicServer.close(),
      geminiServer.close(),
    ]);
  }
});

test("包1：任务用量汇总跨轮累计、保留失败前 usage、严格排除后台记忆整理与异步句段标注", async () => {
  const root = tempRoot();
  const presetsDir = path.join(root, "presets");
  const defaultOutfitDir = path.join(presetsDir, "xiacheng", "outfits", "default");
  fs.mkdirSync(path.join(defaultOutfitDir, "sprites"), { recursive: true });
  fs.writeFileSync(path.join(defaultOutfitDir, "home.png"), await tinyPng());
  fs.writeFileSync(
    path.join(defaultOutfitDir, "sprites", "微笑.png"),
    await tinyPng({ r: 220, g: 120, b: 80 }),
  );
  const mcpPath = path.join(root, "mcp-ping.mjs");
  writeTestMcpToolServer(mcpPath);

  let chatRound = 0;
  let annotationCount = 0;
  const scriptedModel = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      // 句段标注请求不挂载工具且 system 包含句段标注指令：给予明显超大 token 以便检验是否被错误计入任务用量。
      if (request.tools.length === 0 && request.system.includes("句段")) {
        annotationCount += 1;
        yield {
          type: "text_delta",
          text: JSON.stringify({ picks: [] }),
        };
        yield {
          type: "usage",
          inputTokens: 9999,
          cachedTokens: 8888,
          outputTokens: 7777,
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }

      chatRound += 1;
      if (chatRound === 1) {
        const pingTool = request.tools.find((tool) => tool.name.endsWith("_ping"));
        assert.ok(pingTool);
        // 第 1 轮：在 task_id 尚未通过 ensureTask 创建时就带 usage 并触发工具调用。
        yield {
          type: "tool_call",
          callId: "c1",
          name: pingTool.name,
          arguments: {},
        };
        yield {
          type: "usage",
          inputTokens: 100,
          cachedTokens: 40,
          outputTokens: 20,
        };
        yield { type: "completed", stopReason: "tool_use" };
        return;
      }
      if (chatRound === 2) {
        // 第 2 轮：无 usage 返回，检验 missingUsageCalls 如实计数且不伪造 0 之外的值。
        yield {
          type: "tool_call",
          callId: "c2",
          name: "task_pause",
          arguments: { reason: "等待复核" },
        };
        yield { type: "completed", stopReason: "tool_use" };
        return;
      }
      if (chatRound === 3) {
        yield { type: "text_delta", text: "第一阶段暂停完成。" };
        yield {
          type: "usage",
          inputTokens: 50,
          cachedTokens: 10,
          outputTokens: 15,
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      // 第 4 轮（恢复原任务续行）：先收到 usage 再抛出失败，确认失败调⽤已返回 usage 也落库且不丢弃。
      yield {
        type: "usage",
        inputTokens: 80,
        cachedTokens: 20,
        outputTokens: 10,
      };
      throw new Error("UPSTREAM_MIDSTREAM_FAIL");
    },
  };

  const memoryModel = new ScriptedMemoryModel([
    {
      operations: [
        {
          op: "create_event",
          title: "记忆测试事件",
          summary: "记忆整理消耗大量模型但不应计入任务用量",
          occurredAtStart: "2026-11-16T10:00:00.000Z",
          evidenceIds: [],
        },
      ],
    },
  ]);

  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    presetsDir,
    "--port",
    "0",
  ]);
  seedLegacyPresetAssistant(config);
  const app = createBackendApp(config, {
    modelPortFactory: () => scriptedModel,
    memoryModelFactory: () => memoryModel,
    memoryIdleMs: 50,
  });
  const port = await listen(app.server, 0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const builtin = app.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY)!;
    const role = app.services.roles.getRole(builtin.roleId);
    const modelRes = app.services.resources.create({
      kind: "model",
      name: "用量测试模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    const mcpRes = app.services.resources.create({
      kind: "mcp",
      name: "ping",
      config: { command: process.execPath, args: [mcpPath], env: {} },
    });
    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: modelRes.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: modelRes.resourceId,
        modelName: "offline-memory",
        enabled: true,
      },
      {
        capability: "mcp",
        resourceId: mcpRes.resourceId,
        enabled: true,
      },
    ]);
    app.services.activity.resume(role.roleId);

    // 触发任务并运行至暂停完成。
    await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/windows/${role.defaultWindowId}/messages`,
      { content: "执行并统计 token", submissionId: randomUUID() },
    );
    await waitUntil(
      () =>
        app.conversation.listTasks(role.roleId)[0]?.status === "paused" &&
        annotationCount >= 1,
    );
    await app.conversation.waitForIdle(role.roleId);
    const taskId = app.conversation.listTasks(role.roleId)[0]!.taskId;

    // 通过定时唤醒接回原任务继续执行第 4 轮（第 4 轮返回 usage 后中途报错失败）。
    app.services.autonomy.scheduleWake(role.roleId, {
      wakeAt: new Date(Date.now() + 120).toISOString(),
      intent: "继续原任务统计第4轮失败用量",
      taskId,
    });
    await waitUntil(
      () => app.conversation.getTask(role.roleId, taskId).status === "failed",
    );
    await app.conversation.waitForIdle(role.roleId);

    // 触发一次后台记忆整理（purpose = 'memory_maintenance'）。
    const batchRes = await jsonApi(
      baseUrl,
      "POST",
      `/v1/roles/${role.roleId}/memory/batches`,
    );
    assert.equal(batchRes.status, 202);
    await waitUntil(() => memoryModel.requests.length >= 1);
    await waitUntil(
      () =>
        app.services.memory.listBatches(role.roleId, 5).some(
          (batch) => batch.status === "completed" || batch.status === "failed",
        ),
    );
    // 再显式注入一条带超大 token 的 memory_maintenance 记录到同一 task_id，确保查询条件严格过滤记忆整理。
    withStorage(
      {
        app,
        roleId: role.roleId,
        root,
        windowId: role.defaultWindowId,
        model: scriptedModel,
        close: async () => {},
      },
      (storage) => {
        storage.business.db
          .prepare(
            `INSERT INTO model_calls
               (model_call_id, role_id, execution_id, batch_id, task_id, call_kind,
                purpose, resource_id, model_name, protocol, status, error_code,
                started_at, finished_at, usage_json, raw_response_json)
             VALUES (?, ?, NULL, NULL, ?, 'memory_maintenance', 'memory_maintenance',
                     NULL, 'offline-memory', 'openai-chat', 'succeeded', NULL,
                     ?, ?, ?, NULL)`,
          )
          .run(
            randomUUID(),
            role.roleId,
            taskId,
            new Date().toISOString(),
            new Date().toISOString(),
            JSON.stringify({ inputTokens: 50000, cachedTokens: 40000, outputTokens: 5000 }),
          );
      },
    );

    // 验证任务列表和详情接口准确累计主链 4 次调用，并严格排除 9999/8888/7777 的句段标注和记忆整理。
    const listRes = await jsonApi(baseUrl, "GET", `/v1/roles/${role.roleId}/tasks`);
    assert.equal(listRes.status, 200);
    const items = listRes.body.items as TaskRecord[];
    assert.equal(items.length, 1);

    const detailRes = await jsonApi(
      baseUrl,
      "GET",
      `/v1/roles/${role.roleId}/tasks/${taskId}`,
    );
    assert.equal(detailRes.status, 200);
    const detail = detailRes.body as unknown as TaskRecord;
    assert.deepEqual(detail.usage, {
      inputTokens: 100 + 50 + 80,
      cachedTokens: 40 + 10 + 20,
      outputTokens: 20 + 15 + 10,
      totalTokens: 230 + 45,
      callCount: 4,
      missingUsageCalls: 1,
    });
    assert.deepEqual(items[0]?.usage, detail.usage);

    // 核实数据库里确实存在异步句段标注记录和失败调用 partial usage 记录。
    const dbCheck = withStorage({ app, roleId: role.roleId, root, windowId: role.defaultWindowId, model: scriptedModel, close: async () => {} }, (storage) => {
      const kinds = storage.business.db
        .prepare("SELECT call_kind, status, usage_json FROM model_calls WHERE role_id = ?")
        .all(role.roleId) as Array<{ call_kind: string; status: string; usage_json: string | null }>;
      return kinds;
    });
    assert.ok(dbCheck.some((row) => row.call_kind === "segment_annotation"));
    assert.ok(
      dbCheck.some(
        (row) =>
          row.call_kind === "primary_decision" &&
          row.status === "failed" &&
          row.usage_json !== null,
      ),
    );
  } finally {
    await app.close();
    cleanupDir(root);
  }
});

test("包1：夏澄默认预置服饰资源（日常常服与时序织梦）真实加载、激活默认项并同步中文展示名", async () => {
  const root = tempRoot();
  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--port",
    "0",
  ]);
  const app = createBackendApp(config, { disableMemoryRuntime: true });
  try {
    const port = await listen(app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const builtin = app.services.roles
      .listRoles()
      .find((item) => item.builtinKey === XIA_CHENG_BUILTIN_KEY);
    assert.ok(builtin);
    assert.equal(app.services.activity.view(builtin.roleId).state, "stopped");

    const outfitsRes = await jsonApi(
      baseUrl,
      "GET",
      `/v1/roles/${builtin.roleId}/appearance/outfits`,
    );
    assert.equal(outfitsRes.status, 200);
    const outfits = outfitsRes.body.items as OutfitRecord[];
    assert.equal(outfits.length, 2);

    const daily = outfits.find((item) => item.name === "日常常服");
    const weaver = outfits.find((item) => item.name === "时序织梦");
    assert.ok(daily);
    assert.ok(weaver);
    assert.equal(daily.isPreset, true);
    assert.equal(weaver.isPreset, true);
    assert.ok(daily.home);
    assert.ok(weaver.home);
    assert.equal(daily.sprites.length, 19);
    assert.equal(weaver.sprites.length, 19);
    assert.equal(
      app.services.roles.getState(builtin.roleId).state.outfitId,
      daily.outfitId,
    );

    const dailySmile = daily.sprites.find((item) => item.fileName === "smile.png");
    const dailyHair = daily.sprites.find((item) => item.fileName === "hair_tuck.png");
    const weaverReserved = weaver.sprites.find((item) => item.fileName === "reserved.png");
    assert.equal(dailySmile?.displayName, "温暖微笑");
    assert.equal(dailyHair?.displayName, "整理发丝");
    assert.equal(weaverReserved?.displayName, "不悦");

    for (const outfit of [daily, weaver]) {
      const homeResp = await fetch(
        `${baseUrl}/v1/roles/${builtin.roleId}/appearance/assets/${outfit.home!.assetId}`,
      );
      assert.equal(homeResp.status, 200);
      assert.equal(homeResp.headers.get("content-type"), "image/png");
      const homeBytes = Buffer.from(await homeResp.arrayBuffer());
      assert.ok(homeBytes.length > 100_000);
    }
    const spriteResp = await fetch(
      `${baseUrl}/v1/roles/${builtin.roleId}/appearance/assets/${weaver.sprites[0]!.assetId}`,
    );
    assert.equal(spriteResp.status, 200);
    assert.equal(spriteResp.headers.get("content-type"), "image/png");
  } finally {
    await app.close();
    cleanupDir(root);
  }
});

test("包1：就绪后更新预置 manifest.json 保留已播种的差分名与素材文件", async () => {
  const root = tempRoot();
  const presetsDir = path.join(root, "presets");
  const defaultDir = path.join(presetsDir, "xiacheng", "outfits", "default");
  fs.mkdirSync(path.join(defaultDir, "sprites"), { recursive: true });
  fs.writeFileSync(path.join(defaultDir, "home.png"), await tinyPng());
  fs.writeFileSync(
    path.join(defaultDir, "sprites", "smile.png"),
    await tinyPng({ r: 210, g: 130, b: 90 }),
  );
  fs.writeFileSync(
    path.join(defaultDir, "manifest.json"),
    JSON.stringify({
      name: "日常常服",
      spriteNames: { smile: "微笑" },
    }),
  );

  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    presetsDir,
    "--port",
    "0",
  ]);
  try {
    const first = createBackendApp(config, { disableMemoryRuntime: true });
    let roleId: string;
    let firstSpriteId: string;
    let appearanceDir: string;
    let filesBefore: string[];
    try {
      const builtin = first.services.roles
        .listRoles()
        .find((item) => item.builtinKey === XIA_CHENG_BUILTIN_KEY)!;
      roleId = builtin.roleId;
      const outfits = first.services.appearance.list(roleId).items;
      assert.equal(outfits[0]?.sprites[0]?.displayName, "微笑");
      firstSpriteId = outfits[0]!.sprites[0]!.assetId;
      appearanceDir = rolePaths(config.dataRoot, roleId).appearanceDir;
      filesBefore = fs.readdirSync(appearanceDir).sort();
    } finally {
      await first.close();
    }

    fs.writeFileSync(
      path.join(defaultDir, "manifest.json"),
      JSON.stringify({
        name: "日常常服",
        spriteNames: { "smile.png": "温暖微笑" },
      }),
    );

    const second = createBackendApp(config, { disableMemoryRuntime: true });
    try {
      const outfits = second.services.appearance.list(roleId).items;
      assert.equal(outfits[0]?.sprites.length, 1);
      assert.equal(outfits[0]?.sprites[0]?.assetId, firstSpriteId);
      assert.equal(outfits[0]?.sprites[0]?.displayName, "微笑");
      assert.deepEqual(fs.readdirSync(appearanceDir).sort(), filesBefore);
    } finally {
      await second.close();
    }
  } finally {
    cleanupDir(root);
  }
});

test("包1 复核 R01：cancel 写任务终态或写取消事件失败时整笔回滚，排障后放行或重试均保持状态一致", async () => {
  // 场景 A：写 tasks 终态失败时回滚 interruptExecution，解除故障后原执行正常收尾且不分裂新执行。
  {
    let clock = new Date("2026-11-17T03:00:00.000Z");
    const entered = deferred<void>();
    const release = deferred<void>();
    const f = createFixtureWithModel(
      {
        async *stream(): AsyncIterable<ModelEvent> {
          entered.resolve();
          await release.promise;
          yield { type: "text_delta", text: "正常收尾。" };
          yield { type: "completed", stopReason: "stop" };
        },
      },
      { now: () => clock, disablePresetAssistant: true },
    );
    try {
      f.app.services.autonomy.scheduleWake(f.roleId, {
        wakeAt: "2026-11-17T04:00:00.000Z",
        intent: "R01 任务终态写故障测试",
      });
      clock = new Date("2026-11-17T04:00:00.000Z");
      assert.equal(f.app.conversation.runDueAutonomy(f.roleId), true);
      await entered.promise;
      const taskId = f.app.conversation.listTasks(f.roleId)[0]!.taskId;

      withStorage(f, (storage) => {
        storage.business.db.exec(`
          CREATE TRIGGER test_r01_task_fault
          BEFORE UPDATE OF status ON tasks
          WHEN NEW.end_reason = 'USER_CANCELLED'
          BEGIN
            SELECT RAISE(ABORT, 'INJECTED_TASK_WRITE_FAILURE');
          END;
        `);
      });
      assert.throws(() => f.app.conversation.cancelTask({ roleId: f.roleId, taskId }));

      const mid = withStorage(f, (storage) => ({
        task: storage.business.getTask(f.roleId, taskId).status,
        executions: storage.business.db
          .prepare("SELECT status FROM executions ORDER BY rowid ASC")
          .all() as Array<{ status: string }>,
        cancelEvents: (
          storage.business.db
            .prepare(
              "SELECT COUNT(*) AS n FROM execution_stream_events WHERE event_type = 'task_cancelled'",
            )
            .get() as { n: number }
        ).n,
      }));
      assert.equal(mid.task, "active");
      assert.deepEqual(mid.executions, [{ status: "running" }]);
      assert.equal(mid.cancelEvents, 0);

      withStorage(f, (storage) => {
        storage.business.db.exec("DROP TRIGGER test_r01_task_fault");
      });
      release.resolve();
      await f.app.conversation.waitForIdle(f.roleId);

      const done = withStorage(f, (storage) => ({
        task: storage.business.getTask(f.roleId, taskId).status,
        executions: storage.business.db
          .prepare("SELECT status FROM executions ORDER BY rowid ASC")
          .all() as Array<{ status: string }>,
        cancelEvents: (
          storage.business.db
            .prepare(
              "SELECT COUNT(*) AS n FROM execution_stream_events WHERE event_type = 'task_cancelled'",
            )
            .get() as { n: number }
        ).n,
      }));
      assert.equal(done.task, "completed");
      assert.deepEqual(done.executions, [{ status: "completed" }]);
      assert.equal(done.cancelEvents, 0);
    } finally {
      release.resolve();
      await f.close();
    }
  }

  // 场景 B：写 task_cancelled 流事件失败时整笔回滚，排障后通过 HTTP 重试取消成功。
  {
    let clock = new Date("2026-11-17T03:00:00.000Z");
    const entered = deferred<void>();
    const release = deferred<void>();
    const f = createFixtureWithModel(
      {
        async *stream(): AsyncIterable<ModelEvent> {
          entered.resolve();
          await release.promise;
          yield { type: "text_delta", text: "若未被取消才会输出。" };
          yield { type: "completed", stopReason: "stop" };
        },
      },
      { now: () => clock, disablePresetAssistant: true },
    );
    try {
      const port = await listen(f.app.server, 0, "127.0.0.1");
      const baseUrl = `http://127.0.0.1:${port}`;
      f.app.services.autonomy.scheduleWake(f.roleId, {
        wakeAt: "2026-11-17T04:00:00.000Z",
        intent: "R01 取消事件写故障重试测试",
      });
      clock = new Date("2026-11-17T04:00:00.000Z");
      assert.equal(f.app.conversation.runDueAutonomy(f.roleId), true);
      await entered.promise;
      const taskId = f.app.conversation.listTasks(f.roleId)[0]!.taskId;

      withStorage(f, (storage) => {
        storage.business.db.exec(`
          CREATE TRIGGER test_r01_event_fault
          BEFORE INSERT ON execution_stream_events
          WHEN NEW.event_type = 'task_cancelled'
          BEGIN
            SELECT RAISE(ABORT, 'INJECTED_EVENT_WRITE_FAILURE');
          END;
        `);
      });
      const failedReq = await jsonApi(
        baseUrl,
        "POST",
        `/v1/roles/${f.roleId}/tasks/${taskId}/cancel`,
        { reason: "USER_CANCELLED" },
      );
      assert.equal(failedReq.status, 500);

      const mid = withStorage(f, (storage) => ({
        task: storage.business.getTask(f.roleId, taskId).status,
        executions: storage.business.db
          .prepare("SELECT status FROM executions ORDER BY rowid ASC")
          .all() as Array<{ status: string }>,
        cancelEvents: (
          storage.business.db
            .prepare(
              "SELECT COUNT(*) AS n FROM execution_stream_events WHERE event_type = 'task_cancelled'",
            )
            .get() as { n: number }
        ).n,
      }));
      assert.equal(mid.task, "active");
      assert.deepEqual(mid.executions, [{ status: "running" }]);
      assert.equal(mid.cancelEvents, 0);

      withStorage(f, (storage) => {
        storage.business.db.exec("DROP TRIGGER test_r01_event_fault");
      });
      const retryReq = await jsonApi(
        baseUrl,
        "POST",
        `/v1/roles/${f.roleId}/tasks/${taskId}/cancel`,
        { reason: "USER_CANCELLED" },
      );
      assert.equal(retryReq.status, 200);
      assert.equal(retryReq.body.status, "failed");
      assert.equal(retryReq.body.endReason, "USER_CANCELLED");

      release.resolve();
      await f.app.conversation.waitForIdle(f.roleId);
      const done = withStorage(f, (storage) => ({
        task: storage.business.getTask(f.roleId, taskId).status,
        executions: storage.business.db
          .prepare("SELECT status FROM executions ORDER BY rowid ASC")
          .all() as Array<{ status: string }>,
        cancelEvents: (
          storage.business.db
            .prepare(
              "SELECT COUNT(*) AS n FROM execution_stream_events WHERE event_type = 'task_cancelled'",
            )
            .get() as { n: number }
        ).n,
      }));
      assert.equal(done.task, "failed");
      assert.deepEqual(done.executions, [{ status: "failed" }]);
      assert.equal(done.cancelEvents, 1);
    } finally {
      release.resolve();
      await f.close();
    }
  }
});

test("预置素材首次读取失败时保留恢复载荷，修复后沿用席位完成播种", async () => {
  const root = tempRoot();
  const presets = path.join(root, "presets");
  const home = path.join(presets, "xiacheng", "outfits", "default", "home.png");
  const config = parseBackendConfig(["--app-root", path.join(root, "app"), "--preset-assets-dir", presets]);
  const options = { disableMemoryRuntime: true };
  try {
    fs.mkdirSync(home, { recursive: true });
    assert.throws(() => createBackendApp(config, options));
    const db = new Database(config.appDatabasePath, { readonly: true });
    let row: { role_id: string; init_status: string };
    try {
      row = db.prepare("SELECT role_id, init_status FROM roles WHERE builtin_key = 'xiacheng'").get() as typeof row;
      assert.equal(row.init_status, "failed");
    } finally {
      db.close();
    }
    fs.rmdirSync(home);
    fs.writeFileSync(home, await tinyPng());
    const recovered = createBackendApp(config, options);
    try {
      assert.deepEqual(recovered.services.roles.listRoles().map(role => [role.roleId, role.status]), [[row.role_id, "ready"]]);
      assert.ok(recovered.services.appearance.list(row.role_id).items[0]?.home);
    } finally {
      await recovered.close();
    }
  } finally {
    cleanupDir(root);
  }
});

test("主角色改名、编辑或清空介绍、替换和删除官方外观后，重启与单角色迁移保留外壳", async () => {
  const root = tempRoot();
  const presets = path.join(root, "presets");
  const configFor = (name: string) => parseBackendConfig([
    "--app-root", path.join(root, name), "--preset-assets-dir", presets, "--port", "0",
  ]);
  const original = await tinyPng();
  const replacement = await tinyPng({ r: 10, g: 20, b: 30 });
  for (const slug of ["default", "other"]) {
    const dir = path.join(presets, "xiacheng", "outfits", slug);
    fs.mkdirSync(path.join(dir, "sprites"), { recursive: true });
    fs.writeFileSync(path.join(dir, "home.png"), original);
    fs.writeFileSync(path.join(dir, "sprites", "微笑.png"), original);
  }
  const source = configFor("source");
  const options = { disableMemoryRuntime: true };
  let app = createBackendApp(source, options);
  try {
    const id = app.services.roles.listRoles()[0]!.roleId;
    const [keep, remove] = app.services.appearance.list(id).items;
    assert.ok(keep && remove);
    await app.services.appearance.renameOutfit(id, keep.outfitId, { name: "新装" });
    const home = await app.services.appearance.replaceHome(id, keep.outfitId, { fileName: "新立绘.png", data: replacement });
    app.services.appearance.deleteSprite(id, keep.outfitId, keep.sprites[0]!.assetId);
    app.services.appearance.deleteOutfit(id, remove.outfitId);
    for (const [index, bio] of ["我的新介绍", ""].entries()) {
      app.services.roles.updateDefinition(id, { displayName: "岚", bio });
      await app.close();
      const packet = path.join(root, `seat-${index}.json`);
      const target = configFor(`target-${index}`);
      exportRoleTransfer(source, id, packet);
      const preview = preflightRoleTransfer(target, packet);
      assert.equal(applyRoleTransfer(target, packet, preview.token).outcome, "published");
      for (const installation of [target, source]) {
        app = createBackendApp(installation, options);
        assert.deepEqual(app.services.roles.listRoles().map(r => [r.roleId, r.builtinKey, r.displayName, r.bio]),
          [[id, "xiacheng", "岚", bio]]);
        const wardrobe = app.services.appearance.list(id).items;
        assert.deepEqual(wardrobe.map(o => [o.outfitId, o.name, o.home?.assetId, o.sprites]), [[keep.outfitId, "新装", home.assetId, []]]);
        assert.deepEqual(app.services.appearance.readAsset(id, home.assetId).data, replacement);
        if (installation === target) await app.close();
      }
    }
  } finally {
    await app.close();
    cleanupDir(root);
  }
});

test("包1 复核 R03：OpenAI Chat/Responses/Anthropic 工具参数无效时保留已收到 usage 并计入任务失败调用汇总", async () => {
  const collectEvents = async (adapter: HttpModelAdapter) => {
    const events: ModelEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of adapter.stream({
        modelName: "offline-model",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      })) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }
    return { events, caught };
  };

  let chatCall = 0;
  const openAiChatServer = await startSseServer(() => {
    chatCall += 1;
    // 第 1 次用于适配器单测，或由任务链第 2 轮复用；带截断工具参数 JSON 与正常 [DONE] + usage。
    return {
      chunks: [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-chat-${chatCall}`,
                    function: { name: "broken_tool", arguments: "{" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 27,
            completion_tokens: 9,
            prompt_tokens_details: { cached_tokens: 10 },
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
    };
  });

  const openAiResponsesServer = await startSseServer(() => ({
    chunks: [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc-1",
          call_id: "call-resp-1",
          name: "broken_tool",
          arguments: "{",
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 27,
            output_tokens: 9,
            input_tokens_details: { cached_tokens: 6 },
          },
        },
      })}\n\n`,
    ],
  }));

  const anthropicServer = await startSseServer(() => ({
    chunks: [
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 15,
            output_tokens: 1,
          },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-anth-1",
          name: "broken_tool",
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 9 },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ],
  }));

  const root = tempRoot();
  const presetsDir = path.join(root, "empty-presets");
  fs.mkdirSync(presetsDir, { recursive: true });
  const mcpPath = path.join(root, "mcp-ping.mjs");
  writeTestMcpToolServer(mcpPath);

  let taskRound = 0;
  const openAiChatTaskAdapter = new HttpModelAdapter(
    { protocol: "openai-chat", baseUrl: openAiChatServer.baseUrl },
    "sk-test",
  );
  const taskModel = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      taskRound += 1;
      if (taskRound === 1) {
        const pingTool = request.tools.find((tool) => tool.name.endsWith("_ping"));
        assert.ok(pingTool);
        yield {
          type: "tool_call",
          callId: "c1",
          name: pingTool.name,
          arguments: {},
        };
        yield {
          type: "usage",
          inputTokens: 100,
          cachedTokens: 40,
          outputTokens: 20,
        };
        yield { type: "completed", stopReason: "tool_use" };
        return;
      }
      // 第 2 轮直接走真实 HttpModelAdapter OpenAI Chat SSE，复现工具参数截断 JSON + 尾部 usage + [DONE]。
      yield* openAiChatTaskAdapter.stream(request);
    },
  };

  try {
    // 1. 三种后置解析工具参数的协议适配器均必须在抛出 MODEL_TOOL_ARGUMENTS_INVALID 前发出 usage，且不发出 tool_call/completed。
    const chatRes = await collectEvents(
      new HttpModelAdapter(
        { protocol: "openai-chat", baseUrl: openAiChatServer.baseUrl },
        "sk",
      ),
    );
    assert.equal((chatRes.caught as { code?: string })?.code, "MODEL_TOOL_ARGUMENTS_INVALID");
    assert.equal(chatRes.events.some((e) => e.type === "tool_call"), false);
    assert.equal(chatRes.events.some((e) => e.type === "completed"), false);
    assert.deepEqual(chatRes.events.find((e) => e.type === "usage"), {
      type: "usage",
      inputTokens: 27,
      cachedTokens: 10,
      outputTokens: 9,
    });

    const respRes = await collectEvents(
      new HttpModelAdapter(
        { protocol: "openai-responses", baseUrl: openAiResponsesServer.baseUrl },
        "sk",
      ),
    );
    assert.equal((respRes.caught as { code?: string })?.code, "MODEL_TOOL_ARGUMENTS_INVALID");
    assert.equal(respRes.events.some((e) => e.type === "tool_call"), false);
    assert.equal(respRes.events.some((e) => e.type === "completed"), false);
    assert.deepEqual(respRes.events.find((e) => e.type === "usage"), {
      type: "usage",
      inputTokens: 27,
      cachedTokens: 6,
      outputTokens: 9,
    });

    const anthRes = await collectEvents(
      new HttpModelAdapter(
        { protocol: "anthropic-messages", baseUrl: anthropicServer.baseUrl },
        "sk",
      ),
    );
    assert.equal((anthRes.caught as { code?: string })?.code, "MODEL_TOOL_ARGUMENTS_INVALID");
    assert.equal(anthRes.events.some((e) => e.type === "tool_call"), false);
    assert.equal(anthRes.events.some((e) => e.type === "completed"), false);
    assert.deepEqual(anthRes.events.find((e) => e.type === "usage"), {
      type: "usage",
      inputTokens: 27,
      cachedTokens: 15,
      outputTokens: 9,
    });

    // 2. 端到端任务汇总：第 2 轮返回截断 JSON 时失败落库并计入任务累计 token，且不派发无效工具调用。
    const config = parseBackendConfig([
      "--app-root",
      path.join(root, "app"),
      "--preset-assets-dir",
      presetsDir,
      "--port",
      "0",
    ]);
    const app = createBackendApp(config, {
      disableMemoryRuntime: true,
      disablePresetAssistant: true,
      typingMs: 10,
      modelPortFactory: () => taskModel,
    });
    try {
      const port = await listen(app.server, 0, "127.0.0.1");
      const baseUrl = `http://127.0.0.1:${port}`;
      const role = createLegacyRole(app, {
        displayName: "R03任务汇总角色",
        definition: { text: "test" },
      });
      const modelRes = app.services.resources.create({
        kind: "model",
        name: "openai-chat",
        config: { protocol: "openai-chat", baseUrl: openAiChatServer.baseUrl },
      });
      const mcpRes = app.services.resources.create({
        kind: "mcp",
        name: "本地工具",
        config: { command: process.execPath, args: [mcpPath], env: {} },
      });
      app.services.resources.replaceBindings(role.roleId, [
        {
          capability: "chat_model",
          resourceId: modelRes.resourceId,
          modelName: "offline",
          enabled: true,
        },
        {
          capability: "mcp",
          resourceId: mcpRes.resourceId,
          enabled: true,
        },
      ]);
      app.services.activity.resume(role.roleId);
      const submit = await jsonApi(
        baseUrl,
        "POST",
        `/v1/roles/${role.roleId}/windows/${role.defaultWindowId}/messages`,
        { content: "触发第2轮工具参数错误", submissionId: randomUUID() },
      );
      assert.equal(submit.status, 201);
      await app.conversation.waitForIdle(role.roleId);

      const tasksRes = await jsonApi(baseUrl, "GET", `/v1/roles/${role.roleId}/tasks`);
      assert.equal(tasksRes.status, 200);
      const taskItems = tasksRes.body.items as TaskRecord[];
      assert.equal(taskItems.length, 1);
      assert.equal(taskItems[0]?.status, "failed");
      assert.equal(taskItems[0]?.endReason, "MODEL_TOOL_ARGUMENTS_INVALID");
      assert.deepEqual(taskItems[0]?.usage, {
        inputTokens: 127,
        cachedTokens: 50,
        outputTokens: 29,
        totalTokens: 156,
        callCount: 2,
        missingUsageCalls: 0,
      });

      const toolCalls = withStorage(
        {
          app,
          roleId: role.roleId,
          root,
          windowId: role.defaultWindowId,
          model: taskModel,
          close: async () => {},
        },
        (storage) =>
          storage.business.db
            .prepare(
              "SELECT tc.tool_name FROM tool_calls tc JOIN tasks t ON t.task_id = tc.task_id WHERE t.role_id = ?",
            )
            .all(role.roleId) as Array<{ tool_name: string }>,
      );
      assert.equal(toolCalls.some((item) => item.tool_name === "broken_tool"), false);
    } finally {
      await app.close();
    }
  } finally {
    await Promise.all([
      openAiChatServer.close(),
      openAiResponsesServer.close(),
      anthropicServer.close(),
    ]);
    cleanupDir(root);
  }
});
