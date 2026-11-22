import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBackendApp, listen, type BackendAppOptions } from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import { XIA_CHENG_BUILTIN_KEY } from "../../src/application/role/preset-assistant.js";
import type { ModelEvent, ModelRequest } from "../../src/domain/model.js";
import { RoleActivityStore } from "../../src/storage/role/role-activity-store.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";
import { createLegacyRole } from "../fixtures/legacy-role-fixture.js";
import { deferred } from "../fixtures/conversation-fixture.js";

const definition = { displayName: "阿临", definition: { text: "你叫阿临，喜欢安静地读书。" } };

function installation(t: TestContext, options: BackendAppOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-first-activation-"));
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const open = () => createBackendApp(config, { disableMemoryRuntime: true, ...options });
  let app = open();
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    root,
    get app() { return app; },
    async reboot() {
      await app.close();
      app = open();
      return app;
    },
    bind(roleId: string, baseUrl = "http://offline.invalid/v1", credentialRef?: string) {
      const model = app.services.resources.create({
        kind: "model",
        name: "离线对话",
        config: { protocol: "openai-chat", baseUrl, ...(credentialRef ? { credentialRef } : {}) },
      });
      app.services.resources.replaceBindings(roleId, [{
        capability: "chat_model", resourceId: model.resourceId, modelName: "offline", enabled: true,
      }]);
    },
    pending(roleId: string) {
      const storage = RoleStorage.openExisting(rolePaths(config.dataRoot, roleId));
      try {
        return storage.business.db.prepare("SELECT first_activation_pending AS pending FROM roles WHERE role_id = ?")
          .pluck().get(roleId);
      } finally {
        storage.close();
      }
    },
  };
}

function recordingModel() {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield { type: "text_delta", text: "我先读一会儿书。" };
      yield { type: "completed", stopReason: "stop" };
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "DL-161 等待运行时超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("新建角色开始活动一次；真实预置也先等显式启用，重启和启停不会重发", async (t) => {
  const model = recordingModel();
  const env = installation(t, { modelPortFactory: () => model });
  const role = env.app.services.roles.createRole(definition);
  const builtin = env.app.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY)!;
  env.bind(role.roleId);
  env.bind(builtin.roleId);
  assert.equal(env.pending(role.roleId), 1);
  assert.equal(env.pending(builtin.roleId), 1);
  assert.deepEqual(env.app.services.autonomy.listWakes(role.roleId), []);
  const port = await listen(env.app.server, 0, "127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${port}/v1/roles/${role.roleId}/activity/resume`, { method: "POST" });
  assert.equal(response.status, 200);
  await until(() => env.app.services.autonomy.listWakes(role.roleId)[0]?.status === "completed");
  const [wake] = env.app.services.autonomy.listWakes(role.roleId);
  assert.equal(wake?.wakeId, `first-activation:${role.roleId}`);
  assert.match(JSON.stringify(model.requests[0]), /第一次开始活动/);
  assert.match(JSON.stringify(model.requests[0]), /你叫阿临，喜欢安静地读书/);
  assert.equal(env.pending(role.roleId), 0);
  assert.equal(env.app.services.autonomy.getBudget(role.roleId).usedPoints, 1);
  assert.deepEqual(env.app.services.messages.list(role.roleId, role.defaultWindowId, null, 100).items, []);
  assert.deepEqual(env.app.services.autonomy.listWakes(builtin.roleId), []);
  await env.reboot();
  env.app.services.activity.requestStop(role.roleId);
  env.app.services.activity.resume(role.roleId);
  env.app.conversation.wakePendingWork(role.roleId);
  assert.deepEqual(env.app.services.autonomy.listWakes(role.roleId).map((item) => item.wakeId), [wake?.wakeId]);
  assert.equal(model.requests.length, 1);
  env.app.services.activity.resume(builtin.roleId);
  await until(() => env.app.services.autonomy.listWakes(builtin.roleId)[0]?.status === "completed");
  const builtinWake = env.app.services.autonomy.listWakes(builtin.roleId);
  assert.equal(builtinWake.length, 1);
  assert.match(model.requests[1]!.system, /第一次开始活动/);
});

test("先启用后绑定保留资格，已有用户消息优先", async (t) => {
  const model = recordingModel();
  const env = installation(t, { modelPortFactory: () => model });
  const app = env.app;
  const role = app.services.roles.createRole(definition);
  app.services.activity.resume(role.roleId);
  const sent = app.conversation.submitMessage(role.roleId, role.defaultWindowId, {
    content: "先回答我正在读什么。",
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
  assert.equal(sent.waitReason, "MODEL_MISSING");
  assert.equal(env.pending(role.roleId), 1);
  assert.equal(model.requests.length, 0);
  env.bind(role.roleId);
  await until(() => app.services.autonomy.listWakes(role.roleId)[0]?.status === "completed");
  assert.equal(model.requests.length, 2);
  assert.match(JSON.stringify(model.requests[0]), /先回答我正在读什么/);
  assert.match(JSON.stringify(model.requests[1]), /第一次开始活动/);
  assert.equal(app.services.messages.list(role.roleId, role.defaultWindowId, null, 100).items.length, 2);
});

test("真实 HTTP 凭据晚到且经历重启，补偿仍只发出一次模型请求", async (t) => {
  const requests: Array<{ authorization: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization });
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"继续等一会儿。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listen(server, 0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = installation(t);
  const role = env.app.services.roles.createRole(definition);
  env.bind(role.roleId, `http://127.0.0.1:${port}/v1`, "file:late-model-key.txt");
  // 模拟全局活动事务写完即退出，调度回调和角色库唤醒尚未运行。
  new RoleActivityStore(env.app.appStore.db).activate(role.roleId, new Date().toISOString());
  await env.reboot();
  assert.equal(env.pending(role.roleId), 1);
  assert.deepEqual(env.app.services.autonomy.listWakes(role.roleId), []);
  assert.deepEqual(requests, []);
  fs.writeFileSync(path.join(env.root, "late-model-key.txt"), "offline-late-key\n");
  await until(() => env.app.services.autonomy.listWakes(role.roleId)[0]?.status === "completed");
  assert.deepEqual(requests, [{ authorization: "Bearer offline-late-key" }]);
  await env.reboot();
  assert.equal(env.app.services.autonomy.listWakes(role.roleId).length, 1);
  assert.equal(requests.length, 1);
});

test("真实 V22 角色升级后不获得首次唤醒，尚未建业务身份的初始化重试仍获得资格", async (t) => {
  const model = recordingModel();
  const env = installation(t, { modelPortFactory: () => model });
  const app = env.app;
  const previous = createLegacyRole(app, definition);
  const retriedId = randomUUID();
  app.appStore.createRoleIndex({
    roleId: retriedId, relativeDir: `roles/${retriedId}`,
    initPayload: { displayName: definition.displayName, definition: { ...definition.definition, payload: {} }, state: {} },
  });
  app.services.roles.initializeRole(retriedId);
  assert.equal(env.pending(previous.roleId), 0);
  assert.equal(env.pending(retriedId), 1);
  env.bind(previous.roleId);
  env.bind(retriedId);
  app.services.activity.resume(previous.roleId);
  app.services.activity.resume(retriedId);
  await until(() => app.services.autonomy.listWakes(retriedId)[0]?.status === "completed");
  assert.deepEqual(app.services.autonomy.listWakes(previous.roleId), []);
  assert.equal(model.requests.length, 1);
});

test("用户发送消息抢占已派发的首次思考", async (t) => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const requests: ModelRequest[] = [];
  const env = installation(t, { modelPortFactory: () => ({
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      if (requests.length === 1) {
        const signal = request.signal!;
        const interrupted = new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        started.resolve();
        await interrupted;
        aborted.resolve();
        return;
      }
      yield { type: "text_delta", text: "我在。" };
      yield { type: "completed", stopReason: "stop" };
    },
  }) });
  const app = env.app;
  const role = app.services.roles.createRole(definition);
  env.bind(role.roleId);
  app.services.activity.resume(role.roleId);
  await started.promise;
  app.conversation.submitMessage(role.roleId, role.defaultWindowId, { content: "现在先听我说。", submissionId: randomUUID(), sourcePlatform: "nowadays" });
  await aborted.promise;
  await until(() => app.services.messages.list(role.roleId, role.defaultWindowId, null, 100).items.length === 2);
  assert.match(JSON.stringify(requests[1]), /现在先听我说/);
  assert.equal(app.services.autonomy.listWakes(role.roleId).length, 1);
});
