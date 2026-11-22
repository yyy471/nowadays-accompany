import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { listen } from "../../src/bootstrap/app.js";
import type { MemoryModelPort } from "../../src/domain/memory.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../../src/domain/model.js";
import {
  addBinding,
  createFixture,
  createFixtureWithModel,
  deferred,
  GatedChatModel,
  ScriptedChatModel,
  withStorage,
  type Fixture,
} from "../fixtures/conversation-fixture.js";

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function start(fixture: Fixture): Promise<string> {
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

async function api(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
  };
}

function errorCode(result: ApiResult): string {
  return (result.body.error as { code?: string } | undefined)?.code ?? "";
}

async function submit(
  base: string,
  roleId: string,
  windowId: string,
  input: { content: string; submissionId: string },
): Promise<ApiResult> {
  return api(
    base,
    "POST",
    `/v1/roles/${roleId}/windows/${windowId}/messages`,
    { content: input.content, submissionId: input.submissionId },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await delay(20);
  }
  throw new Error("WAIT_TIMEOUT");
}

function messageCounts(fixture: Fixture): { user: number; assistant: number } {
  return withStorage(fixture, (storage) => {
    const row = storage.business.db
      .prepare(
        `SELECT
           SUM(CASE WHEN sender = 'user' THEN 1 ELSE 0 END) AS user_count,
           SUM(CASE WHEN sender = 'assistant' THEN 1 ELSE 0 END) AS assistant_count
         FROM messages`,
      )
      .get() as { user_count: number | null; assistant_count: number | null };
    return {
      user: row.user_count ?? 0,
      assistant: row.assistant_count ?? 0,
    };
  });
}

function modelRequests(model: ModelPort): number {
  return (model as { requests?: ModelRequest[] }).requests?.length ?? 0;
}

/** 第一轮正常完成，第二轮停在模型调用，用于观察对话与记忆同时在途。 */
class FirstThenGatedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  readonly secondStarted = deferred<void>();
  readonly release = deferred<void>();
  private calls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "text_delta", text: "第一轮回复" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    yield { type: "text_delta", text: "第二轮" };
    this.secondStarted.resolve();
    await this.release.promise;
    yield { type: "text_delta", text: "回复" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("模型维护期间拒绝新增依赖与依赖角色恢复，操作结束后释放", { timeout: 60_000 }, async () => {
  const model = new GatedChatModel();
  const fixture = createFixtureWithModel(model);
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    const other = fixture.app.services.resources.create({
      kind: "model",
      name: "无关模型",
      config: { protocol: "openai-chat", baseUrl: "http://other.invalid/v1" },
    });
    const bindChat = (roleId: string, resourceId: string, modelName: string) =>
      fixture.app.services.resources.replaceBindings(roleId, [
        { capability: "chat_model", resourceId, modelName, enabled: true },
      ]);
    const unrelated = fixture.app.services.roles.createRole({
      displayName: "无关角色",
      definition: { text: "使用无关模型" },
    });
    bindChat(unrelated.roleId, other.resourceId, "other");
    const rebinding = fixture.app.services.roles.createRole({
      displayName: "待改绑角色",
      definition: { text: "准备改绑到目标模型" },
    });
    bindChat(rebinding.roleId, other.resourceId, "other");
    const dependent = fixture.app.services.roles.createRole({
      displayName: "依赖角色",
      definition: { text: "使用目标模型" },
    });
    bindChat(
      dependent.roleId,
      resource.resourceId,
      "offline-chat",
    );

    const running = await submit(base, fixture.roleId, fixture.windowId, {
      content: "先跑起来",
      submissionId: randomUUID(),
    });
    assert.equal(running.status, 201);
    await model.started.promise;

    const patch = api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${String(resource.config.baseUrl)}-v2`,
        },
      },
    );
    await waitUntil(() =>
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
    );

    // 无关角色可以继续：它不依赖维护中的服务。
    const unrelatedResume = await api(
      base,
      "POST",
      `/v1/roles/${unrelated.roleId}/activity/resume`,
    );
    assert.equal(unrelatedResume.status, 200);

    // 新增绑定到维护中的服务会被拒绝。
    const rebind = await api(
      base,
      "PUT",
      `/v1/roles/${rebinding.roleId}/bindings`,
      {
        bindings: [
          {
            capability: "chat_model",
            resourceId: resource.resourceId,
            modelName: "offline-chat",
          },
        ],
      },
    );
    assert.equal(rebind.status, 409);
    assert.equal(errorCode(rebind), "RESOURCE_MAINTENANCE");

    // 仍依赖维护服务的已停止角色不能先恢复再领取调用。
    const dependentResume = await api(
      base,
      "POST",
      `/v1/roles/${dependent.roleId}/activity/resume`,
    );
    assert.equal(dependentResume.status, 409);
    assert.equal(errorCode(dependentResume), "RESOURCE_MAINTENANCE");

    model.release.resolve();
    const changed = await patch;
    assert.equal(changed.status, 200);
    assert.deepEqual(
      (changed.body.maintenance as { pausedRoleIds: string[] }).pausedRoleIds,
      [fixture.roleId],
    );
    assert.equal(
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
      false,
    );

    // 维护结束后同一个角色可以恢复。
    const resumed = await api(
      base,
      "POST",
      `/v1/roles/${dependent.roleId}/activity/resume`,
    );
    assert.equal(resumed.status, 200);
  } finally {
    model.release.resolve();
    await fixture.close();
  }
});

test("重新启用模型后自动继续处理已接收消息", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "我回来了。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    const disabled = await api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      { enabled: false },
    );
    assert.equal(disabled.status, 200);

    const submitted = await submit(base, fixture.roleId, fixture.windowId, {
      content: "在吗？",
      submissionId: randomUUID(),
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.decisionScheduled, false);
    assert.equal(submitted.body.waitReason, "MODEL_MISSING");
    assert.equal(modelRequests(fixture.model), 0);

    const enabled = await api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      { enabled: true },
    );
    assert.equal(enabled.status, 200);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(modelRequests(fixture.model), 1, "恢复后应自动继续调度");
    assert.deepEqual(messageCounts(fixture), { user: 1, assistant: 1 });
  } finally {
    await fixture.close();
  }
});

test("窗口失败后可用原提交标识重试原消息", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    () => {
      throw new Error("MODEL_DOWN");
    },
    [
      { type: "text_delta", text: "这次成功了。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const base = await start(fixture);
    const submissionId = randomUUID();
    const first = await submit(base, fixture.roleId, fixture.windowId, {
      content: "重试这条",
      submissionId,
    });
    assert.equal(first.status, 201);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const failed = await submit(base, fixture.roleId, fixture.windowId, {
      content: "重试这条",
      submissionId,
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.duplicate, true);
    assert.equal(failed.body.decisionScheduled, true);
    assert.equal(failed.body.waitReason, null, "重试应解除窗口阻塞");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(modelRequests(fixture.model), 2);
    assert.deepEqual(messageCounts(fixture), { user: 1, assistant: 1 });
  } finally {
    await fixture.close();
  }
});

test("影响范围与运行时解析一致：停用资源不扩大范围，记忆回退计入实际目标", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const chat = fixture.app.services.resources.list("model")[0];
    assert.ok(chat);
    const memory = fixture.app.services.resources.create({
      kind: "model",
      name: "独立记忆模型",
      config: { protocol: "openai-chat", baseUrl: "http://memory.invalid/v1" },
    });
    fixture.app.services.resources.update(memory.resourceId, {
      enabled: false,
    });
    fixture.app.services.resources.replaceBindings(fixture.roleId, [
      {
        capability: "chat_model",
        resourceId: chat.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: memory.resourceId,
        modelName: "memory-model",
        enabled: true,
      },
    ]);

    // 独立记忆模型全局停用：运行时回退到对话模型，影响报告也必须计入对话目标。
    const chatImpact = fixture.app.services.resources.impact(chat.resourceId);
    const roleImpact = chatImpact.roles.find(
      (role) => role.roleId === fixture.roleId,
    );
    assert.deepEqual(roleImpact?.usages.sort(), ["chat", "memory"].sort());

    // 停用且无续用的资源不被列为依赖，也不触发角色暂停。
    const memoryImpact = fixture.app.services.resources.impact(
      memory.resourceId,
    );
    assert.equal(
      memoryImpact.roles.some((role) => role.roleId === fixture.roleId),
      false,
    );
    const plan = fixture.app.services.resources.maintenancePlan(
      memory.resourceId,
      {
        config: { protocol: "openai-chat", baseUrl: "http://memory-v2.invalid/v1" },
      },
    );
    assert.deepEqual(plan.pauseRoleIds, []);
  } finally {
    await fixture.close();
  }
});

test("跨站点沿用旧密钥在暂停角色之前被拒绝", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.create({
      kind: "model",
      name: "带密钥模型",
      config: { protocol: "openai-chat", baseUrl: "http://one.invalid/v1" },
      secret: "sk-test",
    });
    fixture.app.services.resources.replaceBindings(fixture.roleId, [
      {
        capability: "chat_model",
        resourceId: resource.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "active",
    );

    const rejected = await api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: { protocol: "openai-chat", baseUrl: "http://two.invalid/v1" },
      },
    );
    assert.equal(rejected.status, 400);
    assert.equal(errorCode(rejected), "RESOURCE_CREDENTIAL_STALE");
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "active",
      "可预判的校验不应先暂停角色",
    );
  } finally {
    await fixture.close();
  }
});

test("已开始的后台记忆调用计入维护等待，结算后才写入新地址", { timeout: 60_000 }, async () => {
  const chat = new ScriptedChatModel([
    [
      { type: "text_delta", text: "记下了。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  let memoryCalls = 0;
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryCalls += 1;
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(chat, {
    disableMemoryRuntime: false,
    memoryModelFactory: () => memoryModel,
  });
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "今天去了旧书店",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    void fixture.app.conversation.runMemoryPending(fixture.roleId);
    await memoryStarted.promise;

    const patch = api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${String(resource.config.baseUrl)}-v2`,
        },
      },
    );
    // 已发出的记忆调用未结算前，角色保持 stopping，写入不得完成。
    await waitUntil(
      () => fixture.app.services.activity.view(fixture.roleId).state === "stopping",
    );
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopping",
    );

    memoryRelease.resolve();
    const changed = await patch;
    assert.equal(changed.status, 200, "记忆调用结算后维护才写入");
    assert.deepEqual(
      (changed.body.maintenance as { pausedRoleIds: string[] }).pausedRoleIds,
      [fixture.roleId],
    );
    assert.equal(memoryCalls, 1);
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopped",
    );
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("多角色暂停超时时返回已经停止的角色名单", { timeout: 60_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "稍等，我先回想一下。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
      maintenancePauseTimeoutMs: 600,
    },
  );
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    const busy = fixture.app.services.roles.createRole({
      displayName: "记忆忙碌角色",
      definition: { text: "正在整理记忆" },
    });
    fixture.app.services.resources.replaceBindings(busy.roleId, [
      {
        capability: "chat_model",
        resourceId: resource.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: resource.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);
    fixture.app.services.activity.resume(busy.roleId);
    fixture.app.conversation.submitMessage(
      busy.roleId,
      fixture.app.services.roles.listWindows(busy.roleId)[0]!.windowId,
      {
        content: "整理一下今天的记忆",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(busy.roleId);
    void fixture.app.conversation.runMemoryPending(busy.roleId);
    await memoryStarted.promise;

    // 夹具角色先确认停止；忙碌角色一直等到暂停超时。
    const rejected = await api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${String(resource.config.baseUrl)}-v2`,
        },
      },
    );
    assert.equal(rejected.status, 409);
    assert.equal(errorCode(rejected), "ROLES_NOT_STOPPED");
    const details = rejected.body.error as {
      details?: {
        roles?: Array<{ roleId: string }>;
        maintenance?: { pausedRoleIds: string[] };
      };
    };
    assert.deepEqual(details.details?.maintenance?.pausedRoleIds, [
      fixture.roleId,
    ]);
    assert.ok(
      (details.details?.roles ?? []).some(
        (role) => role.roleId === busy.roleId,
      ),
    );
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopped",
    );

    // 已停止的角色可以在原处恢复。
    const resumed = await api(
      base,
      "POST",
      `/v1/roles/${fixture.roleId}/activity/resume`,
    );
    assert.equal(resumed.status, 200);
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("对话与后台记忆同时在途时等两者都到边界才确认停止", { timeout: 60_000 }, async () => {
  const chat = new FirstThenGatedModel();
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(chat, {
    disableMemoryRuntime: false,
    memoryModelFactory: () => memoryModel,
  });
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    // 第一轮完成并产生记忆证据，后台整理挂起。
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "第一轮",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    void fixture.app.conversation.runMemoryPending(fixture.roleId);
    await memoryStarted.promise;
    // 第二轮对话也进入模型调用并挂起。
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "第二轮",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await chat.secondStarted.promise;

    const originalUrl = String(resource.config.baseUrl);
    const patch = api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${originalUrl}-v2`,
        },
      },
    );
    await waitUntil(
      () => fixture.app.services.activity.view(fixture.roleId).state === "stopping",
    );

    // 先让对话到达保存边界：记忆仍在途时不得确认停止或写入。
    chat.release.resolve();
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopping",
      "后台记忆未结算前不能确认停止",
    );
    assert.equal(
      String(
        fixture.app.services.resources.get(resource.resourceId).config.baseUrl,
      ),
      originalUrl,
      "两个调用都到边界前不得写入新地址",
    );

    memoryRelease.resolve();
    const changed = await patch;
    assert.equal(changed.status, 200);
    assert.deepEqual(
      (changed.body.maintenance as { pausedRoleIds: string[] }).pausedRoleIds,
      [fixture.roleId],
    );
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopped",
    );
  } finally {
    chat.release.resolve();
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("用户先前发起停止的角色不进入本次维护暂停名单", { timeout: 60_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "记下了。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    },
  );
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "留一条记忆",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    void fixture.app.conversation.runMemoryPending(fixture.roleId);
    await memoryStarted.promise;

    // 用户先发起停止：角色进入 stopping，随后才开始模型维护。
    const stopped = fixture.app.services.activity.requestStop(fixture.roleId);
    assert.equal(stopped.confirmed, false);
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopping",
    );
    const patch = api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${String(resource.config.baseUrl)}-v2`,
        },
      },
    );
    memoryRelease.resolve();
    const changed = await patch;
    assert.equal(changed.status, 200);
    assert.deepEqual(
      (changed.body.maintenance as { pausedRoleIds: string[] }).pausedRoleIds,
      [],
      "用户先前停止的角色不属于本次维护暂停",
    );
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopped",
    );
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("已停止角色的在途记忆调用仍计入维护等待且不加入恢复名单", { timeout: 60_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "记下了。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    },
  );
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "留一条待整理的记忆",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );

    // 角色已停止后，通过现有记忆整理接口发起整理并挂起。
    const triggered = await api(
      base,
      "POST",
      `/v1/roles/${fixture.roleId}/memory/batches`,
    );
    assert.equal(triggered.status, 202);
    await memoryStarted.promise;
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopped",
    );
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).running,
      true,
      "在途记忆调用应反映为角色仍在运行",
    );

    const originalUrl = String(resource.config.baseUrl);
    const patch = api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${originalUrl}-v2`,
        },
      },
    );
    await waitUntil(() =>
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
    );
    await delay(300);
    assert.equal(
      String(
        fixture.app.services.resources.get(resource.resourceId).config.baseUrl,
      ),
      originalUrl,
      "已停止角色的在途调用未结算前不得写入",
    );

    memoryRelease.resolve();
    const changed = await patch;
    assert.equal(changed.status, 200);
    assert.deepEqual(
      (changed.body.maintenance as { pausedRoleIds: string[] }).pausedRoleIds,
      [],
      "已停止角色不加入本次维护的恢复名单",
    );
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopped",
    );
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("服务停用后维护仍等待目标服务的旧在途调用", { timeout: 60_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "记下了。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    },
  );
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "准备一条记忆",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    assert.equal(
      (await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status,
      202,
    );
    await memoryStarted.promise;

    // 先全局停用：影响范围不再包含该角色，但旧调用仍在目标服务上。
    assert.equal(
      (await api(base, "PATCH", `/v1/resources/${resource.resourceId}`, {
        enabled: false,
      })).status,
      200,
    );
    const originalUrl = String(resource.config.baseUrl);
    const patch = api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${originalUrl}-v2`,
        },
      },
    );
    await waitUntil(() =>
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
    );
    await delay(300);
    assert.equal(
      String(
        fixture.app.services.resources.get(resource.resourceId).config.baseUrl,
      ),
      originalUrl,
      "停用不影响旧在途调用的等待",
    );
    memoryRelease.resolve();
    const changed = await patch;
    assert.equal(changed.status, 200);
    assert.deepEqual(
      (changed.body.maintenance as { pausedRoleIds: string[] }).pausedRoleIds,
      [],
    );
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("角色改绑到其他服务后维护仍等待旧服务的在途调用", { timeout: 60_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "记下了。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    },
  );
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "准备另一条记忆",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    assert.equal(
      (await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status,
      202,
    );
    await memoryStarted.promise;

    const other = fixture.app.services.resources.create({
      kind: "model",
      name: "新的模型服务",
      config: { protocol: "openai-chat", baseUrl: "http://new.invalid/v1" },
    });
    fixture.app.services.resources.replaceBindings(fixture.roleId, [
      {
        capability: "chat_model",
        resourceId: other.resourceId,
        modelName: "new-model",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: other.resourceId,
        modelName: "new-model",
        enabled: true,
      },
    ]);
    assert.equal(
      fixture.app.services.resources.impact(resource.resourceId).roles.length,
      0,
      "改绑后当前影响范围不再包含该角色",
    );

    const originalUrl = String(resource.config.baseUrl);
    const patch = api(
      base,
      "PATCH",
      `/v1/resources/${resource.resourceId}`,
      {
        config: {
          ...resource.config,
          baseUrl: `${originalUrl}-v2`,
        },
      },
    );
    await waitUntil(() =>
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
    );
    await delay(300);
    assert.equal(
      String(
        fixture.app.services.resources.get(resource.resourceId).config.baseUrl,
      ),
      originalUrl,
      "改绑不影响旧在途调用的等待",
    );
    memoryRelease.resolve();
    const changed = await patch;
    assert.equal(changed.status, 200);
    assert.deepEqual(
      (changed.body.maintenance as { pausedRoleIds: string[] }).pausedRoleIds,
      [],
    );
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("旧服务仍有在途调用时删除被拒绝，结算后可删除且无关服务不受影响", { timeout: 60_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "记下了。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    },
  );
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "准备删除前的记忆",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    assert.equal(
      (await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status,
      202,
    );
    await memoryStarted.promise;

    const other = fixture.app.services.resources.create({
      kind: "model",
      name: "新服务",
      config: { protocol: "openai-chat", baseUrl: "http://new.invalid/v1" },
    });
    fixture.app.services.resources.replaceBindings(fixture.roleId, [
      {
        capability: "chat_model",
        resourceId: other.resourceId,
        modelName: "new-model",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: other.resourceId,
        modelName: "new-model",
        enabled: true,
      },
    ]);

    const report = fixture.app.services.resources.references(
      resource.resourceId,
    );
    assert.equal(report.canDelete, false);
    assert.ok(
      report.references.some(
        (item) =>
          item.reason === "INFLIGHT_CALL" &&
          item.roleId === fixture.roleId,
      ),
    );

    // 无关服务可以被删除。
    const unrelated = fixture.app.services.resources.create({
      kind: "model",
      name: "无关服务",
      config: { protocol: "openai-chat", baseUrl: "http://unrelated.invalid/v1" },
    });
    assert.equal(
      (await api(base, "DELETE", `/v1/resources/${unrelated.resourceId}`)).status,
      200,
    );

    const blocked = await api(
      base,
      "DELETE",
      `/v1/resources/${resource.resourceId}`,
    );
    assert.equal(blocked.status, 409);
    assert.equal(errorCode(blocked), "RESOURCE_IN_USE");
    assert.equal(
      (await api(base, "GET", `/v1/resources/${resource.resourceId}`)).status,
      200,
      "旧在途调用未结算时不得删除服务",
    );

    memoryRelease.resolve();
    await waitUntil(
      () => fixture.app.services.resources.references(resource.resourceId).canDelete,
    );
    const removed = await api(
      base,
      "DELETE",
      `/v1/resources/${resource.resourceId}`,
    );
    assert.equal(removed.status, 200);
    assert.equal(
      (await api(base, "GET", `/v1/resources/${resource.resourceId}`)).status,
      404,
    );
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("只有旧任务依赖维护服务时角色仍可恢复", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const oldResource = fixture.app.services.resources.list("model")[0];
    assert.ok(oldResource);
    const newResource = fixture.app.services.resources.create({
      kind: "model",
      name: "当前模型",
      config: { protocol: "openai-chat", baseUrl: "http://current.invalid/v1" },
    });
    // 一条只依赖旧服务的旧任务链。
    withStorage(fixture, (storage) => {
      const task = storage.business.createTask({
        roleId: fixture.roleId,
        goal: "旧任务",
        origin: "user",
      });
      storage.business.grantResourceContinuation({
        roleId: fixture.roleId,
        taskId: task.taskId,
        resourceId: oldResource.resourceId,
      });
    });
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    // 当前对话与记忆都改到新服务。
    fixture.app.services.resources.replaceBindings(fixture.roleId, [
      {
        capability: "chat_model",
        resourceId: newResource.resourceId,
        modelName: "current",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: newResource.resourceId,
        modelName: "current",
        enabled: true,
      },
    ]);

    fixture.app.services.resources.beginMaintenance(oldResource.resourceId);
    try {
      assert.equal(
        fixture.app.services.activity.resume(fixture.roleId).state,
        "active",
        "旧任务依赖不应阻止角色恢复使用新服务",
      );
    } finally {
      fixture.app.services.resources.endMaintenance(oldResource.resourceId);
    }
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "active",
    );
  } finally {
    await fixture.close();
  }
});

test("只剩搁置续行的已停止角色可以直接删除", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    // 模拟停止时留在队列里、不会再启动的任务续行。
    const internals = fixture.app.conversation as unknown as {
      pendingContinuations: Map<
        string,
        Array<{ taskId: string; windowId: string }>
      >;
    };
    internals.pendingContinuations.set(fixture.roleId, [
      { taskId: "parked-task", windowId: fixture.windowId },
    ]);
    // 至少保留一个角色：再放一个停止状态的空角色。
    fixture.app.services.roles.createRole({
      displayName: "留下的角色",
      definition: { text: "用于保留最后一个角色" },
    });
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );

    const started = Date.now();
    const removed = await api(
      base,
      "DELETE",
      `/v1/roles/${fixture.roleId}?keepHistory=1`,
    );
    assert.equal(removed.status, 200);
    assert.ok(
      Date.now() - started < 5_000,
      "搁置续行不应让删除等到超时",
    );
    assert.equal(
      fixture.app.services.roles.listRoles().some(
        (role) => role.roleId === fixture.roleId,
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("尚未领取的标注等待不阻塞删除", { timeout: 40_000 }, async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "风很轻。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const base = await start(fixture);
    const png = await sharp({
      create: {
        width: 40,
        height: 80,
        channels: 3,
        background: { r: 100, g: 120, b: 220 },
      },
    })
      .png()
      .toBuffer();
    const outfit = await fixture.app.services.appearance.importOutfit(
      fixture.roleId,
      {
        name: "标注用服饰",
        home: { fileName: "home.png", data: png },
        sprites: [{ fileName: "微笑.png", data: png }],
      },
    );
    const state = fixture.app.services.roles.getState(fixture.roleId);
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { ...state.state, outfitId: outfit.outfitId },
    });
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "今天风很轻",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const page = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      null,
      50,
    );
    const reply = page.items.filter((item) => item.sender === "assistant").at(-1);
    assert.ok(reply);
    const executionId = withStorage(
      fixture,
      (storage) =>
        (
          storage.business.db
            .prepare(
              "SELECT execution_id AS id FROM executions ORDER BY rowid DESC LIMIT 1",
            )
            .get() as { id: string | null }
        ).id,
    );
    assert.ok(executionId);
    // 让句段重新变成待标注，并在维护窗口内排队（不会发出模型调用）。
    withStorage(fixture, (storage) => {
      storage.business.db
        .prepare(
          "UPDATE message_segments SET annotated_at = NULL WHERE message_id = ?",
        )
        .run(reply.messageId);
    });
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    fixture.app.services.resources.beginMaintenance(resource.resourceId);
    try {
      fixture.app.conversation.queueSegmentAnnotation({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        messageId: reply.messageId,
        executionId,
      });
      await waitUntil(
        () => fixture.app.services.resources.inflightRoleIds(resource.resourceId).length === 0,
      );
      fixture.app.services.roles.createRole({
        displayName: "保留角色",
        definition: { text: "用于删除时至少保留一个角色" },
      });
      assert.equal(
        fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
        true,
      );

      const started = Date.now();
      const removed = await api(
        base,
        "DELETE",
        `/v1/roles/${fixture.roleId}?keepHistory=1`,
      );
      assert.equal(removed.status, 200);
      assert.ok(
        Date.now() - started < 5_000,
        "取消排队中的标注后删除不应等待超时",
      );
    } finally {
      fixture.app.services.resources.endMaintenance(resource.resourceId);
    }
  } finally {
    await fixture.close();
  }
});

test("停用的独立记忆绑定不阻止角色恢复", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const oldResource = fixture.app.services.resources.list("model")[0];
    assert.ok(oldResource);
    const current = fixture.app.services.resources.create({
      kind: "model",
      name: "当前模型",
      config: { protocol: "openai-chat", baseUrl: "http://current.invalid/v1" },
    });
    // 对话用当前服务；独立记忆绑定指向马上要维护的旧服务。
    fixture.app.services.resources.replaceBindings(fixture.roleId, [
      {
        capability: "chat_model",
        resourceId: current.resourceId,
        modelName: "current",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: oldResource.resourceId,
        modelName: "old",
        enabled: true,
      },
    ]);
    fixture.app.services.resources.update(oldResource.resourceId, {
      enabled: false,
    });
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );

    fixture.app.services.resources.beginMaintenance(oldResource.resourceId);
    try {
      assert.equal(
        fixture.app.services.activity.resume(fixture.roleId).state,
        "active",
        "停用的记忆绑定应回退到对话服务，不应阻止恢复",
      );
    } finally {
      fixture.app.services.resources.endMaintenance(oldResource.resourceId);
    }
  } finally {
    await fixture.close();
  }
});

test("在途记忆整理超过删除期限时保留角色并释放删除队列", { timeout: 40_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "记下了。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
      roleDeletionWaitMs: 500,
    },
  );
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    addBinding(fixture, "memory_model", resource.resourceId);
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "留一条正在整理的记忆",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    assert.equal(
      (await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status,
      202,
    );
    await memoryStarted.promise;

    const deletable = fixture.app.services.roles.createRole({
      displayName: "同时删除的角色",
      definition: { text: "另一个可删除角色" },
    });
    fixture.app.services.roles.createRole({
      displayName: "最终保留的角色",
      definition: { text: "至少保留一个角色" },
    });

    const first = api(
      base,
      "DELETE",
      `/v1/roles/${fixture.roleId}?keepHistory=1`,
    );
    const second = api(
      base,
      "DELETE",
      `/v1/roles/${deletable.roleId}?keepHistory=1`,
    );
    const exceeded = await first;
    assert.equal(exceeded.status, 409);
    assert.equal(errorCode(exceeded), "ROLE_BUSY");
    const queued = await second;
    assert.equal(queued.status, 200, "前一删除超时后另一角色可以继续删除");
    assert.equal(
      fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
      false,
    );
    assert.equal(
      fixture.app.services.activity.view(fixture.roleId).state,
      "stopped",
    );
    // 删除保护已释放，角色仍可继续使用整理入口。
    assert.equal(
      (await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status,
      202,
    );

    memoryRelease.resolve();
    let retried: ApiResult | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      retried = await api(
        base,
        "DELETE",
        `/v1/roles/${fixture.roleId}?keepHistory=1`,
      );
      if (retried.status === 200) break;
      await delay(100);
    }
    assert.equal(retried?.status, 200);
  } finally {
    memoryRelease.resolve();
    await fixture.close();
  }
});

test("删除超时后补发删除期间被拒绝的维护唤醒", { timeout: 40_000 }, async () => {
  let memoryCalls = 0;
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryCalls += 1;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "记下了。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
      roleDeletionWaitMs: 500,
    },
  );
  let claim: { admitted: boolean; release: () => void } | null = null;
  try {
    const base = await start(fixture);
    const chatResource = fixture.app.services.resources.list("model")[0];
    assert.ok(chatResource);
    const memoryResource = fixture.app.services.resources.create({
      kind: "model",
      name: "记忆服务",
      config: { protocol: "openai-chat", baseUrl: "http://memory.invalid/v1" },
    });
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "留一条待整理记忆",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    addBinding(fixture, "memory_model", memoryResource.resourceId);
    fixture.app.services.resources.beginMaintenance(memoryResource.resourceId);
    assert.equal(
      (await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status,
      202,
    );
    assert.equal(memoryCalls, 0, "维护中的触发只排队，不调用模型");

    fixture.app.services.roles.createRole({
      displayName: "保留角色",
      definition: { text: "至少保留一个角色" },
    });
    // 用一条已领取的调用让删除等到超时。
    claim = fixture.app.services.resources.claimModelCall(
      fixture.roleId,
      chatResource.resourceId,
    );
    assert.equal(claim.admitted, true);

    const deletion = api(
      base,
      "DELETE",
      `/v1/roles/${fixture.roleId}?keepHistory=1`,
    );
    await waitUntil(() =>
      fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
    );
    // 删除保护期间结束记忆服务维护：这次唤醒会被拒绝。
    fixture.app.services.resources.endMaintenance(memoryResource.resourceId);
    const failed = await deletion;
    assert.equal(failed.status, 409);
    assert.equal(errorCode(failed), "ROLE_BUSY");
    claim.release();
    claim = null;

    // 删除失败后补发唤醒，已接收的整理自动继续。
    await waitUntil(() => memoryCalls > 0);
    assert.equal(
      fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
      false,
    );
    assert.equal(
      fixture.app.services.roles.listRoles().some(
        (role) => role.roleId === fixture.roleId,
      ),
      true,
    );
  } finally {
    claim?.release();
    await fixture.close();
  }
});

test("删除期间确认结束的任务在删除失败后补发整理", { timeout: 40_000 }, async () => {
  let memoryCalls = 0;
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryCalls += 1;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
      roleDeletionWaitMs: 500,
    },
  );
  let claim: { admitted: boolean; release: () => void } | null = null;
  try {
    const base = await start(fixture);
    const chatResource = fixture.app.services.resources.list("model")[0];
    assert.ok(chatResource);
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    const taskId = withStorage(fixture, (storage) => {
      const task = storage.business.createTask({
        roleId: fixture.roleId,
        goal: "整理工具结果",
        origin: "user",
      });
      const execution = storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "user_message",
      });
      storage.business.linkExecutionTask({
        roleId: fixture.roleId,
        executionId: execution.executionId,
        taskId: task.taskId,
        relation: "initiates",
      });
      const call = storage.business.beginToolCall({
        roleId: fixture.roleId,
        taskId: task.taskId,
        executionId: execution.executionId,
        stepKey: "delete-task-end",
        toolName: "local_note_write",
        args: { path: "note.md" },
      });
      storage.business.saveToolResult({
        roleId: fixture.roleId,
        toolCallId: call.toolCall.toolCallId,
        status: "success",
        rawResponse: { saved: true },
      });
      return task.taskId;
    });
    fixture.app.services.roles.createRole({
      displayName: "保留角色",
      definition: { text: "至少保留一个角色" },
    });
    claim = fixture.app.services.resources.claimModelCall(
      fixture.roleId,
      chatResource.resourceId,
    );
    assert.equal(claim.admitted, true);

    const deletion = api(
      base,
      "DELETE",
      `/v1/roles/${fixture.roleId}?keepHistory=1`,
    );
    await waitUntil(() =>
      fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
    );
    const finished = await api(
      base,
      "POST",
      `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
      { status: "completed", endReason: "删除期间完成" },
    );
    assert.equal(finished.status, 200, "任务结束请求在删除期仍然成功");
    const failed = await deletion;
    assert.equal(failed.status, 409);
    claim.release();
    claim = null;

    await waitUntil(() => memoryCalls > 0);
    assert.equal(memoryCalls, 1, "任务结束的整理只执行一次");
    assert.equal(
      fixture.app.services.roles.listRoles().some(
        (role) => role.roleId === fixture.roleId,
      ),
      true,
    );
  } finally {
    claim?.release();
    await fixture.close();
  }
});

test("记忆服务晚于删除超时恢复时仍补发任务整理", { timeout: 40_000 }, async () => {
  let memoryCalls = 0;
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryCalls += 1;
      return {};
    },
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
      roleDeletionWaitMs: 500,
    },
  );
  let claim: { admitted: boolean; release: () => void } | null = null;
  let memoryMaintenance = false;
  try {
    const base = await start(fixture);
    const chatResource = fixture.app.services.resources.list("model")[0];
    assert.ok(chatResource);
    const memoryResource = fixture.app.services.resources.create({
      kind: "model",
      name: "记忆服务",
      config: { protocol: "openai-chat", baseUrl: "http://memory.invalid/v1" },
    });
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    addBinding(fixture, "memory_model", memoryResource.resourceId);
    const taskId = withStorage(fixture, (storage) => {
      const task = storage.business.createTask({
        roleId: fixture.roleId,
        goal: "稍后整理工具结果",
        origin: "user",
      });
      const execution = storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "user_message",
      });
      storage.business.linkExecutionTask({
        roleId: fixture.roleId,
        executionId: execution.executionId,
        taskId: task.taskId,
        relation: "initiates",
      });
      const call = storage.business.beginToolCall({
        roleId: fixture.roleId,
        taskId: task.taskId,
        executionId: execution.executionId,
        stepKey: "deferred-task-end",
        toolName: "local_note_write",
        args: { path: "note.md" },
      });
      storage.business.saveToolResult({
        roleId: fixture.roleId,
        toolCallId: call.toolCall.toolCallId,
        status: "success",
        rawResponse: { saved: true },
      });
      return task.taskId;
    });
    fixture.app.services.roles.createRole({
      displayName: "保留角色",
      definition: { text: "至少保留一个角色" },
    });
    // 记忆服务在删除期间及删除超时后仍处于维护。
    fixture.app.services.resources.beginMaintenance(memoryResource.resourceId);
    memoryMaintenance = true;
    claim = fixture.app.services.resources.claimModelCall(
      fixture.roleId,
      chatResource.resourceId,
    );
    assert.equal(claim.admitted, true);

    const deletion = api(
      base,
      "DELETE",
      `/v1/roles/${fixture.roleId}?keepHistory=1`,
    );
    await waitUntil(() =>
      fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
    );
    assert.equal(
      (
        await api(
          base,
          "POST",
          `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
          { status: "completed", endReason: "删除期间完成" },
        )
      ).status,
      200,
    );
    const failed = await deletion;
    assert.equal(failed.status, 409);
    claim.release();
    claim = null;
    assert.equal(memoryCalls, 0, "记忆服务仍在维护时不调用模型");

    // 删除失败后记忆服务才恢复：暂存的任务结束通知仍要形成一次整理。
    fixture.app.services.resources.endMaintenance(memoryResource.resourceId);
    memoryMaintenance = false;
    await waitUntil(() => memoryCalls > 0);
    assert.equal(memoryCalls, 1);
    assert.equal(
      fixture.app.services.roles.listRoles().some(
        (role) => role.roleId === fixture.roleId,
      ),
      true,
    );
  } finally {
    claim?.release();
    if (memoryMaintenance) {
      fixture.app.services.resources.endMaintenance(
        fixture.app.services.resources.list("model").at(-1)!.resourceId,
      );
    }
    await fixture.close();
  }
});
