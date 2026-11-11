import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { AppError } from "../src/domain/errors.js";
import type { ModelServiceConfig } from "../src/domain/model.js";
import { HttpModelAdapter } from "../src/model/protocols.js";
import { AppStore } from "../src/storage/app-store.js";

interface MockServer {
  baseUrl: string;
  requests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: unknown;
  }>;
  models: {
    status: number;
    body: unknown;
    delayMs: number;
  };
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const models: MockServer["models"] = {
    status: 200,
    body: { data: [{ id: "mock-model" }] },
    delayMs: 0,
  };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: rawBody.length === 0 ? null : (JSON.parse(rawBody) as unknown),
    });
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      if (models.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, models.delayMs));
      }
      response.writeHead(models.status, {
        "content-type": "application/json",
        ...(models.status === 302
          ? { location: "http://127.0.0.1:1/elsewhere" }
          : {}),
      });
      response.end(
        models.status === 302 ? "" : JSON.stringify(models.body),
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url?.endsWith("/chat/completions")
    ) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"choices":[{"delta":{"content":"pong"}}]}\n\n',
      );
      response.write(
        'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    models,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function api(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
    raw,
  };
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
}

async function rejectsWithCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p12-"));
}

async function startApp(root: string) {
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config, {
    typingMs: 20,
    disableMemoryRuntime: true,
  });
  const port = await listen(app.server, 0, config.host);
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

function credentialOf(body: Record<string, unknown>): {
  status: string;
  reference: string | null;
  resolvable: boolean;
} {
  return body.credential as {
    status: string;
    reference: string | null;
    resolvable: boolean;
  };
}

test("a saved model key is write-only and is used by tests and conversations", { timeout: 60_000 }, async () => {
  const root = tempRoot();
  const server = await startMockServer();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const created = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "本地模型",
      config: { protocol: "openai-chat", baseUrl: server.baseUrl },
      secret: "sk-live-secret",
    });
    assert.equal(created.status, 201);
    assert.equal(credentialOf(created.body).status, "stored");
    assert.equal(credentialOf(created.body).resolvable, true);
    assert.equal(created.raw.includes("sk-live-secret"), false, "创建响应不应回传明文");
    const resourceId = created.body.resourceId as string;

    const listed = await api(app.baseUrl, "GET", "/v1/resources?kind=model");
    assert.equal(listed.raw.includes("sk-live-secret"), false, "列表不应回传明文");
    const fetched = await api(
      app.baseUrl,
      "GET",
      `/v1/resources/${resourceId}`,
    );
    assert.equal(fetched.raw.includes("sk-live-secret"), false, "详情不应回传明文");

    const models = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/models`,
    );
    assert.equal(models.status, 200);
    assert.deepEqual(models.body, { models: ["mock-model"] });
    assert.equal(
      server.requests.at(-1)?.headers.authorization,
      "Bearer sk-live-secret",
    );

    const tested = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/model-test`,
      { model: "mock-model" },
    );
    assert.equal(tested.status, 200);
    assert.equal(tested.body.ok, true);
    assert.equal(typeof tested.body.fingerprint, "string");

    const role = await api(app.baseUrl, "POST", "/v1/roles", {
      displayName: "凭据角色",
      definition: { text: "用已保存密钥对话" },
    });
    assert.equal(role.status, 201);
    const roleId = role.body.roleId as string;
    const bindings = await api(
      app.baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [
          {
            capability: "chat_model",
            resourceId,
            modelName: "mock-model",
          },
        ],
      },
    );
    assert.equal(bindings.status, 200);
    const window = await api(
      app.baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows`,
      {},
    );
    assert.equal(window.status, 201);
    const windowId = window.body.windowId as string;
    const submitted = await api(
      app.baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows/${windowId}/messages`,
      { content: "你好", submissionId: randomUUID() },
    );
    assert.equal(submitted.status, 201);
    await app.app.conversation.waitForIdle(roleId);

    const chatRequest = server.requests.find(
      (request) => request.url.endsWith("/chat/completions"),
    );
    assert.ok(chatRequest, "对话应发出模型请求");
    assert.equal(chatRequest.headers.authorization, "Bearer sk-live-secret");
  } finally {
    await app?.app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secret updates keep, replace and clear the saved credential", { timeout: 60_000 }, async () => {
  const root = tempRoot();
  const server = await startMockServer();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const created = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "可替换密钥",
      config: { protocol: "openai-chat", baseUrl: server.baseUrl },
      secret: "sk-first",
    });
    const resourceId = created.body.resourceId as string;

    const renamed = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      { name: "改名但保留密钥" },
    );
    assert.equal(credentialOf(renamed.body).status, "stored");
    const keptTest = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/model-test`,
      { model: "mock-model" },
    );
    assert.equal(keptTest.body.ok, true);
    assert.equal(
      server.requests.at(-1)?.headers.authorization,
      "Bearer sk-first",
    );

    const replaced = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      { secret: "sk-second" },
    );
    assert.equal(credentialOf(replaced.body).status, "stored");
    const replacedTest = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/model-test`,
      { model: "mock-model" },
    );
    assert.equal(replacedTest.body.ok, true);
    assert.equal(
      server.requests.at(-1)?.headers.authorization,
      "Bearer sk-second",
    );

    const keepConflict = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      {
        config: {
          protocol: "openai-chat",
          baseUrl: server.baseUrl,
          credentialRef: "env:NOWADAYS_P12_KEY",
        },
      },
    );
    assert.equal(keepConflict.status, 400);
    assert.equal(
      errorCode(keepConflict.body),
      "RESOURCE_CREDENTIAL_CONFLICT",
    );

    const cleared = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      { secret: null },
    );
    assert.equal(credentialOf(cleared.body).status, "missing");
    assert.equal(credentialOf(cleared.body).resolvable, false);
    const clearedTest = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/model-test`,
      { model: "mock-model" },
    );
    // 未配置密钥的本地服务仍然可用：请求不带 Authorization，不视为失败。
    assert.equal(clearedTest.body.ok, true);
    assert.equal(
      server.requests.at(-1)?.headers.authorization,
      undefined,
    );

    const conflict = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      {
        config: {
          protocol: "openai-chat",
          baseUrl: server.baseUrl,
          credentialRef: "env:NOWADAYS_P12_KEY",
        },
        secret: "sk-conflict",
      },
    );
    assert.equal(conflict.status, 400);
    assert.equal(errorCode(conflict.body), "RESOURCE_CREDENTIAL_CONFLICT");

    const createConflict = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "冲突创建",
      config: {
        protocol: "openai-chat",
        baseUrl: server.baseUrl,
        credentialRef: "env:NOWADAYS_P12_KEY",
      },
      secret: "sk-conflict",
    });
    assert.equal(createConflict.status, 400);
    assert.equal(
      errorCode(createConflict.body),
      "RESOURCE_CREDENTIAL_CONFLICT",
    );
  } finally {
    await app?.app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creating a service with a secret is atomic", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const invalid = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "坏配置",
      config: { protocol: "unknown", baseUrl: "http://127.0.0.1:1" },
      secret: "sk-orphan",
    });
    assert.equal(invalid.status, 400);
    assert.equal(errorCode(invalid.body), "INVALID_RESOURCE_CONFIG");

    const tooLong = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "超长密钥",
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1" },
      secret: "x".repeat(4001),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(errorCode(tooLong.body), "INVALID_REQUEST");

    const resources = app.app.appStore.db
      .prepare("SELECT COUNT(*) AS total FROM resources")
      .get() as { total: number };
    const secrets = app.app.appStore.db
      .prepare("SELECT COUNT(*) AS total FROM resource_secrets")
      .get() as { total: number };
    assert.equal(resources.total, 0);
    assert.equal(secrets.total, 0);
  } finally {
    await app?.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("saved probes record the resource and mark stale results", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  const server = await startMockServer();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const created = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "指纹服务",
      config: { protocol: "openai-chat", baseUrl: server.baseUrl },
      secret: "sk-first",
    });
    const resourceId = created.body.resourceId as string;
    const tested = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/model-test`,
      { model: "mock-model" },
    );
    assert.equal(tested.body.ok, true);

    const row = app.app.appStore.db
      .prepare(
        "SELECT resource_id, config_fingerprint FROM model_test_calls ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { resource_id: string; config_fingerprint: string };
    assert.equal(row.resource_id, resourceId);
    assert.equal(row.config_fingerprint, tested.body.fingerprint);

    const fresh = await api(
      app.baseUrl,
      "GET",
      `/v1/resources/${resourceId}`,
    );
    assert.equal((fresh.body.lastTest as { stale: boolean }).stale, false);

    const replaced = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      { secret: "sk-second" },
    );
    assert.equal((replaced.body.lastTest as { stale: boolean }).stale, true);

    const moved = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      {
        config: {
          protocol: "openai-chat",
          baseUrl: `${server.baseUrl}/v2`,
        },
      },
    );
    assert.equal(moved.body.lastTest, null, "地址变化后旧测试应清空");
    const remaining = app.app.appStore.db
      .prepare(
        "SELECT COUNT(*) AS total FROM model_test_calls WHERE resource_id = ?",
      )
      .get(resourceId) as { total: number };
    assert.equal(remaining.total, 0);
  } finally {
    await app?.app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an undecryptable secret is reported instead of crashing", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  const server = await startMockServer();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const created = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "损坏密钥",
      config: { protocol: "openai-chat", baseUrl: server.baseUrl },
      secret: "sk-broken",
    });
    const resourceId = created.body.resourceId as string;
    app.app.appStore.db
      .prepare(
        "UPDATE resource_secrets SET ciphertext = ? WHERE resource_id = ?",
      )
      .run("v1.bad.bad.bad", resourceId);

    const fetched = await api(
      app.baseUrl,
      "GET",
      `/v1/resources/${resourceId}`,
    );
    assert.equal(credentialOf(fetched.body).status, "unavailable");
    assert.equal(credentialOf(fetched.body).resolvable, false);

    const before = server.requests.length;
    const tested = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/model-test`,
      { model: "mock-model" },
    );
    assert.equal(tested.body.ok, false);
    assert.equal(
      (tested.body.error as { code: string }).code,
      "MODEL_CREDENTIAL_UNAVAILABLE",
    );
    assert.equal(server.requests.length, before);
  } finally {
    await app?.app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model list distinguishes empty data, incompatible payloads and redirects", { timeout: 30_000 }, async () => {
  const server = await startMockServer();
  const config: ModelServiceConfig = {
    protocol: "openai-chat",
    baseUrl: server.baseUrl,
  };
  const adapter = new HttpModelAdapter(config, undefined, {
    listTimeoutMs: 80,
  });
  try {
    assert.deepEqual(await adapter.listModels(), ["mock-model"]);

    server.models.body = { data: [] };
    assert.deepEqual(await adapter.listModels(), []);

    server.models.body = { data: { id: "not-an-array" } };
    await rejectsWithCode(
      () => adapter.listModels(),
      "MODEL_LIST_INCOMPATIBLE",
    );

    server.models.body = { data: [{ name: "without-id" }] };
    await rejectsWithCode(
      () => adapter.listModels(),
      "MODEL_LIST_INCOMPATIBLE",
    );

    server.models.body = { models: ["legacy-shape"] };
    await rejectsWithCode(
      () => adapter.listModels(),
      "MODEL_LIST_INCOMPATIBLE",
    );

    server.models.body = { data: [{ id: "mock-model" }] };
    server.models.status = 302;
    await rejectsWithCode(
      () => adapter.listModels(),
      "MODEL_REDIRECT_BLOCKED",
    );

    server.models.status = 200;
    server.models.delayMs = 300;
    await rejectsWithCode(
      () => adapter.listModels(),
      "MODEL_REQUEST_TIMEOUT",
    );
  } finally {
    await server.close();
  }
});

test("model base urls are validated and normalized", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    for (const baseUrl of [
      "ftp://example.com/v1",
      "https://user:pass@example.com/v1",
      "https://example.com/v1?token=1",
      "https://example.com/v1#fragment",
      "not-a-url",
    ]) {
      const rejected = await api(app.baseUrl, "POST", "/v1/resources", {
        kind: "model",
        name: "非法地址",
        config: { protocol: "openai-chat", baseUrl },
      });
      assert.equal(rejected.status, 400, baseUrl);
      assert.equal(errorCode(rejected.body), "INVALID_RESOURCE_CONFIG");
    }

    const normalized = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "末尾斜杠",
      config: {
        protocol: "openai-chat",
        baseUrl: "https://example.com/v1///",
      },
    });
    assert.equal(normalized.status, 201);
    assert.equal(
      (normalized.body.config as { baseUrl: string }).baseUrl,
      "https://example.com/v1",
    );
  } finally {
    await app?.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("env references stay readable and report their resolution state", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  const server = await startMockServer();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const created = await api(app.baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "引用密钥",
      config: {
        protocol: "openai-chat",
        baseUrl: server.baseUrl,
        credentialRef: "env:NOWADAYS_P12_REFERENCE_KEY",
      },
    });
    const resourceId = created.body.resourceId as string;
    const missing = credentialOf(created.body);
    assert.equal(missing.status, "reference");
    assert.equal(missing.reference, "env:NOWADAYS_P12_REFERENCE_KEY");
    assert.equal(missing.resolvable, false);

    process.env.NOWADAYS_P12_REFERENCE_KEY = "env-secret";
    const resolved = await api(
      app.baseUrl,
      "GET",
      `/v1/resources/${resourceId}`,
    );
    assert.equal(credentialOf(resolved.body).resolvable, true);
    const tested = await api(
      app.baseUrl,
      "POST",
      `/v1/resources/${resourceId}/model-test`,
      { model: "mock-model" },
    );
    assert.equal(tested.body.ok, true);
    assert.equal(
      server.requests.at(-1)?.headers.authorization,
      "Bearer env-secret",
    );
  } finally {
    delete process.env.NOWADAYS_P12_REFERENCE_KEY;
    await app?.app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function wavAudio(): Buffer {
  const payload = Buffer.alloc(64);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + payload.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

async function createRole(baseUrl: string): Promise<string> {
  const role = await api(baseUrl, "POST", "/v1/roles", {
    displayName: "声音角色",
    definition: { text: "参考音频管理" },
  });
  assert.equal(role.status, 201);
  return role.body.roleId as string;
}

async function uploadReference(
  base: string,
  fileName: string,
): Promise<{ assetId: string; relativePath: string }> {
  const form = new FormData();
  form.set("file", new Blob([wavAudio()], { type: "audio/wav" }), fileName);
  const response = await fetch(`${base}/voice/reference`, {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    reference: { assetId: string; relativePath: string };
  };
  return body.reference;
}

test("reference audio can be listed and deleted unless it is in use", { timeout: 60_000 }, async () => {
  const root = tempRoot();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const roleId = await createRole(app.baseUrl);
    const roleBase = `${app.baseUrl}/v1/roles/${roleId}`;
    const first = await uploadReference(roleBase, "第一次.wav");
    const second = await uploadReference(roleBase, "第二次.wav");

    const listed = await api(app.baseUrl, "GET", `/v1/roles/${roleId}/voice/references`);
    assert.equal(listed.status, 200);
    const items = listed.body.items as Array<{
      assetId: string;
      fileName: string;
      inUse: boolean;
    }>;
    assert.equal(items.length, 2);
    assert.equal(items.every((item) => item.inUse === false), true);
    assert.deepEqual(
      items.map((item) => item.fileName).sort(),
      ["第一次.wav", "第二次.wav"],
    );

    const saved = await api(app.baseUrl, "PUT", `/v1/roles/${roleId}/voice`, {
      baseUrl: "http://127.0.0.1:1",
      protocol: "nowadays-tts-v1",
      voiceSource: { kind: "reference", referenceAssetId: first.assetId },
    });
    assert.equal(saved.status, 200);

    const inUseList = await api(app.baseUrl, "GET", `/v1/roles/${roleId}/voice/references`);
    const inUse = (inUseList.body.items as Array<{ assetId: string; inUse: boolean }>).find(
      (item) => item.assetId === first.assetId,
    );
    assert.equal(inUse?.inUse, true);

    const blocked = await api(
      app.baseUrl,
      "DELETE",
      `/v1/roles/${roleId}/voice/references/${first.assetId}`,
    );
    assert.equal(blocked.status, 409);
    assert.equal(errorCode(blocked.body), "VOICE_REFERENCE_IN_USE");

    const deleted = await api(
      app.baseUrl,
      "DELETE",
      `/v1/roles/${roleId}/voice/references/${second.assetId}`,
    );
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.fileRemoved, true);

    const after = await api(app.baseUrl, "GET", `/v1/roles/${roleId}/voice/references`);
    assert.equal((after.body.items as unknown[]).length, 1);
    const voiceDir = path.join(
      root,
      "data",
      "roles",
      roleId,
      "voice",
    );
    assert.deepEqual(
      fs.readdirSync(voiceDir),
      [path.basename(first.relativePath)],
    );

    const missing = await api(
      app.baseUrl,
      "DELETE",
      `/v1/roles/${roleId}/voice/references/${second.assetId}`,
    );
    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing.body), "VOICE_REFERENCE_NOT_FOUND");
  } finally {
    await app?.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capabilities sent with a save are validated and persisted", { timeout: 60_000 }, async () => {
  const root = tempRoot();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const roleId = await createRole(app.baseUrl);
    const roleBase = `${app.baseUrl}/v1/roles/${roleId}`;
    const reference = await uploadReference(roleBase, "声明校验.wav");
    const capabilities = {
      referenceModes: [{ id: "clone", label: "克隆", requiresReferenceText: false }],
      presetVoices: false,
      languages: ["zh"],
      speed: { min: 0.5, max: 2 },
    };

    // 声明里没有参考模式时，参考音频音色不能被保存。
    const unsupported = await api(app.baseUrl, "PUT", `/v1/roles/${roleId}/voice`, {
      baseUrl: "http://127.0.0.1:1",
      protocol: "nowadays-tts-v1",
      capabilities: { ...capabilities, referenceModes: [] },
      voiceSource: { kind: "reference", referenceAssetId: reference.assetId },
    });
    assert.equal(unsupported.status, 400);
    assert.equal(errorCode(unsupported.body), "VOICE_REFERENCE_MODE_UNSUPPORTED");

    // 声明支持时保存成功，能力随配置持久化，重新读取仍在。
    const saved = await api(app.baseUrl, "PUT", `/v1/roles/${roleId}/voice`, {
      baseUrl: "http://127.0.0.1:1",
      protocol: "nowadays-tts-v1",
      capabilities,
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone",
      },
    });
    assert.equal(saved.status, 200);
    const savedVoice = saved.body.voice as { capabilities: unknown };
    assert.deepEqual(savedVoice.capabilities, capabilities);

    const read = await api(app.baseUrl, "GET", `/v1/roles/${roleId}/voice`);
    assert.equal(read.status, 200);
    assert.deepEqual((read.body.voice as { capabilities: unknown }).capabilities, capabilities);
  } finally {
    await app?.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a preset voice reported as missing maps to a distinct error", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  const tts = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // 丢弃请求体，只验证错误映射。
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ detail: "预设音色已下架", code: "VOICE_NOT_FOUND" }),
    );
  });
  await new Promise<void>((resolve) => tts.listen(0, "127.0.0.1", resolve));
  const address = tts.address();
  assert.ok(address !== null && typeof address === "object");
  const ttsUrl = `http://127.0.0.1:${address.port}`;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp(root);
    const roleId = await createRole(app.baseUrl);
    const preview = await api(
      app.baseUrl,
      "POST",
      `/v1/roles/${roleId}/voice/preview`,
      {
        text: "你好",
        config: {
          baseUrl: ttsUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: { kind: "preset", voiceId: "gone-voice" },
        },
      },
    );
    assert.equal(preview.status, 409);
    assert.equal(errorCode(preview.body), "TTS_VOICE_UNAVAILABLE");
  } finally {
    await app?.app.close();
    await new Promise<void>((resolve, reject) =>
      tts.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an app database from v2 upgrades to v3 and keeps resources", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config);
  let resourceId: string;
  try {
    const created = app.services.resources.create({
      kind: "model",
      name: "旧版服务",
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1" },
    });
    resourceId = created.resourceId;
  } finally {
    await app.close();
  }

  const raw = new Database(config.appDatabasePath);
  try {
    raw.exec(
      "DROP INDEX IF EXISTS idx_model_test_calls_resource; DROP TABLE resource_secrets; ALTER TABLE model_test_calls DROP COLUMN config_fingerprint;",
    );
    raw.pragma("user_version = 2");
  } finally {
    raw.close();
  }

  const reopened = new AppStore(config.appDatabasePath);
  try {
    assert.equal(reopened.schemaVersion, 4);
    assert.equal(reopened.getResource(resourceId).name, "旧版服务");
    const tables = reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    assert.ok(tables.some((table) => table.name === "resource_secrets"));
    const columns = reopened.db
      .prepare("PRAGMA table_info(model_test_calls)")
      .all() as Array<{ name: string }>;
    assert.ok(
      columns.some((column) => column.name === "config_fingerprint"),
    );
  } finally {
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected file cleanup keeps the deleted record reported", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  const originalRemove = fs.rmSync;
  const patched = fs as unknown as { rmSync: typeof fs.rmSync };
  try {
    app = await startApp(root);
    const roleId = await createRole(app.baseUrl);
    const reference = await uploadReference(
      `${app.baseUrl}/v1/roles/${roleId}`,
      "待清理.wav",
    );
    patched.rmSync = ((target: unknown, options?: unknown) => {
      if (String(target).includes(`${path.sep}voice${path.sep}`)) {
        throw Object.assign(new Error("EPERM: operation not permitted"), {
          code: "EPERM",
        });
      }
      return originalRemove.call(fs, target as never, options as never);
    }) as typeof fs.rmSync;

    const deleted = await api(
      app.baseUrl,
      "DELETE",
      `/v1/roles/${roleId}/voice/references/${reference.assetId}`,
    );
    patched.rmSync = originalRemove;
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.fileRemoved, false);

    const listed = await api(
      app.baseUrl,
      "GET",
      `/v1/roles/${roleId}/voice/references`,
    );
    assert.deepEqual(listed.body.items, []);
    assert.ok(
      fs.existsSync(
        path.join(root, "data", "roles", roleId, reference.relativePath),
      ),
      "清理失败时保留文件以便重试",
    );
  } finally {
    patched.rmSync = originalRemove;
    await app?.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stored key is rejected when the model service moves to another origin", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  const app = await startApp(root);
  try {
    const created = app.app.services.resources.create({
      kind: "model",
      name: "主服务",
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9101" },
      secret: "sk-first",
    });
    const resourceId = created.resourceId;

    const sameOrigin = app.app.services.resources.update(resourceId, {
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9101/v2" },
    });
    assert.equal(
      credentialOf(sameOrigin as unknown as Record<string, unknown>).status,
      "stored",
      "同站点换路径仍算同一个服务，允许保留密钥",
    );

    await rejectsWithCode(
      async () =>
        app.app.services.resources.update(resourceId, {
          config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9102" },
        }),
      "RESOURCE_CREDENTIAL_STALE",
    );

    await rejectsWithCode(
      async () =>
        app.app.services.resources.update(resourceId, {
          config: {
            protocol: "anthropic-messages",
            baseUrl: "http://127.0.0.1:9101",
          },
        }),
      "RESOURCE_CREDENTIAL_STALE",
    );

    const replaced = app.app.services.resources.update(resourceId, {
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9102" },
      secret: "sk-second",
    });
    assert.equal(
      credentialOf(replaced as unknown as Record<string, unknown>).status,
      "stored",
      "同时给出新密钥时允许换站点",
    );

    const cleared = app.app.services.resources.update(resourceId, {
      secret: null,
    });
    assert.equal(
      credentialOf(cleared as unknown as Record<string, unknown>).status,
      "missing",
      "显式清除后不再持有旧密钥",
    );

    const moved = app.app.services.resources.update(resourceId, {
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9103" },
    });
    assert.equal(
      credentialOf(moved as unknown as Record<string, unknown>).status,
      "missing",
    );

    const viaHttp = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      { config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9101" } },
    );
    assert.equal(viaHttp.status, 200, "没有密钥时换站点不需要重新确认");

    await api(app.baseUrl, "PATCH", `/v1/resources/${resourceId}`, {
      secret: "sk-third",
    });
    const blocked = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      { config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9104" } },
    );
    assert.equal(blocked.status, 400);
    assert.equal(errorCode(blocked.body), "RESOURCE_CREDENTIAL_STALE");
  } finally {
    await app.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reused credential reference is rejected when the service moves to another origin", { timeout: 30_000 }, async () => {
  const root = tempRoot();
  const app = await startApp(root);
  try {
    const created = app.app.services.resources.create({
      kind: "model",
      name: "引用服务",
      config: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:9201",
        credentialRef: "env:NOWADAYS_TEST_KEY",
      },
    });
    const resourceId = created.resourceId;

    const sameOrigin = app.app.services.resources.update(resourceId, {
      config: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:9201/v2",
        credentialRef: "env:NOWADAYS_TEST_KEY",
      },
    });
    assert.equal(
      credentialOf(sameOrigin as unknown as Record<string, unknown>).status,
      "reference",
      "同站点换路径仍可沿用原引用",
    );

    await rejectsWithCode(
      async () =>
        app.app.services.resources.update(resourceId, {
          config: {
            protocol: "openai-chat",
            baseUrl: "http://127.0.0.1:9202",
            credentialRef: "env:NOWADAYS_TEST_KEY",
          },
        }),
      "RESOURCE_CREDENTIAL_STALE",
    );

    const switchedReference = app.app.services.resources.update(resourceId, {
      config: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:9202",
        credentialRef: "file:/tmp/nowadays-other.key",
      },
    });
    assert.equal(
      credentialOf(switchedReference as unknown as Record<string, unknown>).reference,
      "file:/tmp/nowadays-other.key",
      "换站点的同时换引用应放行",
    );

    // 清除直填密钥不等于重新确认引用。
    await rejectsWithCode(
      async () =>
        app.app.services.resources.update(resourceId, {
          config: {
            protocol: "openai-chat",
            baseUrl: "http://127.0.0.1:9203",
            credentialRef: "file:/tmp/nowadays-other.key",
          },
          secret: null,
        }),
      "RESOURCE_CREDENTIAL_STALE",
    );

    const moved = app.app.services.resources.update(resourceId, {
      config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:9203" },
    });
    assert.equal(
      credentialOf(moved as unknown as Record<string, unknown>).status,
      "missing",
      "移除引用后换站点不需要确认",
    );

    const viaHttp = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      {
        config: {
          protocol: "openai-chat",
          baseUrl: "http://127.0.0.1:9204",
          credentialRef: "env:NOWADAYS_HTTP_KEY",
        },
      },
    );
    assert.equal(viaHttp.status, 200, "通过 HTTP 换引用同样放行");

    const blocked = await api(
      app.baseUrl,
      "PATCH",
      `/v1/resources/${resourceId}`,
      {
        config: {
          protocol: "openai-chat",
          baseUrl: "http://127.0.0.1:9205",
          credentialRef: "env:NOWADAYS_HTTP_KEY",
        },
      },
    );
    assert.equal(blocked.status, 400);
    assert.equal(errorCode(blocked.body), "RESOURCE_CREDENTIAL_STALE");
  } finally {
    await app.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
