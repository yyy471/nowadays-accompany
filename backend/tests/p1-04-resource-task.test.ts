import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { AppError } from "../src/domain/errors.js";
import { RoleStore } from "../src/storage/role-store.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p1-04-"));
}

async function start(root: string) {
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config);
  const port = await listen(app.server, 0, config.host);
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

async function request(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
}

function businessPath(appRoot: string, roleId: string): string {
  return path.join(appRoot, "data", "roles", roleId, "business.sqlite");
}

function expectCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof AppError && error.code === code;
}

test("resources and role bindings validate, replace and persist", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    let started = await start(root);
    app = started.app;
    let baseUrl = started.baseUrl;

    const role = await request(baseUrl, "POST", "/v1/roles", {
      displayName: "配置角色",
      definition: { text: "配置验证" },
    });
    assert.equal(role.status, 201);
    const roleId = role.body.roleId as string;

    const model = await request(baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "对话模型",
      config: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:9999/v1",
        credentialRef: "env:NOWADAYS_TEST_KEY",
      },
    });
    assert.equal(model.status, 201);
    const modelId = model.body.resourceId as string;
    assert.equal(model.body.enabled, true);
    assert.deepEqual(model.body.config, {
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:9999/v1",
      credentialRef: "env:NOWADAYS_TEST_KEY",
    });

    const mcp = await request(baseUrl, "POST", "/v1/resources", {
      kind: "mcp",
      name: "本地文件",
      enabled: false,
      config: { command: "node", args: ["server.js"], env: {} },
    });
    assert.equal(mcp.status, 201);
    const mcpId = mcp.body.resourceId as string;

    const skill = await request(baseUrl, "POST", "/v1/resources", {
      kind: "skill",
      name: "笔记",
      config: { sourcePath: "skills/notes" },
    });
    assert.equal(skill.status, 201);
    const skillId = skill.body.resourceId as string;

    const invalidConfig = await request(baseUrl, "POST", "/v1/resources", {
      kind: "model",
      name: "错误模型",
      config: { protocol: "unknown", baseUrl: "http://127.0.0.1:1" },
    });
    assert.equal(invalidConfig.status, 400);
    assert.equal(errorCode(invalidConfig.body), "INVALID_RESOURCE_CONFIG");

    const unknownKind = await request(baseUrl, "POST", "/v1/resources", {
      kind: "other",
      name: "错误类型",
      config: {},
    });
    assert.equal(unknownKind.status, 400);
    assert.equal(errorCode(unknownKind.body), "INVALID_REQUEST");

    const models = await request(baseUrl, "GET", "/v1/resources?kind=model");
    assert.equal(models.status, 200);
    assert.equal((models.body.items as unknown[]).length, 1);
    const badKind = await request(
      baseUrl,
      "GET",
      "/v1/resources?kind=unknown",
    );
    assert.equal(badKind.status, 400);
    assert.equal(errorCode(badKind.body), "INVALID_QUERY");

    const patched = await request(
      baseUrl,
      "PATCH",
      `/v1/resources/${modelId}`,
      { enabled: false, name: "停用模型" },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.enabled, false);
    assert.equal(patched.body.name, "停用模型");

    const bindings = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [
          { capability: "chat_model", resourceId: modelId, modelName: "chat-a" },
          { capability: "mcp", resourceId: mcpId, enabled: false },
          { capability: "skill", resourceId: skillId },
        ],
      },
    );
    assert.equal(bindings.status, 200);
    const bindingItems = bindings.body.items as Array<{
      capability: string;
      resourceId: string;
      modelName: string | null;
      enabled: boolean;
    }>;
    assert.equal(bindingItems.length, 3);
    assert.equal(
      bindingItems.filter((item) => item.capability === "memory_model").length,
      0,
    );
    const mcpBinding = bindingItems.find((item) => item.capability === "mcp");
    assert.equal(mcpBinding?.enabled, false);

    const duplicateChat = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [
          { capability: "chat_model", resourceId: modelId, modelName: " chat-a" },
          {
            capability: "chat_model",
            resourceId: modelId,
            modelName: "chat-a",
          },
        ],
      },
    );
    assert.equal(duplicateChat.status, 409);
    assert.equal(errorCode(duplicateChat.body), "BINDING_CONFLICT");

    const kindMismatch = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [{ capability: "skill", resourceId: modelId }],
      },
    );
    assert.equal(kindMismatch.status, 400);
    assert.equal(errorCode(kindMismatch.body), "RESOURCE_KIND_MISMATCH");

    const missingModelName = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [{ capability: "chat_model", resourceId: modelId }],
      },
    );
    assert.equal(missingModelName.status, 400);
    assert.equal(errorCode(missingModelName.body), "INVALID_BINDING");

    const nonModelName = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [
          { capability: "mcp", resourceId: mcpId, modelName: "not-allowed" },
        ],
      },
    );
    assert.equal(nonModelName.status, 400);
    assert.equal(errorCode(nonModelName.body), "INVALID_BINDING");

    const missingResource = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [
          { capability: "skill", resourceId: randomUUID() },
        ],
      },
    );
    assert.equal(missingResource.status, 404);
    assert.equal(errorCode(missingResource.body), "RESOURCE_NOT_FOUND");

    const replaced = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/bindings`,
      {
        bindings: [
          { capability: "chat_model", resourceId: modelId, modelName: "chat-a" },
        ],
      },
    );
    assert.equal(replaced.status, 200);
    assert.equal((replaced.body.items as unknown[]).length, 1);

    await app.close();
    app = undefined;
    started = await start(root);
    app = started.app;
    baseUrl = started.baseUrl;

    const reopenedModel = await request(
      baseUrl,
      "GET",
      `/v1/resources/${modelId}`,
    );
    assert.equal(reopenedModel.status, 200);
    assert.equal(reopenedModel.body.enabled, false);
    const reopenedBindings = await request(
      baseUrl,
      "GET",
      `/v1/roles/${roleId}/bindings`,
    );
    assert.equal(reopenedBindings.status, 200);
    const reopenedItems = reopenedBindings.body.items as Array<{
      capability: string;
      modelName: string;
    }>;
    assert.equal(reopenedItems.length, 1);
    assert.equal(reopenedItems[0]?.capability, "chat_model");
    assert.equal(reopenedItems[0]?.modelName, "chat-a");

    const missing = await request(
      baseUrl,
      "GET",
      `/v1/resources/${randomUUID()}`,
    );
    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing.body), "RESOURCE_NOT_FOUND");
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tasks, executions, tool calls and continuations persist with version semantics", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  let store: RoleStore | undefined;
  let otherStore: RoleStore | undefined;
  try {
    const started = await start(root);
    app = started.app;

    const role = await request(started.baseUrl, "POST", "/v1/roles", {
      displayName: "任务角色",
      definition: { text: "任务验证" },
    });
    const roleId = role.body.roleId as string;
    const otherRole = await request(started.baseUrl, "POST", "/v1/roles", {
      displayName: "其他角色",
      definition: { text: "隔离验证" },
    });
    const otherRoleId = otherRole.body.roleId as string;
    const roleBusinessPath = businessPath(root, roleId);

    store = new RoleStore(roleBusinessPath);
    otherStore = new RoleStore(businessPath(root, otherRoleId));

    store.replaceRoleBindings(roleId, [
      {
        capability: "mcp",
        resourceId: "resource-kept",
        modelName: null,
        enabled: true,
      },
    ]);
    const twoChatModels = [
      {
        capability: "chat_model" as const,
        resourceId: "resource-a",
        modelName: "model-a",
        enabled: true,
      },
      {
        capability: "chat_model" as const,
        resourceId: "resource-b",
        modelName: "model-b",
        enabled: true,
      },
    ];
    assert.throws(
      () => store?.replaceRoleBindings(roleId, twoChatModels),
      expectCode("BINDING_CONFLICT"),
    );
    store.db.exec("DROP INDEX idx_role_single_chat_model");
    assert.throws(
      () => store?.replaceRoleBindings(roleId, twoChatModels),
      expectCode("BINDING_CONFLICT"),
    );
    store.db.exec(
      "CREATE UNIQUE INDEX idx_role_single_chat_model ON role_bindings(role_id) WHERE capability = 'chat_model'",
    );
    const keptBindings = store.listRoleBindings(roleId);
    assert.equal(keptBindings.length, 1);
    assert.equal(keptBindings[0]?.capability, "mcp");
    assert.equal(keptBindings[0]?.resourceId, "resource-kept");

    const task = store.createTask({ roleId, goal: "完成一次验证" });
    assert.equal(task.status, "active");
    assert.equal(task.endReason, null);

    const execution1 = store.createExecution({
      roleId,
      triggerType: "user_message",
      stateVersionLoaded: 1,
    });
    assert.equal(execution1.status, "running");
    assert.equal(execution1.stateVersionCommitted, null);
    store.linkExecutionTask({
      roleId,
      executionId: execution1.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    assert.throws(
      () =>
        store?.linkExecutionTask({
          roleId,
          executionId: execution1.executionId,
          taskId: task.taskId,
          relation: "continues",
        }),
      expectCode("EXECUTION_TASK_CONFLICT"),
    );

    const begun = store.beginToolCall({
      roleId,
      taskId: task.taskId,
      executionId: execution1.executionId,
      stepKey: "step-1",
      toolName: "read_file",
      args: { b: 2, a: 1 },
    });
    assert.equal(begun.duplicate, false);
    assert.equal(begun.toolCall.status, "pending");
    assert.equal(begun.toolCall.mode, "foreground");
    const toolCallId = begun.toolCall.toolCallId;

    const duplicate = store.beginToolCall({
      roleId,
      taskId: task.taskId,
      executionId: execution1.executionId,
      stepKey: "step-1",
      toolName: "read_file",
      args: { a: 1, b: 2 },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.toolCall.toolCallId, toolCallId);

    assert.throws(
      () =>
        store?.beginToolCall({
          roleId,
          taskId: task.taskId,
          executionId: execution1.executionId,
          stepKey: "step-1",
          toolName: "read_file",
          args: { a: 9 },
        }),
      expectCode("TOOL_CALL_CONFLICT"),
    );

    const taskB = store.createTask({ roleId, goal: "同一执行的其他任务" });
    store.linkExecutionTask({
      roleId,
      executionId: execution1.executionId,
      taskId: taskB.taskId,
      relation: "references",
    });
    assert.throws(
      () =>
        store?.beginToolCall({
          roleId,
          taskId: taskB.taskId,
          executionId: execution1.executionId,
          stepKey: "step-1",
          toolName: "read_file",
          args: { a: 1, b: 2 },
        }),
      expectCode("TOOL_CALL_CONFLICT"),
    );
    assert.equal(store.getToolCall(roleId, toolCallId).taskId, task.taskId);
    assert.equal(
      store.listToolCallModeEvents(roleId, toolCallId).length,
      1,
    );

    const running = store.markToolCallRunning(roleId, toolCallId);
    assert.equal(running.status, "running");
    assert.ok(running.startedAt);
    assert.throws(
      () =>
        store?.saveToolResult({
          roleId,
          toolCallId,
          status: "success",
        }),
      expectCode("TOOL_RESULT_EVIDENCE_REQUIRED"),
    );

    store.switchToolCallMode({
      roleId,
      toolCallId,
      mode: "background",
    });
    assert.equal(store.getToolCall(roleId, toolCallId).mode, "background");
    store.switchToolCallMode({ roleId, toolCallId, mode: "background" });
    assert.equal(
      store.listToolCallModeEvents(roleId, toolCallId).length,
      2,
    );

    const saved = store.saveToolResult({
      roleId,
      toolCallId,
      status: "success",
      rawResponse: { ok: true },
      adaptedResult: { text: "完成" },
      diagnosticCode: null,
    });
    assert.equal(saved.duplicate, false);
    assert.deepEqual(saved.result.adaptedResult, { text: "完成" });
    const finishedCall = store.getToolCall(roleId, toolCallId);
    assert.equal(finishedCall.status, "success");
    assert.ok(finishedCall.finishedAt);

    const duplicateResult = store.saveToolResult({
      roleId,
      toolCallId,
      status: "success",
      rawResponse: { ok: true },
      adaptedResult: { text: "完成" },
      diagnosticCode: null,
    });
    assert.equal(duplicateResult.duplicate, true);
    assert.throws(
      () =>
        store?.saveToolResult({
          roleId,
          toolCallId,
          status: "failed",
          error: { message: "不同结果" },
        }),
      expectCode("TOOL_RESULT_CONFLICT"),
    );

    const failedCall = store.beginToolCall({
      roleId,
      taskId: task.taskId,
      executionId: execution1.executionId,
      stepKey: "step-2",
      toolName: "run_script",
      args: {},
    });
    store.markToolCallRunning(roleId, failedCall.toolCall.toolCallId);
    assert.equal(
      store.finishToolCall(roleId, failedCall.toolCall.toolCallId, "failed")
        .status,
      "failed",
    );

    const unknownCall = store.beginToolCall({
      roleId,
      taskId: task.taskId,
      executionId: execution1.executionId,
      stepKey: "step-3",
      toolName: "remote_call",
      args: {},
    });
    const unknownResult = store.saveToolResult({
      roleId,
      toolCallId: unknownCall.toolCall.toolCallId,
      status: "unknown",
      rawResponse: { partial: true },
      adaptedResult: { text: "未知结果" },
      diagnosticCode: "CONNECTION_LOST",
    });
    assert.equal(unknownResult.result.diagnosticCode, "CONNECTION_LOST");
    assert.equal(
      store.getToolCall(roleId, unknownCall.toolCall.toolCallId).status,
      "unknown",
    );

    assert.equal(store.getTask(roleId, task.taskId).status, "active");

    const execution2 = store.createExecution({
      roleId,
      triggerType: "recovery",
      stateVersionLoaded: 1,
    });
    store.linkExecutionTask({
      roleId,
      executionId: execution2.executionId,
      taskId: task.taskId,
      relation: "continues",
    });
    assert.equal(
      store.listExecutionTasks(roleId, execution1.executionId).length,
      2,
    );
    assert.equal(
      store.listExecutionTasks(roleId, execution2.executionId)[0]?.relation,
      "continues",
    );

    const committed = store.commitExecution({
      roleId,
      executionId: execution1.executionId,
      stateVersionCommitted: 1,
    });
    assert.equal(committed.stateVersionCommitted, 1);
    assert.equal(committed.status, "completed");

    const stateUpdate = await request(
      started.baseUrl,
      "PUT",
      `/v1/roles/${roleId}/state`,
      { state: { mood: "changed" }, expectedVersion: 1 },
    );
    assert.equal(stateUpdate.status, 200);
    assert.equal(stateUpdate.body.stateVersion, 2);
    const executionAfterState = store.getExecution(
      roleId,
      execution1.executionId,
    );
    assert.equal(executionAfterState.stateVersionLoaded, 1);
    assert.equal(executionAfterState.stateVersionCommitted, 1);

    store.commitExecution({
      roleId,
      executionId: execution1.executionId,
      stateVersionCommitted: 1,
    });
    assert.throws(
      () =>
        store?.commitExecution({
          roleId,
          executionId: execution1.executionId,
          stateVersionCommitted: 2,
        }),
      expectCode("EXECUTION_ALREADY_COMMITTED"),
    );

    const finishedTask = store.finishTask({
      roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "验证完成",
    });
    assert.equal(finishedTask.status, "completed");
    assert.equal(finishedTask.endReason, "验证完成");
    const repeatedFinish = store.finishTask({
      roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "验证完成",
    });
    assert.equal(repeatedFinish.status, "completed");
    assert.throws(
      () =>
        store?.finishTask({
          roleId,
          taskId: task.taskId,
          status: "failed",
          endReason: "其他原因",
        }),
      expectCode("TASK_STATE_CONFLICT"),
    );

    const continuation = store.grantResourceContinuation({
      roleId,
      taskId: task.taskId,
      resourceId: randomUUID(),
    });
    assert.equal(continuation.endedAt, null);
    assert.equal(
      store.listResourceContinuations(roleId, task.taskId).length,
      1,
    );
    assert.throws(
      () => otherStore?.getTask(roleId, task.taskId),
      expectCode("TASK_NOT_FOUND"),
    );
    assert.throws(
      () => otherStore?.listTasks(roleId),
      expectCode("ROLE_NOT_FOUND"),
    );

    store.close();
    store = undefined;
    otherStore.close();
    otherStore = undefined;

    await app.close();
    app = undefined;

    const reopened = await start(root);
    app = reopened.app;
    store = new RoleStore(roleBusinessPath);

    const reopenedTask = store.getTask(roleId, task.taskId);
    assert.equal(reopenedTask.status, "completed");
    assert.equal(reopenedTask.endReason, "验证完成");
    const reopenedExecution = store.getExecution(
      roleId,
      execution1.executionId,
    );
    assert.equal(reopenedExecution.stateVersionCommitted, 1);
    const reopenedCall = store.getToolCall(roleId, toolCallId);
    assert.equal(reopenedCall.status, "success");
    assert.equal(reopenedCall.mode, "background");
    assert.equal(
      store.listToolCallModeEvents(roleId, toolCallId).length,
      2,
    );
    assert.deepEqual(store.getToolResult(roleId, toolCallId).adaptedResult, {
      text: "完成",
    });
    const reopenedCallStatuses = store
      .listToolCalls(roleId, execution1.executionId)
      .map((call) => call.status);
    assert.deepEqual(reopenedCallStatuses, ["success", "failed", "unknown"]);

    assert.throws(
      () =>
        store?.saveToolResult({
          roleId,
          toolCallId: unknownCall.toolCall.toolCallId,
          status: "success",
        }),
      expectCode("TOOL_RESULT_EVIDENCE_REQUIRED"),
    );
    assert.throws(
      () =>
        store?.saveToolResult({
          roleId,
          toolCallId: unknownCall.toolCall.toolCallId,
          status: "success",
          diagnosticCode: "LATE_CONFIRMATION",
        }),
      expectCode("TOOL_RESULT_EVIDENCE_REQUIRED"),
    );
    assert.equal(
      store.getToolResult(roleId, unknownCall.toolCall.toolCallId).status,
      "unknown",
    );

    const reconciled = store.saveToolResult({
      roleId,
      toolCallId: unknownCall.toolCall.toolCallId,
      status: "success",
      rawResponse: { late: true },
      adaptedResult: { text: "补录结果" },
      diagnosticCode: "LATE_CONFIRMATION",
    });
    assert.equal(reconciled.duplicate, false);
    assert.equal(reconciled.result.status, "success");
    assert.equal(reconciled.result.previousStatus, "unknown");
    assert.equal(reconciled.result.previousDiagnosticCode, "CONNECTION_LOST");
    assert.deepEqual(reconciled.result.previousRawResponse, { partial: true });
    assert.deepEqual(reconciled.result.previousAdaptedResult, {
      text: "未知结果",
    });
    assert.ok(reconciled.result.reconciledAt);
    assert.equal(
      store.getToolCall(roleId, unknownCall.toolCall.toolCallId).status,
      "success",
    );
    assert.equal(
      store.finishToolCall(
        roleId,
        unknownCall.toolCall.toolCallId,
        "success",
      ).status,
      "success",
    );
    const reconciledAgain = store.saveToolResult({
      roleId,
      toolCallId: unknownCall.toolCall.toolCallId,
      status: "success",
      rawResponse: { late: true },
      adaptedResult: { text: "补录结果" },
      diagnosticCode: "LATE_CONFIRMATION",
    });
    assert.equal(reconciledAgain.duplicate, true);
    assert.throws(
      () =>
        store?.saveToolResult({
          roleId,
          toolCallId: unknownCall.toolCall.toolCallId,
          status: "failed",
          error: { message: "冲突结果" },
        }),
      expectCode("TOOL_RESULT_CONFLICT"),
    );

    const callOnlyUnknown = store.beginToolCall({
      roleId,
      taskId: task.taskId,
      executionId: execution2.executionId,
      stepKey: "step-only-state",
      toolName: "sample",
      args: {},
    });
    store.markToolCallRunning(roleId, callOnlyUnknown.toolCall.toolCallId);
    store.finishToolCall(roleId, callOnlyUnknown.toolCall.toolCallId, "unknown");
    const callOnlyConfirmed = store.saveToolResult({
      roleId,
      toolCallId: callOnlyUnknown.toolCall.toolCallId,
      status: "success",
      rawResponse: { confirmed: true },
      adaptedResult: "confirmed",
    });
    assert.equal(callOnlyConfirmed.result.status, "success");
    assert.equal(callOnlyConfirmed.result.previousStatus, "unknown");
    assert.equal(callOnlyConfirmed.result.previousDiagnosticCode, null);
    assert.ok(callOnlyConfirmed.result.reconciledAt);
    assert.equal(
      store.getToolCall(roleId, callOnlyUnknown.toolCall.toolCallId).status,
      "success",
    );

    const emptyResultCall = store.beginToolCall({
      roleId,
      taskId: task.taskId,
      executionId: execution2.executionId,
      stepKey: "step-empty-result",
      toolName: "sample",
      args: {},
    });
    store.markToolCallRunning(roleId, emptyResultCall.toolCall.toolCallId);
    store.saveToolResult({
      roleId,
      toolCallId: emptyResultCall.toolCall.toolCallId,
      status: "unknown",
      diagnosticCode: "RESPONSE_LOST",
    });
    const emptyResultConfirmed = store.saveToolResult({
      roleId,
      toolCallId: emptyResultCall.toolCall.toolCallId,
      status: "success",
      rawResponse: null,
    });
    assert.equal(emptyResultConfirmed.result.status, "success");
    assert.equal(emptyResultConfirmed.result.rawResponse, null);
    assert.equal(emptyResultConfirmed.result.previousStatus, "unknown");
    assert.equal(
      emptyResultConfirmed.result.previousDiagnosticCode,
      "RESPONSE_LOST",
    );
    assert.ok(emptyResultConfirmed.result.reconciledAt);

    assert.equal(
      store.listExecutionTasks(roleId, execution2.executionId).length,
      1,
    );
    assert.equal(
      store.listResourceContinuations(roleId, task.taskId).length,
      1,
    );
    assert.equal(
      store.endResourceContinuation({
        roleId,
        taskId: task.taskId,
        resourceId: continuation.resourceId,
      }),
      true,
    );
    assert.ok(
      store.listResourceContinuations(roleId, task.taskId)[0]?.endedAt,
    );

    store.close();
    store = new RoleStore(roleBusinessPath);
    const persistedReconciliation = store.getToolResult(
      roleId,
      unknownCall.toolCall.toolCallId,
    );
    assert.equal(persistedReconciliation.status, "success");
    assert.equal(
      persistedReconciliation.previousDiagnosticCode,
      "CONNECTION_LOST",
    );
    assert.deepEqual(persistedReconciliation.previousRawResponse, {
      partial: true,
    });
    assert.deepEqual(persistedReconciliation.adaptedResult, {
      text: "补录结果",
    });
    const persistedCallOnly = store.getToolResult(
      roleId,
      callOnlyUnknown.toolCall.toolCallId,
    );
    assert.equal(persistedCallOnly.status, "success");
    assert.equal(persistedCallOnly.previousStatus, "unknown");
    assert.ok(persistedCallOnly.reconciledAt);
  } finally {
    store?.close();
    otherStore?.close();
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
