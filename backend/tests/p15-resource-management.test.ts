import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { ScriptedMemoryModel } from "../src/model/offline-memory.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import {
  ScriptedChatModel,
  addBinding,
  createFixture,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

/**
 * 252 第二包定向用例：模型与扩展资源管理。
 * 覆盖配置闭环、删除引用检查、MCP／Skill 修改与全局关闭、绑定版本冲突、
 * 以及资源读视图的 MCP 环境变量脱敏。
 */

interface ApiResult {
  status: number;
  raw: string;
  body: Record<string, unknown>;
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
    raw,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
  };
}

function errorOf(result: ApiResult): {
  code: string;
  details: Record<string, unknown> | undefined;
} {
  const error = result.body.error as
    | { code: string; details?: Record<string, unknown> }
    | undefined;
  assert.ok(error, `响应不是结构化错误：${result.raw}`);
  return { code: error.code, details: error.details };
}

async function start(fixture: Fixture): Promise<string> {
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

function modelResource(fixture: Fixture): string {
  const resource = fixture.app.services.resources.list("model")[0];
  assert.ok(resource, "夹具应已创建一个模型服务");
  return resource.resourceId;
}

function chatBinding(fixture: Fixture, enabled = true): {
  capability: "chat_model";
  resourceId: string;
  modelName: string;
  enabled: boolean;
} {
  return {
    capability: "chat_model",
    resourceId: modelResource(fixture),
    modelName: "offline-chat",
    enabled,
  };
}

function stopRole(base: string, roleId: string): Promise<ApiResult> {
  return api(base, "POST", `/v1/roles/${roleId}/activity/stop`);
}

function putBindings(
  base: string,
  roleId: string,
  bindings: readonly unknown[],
): Promise<ApiResult> {
  return api(base, "PUT", `/v1/roles/${roleId}/bindings`, { bindings });
}

test("配置闭环：建角色、配服务、存绑定后可以对话", { timeout: 40_000 }, async () => {
  const model = new ScriptedChatModel([
    [
      { type: "text_delta", text: "配置完成" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createFixtureWithModel(model);
  try {
    const base = await start(fixture);
    const created = await api(base, "POST", "/v1/roles", {
      displayName: "新角色",
      definition: { text: "新角色设定" },
    });
    assert.equal(created.status, 201);
    const roleId = created.body.roleId as string;
    const windowId = created.body.defaultWindowId as string;
    assert.ok(roleId && windowId);

    // DL-148：配置写入前先由后端确认停止，保存后按需恢复活动。
    assert.equal((await stopRole(base, roleId)).status, 200);
    const bound = await putBindings(base, roleId, [
      chatBinding(fixture),
      {
        capability: "memory_model",
        resourceId: modelResource(fixture),
        modelName: "offline-chat",
      },
    ]);
    assert.equal(bound.status, 200);
    assert.equal(typeof bound.body.revision, "string");
    assert.equal((bound.body.items as unknown[]).length, 2);
    const resumed = await api(
      base,
      "POST",
      `/v1/roles/${roleId}/activity/resume`,
    );
    assert.equal(resumed.status, 200);
    assert.equal(
      (resumed.body.activity as { state: string }).state,
      "active",
    );

    const submitted = await api(
      base,
      "POST",
      `/v1/roles/${roleId}/windows/${windowId}/messages`,
      { content: "你好", submissionId: randomUUID() },
    );
    assert.equal(submitted.status, 201);
    await fixture.app.conversation.waitForIdle(roleId);

    const messages = await api(
      base,
      "GET",
      `/v1/roles/${roleId}/windows/${windowId}/messages`,
    );
    const items = messages.body.items as Array<{
      sender: string;
      content: string;
    }>;
    assert.ok(
      items.some(
        (item) =>
          item.sender === "assistant" && item.content.includes("配置完成"),
      ),
      `配置闭环应收到回复：${JSON.stringify(items)}`,
    );
    assert.equal(model.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("独立记忆模型可单独绑定，未绑定时跟随对话模型", { timeout: 40_000 }, async () => {
  const captured: Array<{
    capability: string;
    resourceId: string;
    modelName: string;
  }> = [];
  const memoryModel = new ScriptedMemoryModel([
    { operations: [] },
    { operations: [] },
  ]);
  const chat = new ScriptedChatModel([
    [
      { type: "text_delta", text: "记下了" },
      { type: "completed", stopReason: "stop" },
    ],
    [
      { type: "text_delta", text: "又记下了" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createFixtureWithModel(chat, {
    disableMemoryRuntime: false,
    memoryModelFactory: (binding) => {
      captured.push({
        capability: binding.capability,
        resourceId: binding.resourceId,
        modelName: binding.modelName,
      });
      return memoryModel;
    },
  });
  try {
    const chatResourceId = modelResource(fixture);
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
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    // 只绑对话模型：记忆运行时跟随对话模型。一次待处理可能分多批执行，
    // 每批都要落在同一个模型上。
    assert.ok(captured.length > 0, "记忆运行时应该调用过模型");
    assert.deepEqual(
      new Set(captured.map((item) => `${item.capability}:${item.resourceId}`)),
      new Set([`chat_model:${chatResourceId}`]),
    );

    const memoryResource = fixture.app.services.resources.create({
      kind: "model",
      name: "记忆模型",
      config: {
        protocol: "openai-chat",
        baseUrl: "http://offline.invalid/v1",
      },
    });
    // 绑定属于角色配置写入，先由后端确认停止再改（DL-148）。
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    addBinding(fixture, "memory_model", memoryResource.resourceId);
    fixture.app.services.activity.resume(fixture.roleId);

    const before = captured.length;
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "又想起一件事",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    // 绑了独立记忆模型后改用它，不再借用对话模型。
    assert.ok(captured.length > before, "新增记忆模型后应再次运行记忆");
    assert.deepEqual(
      new Set(
        captured
          .slice(before)
          .map((item) => `${item.capability}:${item.resourceId}`),
      ),
      new Set([`memory_model:${memoryResource.resourceId}`]),
    );
  } finally {
    await fixture.close();
  }
});

test("删除资源前检查角色选择与未结束任务链", { timeout: 40_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = fixture.roleId;
    assert.equal((await stopRole(base, roleId)).status, 200);

    const created = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "本地工具",
      config: {
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "plain-secret" },
      },
    });
    assert.equal(created.status, 201);
    const mcpId = created.body.resourceId as string;
    assert.equal((await putBindings(base, roleId, [
      chatBinding(fixture),
      { capability: "mcp", resourceId: mcpId },
    ])).status, 200);

    const report = await api(
      base,
      "GET",
      `/v1/resources/${mcpId}/references`,
    );
    assert.equal(report.status, 200);
    assert.equal(report.body.canDelete, false);
    const references = report.body.references as Array<{
      roleId: string;
      capability: string | null;
      reason: string;
    }>;
    assert.ok(
      references.some(
        (item) =>
          item.roleId === roleId &&
          item.capability === "mcp" &&
          item.reason === "ROLE_BINDING",
      ),
      `引用报告应定位到角色：${JSON.stringify(references)}`,
    );

    const blocked = await api(base, "DELETE", `/v1/resources/${mcpId}`);
    assert.equal(blocked.status, 409);
    assert.equal(errorOf(blocked).code, "RESOURCE_IN_USE");
    assert.equal(errorOf(blocked).details?.action, "DELETE");

    // 解绑后才允许删除。
    assert.equal(
      (await putBindings(base, roleId, [chatBinding(fixture)])).status,
      200,
    );
    const removed = await api(base, "DELETE", `/v1/resources/${mcpId}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.resourceId, mcpId);
    assert.equal(
      (await api(base, "GET", `/v1/resources/${mcpId}`)).status,
      404,
    );
  } finally {
    await fixture.close();
  }
});

test("关闭的角色绑定不拦删除，删除后绑定一并清理", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = fixture.roleId;
    assert.equal((await stopRole(base, roleId)).status, 200);

    const created = await api(base, "POST", "/v1/resources", {
      kind: "skill",
      name: "旧技能",
      config: { sourcePath: fixture.root },
    });
    assert.equal(created.status, 201);
    const skillId = created.body.resourceId as string;
    assert.equal(
      (
        await putBindings(base, roleId, [
          chatBinding(fixture),
          { capability: "skill", resourceId: skillId, enabled: false },
        ])
      ).status,
      200,
    );

    // 236 §8：链结束后，关闭的绑定不再拦截删除。
    const report = await api(base, "GET", `/v1/resources/${skillId}/references`);
    assert.equal(report.status, 200);
    assert.equal(report.body.canDelete, true);
    const references = report.body.references as Array<{
      reason: string;
      bindingEnabled: boolean | null;
    }>;
    assert.deepEqual(references, [
      { roleId, capability: "skill", bindingEnabled: false, reason: "ROLE_BINDING" },
    ]);

    const removed = await api(base, "DELETE", `/v1/resources/${skillId}`);
    assert.equal(removed.status, 200);
    const bindings = await api(base, "GET", `/v1/roles/${roleId}/bindings`);
    assert.deepEqual(
      (bindings.body.items as Array<{ capability: string }>).map(
        (item) => item.capability,
      ),
      ["chat_model"],
    );
  } finally {
    await fixture.close();
  }
});

test("MCP 修改与全局关闭检查角色开关和未结束任务链", { timeout: 40_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = fixture.roleId;
    assert.equal((await stopRole(base, roleId)).status, 200);

    const created = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "工具",
      config: { command: "node", args: ["x.js"], env: {} },
    });
    assert.equal(created.status, 201);
    const mcpId = created.body.resourceId as string;
    assert.equal((await putBindings(base, roleId, [
      chatBinding(fixture),
      { capability: "mcp", resourceId: mcpId },
    ])).status, 200);

    const blockedUpdate = await api(base, "PATCH", `/v1/resources/${mcpId}`, {
      name: "改名",
    });
    assert.equal(blockedUpdate.status, 409);
    assert.equal(errorOf(blockedUpdate).code, "RESOURCE_IN_USE");
    assert.equal(errorOf(blockedUpdate).details?.action, "UPDATE");

    // 全局停用立即阻止新任务，原任务继续；启用中的绑定不拦停用（278 §3）。
    const disabledWhileEnabled = await api(base, "PATCH", `/v1/resources/${mcpId}`, {
      enabled: false,
    });
    assert.equal(disabledWhileEnabled.status, 200);
    assert.equal(disabledWhileEnabled.body.enabled, false);
    assert.ok(
      (await putBindings(base, roleId, [
        chatBinding(fixture),
        { capability: "mcp", resourceId: mcpId },
      ])).status === 200,
      "停用后角色绑定仍可保留",
    );

    // 关闭角色侧开关后，全局关闭可以执行。
    assert.equal((await putBindings(base, roleId, [
      chatBinding(fixture),
      { capability: "mcp", resourceId: mcpId, enabled: false },
    ])).status, 200);
    const disabled = await api(base, "PATCH", `/v1/resources/${mcpId}`, {
      enabled: false,
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);

    // 未结束任务链仍占用时，即使没有角色开关也拒绝修改。
    const other = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "另一工具",
      config: { command: "node", args: ["y.js"], env: {} },
    });
    assert.equal(other.status, 201);
    const otherId = other.body.resourceId as string;
    const taskId = withStorage(fixture, (storage) => {
      const task = storage.business.createTask({
        roleId,
        goal: "占用扩展资源",
        origin: "user",
      });
      storage.business.grantResourceContinuation({
        roleId,
        taskId: task.taskId,
        resourceId: otherId,
      });
      return task.taskId;
    });

    const chainBlocked = await api(base, "PATCH", `/v1/resources/${otherId}`, {
      name: "改另一工具",
    });
    assert.equal(chainBlocked.status, 409);
    const chainReferences = errorOf(chainBlocked).details?.references as Array<{
      reason: string;
      taskId?: string;
    }>;
    assert.ok(
      chainReferences.some(
        (item) => item.reason === "TASK_CHAIN" && item.taskId === taskId,
      ),
      `应返回占用任务链：${JSON.stringify(chainReferences)}`,
    );

    withStorage(fixture, (storage) =>
      storage.business.finishTask({
        roleId,
        taskId,
        status: "completed",
        endReason: "任务完成",
      }),
    );
    const allowed = await api(base, "PATCH", `/v1/resources/${otherId}`, {
      name: "改另一工具",
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.name, "改另一工具");
  } finally {
    await fixture.close();
  }
});

test("绑定整表替换支持版本冲突保护", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = fixture.roleId;
    assert.equal((await stopRole(base, roleId)).status, 200);

    const before = await api(base, "GET", `/v1/roles/${roleId}/bindings`);
    assert.equal(before.status, 200);
    const revision = before.body.revision as string;
    assert.ok(revision, "读取绑定应返回 revision");

    const stale = await api(base, "PUT", `/v1/roles/${roleId}/bindings`, {
      bindings: [chatBinding(fixture)],
      expectedRevision: "stale-revision",
    });
    assert.equal(stale.status, 409);
    assert.equal(errorOf(stale).code, "BINDING_REVISION_CONFLICT");
    assert.deepEqual(errorOf(stale).details, {
      roleId,
      expected: "stale-revision",
      actual: revision,
    });

    const saved = await api(base, "PUT", `/v1/roles/${roleId}/bindings`, {
      bindings: [chatBinding(fixture)],
      expectedRevision: revision,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, revision);
  } finally {
    await fixture.close();
  }
});

test("资源列表与详情脱敏 MCP 环境变量", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    assert.equal((await stopRole(base, fixture.roleId)).status, 200);

    const created = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "脱敏工具",
      config: {
        command: "node",
        args: ["s.js"],
        env: { TOKEN: "plain-secret", MODE: "debug" },
      },
    });
    assert.equal(created.status, 201);
    const resourceId = created.body.resourceId as string;
    assert.equal(created.raw.includes("plain-secret"), false);

    const detail = await api(base, "GET", `/v1/resources/${resourceId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.raw.includes("plain-secret"), false);
    assert.deepEqual(
      (detail.body.config as { env: Record<string, string> }).env,
      { TOKEN: "***", MODE: "***" },
    );
    assert.equal(detail.body.redacted, true);

    const listed = await api(base, "GET", "/v1/resources?kind=mcp");
    assert.equal(listed.status, 200);
    assert.equal(listed.raw.includes("plain-secret"), false);

    // 原样回传脱敏配置不应把真实值覆盖成占位符。
    const patched = await api(base, "PATCH", `/v1/resources/${resourceId}`, {
      name: "脱敏工具改名",
      config: {
        command: "node",
        args: ["s.js"],
        env: { TOKEN: "***", MODE: "***" },
      },
    });
    assert.equal(patched.status, 200);
    const raw = fixture.app.services.resources.get(resourceId);
    assert.deepEqual(
      (raw.config as { env: Record<string, string> }).env,
      { TOKEN: "plain-secret", MODE: "debug" },
    );
  } finally {
    await fixture.close();
  }
});

test("角色活动期间仍可维护未占用的扩展资源", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const roleId = fixture.roleId;
    const created = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "未绑定工具",
      config: { command: "node", args: ["unbound.js"], env: {} },
    });
    assert.equal(created.status, 201);
    const resourceId = created.body.resourceId as string;

    // 无关角色仍在活动：未绑定的扩展不受全角色停止条件限制（RP-R01）。
    const activity = await api(base, "GET", `/v1/roles/${roleId}/activity`);
    assert.equal(
      (activity.body.activity as { state: string }).state,
      "active",
    );
    const refs = await api(
      base,
      "GET",
      `/v1/resources/${resourceId}/references`,
    );
    assert.equal(refs.status, 200);
    assert.deepEqual(refs.body.references, []);
    assert.deepEqual(
      [refs.body.canUpdate, refs.body.canDisable, refs.body.canDelete],
      [true, true, true],
    );

    const renamed = await api(base, "PATCH", `/v1/resources/${resourceId}`, {
      name: "已改名",
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "已改名");
    const disabled = await api(base, "PATCH", `/v1/resources/${resourceId}`, {
      enabled: false,
    });
    assert.equal(disabled.status, 200);
    const removed = await api(base, "DELETE", `/v1/resources/${resourceId}`);
    assert.equal(removed.status, 200);

    // 目标资源被绑定后仍按占用规则拒绝，并返回占用原因。
    const bound = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "被绑定工具",
      config: { command: "node", args: ["bound.js"], env: {} },
    });
    assert.equal(bound.status, 201);
    const boundId = bound.body.resourceId as string;
    addBinding(fixture, "mcp", boundId);
    const blocked = await api(base, "PATCH", `/v1/resources/${boundId}`, {
      name: "不应改名",
    });
    assert.equal(blocked.status, 409);
    assert.equal(errorOf(blocked).code, "RESOURCE_IN_USE");
    const blockedDetails = errorOf(blocked).details as {
      action: string;
      references: Array<{ roleId: string; reason: string }>;
    };
    assert.equal(blockedDetails.action, "UPDATE");
    assert.ok(
      blockedDetails.references.some(
        (item) => item.roleId === roleId && item.reason === "ROLE_BINDING",
      ),
      `应返回占用原因：${JSON.stringify(blockedDetails.references)}`,
    );
    const blockedDelete = await api(
      base,
      "DELETE",
      `/v1/resources/${boundId}`,
    );
    assert.equal(blockedDelete.status, 409);
    assert.equal(errorOf(blockedDelete).code, "RESOURCE_IN_USE");
  } finally {
    await fixture.close();
  }
});

test("角色库不可读时引用检查失败并拒绝写入", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const created = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "被绑定工具",
      config: { command: "node", args: ["guard.js"], env: {} },
    });
    assert.equal(created.status, 201);
    const resourceId = created.body.resourceId as string;
    addBinding(fixture, "mcp", resourceId);

    const baseline = await api(
      base,
      "GET",
      `/v1/resources/${resourceId}/references`,
    );
    assert.equal(baseline.status, 200);
    assert.equal(baseline.body.canDisable, true, "全局停用不要求先关闭绑定");

    const db = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).businessDatabasePath;
    const backup = `${db}.review-backup`;
    fs.renameSync(db, backup);
    try {
      // 引用扫描无法完成时必须明确报错，不能把实际占用当成空（RP-R02）。
      const refs = await api(
        base,
        "GET",
        `/v1/resources/${resourceId}/references`,
      );
      assert.equal(refs.status, 500);
      assert.equal(errorOf(refs).code, "STORAGE_ERROR");
      // 修改名称属于配置写入，仍依赖引用扫描的完整性。
      const blocked = await api(base, "PATCH", `/v1/resources/${resourceId}`, {
        name: "不可读时改名",
      });
      assert.equal(blocked.status, 500);
      assert.equal(errorOf(blocked).code, "STORAGE_ERROR");
    } finally {
      fs.renameSync(backup, db);
    }

    const after = await api(base, "GET", `/v1/resources/${resourceId}`);
    assert.equal(after.body.enabled, true);
    const binding = fixture.app.services.resources
      .listBindings(fixture.roleId)
      .find((item) => item.resourceId === resourceId);
    assert.equal(binding?.enabled, true);
  } finally {
    await fixture.close();
  }
});

test("删除失败不会移除已处理的角色绑定", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const created = await api(base, "POST", "/v1/resources", {
      kind: "mcp",
      name: "关闭绑定工具",
      config: { command: "node", args: ["cleanup.js"], env: {} },
    });
    assert.equal(created.status, 201);
    const resourceId = created.body.resourceId as string;
    const second = fixture.app.services.roles.createRole({
      displayName: "第二位角色",
      definition: { text: "复核删除失败" },
    });
    const firstId = fixture.roleId;

    // 首个角色只有关闭的绑定；关闭的绑定不拦删除，但删除时要一并清理。
    const current = fixture.app.services.resources.listBindings(firstId);
    fixture.app.services.resources.replaceBindings(firstId, [
      ...current.map((item) => ({
        capability: item.capability,
        resourceId: item.resourceId,
        ...(item.modelName === null ? {} : { modelName: item.modelName }),
        enabled: item.enabled,
      })),
      { capability: "mcp", resourceId, enabled: false },
    ]);

    const secondDb = rolePaths(
      fixture.app.config.dataRoot,
      second.roleId,
    ).businessDatabasePath;
    const backup = `${secondDb}.review-backup`;
    fs.renameSync(secondDb, backup);
    try {
      const failed = await api(base, "DELETE", `/v1/resources/${resourceId}`);
      assert.equal(failed.status, 500);
      assert.equal(errorOf(failed).code, "STORAGE_ERROR");
      const resourceAfter = await api(
        base,
        "GET",
        `/v1/resources/${resourceId}`,
      );
      assert.equal(resourceAfter.status, 200);
      const kept = fixture.app.services.resources
        .listBindings(firstId)
        .some((item) => item.resourceId === resourceId);
      assert.equal(kept, true, "删除失败时已处理的角色绑定必须保留");
    } finally {
      fs.renameSync(backup, secondDb);
    }

    // 存储恢复后重试收敛：清理剩余绑定并删除资源。
    const removed = await api(base, "DELETE", `/v1/resources/${resourceId}`);
    assert.equal(removed.status, 200);
    const cleaned = fixture.app.services.resources
      .listBindings(firstId)
      .some((item) => item.resourceId === resourceId);
    assert.equal(cleaned, false);
  } finally {
    await fixture.close();
  }
});

for (const failAt of ["second-role-binding", "final-resource-delete"] as const) {
  test(`删除写入失败时回滚全部绑定（${failAt}）`, { timeout: 20_000 }, async () => {
    const fixture = createFixture([]);
    try {
      const base = await start(fixture);
      fixture.app.services.roles.createRole({
        displayName: "第二位角色",
        definition: { text: "删除回滚" },
      });
      const roleIds = fixture.app.appStore
        .listRoleIndexes()
        .map((index) => index.roleId);
      assert.equal(roleIds.length, 2);
      const created = await api(base, "POST", "/v1/resources", {
        kind: "mcp",
        name: "回滚工具",
        config: { command: "node", args: ["rollback.js"], env: {} },
      });
      assert.equal(created.status, 201);
      const resourceId = created.body.resourceId as string;
      for (const roleId of roleIds) {
        const prior = fixture.app.services.resources.listBindings(roleId);
        fixture.app.services.resources.replaceBindings(roleId, [
          ...prior.map((item) => ({
            capability: item.capability,
            resourceId: item.resourceId,
            ...(item.modelName === null ? {} : { modelName: item.modelName }),
            enabled: item.enabled,
          })),
          { capability: "mcp", resourceId, enabled: false },
        ]);
      }
      const route = `/v1/resources/${resourceId}`;
      const before = await api(base, "GET", `${route}/references`);
      assert.equal(before.status, 200);
      assert.equal(before.body.canDelete, true);

      // 分别让第二个角色库的绑定删除、全局库的资源删除在语句层失败。
      const secondStore =
        failAt === "second-role-binding"
          ? RoleStorage.openExisting(
              rolePaths(fixture.app.config.dataRoot, roleIds[1]!),
            )
          : null;
      const target = secondStore?.business.db ?? fixture.app.appStore.db;
      const table = secondStore ? "role_bindings" : "resources";
      try {
        target.exec(
          `CREATE TRIGGER review_abort_delete BEFORE DELETE ON ${table} ` +
            "BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
        );
        const failed = await api(base, "DELETE", route);
        assert.equal(failed.status, 500);
        assert.equal(errorOf(failed).code, "INTERNAL_ERROR");

        // 失败响应必须对应一致的可见状态：资源仍在、所有原绑定都保留。
        const after = await api(base, "GET", `${route}/references`);
        assert.equal(after.status, 200);
        const present = roleIds.map((roleId) =>
          (after.body.references as Array<{ roleId: string }>).some(
            (item) => item.roleId === roleId,
          ),
        );
        assert.deepEqual(present, [true, true], "失败时原绑定必须全部保留");
      } finally {
        target.exec("DROP TRIGGER IF EXISTS review_abort_delete");
        secondStore?.close();
      }

      // 移除故障注入后重试收敛：清理绑定并删除资源。
      const retried = await api(base, "DELETE", route);
      assert.equal(retried.status, 200);
      assert.equal((await api(base, "GET", route)).status, 404);
    } finally {
      await fixture.close();
    }
  });
}

async function bindMcpToTwoRoles(
  fixture: Fixture,
): Promise<{ base: string; resourceId: string; roleIds: string[] }> {
  const base = await start(fixture);
  fixture.app.services.roles.createRole({
    displayName: "第二位角色",
    definition: { text: "删除恢复" },
  });
  const roleIds = fixture.app.appStore
    .listRoleIndexes()
    .map((index) => index.roleId);
  assert.equal(roleIds.length, 2);
  const created = await api(base, "POST", "/v1/resources", {
    kind: "mcp",
    name: "删除恢复工具",
    config: { command: "node", args: ["recover.js"], env: {} },
  });
  assert.equal(created.status, 201);
  const resourceId = created.body.resourceId as string;
  for (const roleId of roleIds) {
    const prior = fixture.app.services.resources.listBindings(roleId);
    fixture.app.services.resources.replaceBindings(roleId, [
      ...prior.map((item) => ({
        capability: item.capability,
        resourceId: item.resourceId,
        ...(item.modelName === null ? {} : { modelName: item.modelName }),
        enabled: item.enabled,
      })),
      { capability: "mcp", resourceId, enabled: false },
    ]);
  }
  return { base, resourceId, roleIds };
}

test("删除决策提交失败时保留原配置", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const { base, resourceId, roleIds } = await bindMcpToTwoRoles(fixture);
    const route = `/v1/resources/${resourceId}`;
    const db = fixture.app.appStore.db;
    // 延迟外键：语句都成功，删除被引用的资源只在 COMMIT 时违反约束。
    db.exec(
      `CREATE TABLE review_deferred_fk (
         id INTEGER PRIMARY KEY,
         resource_id TEXT REFERENCES resources(resource_id)
           DEFERRABLE INITIALLY DEFERRED
       )`,
    );
    db.prepare(
      "INSERT INTO review_deferred_fk (id, resource_id) VALUES (1, ?)",
    ).run(resourceId);
    try {
      const failed = await api(base, "DELETE", route);
      assert.equal(failed.status, 500);
      assert.equal(errorOf(failed).code, "INTERNAL_ERROR");

      // 决策提交失败：资源、密钥与全部绑定都保持原样，也没有待清理记录。
      const refs = await api(base, "GET", `${route}/references`);
      assert.equal(refs.status, 200);
      assert.equal((refs.body.references as unknown[]).length, 2);
      assert.equal((await api(base, "GET", route)).status, 200);
      assert.deepEqual(fixture.app.appStore.listResourceDeletions(), []);
      for (const roleId of roleIds) {
        const bindings = await api(base, "GET", `/v1/roles/${roleId}/bindings`);
        assert.ok(
          (bindings.body.items as Array<{ resourceId: string }>).some(
            (item) => item.resourceId === resourceId,
          ),
          `提交失败后绑定应保留：${roleId}`,
        );
      }
    } finally {
      db.exec("DROP TABLE IF EXISTS review_deferred_fk");
    }

    const retried = await api(base, "DELETE", route);
    assert.equal(retried.status, 200);
    assert.equal((await api(base, "GET", route)).status, 404);
  } finally {
    await fixture.close();
  }
});

test("删除决策提交后中断，重启继续清理残留绑定", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  const config = fixture.app.config;
  try {
    const { resourceId, roleIds } = await bindMcpToTwoRoles(fixture);
    // 模拟第一笔提交（资源删除 + 待清理记录）成功后进程退出，绑定尚未清理。
    fixture.app.appStore.db.transaction(() => {
      fixture.app.appStore.recordResourceDeletion(
        resourceId,
        new Date().toISOString(),
      );
      fixture.app.appStore.deleteResource(resourceId);
    })();
    await fixture.app.close();

    const app = createBackendApp(config, {
      disableMemoryRuntime: true,
      modelPortFactory: () => fixture.model,
    });
    try {
      // 启动恢复完成清理：待清理记录与残留绑定都消失。
      assert.deepEqual(app.appStore.listResourceDeletions(), []);
      const raw = RoleStorage.openExisting(
        rolePaths(config.dataRoot, roleIds[0]!),
      );
      try {
        const remaining = raw.business
          .listRoleBindings(roleIds[0]!)
          .some((item) => item.resourceId === resourceId);
        assert.equal(remaining, false, "重启后残留绑定应被清理");
      } finally {
        raw.close();
      }
      const base = `http://127.0.0.1:${await listen(app.server, 0, "127.0.0.1")}`;
      assert.equal((await api(base, "GET", `/v1/resources/${resourceId}`)).status, 404);
    } finally {
      await app.close();
    }
  } finally {
    await fixture.close();
  }
});

test("待清理状态下列表过滤残留绑定并可重试清理", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const { base, resourceId, roleIds } = await bindMcpToTwoRoles(fixture);
    // 模拟决策已提交但角色库清理失败：资源已删、待清理记录存在、绑定残留。
    fixture.app.appStore.db.transaction(() => {
      fixture.app.appStore.recordResourceDeletion(
        resourceId,
        new Date().toISOString(),
      );
      fixture.app.appStore.deleteResource(resourceId);
    })();

    // 读侧按删除状态过滤，不把残留绑定暴露给页面。
    assert.equal(
      fixture.app.services.resources
        .listBindings(roleIds[0]!)
        .some((item) => item.resourceId === resourceId),
      false,
    );
    const listed = await api(base, "GET", `/v1/roles/${roleIds[0]}/bindings`);
    assert.equal(listed.status, 200);
    assert.equal(
      (listed.body.items as Array<{ resourceId: string }>).some(
        (item) => item.resourceId === resourceId,
      ),
      false,
    );

    // 重试清理：删除残留绑定并清除待清理记录。
    assert.equal(fixture.app.services.resources.reconcilePendingDeletions(), 1);
    assert.deepEqual(fixture.app.appStore.listResourceDeletions(), []);
    for (const roleId of roleIds) {
      const raw = RoleStorage.openExisting(
        rolePaths(fixture.app.config.dataRoot, roleId),
      );
      try {
        assert.equal(
          raw.business
            .listRoleBindings(roleId)
            .some((item) => item.resourceId === resourceId),
          false,
        );
      } finally {
        raw.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

function rawBindingPresent(
  fixture: Fixture,
  resourceId: string,
  roleId = fixture.roleId,
): boolean {
  const storage = RoleStorage.openExisting(
    rolePaths(fixture.app.config.dataRoot, roleId),
  );
  try {
    return storage.business
      .listRoleBindings(roleId)
      .some((item) => item.resourceId === resourceId);
  } finally {
    storage.close();
  }
}

/** 关闭的绑定不拦删除，用于验证删除后的清理路径。 */
function bindDisabled(fixture: Fixture, resourceId: string): void {
  const current = fixture.app.services.resources.listBindings(fixture.roleId);
  fixture.app.services.resources.replaceBindings(fixture.roleId, [
    ...current.map((item) => ({
      capability: item.capability,
      resourceId: item.resourceId,
      ...(item.modelName === null ? {} : { modelName: item.modelName }),
      enabled: item.enabled,
    })),
    { capability: "mcp", resourceId, enabled: false },
  ]);
}

test("清理记录写入失败不阻断已接受的删除", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  const config = fixture.app.config;
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.create({
      kind: "mcp",
      name: "收尾工具",
      config: { command: "node", args: ["tail.js"], env: {} },
    });
    bindDisabled(fixture, resource.resourceId);
    const route = `/v1/resources/${resource.resourceId}`;
    const db = fixture.app.appStore.db;
    db.exec(
      "CREATE TRIGGER review_fail_clear BEFORE DELETE ON resource_deletions " +
        "BEGIN SELECT RAISE(ABORT, 'injected cleanup marker failure'); END",
    );

    // 决策已提交：即使待清理记录没删掉，已接受的删除仍返回成功（RP-R06）。
    const response = await api(base, "DELETE", route);
    assert.equal(response.status, 200);
    assert.equal((await api(base, "GET", route)).status, 404);
    assert.equal(rawBindingPresent(fixture, resource.resourceId), false);
    assert.equal(
      fixture.app.appStore
        .listResourceDeletions()
        .includes(resource.resourceId),
      true,
    );
    await fixture.app.close();

    // 保留故障启动：单条清理失败不能阻断后端启动。
    const app = createBackendApp(config, {
      disableMemoryRuntime: true,
      modelPortFactory: () => fixture.model,
    });
    try {
      assert.deepEqual(app.appStore.listResourceDeletions(), [
        resource.resourceId,
      ]);
      const restartedBase = `http://127.0.0.1:${await listen(app.server, 0, "127.0.0.1")}`;
      app.appStore.db.exec("DROP TRIGGER review_fail_clear");

      // 故障移除后重试同一 DELETE，继续清理待清理记录。
      const retried = await api(restartedBase, "DELETE", route);
      assert.equal(retried.status, 200);
      assert.deepEqual(app.appStore.listResourceDeletions(), []);
    } finally {
      await app.close();
    }
  } finally {
    await fixture.close();
  }
});

test("重试同一 DELETE 继续清理残留绑定", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.create({
      kind: "mcp",
      name: "重试工具",
      config: { command: "node", args: ["retry.js"], env: {} },
    });
    bindDisabled(fixture, resource.resourceId);
    const route = `/v1/resources/${resource.resourceId}`;

    // 延迟外键让角色库的 COMMIT 失败：决策已提交，绑定清理未完成（RP-R07）。
    withStorage(fixture, (storage) => {
      const db = storage.business.db;
      db.exec(
        `CREATE TABLE review_follower_guard (
           role_id TEXT NOT NULL,
           capability TEXT NOT NULL,
           resource_id TEXT NOT NULL,
           FOREIGN KEY (role_id, capability, resource_id)
             REFERENCES role_bindings(role_id, capability, resource_id)
             DEFERRABLE INITIALLY DEFERRED
         )`,
      );
      db.prepare(
        "INSERT INTO review_follower_guard VALUES (?, 'mcp', ?)",
      ).run(fixture.roleId, resource.resourceId);
    });

    const first = await api(base, "DELETE", route);
    assert.equal(first.status, 200);
    assert.equal((await api(base, "GET", route)).status, 404);
    assert.equal(rawBindingPresent(fixture, resource.resourceId), true);
    assert.equal(
      fixture.app.appStore
        .listResourceDeletions()
        .includes(resource.resourceId),
      true,
    );
    const listed = await api(
      base,
      "GET",
      `/v1/roles/${fixture.roleId}/bindings`,
    );
    assert.equal(
      (listed.body.items as Array<{ resourceId: string }>).some(
        (item) => item.resourceId === resource.resourceId,
      ),
      false,
      "残留绑定不应出现在读取视图中",
    );

    withStorage(fixture, (storage) =>
      storage.business.db.exec("DROP TABLE review_follower_guard"),
    );
    const retried = await api(base, "DELETE", route);
    assert.equal(retried.status, 200);
    assert.equal(rawBindingPresent(fixture, resource.resourceId), false);
    assert.equal(
      fixture.app.appStore
        .listResourceDeletions()
        .includes(resource.resourceId),
      false,
    );
  } finally {
    await fixture.close();
  }
});
