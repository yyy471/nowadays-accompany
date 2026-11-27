import { RoleAccess } from "../../src/application/role/role-access.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import { createBackendApp, listen, type BackendApp } from "../../src/bootstrap/app.js";
import { ModelBindingResolver } from "../../src/application/resources/model-binding-resolver.js";
import { MemoryStore } from "../../src/storage/memory/memory-store.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";
import type { MemoryModelPort } from "../../src/domain/memory.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../../src/domain/model.js";
import {
  addBinding,
  createFixture,
  createFixtureWithModel,
  deferred,
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

test("已确认的任务结束整理在重启后自动恢复", { timeout: 60_000 }, async () => {
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
  let restarted: BackendApp | null = null;
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
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    addBinding(fixture, "memory_model", memoryResource.resourceId);
    const taskId = withStorage(fixture, (storage) => {
      const task = storage.business.createTask({
        roleId: fixture.roleId,
        goal: "重启后整理工具结果",
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
        stepKey: "restart-task-end",
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
    fixture.app.services.resources.beginMaintenance(memoryResource.resourceId);
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
          { status: "completed", endReason: "重启前完成" },
        )
      ).status,
      200,
    );
    const failed = await deletion;
    assert.equal(failed.status, 409);
    claim.release();
    claim = null;
    assert.equal(memoryCalls, 0);
    // 任务结束意图已持久化，进程关闭后仍在。
    const pending = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).listPendingTriggers(
        fixture.roleId,
      ),
    );
    assert.ok(
      pending.some((trigger) => trigger.kind === "task_end"),
      "任务结束意图应写入持久化触发",
    );

    const config = fixture.app.config;
    await fixture.app.close();
    restarted = createBackendApp(config, {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    await waitUntil(() => memoryCalls > 0);
    assert.equal(memoryCalls, 1, "重启后应自动整理一次");
    const storage = RoleStorage.openExisting(
      rolePaths(restarted.config.dataRoot, fixture.roleId),
    );
    try {
      const triggers = new MemoryStore(
        storage.business.db,
      ).listPendingTriggers(fixture.roleId);
      assert.equal(
        triggers.some((trigger) => trigger.kind === "task_end"),
        false,
        "恢复后任务结束触发应被消费",
      );
    } finally {
      storage.close();
    }
    const task = restarted.conversation.getTask(fixture.roleId, taskId);
    assert.equal(task.status, "completed");
  } finally {
    claim?.release();
    if (restarted !== null) {
      await restarted.close();
    }
    await fixture.close();
  }
});

/** 第一轮调用慢工具转后台；后续轮次只记录请求。 */
class SlowToolModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const last = request.messages.at(-1);
    if (last?.role === "user") {
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("slow_op"),
      );
      assert.ok(tool);
      yield { type: "text_delta", text: "正在执行慢操作" };
      yield {
        type: "tool_call",
        callId: "wire-slow",
        name: tool.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    assert.match(String(last?.content ?? ""), /slow-result/);
    yield { type: "text_delta", text: "后台结果已收到" };
    yield { type: "completed", stopReason: "stop" };
  }
}

function addSlowOpMcp(fixture: Fixture, dir: string): string {
  const serverPath = path.join(dir, "slow-op.mjs");
  fs.writeFileSync(
    serverPath,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      `const dir = ${JSON.stringify(dir)};`,
      "const server = new McpServer({ name: 'slow-op', version: '1' });",
      "server.registerTool('slow_op', { inputSchema: {} }, async () => {",
      "  fs.writeFileSync(path.join(dir, 'bg-started'), '');",
      "  const deadline = Date.now() + 20000;",
      "  while (!fs.existsSync(path.join(dir, 'bg-release')) && Date.now() < deadline) {",
      "    await new Promise((r) => setTimeout(r, 20));",
      "  }",
      "  return { content: [{ type: 'text', text: 'slow-result' }] };",
      "});",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"),
    "utf8",
  );
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name: "slow-op",
    config: { command: process.execPath, args: [serverPath], env: {} },
  });
  addBinding(fixture, "mcp", resource.resourceId);
  return resource.resourceId;
}

test("任务终结后在途工具结算与连接收尾前保留资源占用", { timeout: 60_000 }, async () => {
  const model = new SlowToolModel();
  const fixture = createFixtureWithModel(model, { toolForegroundWaitMs: 500 });
  try {
    const workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    fs.mkdirSync(workspace, { recursive: true });
    const mcpId = addSlowOpMcp(fixture, workspace);
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "请执行慢操作",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await waitUntil(() => fs.existsSync(path.join(workspace, "bg-started")));
    let taskId = "";
    await waitUntil(() => {
      const tasks = fixture.app.conversation.listTasks(fixture.roleId);
      if (tasks.length !== 1 || tasks[0]?.status !== "active") {
        return false;
      }
      taskId = tasks[0].taskId;
      return withStorage(
        fixture,
        (storage) => {
          const calls = storage.business.listTaskToolCalls(
            fixture.roleId,
            taskId,
          );
          return calls[0]?.status === "running" && calls[0]?.mode === "background";
        },
      );
    });

    // 发出工具调用后先关闭角色绑定，再终结任务（283 R03 复验场景）。
    const currentBindings = fixture.app.services.resources.listBindings(
      fixture.roleId,
    );
    fixture.app.services.resources.replaceBindings(
      fixture.roleId,
      currentBindings.map((binding) => ({
        capability: binding.capability,
        resourceId: binding.resourceId,
        ...(binding.modelName === null ? {} : { modelName: binding.modelName }),
        enabled: false,
      })),
    );

    // 在途工具尚未结算时结束任务：结果仍记在原任务上，占用保持受阻。
    const finished = fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId,
      status: "completed",
      endReason: "用户在资源详情中结束任务",
    });
    assert.equal(finished.status, "completed");
    const busy = fixture.app.services.resources.references(mcpId);
    assert.equal(busy.canUpdate, false, "在途工具结算前不释放扩展占用");
    assert.equal(busy.canDelete, false);
    assert.ok(
      busy.references.some(
        (item) => item.reason === "TASK_CHAIN" && item.taskId === taskId,
      ),
    );

    // 控制连接关闭节点：结果已写回但目录仍在收尾时必须继续占用（283 §4 R03）。
    const closeGate = deferred<void>();
    const internals = fixture.app.conversation as unknown as {
      taskCatalogs: Map<string, { catalog: { close: () => Promise<void> } }>;
    };
    const entry = internals.taskCatalogs.get(taskId);
    assert.ok(entry, "任务目录应在后台工具在途时保留");
    const originalClose = entry.catalog.close.bind(entry.catalog);
    entry.catalog.close = async () => {
      await closeGate.promise;
      return originalClose();
    };

    // 结算在途结果；目录关闭仍被挂起时占用不得提前释放。
    fs.writeFileSync(path.join(workspace, "bg-release"), "");
    await waitUntil(() =>
      withStorage(fixture, (storage) => {
        const calls = storage.business.listTaskToolCalls(
          fixture.roleId,
          taskId,
        );
        if (calls.length !== 1) {
          return false;
        }
        try {
          return (
            storage.business.getToolResult(fixture.roleId, calls[0]!.toolCallId)
              .status === "success"
          );
        } catch {
          return false;
        }
      }),
    );
    const settledButClosing = fixture.app.services.resources.references(mcpId);
    assert.equal(
      settledButClosing.canUpdate,
      false,
      "结果结算后、连接收尾前仍应占用",
    );
    assert.equal(settledButClosing.canDelete, false);

    closeGate.resolve();
    await waitUntil(() => {
      const report = fixture.app.services.resources.references(mcpId);
      return report.canUpdate && report.canDelete;
    });
    const settled = withStorage(fixture, (storage) => {
      const calls = storage.business.listTaskToolCalls(fixture.roleId, taskId);
      assert.equal(calls.length, 1);
      return storage.business.getToolResult(
        fixture.roleId,
        calls[0]!.toolCallId,
      );
    });
    assert.equal(settled.status, "success");
    assert.equal(model.requests.length, 1, "后台结果不应触发新的任务续行");
  } finally {
    await fixture.close();
  }
});

function seedTaskWithPendingToolEvidence(
  fixture: Fixture,
  goal: string,
  text: string,
  options?: { blockTriggerName?: string },
): string {
  return withStorage(fixture, (storage) => {
    const execution = storage.business.createExecution({
      roleId: fixture.roleId,
      triggerType: "user_message",
    });
    const task = storage.business.createTask({
      roleId: fixture.roleId,
      goal,
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
      stepKey: "step-1",
      toolName: "read_file",
      args: { path: "notes.md" },
    });
    storage.business.markToolCallRunning(
      fixture.roleId,
      call.toolCall.toolCallId,
    );
    storage.business.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: call.toolCall.toolCallId,
      status: "success",
      rawResponse: { content: text },
      adaptedResult: { text },
      diagnosticCode: null,
    });
    storage.business.commitExecution({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      stateVersionCommitted: storage.business.getState(fixture.roleId).stateVersion,
    });
    if (options?.blockTriggerName !== undefined) {
      storage.business.db.exec(`
        CREATE TRIGGER ${options.blockTriggerName}
        BEFORE INSERT ON memory_triggers
        WHEN NEW.kind = 'task_end'
        BEGIN
          SELECT RAISE(ABORT, 'INJECTED_TASK_END_WRITE_FAILURE');
        END;
      `);
    }
    return task.taskId;
  });
}

test("触发写入失败时已确认的任务结束整理仍可跨重启恢复（283 §21）", { timeout: 60_000 }, async () => {
  const scenarios = [
    { keepHistory: "1", clearFaultAfterRestart: false },
    { keepHistory: "0", clearFaultAfterRestart: true },
  ] as const;

  for (const scenario of scenarios) {
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `recovered-${index}`,
            title: "重启恢复的任务工具记忆",
            summary: "从持久化任务状态与待整理工具证据恢复。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
      roleDeletionWaitMs: 1_200,
    });
    let reopened: BackendApp | null = null;
    let reopenedAgain: BackendApp | null = null;
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
      fixture.app.services.roles.createRole({
        displayName: "保留角色",
        definition: { text: "至少保留一个角色" },
      });

      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        "带工具证据的结束任务",
        "读取到笔记内容",
      );

      assert.equal(
        fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
        true,
      );
      addBinding(fixture, "memory_model", memoryResource.resourceId);
      fixture.app.services.resources.beginMaintenance(memoryResource.resourceId);

      // 仅对 memory_triggers(kind = 'task_end') 注入写入失败，保持 tasks 状态更新正常。
      withStorage(fixture, (storage) => {
        storage.business.db.exec(`
          CREATE TRIGGER test_block_task_end_trigger
          BEFORE INSERT ON memory_triggers
          WHEN NEW.kind = 'task_end'
          BEGIN
            SELECT RAISE(ABORT, 'INJECTED_TASK_END_WRITE_FAILURE');
          END;
        `);
      });

      claim = fixture.app.services.resources.claimModelCall(
        fixture.roleId,
        chatResource.resourceId,
      );
      assert.equal(claim.admitted, true);

      const deleting = api(
        base,
        "DELETE",
        `/v1/roles/${fixture.roleId}?keepHistory=${scenario.keepHistory}`,
      );
      await waitUntil(() =>
        fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
      );

      const finishRes = await api(
        base,
        "POST",
        `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
        { status: "completed", endReason: "用户结束任务" },
      );
      assert.equal(finishRes.status, 200);

      const deletionRes = await deleting;
      assert.equal(deletionRes.status, 409);
      assert.equal(errorCode(deletionRes), "ROLE_BUSY");
      claim.release();
      claim = null;

      withStorage(fixture, (storage) => {
        assert.equal(
          storage.business.getTask(fixture.roleId, taskId).status,
          "completed",
        );
        const triggers = storage.business.db
          .prepare("SELECT COUNT(*) AS count FROM memory_triggers")
          .get() as { count: number };
        assert.equal(triggers.count, 0, "触发写入故障期间不应写出 task_end");
      });
      assert.equal(memoryCalls, 0);

      // 模拟重启时记忆模型（及回退对话模型）仍处于不可用状态，等待后续人工唤醒。
      fixture.app.appStore.updateResource({
        resourceId: memoryResource.resourceId,
        enabled: false,
      });
      fixture.app.appStore.updateResource({
        resourceId: chatResource.resourceId,
        enabled: false,
      });
      if (!scenario.clearFaultAfterRestart) {
        withStorage(fixture, (storage) => {
          storage.business.db.exec(
            "DROP TRIGGER IF EXISTS test_block_task_end_trigger;",
          );
        });
      }
      await fixture.app.close();

      reopened = createBackendApp(
        parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
        {
          typingMs: 1000,
          timeZone: "Asia/Shanghai",
          modelPortFactory: () => fixture.model,
          disableMemoryRuntime: false,
          memoryModelFactory: () => memoryModel,
        },
      );
      const reopenedBase = `http://127.0.0.1:${await listen(
        reopened.server,
        0,
        "127.0.0.1",
      )}`;
      await delay(100);
      assert.equal(memoryCalls, 0, "唤醒前记忆模型仍不可用，不应提前整理");

      if (scenario.clearFaultAfterRestart) {
        withStorage(fixture, (storage) => {
          storage.business.db.exec(
            "DROP TRIGGER IF EXISTS test_block_task_end_trigger;",
          );
        });
      } else {
        withStorage(fixture, (storage) => {
          const pending = new MemoryStore(
            storage.business.db,
          ).listPendingTriggers(fixture.roleId);
          assert.equal(pending.length, 1);
          assert.equal(pending[0]?.kind, "task_end");
          assert.equal(pending[0]?.taskId, taskId);
        });
      }

      // 恢复模型可用以唤醒待整理工作，应补写并消费 task_end，只执行一次整理。
      const wakeRes = await api(
        reopenedBase,
        "PATCH",
        `/v1/resources/${memoryResource.resourceId}`,
        { enabled: true },
      );
      assert.equal(wakeRes.status, 200);
      await waitUntil(() =>
        memoryCalls === 1 &&
        withStorage(fixture, (storage) => {
          const trigger = storage.business.db
            .prepare(
              "SELECT consumed_at FROM memory_triggers WHERE role_id = ? AND kind = 'task_end' AND task_id = ?",
            )
            .get(fixture.roleId, taskId) as
            | { consumed_at: string | null }
            | undefined;
          return (
            trigger?.consumed_at !== null &&
            trigger?.consumed_at !== undefined &&
            new MemoryStore(storage.business.db).pendingTaskEvidenceCount(
              fixture.roleId,
              taskId,
            ) === 0
          );
        }),
      );

      withStorage(fixture, (storage) => {
        const triggerRows = storage.business.db
          .prepare(
            "SELECT kind, task_id, consumed_at FROM memory_triggers WHERE role_id = ? AND kind = 'task_end'",
          )
          .all(fixture.roleId) as Array<{
          kind: string;
          task_id: string | null;
          consumed_at: string | null;
        }>;
        assert.equal(triggerRows.length, 1);
        assert.equal(triggerRows[0]?.task_id, taskId);
        assert.ok(triggerRows[0]?.consumed_at);

        assert.equal(
          new MemoryStore(storage.business.db).pendingTaskEvidenceCount(
            fixture.roleId,
            taskId,
          ),
          0,
        );
      });

      await reopened.close();
      reopened = null;

      // 再次重启，不应重复形成记忆。
      reopenedAgain = createBackendApp(
        parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
        {
          typingMs: 1000,
          timeZone: "Asia/Shanghai",
          modelPortFactory: () => fixture.model,
          disableMemoryRuntime: false,
          memoryModelFactory: () => memoryModel,
        },
      );
      await delay(120);
      assert.equal(memoryCalls, 1);
    } finally {
      claim?.release();
      await reopenedAgain?.close();
      await reopened?.close();
      await fixture.close();
    }
  }
});

test("删除成功路径与非删除触发写入失败场景边界（283 §21）", { timeout: 60_000 }, async () => {
  // 1) 删除成功对照（keepHistory=1 / keepHistory=0）：即使曾注入触发写入故障，删除成功后重启不再整理。
  for (const keepHistory of ["1", "0"] as const) {
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form() {
        memoryCalls += 1;
        return {};
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    let reopened: BackendApp | null = null;
    try {
      const base = await start(fixture);
      const resource = fixture.app.services.resources.list("model")[0];
      assert.ok(resource);
      fixture.app.services.roles.createRole({
        displayName: "保留角色",
        definition: { text: "至少保留一个角色" },
      });
      assert.equal(
        fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
        true,
      );
      addBinding(fixture, "memory_model", resource.resourceId);
      fixture.app.services.resources.beginMaintenance(resource.resourceId);
      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        "删除成功的任务",
        "已完成",
        { blockTriggerName: "test_block_task_end_trigger_ctrl" },
      );
      assert.equal(
        (
          await api(
            base,
            "POST",
            `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
            { status: "completed", endReason: "删除前结束" },
          )
        ).status,
        200,
      );
      const removed = await api(
        base,
        "DELETE",
        `/v1/roles/${fixture.roleId}?keepHistory=${keepHistory}`,
      );
      assert.equal(removed.status, 200);
      await fixture.app.close();

      reopened = createBackendApp(
        parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
        {
          typingMs: 1000,
          timeZone: "Asia/Shanghai",
          modelPortFactory: () => fixture.model,
          disableMemoryRuntime: false,
          memoryModelFactory: () => memoryModel,
        },
      );
      await delay(120);
      assert.equal(memoryCalls, 0, "已删除角色重启后不应误触发整理");
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  }

  // 2) 非删除状态下任务结束遇到触发写入故障且模型停用，故障恢复并重启后自动补写并整理一次。
  let nonDeleteCalls = 0;
  const nonDeleteModel: MemoryModelPort = {
    async form(input) {
      nonDeleteCalls += 1;
      return {
        operations: input.evidence.map((item, index) => ({
          op: "create_event" as const,
          localKey: `non-delete-${index}`,
          title: "非删除路径恢复记忆",
          summary: "重启后自动对账任务结束触发并整理。",
          occurredAtStart: item.occurredAt,
          experienceDate: item.localDate,
          evidenceIds: [item.evidenceId],
        })),
      };
    },
  };
  const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
    disableMemoryRuntime: false,
    memoryModelFactory: () => nonDeleteModel,
  });
  let reopened: BackendApp | null = null;
  try {
    const base = await start(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    const taskId = seedTaskWithPendingToolEvidence(
      fixture,
      "非删除恢复测试任务",
      "非删除工具结果",
      { blockTriggerName: "test_block_task_end_non_delete" },
    );

    assert.equal(
      (
        await api(
          base,
          "POST",
          `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
          { status: "completed", endReason: "正常结束" },
        )
      ).status,
      200,
    );
    await delay(100);
    assert.equal(nonDeleteCalls, 0);

    withStorage(fixture, (storage) => {
      storage.business.db.exec(
        "DROP TRIGGER IF EXISTS test_block_task_end_non_delete;",
      );
    });
    await fixture.app.close();

    reopened = createBackendApp(
      parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
      {
        typingMs: 1000,
        timeZone: "Asia/Shanghai",
        modelPortFactory: () => fixture.model,
        disableMemoryRuntime: false,
        memoryModelFactory: () => nonDeleteModel,
      },
    );
    await waitUntil(() =>
      nonDeleteCalls === 1 &&
      withStorage(fixture, (storage) => {
        const trigger = storage.business.db
          .prepare(
            "SELECT consumed_at FROM memory_triggers WHERE role_id = ? AND kind = 'task_end' AND task_id = ?",
          )
          .get(fixture.roleId, taskId) as
          | { consumed_at: string | null }
          | undefined;
        return (
          trigger?.consumed_at !== null &&
          trigger?.consumed_at !== undefined &&
          new MemoryStore(storage.business.db).pendingTaskEvidenceCount(
            fixture.roleId,
            taskId,
          ) === 0
        );
      }),
    );
    assert.equal(nonDeleteCalls, 1);
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("单项任务触发补写失败不阻塞手动整理与独立对话整理（283 §22）", { timeout: 60_000 }, async () => {
  // 1) 运行中保持记忆模型可用，仅拦截 task_end 插入：任务结束后手动整理应照常处理独立对话证据。
  {
    let memoryCalls = 0;
    const formedEvidenceIds = new Set<string>();
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        for (const item of input.evidence) {
          formedEvidenceIds.add(item.evidenceId);
        }
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `isolated-${memoryCalls}-${index}`,
            title: "隔离故障时的记忆整理",
            summary: "task_end 写库失败不阻塞手动触发与独立对话整理。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixture(
      [
        [
          { type: "text_delta", text: "好的，我记下这件事了。" },
          { type: "completed", stopReason: "stop" },
        ],
      ],
      {
        disableMemoryRuntime: false,
        memoryModelFactory: () => memoryModel,
      },
    );
    try {
      const base = await start(fixture);
      fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
        content: "今天去公园散步了。",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      });
      await fixture.app.conversation.waitForIdle(fixture.roleId);

      const messageEvidenceIds = withStorage(fixture, (storage) =>
        new MemoryStore(storage.business.db)
          .listEvidence(fixture.roleId)
          .filter((item) => item.sourceKind === "message")
          .map((item) => item.evidenceId),
      );
      assert.ok(messageEvidenceIds.length > 0);
      assert.equal(memoryCalls, 0);

      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        "触发写库失败的任务",
        "任务工具输出",
        { blockTriggerName: "test_block_task_end_live" },
      );
      const finishRes = await api(
        base,
        "POST",
        `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
        { status: "completed", endReason: "完成" },
      );
      assert.equal(finishRes.status, 200);
      await delay(100);
      assert.equal(memoryCalls, 0);

      // 故障仍未解除时发起手动整理（202），不应被 task_end 补写异常阻断。
      const manualRes = await api(
        base,
        "POST",
        `/v1/roles/${fixture.roleId}/memory/batches`,
      );
      assert.equal(manualRes.status, 202);

      await waitUntil(() =>
        memoryCalls > 0 &&
        withStorage(fixture, (storage) => {
          const store = new MemoryStore(storage.business.db);
          const pendingMsgs = store
            .listEvidence(fixture.roleId)
            .filter(
              (item) =>
                item.sourceKind === "message" &&
                item.processingStatus === "pending",
            );
          const manualRows = storage.business.db
            .prepare(
              "SELECT consumed_at FROM memory_triggers WHERE role_id = ? AND kind = 'manual'",
            )
            .all(fixture.roleId) as Array<{ consumed_at: string | null }>;
          return (
            pendingMsgs.length === 0 &&
            manualRows.length === 1 &&
            manualRows[0]?.consumed_at !== null
          );
        }),
      );
      for (const evidenceId of messageEvidenceIds) {
        assert.equal(formedEvidenceIds.has(evidenceId), true);
      }
      withStorage(fixture, (storage) => {
        const taskEndCount = storage.business.db
          .prepare(
            "SELECT COUNT(*) AS count FROM memory_triggers WHERE role_id = ? AND kind = 'task_end'",
          )
          .get(fixture.roleId) as { count: number };
        assert.equal(taskEndCount.count, 0, "写入故障期间仍未写出 task_end");
      });
    } finally {
      await fixture.close();
    }
  }

  // 2) 删除超时后带故障重启（内存暂存已清空），手动整理仍可直接完成，不被重启对账阻塞。
  {
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `restart-manual-${memoryCalls}-${index}`,
            title: "带故障重启后的手动整理",
            summary: "重启清空暂存后，task_end 故障仍不阻塞手动整理。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixture(
      [
        [
          { type: "text_delta", text: "今天天气真好。" },
          { type: "completed", stopReason: "stop" },
        ],
      ],
      {
        disableMemoryRuntime: false,
        memoryModelFactory: () => memoryModel,
        roleDeletionWaitMs: 600,
      },
    );
    let reopened: BackendApp | null = null;
    let claim: { admitted: boolean; release: () => void } | null = null;
    try {
      const base = await start(fixture);
      const chatResource = fixture.app.services.resources.list("model")[0];
      assert.ok(chatResource);
      fixture.app.services.roles.createRole({
        displayName: "保留角色",
        definition: { text: "至少保留一个角色" },
      });
      fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
        content: "独立对话待整理证据",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      });
      await fixture.app.conversation.waitForIdle(fixture.roleId);

      assert.equal(
        fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
        true,
      );
      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        "带故障重启的结束任务",
        "工具结果",
        { blockTriggerName: "test_block_task_end_across_restart" },
      );

      claim = fixture.app.services.resources.claimModelCall(
        fixture.roleId,
        chatResource.resourceId,
      );
      assert.equal(claim.admitted, true);
      const deleting = api(
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
            { status: "completed", endReason: "结束" },
          )
        ).status,
        200,
      );
      assert.equal((await deleting).status, 409);
      claim.release();
      claim = null;
      await fixture.app.close();

      // 带同一 SQLite 写入故障触发器重启：原 deferredTaskIds 已清空，模型可用。
      reopened = createBackendApp(
        parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
        {
          typingMs: 1000,
          timeZone: "Asia/Shanghai",
          modelPortFactory: () => fixture.model,
          disableMemoryRuntime: false,
          memoryModelFactory: () => memoryModel,
        },
      );
      const reopenedBase = `http://127.0.0.1:${await listen(
        reopened.server,
        0,
        "127.0.0.1",
      )}`;
      await delay(100);
      assert.equal(memoryCalls, 0);

      assert.equal(
        (
          await api(
            reopenedBase,
            "POST",
            `/v1/roles/${fixture.roleId}/memory/batches`,
          )
        ).status,
        202,
      );
      await waitUntil(() =>
        memoryCalls > 0 &&
        withStorage(fixture, (storage) => {
          const store = new MemoryStore(storage.business.db);
          const pendingMsgs = store
            .listEvidence(fixture.roleId)
            .filter(
              (item) =>
                item.sourceKind === "message" &&
                item.processingStatus === "pending",
            );
          const manualRows = storage.business.db
            .prepare(
              "SELECT consumed_at FROM memory_triggers WHERE role_id = ? AND kind = 'manual'",
            )
            .all(fixture.roleId) as Array<{ consumed_at: string | null }>;
          return (
            pendingMsgs.length === 0 &&
            manualRows.length === 1 &&
            manualRows[0]?.consumed_at !== null
          );
        }),
      );
    } finally {
      claim?.release();
      await reopened?.close();
      await fixture.close();
    }
  }
});

test("部分任务补写失败保留可重试状态且不阻塞其他任务触发（283 §22）", { timeout: 60_000 }, async () => {
  // 1) 同一角色两个已结束任务：排序在前的 blockedTaskId 写入失败，后面的 healthyTaskId 仍应成功落库并执行整理。
  {
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `partial-ok-${memoryCalls}-${index}`,
            title: "健康任务触发整理",
            summary: "单项失败不回滚或阻断其余任务触发。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    let reopened: BackendApp | null = null;
    try {
      await start(fixture);
      const blockedTaskId = seedTaskWithPendingToolEvidence(
        fixture,
        "拒绝写入的任务",
        "被拒绝任务工具结果",
      );
      const healthyTaskId = seedTaskWithPendingToolEvidence(
        fixture,
        "可正常写入的任务",
        "正常任务工具结果",
      );
      withStorage(fixture, (storage) => {
        // 先标记两个任务为已完成并确保 updated_at 顺序让 blockedTaskId 排在前面。
        storage.business.db
          .prepare(
            "UPDATE tasks SET status = 'completed', updated_at = '2026-11-13T10:00:00.000Z' WHERE task_id = ?",
          )
          .run(blockedTaskId);
        storage.business.db
          .prepare(
            "UPDATE tasks SET status = 'completed', updated_at = '2026-11-13T10:01:00.000Z' WHERE task_id = ?",
          )
          .run(healthyTaskId);
        storage.business.db.exec(`
          CREATE TRIGGER test_block_single_task_end
          BEFORE INSERT ON memory_triggers
          WHEN NEW.kind = 'task_end' AND NEW.task_id = '${blockedTaskId}'
          BEGIN
            SELECT RAISE(ABORT, 'INJECTED_SINGLE_TASK_FAILURE');
          END;
        `);
      });
      await fixture.app.close();

      reopened = createBackendApp(
        parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
        {
          typingMs: 1000,
          timeZone: "Asia/Shanghai",
          modelPortFactory: () => fixture.model,
          disableMemoryRuntime: false,
          memoryModelFactory: () => memoryModel,
        },
      );

      await waitUntil(() =>
        memoryCalls >= 1 &&
        withStorage(fixture, (storage) => {
          const healthyTrigger = storage.business.db
            .prepare(
              "SELECT consumed_at FROM memory_triggers WHERE role_id = ? AND kind = 'task_end' AND task_id = ?",
            )
            .get(fixture.roleId, healthyTaskId) as
            | { consumed_at: string | null }
            | undefined;
          return (
            healthyTrigger?.consumed_at !== null &&
            healthyTrigger?.consumed_at !== undefined
          );
        }),
      );
      withStorage(fixture, (storage) => {
        const blockedRows = storage.business.db
          .prepare(
            "SELECT COUNT(*) AS count FROM memory_triggers WHERE role_id = ? AND kind = 'task_end' AND task_id = ?",
          )
          .get(fixture.roleId, blockedTaskId) as { count: number };
        assert.equal(blockedRows.count, 0);
      });
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  }

  // 2) 单项任务因触发写库失败未被整理时保留可重试状态，解除故障并唤醒后可补全整理。
  {
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `retry-retained-${index}`,
            title: "解除故障后重试任务整理",
            summary: "失败任务保留可重试状态并在恢复后完成整理。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    try {
      const base = await start(fixture);
      const resource = fixture.app.services.resources.list("model")[0];
      assert.ok(resource);
      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        "失败后保留重试的任务",
        "待重试工具证据",
        { blockTriggerName: "test_block_task_end_retry_retained" },
      );
      assert.equal(
        (
          await api(
            base,
            "POST",
            `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
            { status: "completed", endReason: "结束" },
          )
        ).status,
        200,
      );
      await delay(100);
      assert.equal(memoryCalls, 0);
      withStorage(fixture, (storage) => {
        const store = new MemoryStore(storage.business.db);
        assert.deepEqual(store.listFinishedTasksNeedingTrigger(fixture.roleId), [
          taskId,
        ]);
        assert.equal(store.pendingTaskEvidenceCount(fixture.roleId, taskId), 1);
      });

      // 解除故障后唤醒，原任务保持的可重试状态应自动补写 task_end 并完成整理。
      withStorage(fixture, (storage) => {
        storage.business.db.exec(
          "DROP TRIGGER IF EXISTS test_block_task_end_retry_retained;",
        );
      });
      fixture.app.services.resources.beginMaintenance(resource.resourceId);
      fixture.app.services.resources.endMaintenance(resource.resourceId);

      await waitUntil(() =>
        memoryCalls === 1 &&
        withStorage(fixture, (storage) => {
          const store = new MemoryStore(storage.business.db);
          return (
            store.pendingTaskEvidenceCount(fixture.roleId, taskId) === 0 &&
            store.listFinishedTasksNeedingTrigger(fixture.roleId).length === 0
          );
        }),
      );
    } finally {
      await fixture.close();
    }
  }
});

test("退避到期时模型仍在维护不重复扫库，维护结束后自动整理一次（283 §23）", { timeout: 30_000 }, async (t) => {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
    }
  };
  const installMemoryScanSpy = () => {
    const originalOpenExisting = RoleAccess.prototype.borrow;
    const originalListNeeding =
      MemoryStore.prototype.listFinishedTasksNeedingTrigger;
    const originalNextFailedRetryAt = MemoryStore.prototype.nextFailedRetryAt;
    let enabled = false;
    const counts = {
      borrowCount: 0,
      directMemoryBorrowCount: 0,
      scanCount: 0,
      failedRetryScanCount: 0,
    };
    RoleAccess.prototype.borrow = (function (this: RoleAccess, ...args: Parameters<RoleAccess["borrow"]>) {
      if (enabled) {
        const frames = (new Error().stack ?? "").split("\n");
        const callerFrame = frames[2] ?? "";
        if (frames.some((frame) => frame.includes("memory-runtime"))) {
          counts.borrowCount += 1;
        }
        if (callerFrame.includes("memory-runtime")) {
          counts.directMemoryBorrowCount += 1;
        }
      }
      return originalOpenExisting.apply(this, args);
    }) as RoleAccess["borrow"];
    MemoryStore.prototype.listFinishedTasksNeedingTrigger = function (
      ...args: Parameters<MemoryStore["listFinishedTasksNeedingTrigger"]>
    ) {
      if (enabled) {
        counts.scanCount += 1;
      }
      return originalListNeeding.apply(this, args);
    };
    MemoryStore.prototype.nextFailedRetryAt = function (
      ...args: Parameters<MemoryStore["nextFailedRetryAt"]>
    ) {
      if (enabled) {
        counts.failedRetryScanCount += 1;
      }
      return originalNextFailedRetryAt.apply(this, args);
    };
    return {
      start() {
        counts.borrowCount = 0;
        counts.directMemoryBorrowCount = 0;
        counts.scanCount = 0;
        counts.failedRetryScanCount = 0;
        enabled = true;
      },
      stop() {
        enabled = false;
        return { ...counts };
      },
      restore() {
        enabled = false;
        RoleAccess.prototype.borrow = originalOpenExisting;
        MemoryStore.prototype.listFinishedTasksNeedingTrigger = originalListNeeding;
        MemoryStore.prototype.nextFailedRetryAt = originalNextFailedRetryAt;
      },
    };
  };

  // 1) 真实 30 秒退避定时器在模型维护期间到期，不重入零延迟扫库循环，结束维护后整理一次。
  {
    let currentMs = Date.parse("2026-11-13T10:00:00.000Z");
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `maint-backoff-${index}`,
            title: "维护结束后整理",
            summary: "维护期间不空转扫库，结束维护后单次完成整理。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      now: () => new Date(currentMs),
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    const scanSpy = installMemoryScanSpy();

    try {
      const resource = fixture.app.services.resources.list("model")[0];
      assert.ok(resource);
      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        "退避到期遇维护的任务",
        "维护期间待保留工具输出",
        { blockTriggerName: "test_block_task_end_maint_timer" },
      );

      t.mock.timers.enable({ apis: ["setTimeout"] });

      fixture.app.conversation.finishTask({
        roleId: fixture.roleId,
        taskId,
        status: "completed",
        endReason: "完成",
      });
      await flushMicrotasks();
      assert.equal(memoryCalls, 0);

      // 让记忆模型进入维护，等待真实 30 秒退避定时器到期。
      fixture.app.services.resources.beginMaintenance(resource.resourceId);
      scanSpy.start();

      currentMs += 30_000;
      t.mock.timers.tick(30_000);
      await flushMicrotasks();

      const onExpiry = scanSpy.stop();
      assert.equal(onExpiry.directMemoryBorrowCount, 0, "退避到期命中维护分支时不打开记忆存储");
      assert.equal(onExpiry.scanCount, 0, "退避到期命中维护分支时不扫描待补写任务");
      assert.equal(onExpiry.failedRetryScanCount, 0);

      // 退避到期后的持续窗口（500ms）内不得再安排零延迟唤醒或重复打开角色库。
      scanSpy.start();
      for (let step = 0; step < 20; step += 1) {
        currentMs += 25;
        t.mock.timers.tick(25);
        await flushMicrotasks();
      }
      const afterExpiryWindow = scanSpy.stop();
      assert.equal(afterExpiryWindow.borrowCount, 0, "退避到期后维护期内不应重复打开角色库");
      assert.equal(afterExpiryWindow.scanCount, 0, "退避到期后维护期内不应重复扫描待补写任务");
      assert.equal(afterExpiryWindow.failedRetryScanCount, 0);

      // 在维护期内再次唤醒调度：只跳过一次，同样不应在后续窗口触发扫库循环。
      scanSpy.start();
      fixture.app.conversation.wakePendingWork(fixture.roleId);
      await flushMicrotasks();
      const onWake = scanSpy.stop();
      assert.equal(onWake.directMemoryBorrowCount, 0);
      assert.equal(onWake.scanCount, 0);

      scanSpy.start();
      for (let step = 0; step < 10; step += 1) {
        currentMs += 25;
        t.mock.timers.tick(25);
        await flushMicrotasks();
      }
      const afterWakeWindow = scanSpy.stop();
      assert.equal(afterWakeWindow.borrowCount, 0);
      assert.equal(afterWakeWindow.scanCount, 0);
      assert.equal(afterWakeWindow.failedRetryScanCount, 0);
      assert.equal(memoryCalls, 0);

      withStorage(fixture, (storage) => {
        const store = new MemoryStore(storage.business.db);
        assert.deepEqual(store.listFinishedTasksNeedingTrigger(fixture.roleId), [
          taskId,
        ]);
        assert.equal(store.pendingTaskEvidenceCount(fixture.roleId, taskId), 1);
        storage.business.db.exec(
          "DROP TRIGGER IF EXISTS test_block_task_end_maint_timer;",
        );
      });

      fixture.app.services.resources.endMaintenance(resource.resourceId);
      await flushMicrotasks();
      assert.equal(memoryCalls, 1);

      withStorage(fixture, (storage) => {
        const store = new MemoryStore(storage.business.db);
        assert.equal(store.pendingTaskEvidenceCount(fixture.roleId, taskId), 0);
        assert.deepEqual(
          store.listFinishedTasksNeedingTrigger(fixture.roleId),
          [],
        );
      });
    } finally {
      scanSpy.restore();
      t.mock.timers.reset();
      await fixture.close();
    }
  }

  // 2) 真实事件循环与 HTTP 接口下：过期的补写退避与失败重试在维护窗口内都不空转，恢复后单次整理。
  {
    let currentMs = Date.parse("2026-11-13T11:00:00.000Z");
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `http-maint-backoff-${index}`,
            title: "HTTP 维护恢复整理",
            summary: "真实事件循环中维护期间零重复扫库，维护结束后完成整理。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      now: () => new Date(currentMs),
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    const scanSpy = installMemoryScanSpy();

    try {
      const base = await start(fixture);
      const resource = fixture.app.services.resources.list("model")[0];
      assert.ok(resource);
      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        "HTTP 维护防空转测试任务",
        "待整理工具证据",
        { blockTriggerName: "test_block_task_end_http_maint" },
      );

      assert.equal(
        (
          await api(
            base,
            "POST",
            `/v1/roles/${fixture.roleId}/tasks/${taskId}/finish`,
            { status: "completed", endReason: "完成" },
          )
        ).status,
        200,
      );
      await delay(100);
      assert.equal(memoryCalls, 0);

      fixture.app.services.resources.beginMaintenance(resource.resourceId);
      currentMs += 31_000;
      scanSpy.start();

      fixture.app.conversation.wakePendingWork(fixture.roleId);
      await delay(50);
      const afterWake = scanSpy.stop();
      assert.equal(afterWake.directMemoryBorrowCount, 0);
      assert.equal(afterWake.scanCount, 0);
      assert.equal(afterWake.failedRetryScanCount, 0);

      scanSpy.start();
      await delay(300);

      const observed = scanSpy.stop();
      assert.equal(observed.borrowCount, 0);
      assert.equal(observed.scanCount, 0);
      assert.equal(observed.failedRetryScanCount, 0);
      assert.equal(memoryCalls, 0);

      withStorage(fixture, (storage) => {
        storage.business.db.exec(
          "DROP TRIGGER IF EXISTS test_block_task_end_http_maint;",
        );
      });
      fixture.app.services.resources.endMaintenance(resource.resourceId);

      await waitUntil(() =>
        memoryCalls === 1 &&
        withStorage(fixture, (storage) => {
          const store = new MemoryStore(storage.business.db);
          return (
            store.pendingTaskEvidenceCount(fixture.roleId, taskId) === 0 &&
            store.listFinishedTasksNeedingTrigger(fixture.roleId).length === 0
          );
        }),
      );
      assert.equal(memoryCalls, 1);
    } finally {
      scanSpy.restore();
      await fixture.close();
    }
  }
});

test("定时器读取绑定或角色库暂不可用时不崩溃且恢复后继续处理已持久化触发（283 §24）", { timeout: 60_000 }, async () => {
  // 1) 在 Node 默认设置（未处理拒绝直接终止进程）的隔离进程中，通过真实手动整理接口复验 canScheduleNow 抛出 SQLITE_BUSY：
  //    接口返回 202，模型调用完成且工具证据已处理，进程保持存活并通过健康检查。
  {
    const backendRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const probeScriptPath = path.join(
      os.tmpdir(),
      `nowadays-283-24-probe-${randomUUID()}.mts`,
    );
    const probeScript = `
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ModelBindingResolver } from ${JSON.stringify(pathToFileURL(path.join(backendRoot, "src/application/resources/model-binding-resolver.ts")).href)};
import { createBackendApp, listen } from ${JSON.stringify(pathToFileURL(path.join(backendRoot, "src/bootstrap/app.ts")).href)};
import { MemoryStore } from ${JSON.stringify(pathToFileURL(path.join(backendRoot, "src/storage/memory/memory-store.ts")).href)};
import { createFixtureWithModel, ScriptedChatModel, withStorage } from ${JSON.stringify(pathToFileURL(path.join(backendRoot, "tests/fixtures/conversation-fixture.ts")).href)};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitUntil(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  throw new Error("WAIT_UNTIL_TIMEOUT");
}

let memoryCalls = 0;
let injectedBusy = false;
const originalResolveMemory = ModelBindingResolver.prototype.resolveMemory;
ModelBindingResolver.prototype.resolveMemory = function (roleId: string) {
  if (!injectedBusy && (new Error().stack ?? "").includes("canScheduleNow")) {
    injectedBusy = true;
    throw new Error("SQLITE_BUSY: database is locked");
  }
  return originalResolveMemory.call(this, roleId);
};

const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
  disableMemoryRuntime: false,
  memoryModelFactory: () => ({
    async form(input) {
      memoryCalls += 1;
      return {
        operations: input.evidence.map((item, index) => ({
          op: "create_event" as const,
          localKey: \`child-busy-\${index}\`,
          title: "隔离进程整理事件",
          summary: "canScheduleNow 注入 SQLITE_BUSY 后进程不崩溃。",
          occurredAtStart: item.occurredAt,
          experienceDate: item.localDate,
          evidenceIds: [item.evidenceId],
        })),
      };
    },
  }),
});

try {
  const port = await listen(fixture.app.server);
  const base = \`http://127.0.0.1:\${port}\`;
  const taskId = withStorage(fixture, (storage) => {
    const execution = storage.business.createExecution({
      roleId: fixture.roleId,
      triggerType: "user_message",
    });
    const task = storage.business.createTask({
      roleId: fixture.roleId,
      goal: "隔离验证任务",
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
      stepKey: "step-1",
      toolName: "read_file",
      args: { path: "notes.md" },
    });
    storage.business.markToolCallRunning(
      fixture.roleId,
      call.toolCall.toolCallId,
    );
    storage.business.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: call.toolCall.toolCallId,
      status: "success",
      rawResponse: { content: "隔离进程工具证据" },
      adaptedResult: { text: "隔离进程工具证据" },
      diagnosticCode: null,
    });
    storage.business.commitExecution({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      stateVersionCommitted: storage.business.getState(fixture.roleId).stateVersion,
    });
    return task.taskId;
  });

  const triggerRes = await fetch(\`\${base}/v1/roles/\${fixture.roleId}/memory/batches\`, {
    method: "POST",
  });
  assert.equal(triggerRes.status, 202);

  await waitUntil(() =>
    injectedBusy &&
    memoryCalls === 1 &&
    withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).pendingTaskEvidenceCount(fixture.roleId, taskId) === 0,
    ),
  );

  // 等待足够久确认无未处理 Promise 拒绝触发进程退出，且退避重查不重复调用模型。
  await delay(450);
  const health = await fetch(\`\${base}/v1/health\`);
  assert.equal(health.status, 200);
  assert.equal(memoryCalls, 1);
} finally {
  ModelBindingResolver.prototype.resolveMemory = originalResolveMemory;
  await fixture.close();
}
`;
    fs.writeFileSync(probeScriptPath, probeScript, "utf8");
    try {
      const childResult = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", probeScriptPath],
          { cwd: backendRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          resolve({ code, signal, stdout, stderr });
        });
      });
      assert.equal(
        childResult.code,
        0,
        `隔离进程应保持存活并正常退出: code=${childResult.code}, signal=${childResult.signal}, stderr=${childResult.stderr}`,
      );
    } finally {
      fs.rmSync(probeScriptPath, { force: true });
    }
  }

  // 2) 定时器收尾读取绑定或打开角色库暂不可用（SQLITE_BUSY）后恢复，已持久化的手动触发应自动继续整理完成。
  for (const mode of ["canScheduleNow", "armTimerOpen"] as const) {
    let memoryCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `busy-recover-${mode}-${index}`,
            title: "锁冲突恢复整理",
            summary: "存储恢复后退避定时器自动消费已持久化触发。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const originalResolveMemory = ModelBindingResolver.prototype.resolveMemory;
    const originalOpenExisting = RoleAccess.prototype.borrow;
    let busyLocked = false;
    let armFailHits = 0;

    if (mode === "canScheduleNow") {
      ModelBindingResolver.prototype.resolveMemory = function (roleId: string) {
        if (busyLocked) {
          const stack = new Error().stack ?? "";
          if (stack.includes("canScheduleNow")) {
            armFailHits += 1;
          }
          if (stack.includes("runOnce") || stack.includes("canScheduleNow")) {
            throw new Error("SQLITE_BUSY: simulated busy binding lookup");
          }
        }
        return originalResolveMemory.call(this, roleId);
      };
    } else {
      RoleAccess.prototype.borrow = (function (this: RoleAccess, ...args: Parameters<RoleAccess["borrow"]>) {
        if (busyLocked) {
          const stack = new Error().stack ?? "";
          const inDirectRunOnce =
            stack.includes("runOnce") && !stack.includes("resolveMemory");
          const inDirectArmTimer =
            stack.includes("armTimer") && !stack.includes("canScheduleNow");
          if (inDirectArmTimer) {
            armFailHits += 1;
          }
          if (inDirectRunOnce || inDirectArmTimer) {
            throw new Error("SQLITE_BUSY: simulated busy role storage");
          }
        }
        return originalOpenExisting.apply(this, args);
      }) as RoleAccess["borrow"];
    }

    try {
      const base = await start(fixture);
      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        `存储恢复-${mode}`,
        "待恢复整理的工具证据",
      );

      busyLocked = true;
      const res = await api(
        base,
        "POST",
        `/v1/roles/${fixture.roleId}/memory/batches`,
      );
      assert.equal(res.status, 202);

      await waitUntil(() => armFailHits >= 1);
      await delay(50);
      assert.equal(memoryCalls, 0);
      assert.equal(unhandled.length, 0);

      // 解除存储锁，不额外发唤醒请求，等待短退避定时器自动恢复处理持久化触发。
      busyLocked = false;
      await waitUntil(() =>
        memoryCalls === 1 &&
        withStorage(fixture, (storage) => {
          const store = new MemoryStore(storage.business.db);
          const pendingTriggers = store.listPendingTriggers(fixture.roleId);
          return (
            pendingTriggers.length === 0 &&
            store.pendingTaskEvidenceCount(fixture.roleId, taskId) === 0
          );
        }),
      );

      const health = await api(base, "GET", "/v1/health");
      assert.equal(health.status, 200);
      assert.equal(memoryCalls, 1);
      assert.equal(unhandled.length, 0);
    } finally {
      busyLocked = false;
      ModelBindingResolver.prototype.resolveMemory = originalResolveMemory;
      RoleAccess.prototype.borrow = originalOpenExisting;
      process.off("unhandledRejection", onUnhandled);
      await fixture.close();
    }
  }
});

test("启动读库失败后恢复遗漏的中断批次并继续整理且不重置运行中批次（283 §25）", async () => {
  for (const mode of [
    "autoRecovery",
    "persistedTrigger",
    "immediateManual",
    "missingPathManual",
    "invalidPathManual",
  ] as const) {
    let phase = 1;
    let memoryCalls = 0;
    let liveGate = deferred<void>();
    let liveGateCalls = 0;
    const memoryModel: MemoryModelPort = {
      async form(input) {
        if (phase === 2) {
          liveGateCalls += 1;
          await liveGate.promise;
        }
        memoryCalls += 1;
        return {
          operations: input.evidence.map((item, index) => ({
            op: "create_event" as const,
            localKey: `startup-recover-${mode}-${phase}-${index}`,
            title: "启动读库恢复整理",
            summary: "存储恢复后先补齐遗漏的中断批次恢复，再完成待处理整理。",
            occurredAtStart: item.occurredAt,
            experienceDate: item.localDate,
            evidenceIds: [item.evidenceId],
          })),
        };
      },
    };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
    });
    const originalOpenExisting = RoleAccess.prototype.borrow;
    let reopened: BackendApp | null = null;
    let startupBusyLocked = false;

    try {
      await start(fixture);
      const taskId = seedTaskWithPendingToolEvidence(
        fixture,
        `启动遗留批次-${mode}`,
        "中断批次遗留的工具证据",
      );
      await fixture.app.close();

      // 用真实存储状态保留“已消费触发 + 处于 running 的未完成批次 + processing 证据”，模拟整理中途断开。
      const crashedAt = new Date().toISOString();
      const targetDbPath = withStorage(fixture, (storage) => {
        const store = new MemoryStore(storage.business.db);
        store.enqueueTrigger({
          roleId: fixture.roleId,
          kind: "retry",
          now: crashedAt,
        });
        const started = store.startBatch({
          roleId: fixture.roleId,
          budgetChars: 8_000,
          outputReserveChars: 1_000,
          now: crashedAt,
        });
        assert.ok(started);
        assert.equal(started.batch.status, "running");
        assert.equal(store.listPendingTriggers(fixture.roleId).length, 0);
        if (mode === "persistedTrigger") {
          store.enqueueTrigger({
            roleId: fixture.roleId,
            kind: "manual",
            now: crashedAt,
          });
          assert.equal(store.listPendingTriggers(fixture.roleId).length, 1);
        }
        return {
          batchId: started.batch.batchId,
          dbPath: storage.paths.businessDatabasePath,
        };
      });

      // 重启时仅给该角色的 MemoryRuntime 存储打开注入临时 SQLITE_BUSY。
      let startupBusyHits = 0;
      startupBusyLocked = true;
      RoleAccess.prototype.borrow = (function (
        this: RoleAccess, ...args: Parameters<RoleAccess["borrow"]>
      ) {
        if (
          startupBusyLocked &&
          args[0] === fixture.roleId
        ) {
          const stack = new Error().stack ?? "";
          if (
            stack.includes("memory-runtime") &&
            (stack.includes("recoverOnStartup") ||
              stack.includes("armTimer") ||
              stack.includes("runOnce"))
          ) {
            startupBusyHits += 1;
            if (mode === "missingPathManual") {
              throw new Error("ROLE_STORAGE_PATH_MISSING:business database");
            }
            if (mode === "invalidPathManual") {
              throw new Error("ROLE_STORAGE_PATH_INVALID:business database");
            }
            throw new Error("SQLITE_BUSY: simulated startup lock on role storage");
          }
        }
        return originalOpenExisting.apply(this, args);
      }) as RoleAccess["borrow"];

      reopened = createBackendApp(
        parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
        {
          typingMs: 1000,
          timeZone: "Asia/Shanghai",
          modelPortFactory: () => fixture.model,
          disableMemoryRuntime: false,
          memoryModelFactory: () => memoryModel,
        },
      );
      const port = await listen(reopened.server, 0, "127.0.0.1");
      const reopenedBase = `http://127.0.0.1:${port}`;

      const health = await api(reopenedBase, "GET", "/v1/health");
      assert.equal(health.status, 200);
      assert.ok(startupBusyHits >= 1);
      assert.equal(memoryCalls, 0);
      if (mode === "missingPathManual" || mode === "invalidPathManual") {
        const hits = startupBusyHits;
        await delay(350);
        assert.equal(startupBusyHits, hits, "缺失或非法路径不应被定时轮询");
      }
      assert.equal(
        withStorage(fixture, (storage) =>
          new MemoryStore(storage.business.db).getBatch(
            fixture.roleId,
            targetDbPath.batchId,
          ).status,
        ),
        "running",
      );

      // 解除文件锁，不再次重启：
      // - autoRecovery：等待退避重查自动把遗留批次置为 failed 并完成后续整理；
      // - immediateManual：立即发起 POST .../memory/batches 应先完成中断批次恢复再整理，不再冲突吞零调用。
      startupBusyLocked = false;
      if (mode === "immediateManual" || mode === "missingPathManual" || mode === "invalidPathManual") {
        const manual = await api(
          reopenedBase,
          "POST",
          `/v1/roles/${fixture.roleId}/memory/batches`,
        );
        assert.equal(manual.status, 202);
      }

      await waitUntil(() =>
        memoryCalls === 1 &&
        withStorage(fixture, (storage) => {
          const store = new MemoryStore(storage.business.db);
          const stale = store.getBatch(fixture.roleId, targetDbPath.batchId);
          return (
            stale.status === "failed" &&
            stale.lastErrorCode === "PROCESS_INTERRUPTED" &&
            store.listPendingTriggers(fixture.roleId).length === 0 &&
            store.pendingTaskEvidenceCount(fixture.roleId, taskId) === 0
          );
        }),
      );
      assert.equal(memoryCalls, 1);

      // 解除遗留问题后再发起手动整理，也必须仍能正常继续处理新增待整理证据。
      if (mode === "autoRecovery") {
        const followUpTask = seedTaskWithPendingToolEvidence(
          fixture,
          `恢复后再整理-${mode}`,
          "解锁恢复后新增工具证据",
        );
        const manual = await api(
          reopenedBase,
          "POST",
          `/v1/roles/${fixture.roleId}/memory/batches`,
        );
        assert.equal(manual.status, 202);
        await waitUntil(() =>
          memoryCalls === 2 &&
          withStorage(fixture, (storage) =>
            new MemoryStore(storage.business.db).pendingTaskEvidenceCount(
              fixture.roleId,
              followUpTask,
            ) === 0,
          ),
        );
      }

      // 守护条件：运行中的正常批次不得因后续触发或定时器重查而被重置为 failed。
      phase = 2;
      const callsBeforeLive = memoryCalls;
      const liveTask = seedTaskWithPendingToolEvidence(
        fixture,
        `运行中守护-${mode}`,
        "正在整理的在途工具证据",
      );
      const triggerLive = await api(
        reopenedBase,
        "POST",
        `/v1/roles/${fixture.roleId}/memory/batches`,
      );
      assert.equal(triggerLive.status, 202);
      await waitUntil(() => liveGateCalls === 1);

      const runningBatchId = withStorage(fixture, (storage) => {
        const row = storage.business.db
          .prepare(
            "SELECT batch_id FROM memory_batches WHERE role_id = ? AND status = 'running'",
          )
          .get(fixture.roleId) as { batch_id: string } | undefined;
        return row?.batch_id ?? null;
      });
      assert.ok(runningBatchId);

      // 在途期间再次触发手动整理与 kick，并越过短退避窗口，运行中的正常批次必须保持 running。
      const concurrentManual = await api(
        reopenedBase,
        "POST",
        `/v1/roles/${fixture.roleId}/memory/batches`,
      );
      assert.equal(concurrentManual.status, 202);
      reopened.conversation.wakePendingWork(fixture.roleId);
      await delay(350);

      assert.equal(liveGateCalls, 1);
      assert.equal(memoryCalls, callsBeforeLive);
      assert.equal(
        withStorage(fixture, (storage) =>
          new MemoryStore(storage.business.db).getBatch(
            fixture.roleId,
            runningBatchId,
          ).status,
        ),
        "running",
      );

      liveGate.resolve();
      await waitUntil(() =>
        withStorage(fixture, (storage) => {
          const store = new MemoryStore(storage.business.db);
          return (
            store.getBatch(fixture.roleId, runningBatchId).status === "completed" &&
            store.pendingTaskEvidenceCount(fixture.roleId, liveTask) === 0
          );
        }),
      );
      // 收尾校验不存在被误标记为 PROCESS_INTERRUPTED 的新批次（仅允许启动恢复那 1 条遗留批次）。
      const interruptedCount = withStorage(fixture, (storage) => {
        const row = storage.business.db
          .prepare(
            "SELECT COUNT(*) AS c FROM memory_batches WHERE role_id = ? AND last_error_code = 'PROCESS_INTERRUPTED'",
          )
          .get(fixture.roleId) as { c: number };
        return row.c;
      });
      assert.equal(interruptedCount, 1);
    } finally {
      startupBusyLocked = false;
      liveGate.resolve();
      RoleAccess.prototype.borrow = originalOpenExisting;
      await reopened?.close();
      await fixture.close();
    }
  }
});

test("空手动整理不反复轮询，新增证据后仍可整理", async () => {
  let calls = 0;
  const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
    disableMemoryRuntime: false,
    memoryModelFactory: () => ({
      async form(input) {
        calls++;
        return { operations: input.evidence.map((item, index) => ({
          op: "create_event" as const, localKey: `empty-${index}`,
          title: "新增证据", summary: "空整理后继续处理新增证据。",
          occurredAtStart: item.occurredAt, experienceDate: item.localDate,
          evidenceIds: [item.evidenceId],
        })) };
      },
    }),
  });
  const originalOpen = RoleAccess.prototype.borrow;
  let runs = 0;
  try {
    const base = await start(fixture);
    RoleAccess.prototype.borrow = (function (this: RoleAccess, ...args: Parameters<RoleAccess["borrow"]>) {
      if ((new Error().stack ?? "").includes("runOnce")) runs++;
      return originalOpen.apply(this, args);
    }) as RoleAccess["borrow"];
    assert.equal((await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status, 202);
    await waitUntil(() => runs > 0);
    await delay(100);
    const afterFirst = runs;
    await delay(700);
    assert.equal(runs, afterFirst, "空整理不应触发退避轮询");
    assert.equal(calls, 0);
    const taskId = seedTaskWithPendingToolEvidence(fixture, "空整理后", "新增待整理证据");
    withStorage(fixture, (storage) => {
      storage.business.db.prepare(`UPDATE evidence_processing SET status = 'deferred',
        deferred_after_sequence = (SELECT MAX(role_sequence) FROM evidence_records WHERE role_id = ?)
        WHERE evidence_id IN (SELECT evidence_id FROM evidence_records WHERE role_id = ? AND task_id = ?)`)
        .run(fixture.roleId, fixture.roleId, taskId);
    });
    assert.equal((await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status, 202);
    await waitUntil(() => calls === 1 && withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).pendingTaskEvidenceCount(fixture.roleId, taskId) === 0));
  } finally {
    RoleAccess.prototype.borrow = originalOpen;
    await fixture.close();
  }
});

test("手动整理覆盖多个延后窗口且不重复领取本轮再次延后的证据", async () => {
  const seen: string[] = [];
  const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
    disableMemoryRuntime: false,
    memoryModelFactory: () => ({ async form(input) {
      seen.push(...input.evidence.map((item) => item.evidenceId));
      return { operations: input.evidence.map((item) => ({
        op: "defer" as const, evidenceIds: [item.evidenceId], reason: "继续等待",
      })) };
    } }),
  });
  try {
    const base = await start(fixture);
    const first = seedTaskWithPendingToolEvidence(fixture, "窗口一", "证据一");
    const second = seedTaskWithPendingToolEvidence(fixture, "窗口二", "证据二");
    withStorage(fixture, (storage) => {
      storage.business.db.prepare(`UPDATE evidence_records SET window_id = ? WHERE task_id = ?`)
        .run(fixture.windowId, second);
      storage.business.db.prepare(`UPDATE evidence_processing SET status = 'deferred',
        deferred_after_sequence = (SELECT MAX(role_sequence) FROM evidence_records WHERE role_id = ?)
        WHERE evidence_id IN (SELECT evidence_id FROM evidence_records WHERE role_id = ? AND task_id IN (?, ?))`)
        .run(fixture.roleId, fixture.roleId, first, second);
    });
    assert.equal((await api(base, "POST", `/v1/roles/${fixture.roleId}/memory/batches`)).status, 202);
    await waitUntil(() => seen.length >= 2);
    await delay(700);
    assert.equal(seen.length, 2);
    assert.equal(new Set(seen).size, 2);
    assert.equal(withStorage(fixture, (storage) => new MemoryStore(storage.business.db).listPendingTriggers(fixture.roleId).length), 0);
  } finally {
    await fixture.close();
  }
});

test("手动整理批次间重启保留检查点并继续剩余窗口", async () => {
  const seen: string[] = [];
  const memoryModel: MemoryModelPort = { async form(input) {
    seen.push(...input.evidence.map((item) => item.evidenceId));
    return { operations: input.evidence.map((item) => ({ op: "defer" as const,
      evidenceIds: [item.evidenceId], reason: "继续等待" })) };
  } };
  const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
    disableMemoryRuntime: false, memoryModelFactory: () => memoryModel,
  });
  let reopened: BackendApp | null = null;
  try {
    await start(fixture);
    const first = seedTaskWithPendingToolEvidence(fixture, "重启窗口一", "证据一");
    const second = seedTaskWithPendingToolEvidence(fixture, "重启窗口二", "证据二");
    await fixture.app.close();
    const firstEvidence = withStorage(fixture, (storage) => {
      const db = storage.business.db;
      db.prepare("UPDATE evidence_records SET window_id = ? WHERE task_id = ?").run(fixture.windowId, second);
      db.prepare(`UPDATE evidence_processing SET status = 'deferred', deferred_after_sequence =
        (SELECT MAX(role_sequence) FROM evidence_records WHERE role_id = ?)
        WHERE evidence_id IN (SELECT evidence_id FROM evidence_records WHERE task_id IN (?, ?))`)
        .run(fixture.roleId, first, second);
      const store = new MemoryStore(db);
      const now = new Date().toISOString();
      store.enqueueTrigger({ roleId: fixture.roleId, kind: "manual", now });
      const batch = store.startBatch({ roleId: fixture.roleId, budgetChars: 8000,
        outputReserveChars: 1000, includeDeferred: true, now });
      assert.ok(batch);
      const id = batch.evidence[0]!.evidence.evidenceId;
      db.prepare("UPDATE evidence_processing SET status = 'deferred', deferred_after_sequence = 1 WHERE evidence_id = ?").run(id);
      db.prepare("UPDATE memory_batches SET status = 'completed', finished_at = ? WHERE batch_id = ?").run(now, batch.batch.batchId);
      return id;
    });
    reopened = createBackendApp(parseBackendConfig(["--app-root", fixture.root, "--port", "0"]), {
      typingMs: 1000, timeZone: "Asia/Shanghai", modelPortFactory: () => fixture.model,
      disableMemoryRuntime: false, memoryModelFactory: () => memoryModel,
    });
    await listen(reopened.server, 0, "127.0.0.1");
    await waitUntil(() => seen.length === 1);
    await delay(700);
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], firstEvidence);
    assert.equal(withStorage(fixture, (storage) => new MemoryStore(storage.business.db).listPendingTriggers(fixture.roleId).length), 0);
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});
