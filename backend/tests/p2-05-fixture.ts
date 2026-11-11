import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBackendApp, type BackendApp, type BackendAppOptions } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { localDateFromIso, registerMessageEvidence } from "../src/storage/evidence.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import type { BindingCapability } from "../src/storage/role-store.js";

export class ScriptedChatModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly scripts: Array<
    ModelEvent[] | ((request: ModelRequest) => ModelEvent[])
  >;

  constructor(
    scripts: Array<ModelEvent[] | ((request: ModelRequest) => ModelEvent[])>,
  ) {
    this.scripts = [...scripts];
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error("SCRIPT_EXHAUSTED");
    }
    const events = typeof script === "function" ? script(request) : script;
    for (const event of events) {
      yield event;
    }
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class GatedChatModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  readonly started = deferred<void>();
  readonly release = deferred<void>();
  private calls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "text_delta", text: "旧" };
      this.started.resolve();
      await this.release.promise;
      yield { type: "text_delta", text: "回复" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    yield { type: "text_delta", text: "新回复" };
    yield { type: "completed", stopReason: "stop" };
  }
}

export interface Fixture {
  app: BackendApp;
  root: string;
  roleId: string;
  windowId: string;
  model: ModelPort;
  close(): Promise<void>;
}

export function createFixtureWithModel(
  model: ModelPort,
  options: BackendAppOptions = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-05-"));
  const app = createBackendApp(
    parseBackendConfig(["--app-root", root, "--port", "0"]),
    {
      typingMs: 1000,
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
      ...options,
    },
  );
  const role = app.services.roles.createRole({
    displayName: "阿澄",
    definition: { text: "你是阿澄，记得与用户共同经历的事情。" },
    state: { mood: "平静" },
  });
  const resource = app.services.resources.create({
    kind: "model",
    name: "离线对话模型",
    config: {
      protocol: "openai-chat",
      baseUrl: "http://offline.invalid/v1",
    },
  });
  app.services.resources.replaceBindings(role.roleId, [
    {
      capability: "chat_model",
      resourceId: resource.resourceId,
      modelName: "offline-chat",
      enabled: true,
    },
  ]);
  return {
    app,
    root,
    roleId: role.roleId,
    windowId: role.defaultWindowId,
    model,
    async close() {
      await app.close();
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      });
    },
  };
}

export function createFixture(
  scripts: ConstructorParameters<typeof ScriptedChatModel>[0],
  options: BackendAppOptions = {},
): Fixture {
  return createFixtureWithModel(new ScriptedChatModel(scripts), options);
}

export function addBinding(
  fixture: Fixture,
  capability: BindingCapability,
  resourceId: string,
): void {
  const current = fixture.app.services.resources.listBindings(fixture.roleId);
  fixture.app.services.resources.replaceBindings(fixture.roleId, [
    ...current.map((binding) => ({
      capability: binding.capability,
      resourceId: binding.resourceId,
      ...(binding.modelName === null ? {} : { modelName: binding.modelName }),
      enabled: binding.enabled,
    })),
    {
      capability,
      resourceId,
      ...(capability === "chat_model" || capability === "memory_model"
        ? { modelName: "offline-chat" }
        : {}),
      enabled: true,
    },
  ]);
}

/**
 * 直接写存储层关闭资源，模拟「运行期间资源被外部改动」。
 *
 * 正式路径受 236 §8 的占用检查约束：角色开启或任务链未结束时，全局关闭会被
 * 拒（API 层行为见 p15 用例）。这里要观察的是运行中的任务链如何取舍，
 * 所以绕过服务层，直接从存储层改。
 */
export function disableResourceDirect(
  fixture: Fixture,
  resourceId: string,
): void {
  fixture.app.appStore.updateResource({ resourceId, enabled: false });
}

/** 同上，用于「运行期间配置被外部改动」的场景。 */
export function updateResourceConfigDirect(
  fixture: Fixture,
  resourceId: string,
  config: Record<string, unknown>,
): void {
  fixture.app.appStore.updateResource({ resourceId, config });
}

export function withStorage<T>(
  fixture: Fixture,
  action: (storage: RoleStorage) => T,
): T {
  const storage = RoleStorage.openExisting(
    rolePaths(fixture.app.config.dataRoot, fixture.roleId),
  );
  try {
    return action(storage);
  } finally {
    storage.close();
  }
}

export interface SeededEvent {
  eventId: string;
  evidenceId: string;
  messageId: string;
  occurredAt: string;
  experienceDate: string;
}

export function seedEvent(
  fixture: Fixture,
  input: {
    content: string;
    title: string;
    summary: string;
    occurredAt: string;
    tags?: Record<string, string[]>;
  },
): SeededEvent {
  return withStorage(fixture, (storage) => {
    const db = storage.business.db;
    const submitted = storage.business.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: input.content,
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    const seedExecution = storage.business.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
      triggerMessageId: submitted.message.messageId,
    });
    db.prepare(
      "UPDATE executions SET status = 'completed', state_version_committed = 1 WHERE execution_id = ?",
    ).run(seedExecution.executionId);
    db.prepare(
      "UPDATE messages SET processed_by_execution_id = ?, created_at = ?, updated_at = ? WHERE message_id = ?",
    ).run(
      seedExecution.executionId,
      input.occurredAt,
      input.occurredAt,
      submitted.message.messageId,
    );
    registerMessageEvidence(db, {
      roleId: fixture.roleId,
      messageIds: [submitted.message.messageId],
      executionId: seedExecution.executionId,
      timeZone: "Asia/Shanghai",
    });
    const store = new MemoryStore(db);
    const evidence = store
      .listEvidence(fixture.roleId)
      .find((item) => item.sourceId === submitted.message.messageId);
    assert.ok(evidence);
    const experienceDate = localDateFromIso(input.occurredAt, "Asia/Shanghai");
    const event = store.createEvent({
      roleId: fixture.roleId,
      title: input.title,
      summary: input.summary,
      subjectiveExperience: "",
      occurredAtStart: input.occurredAt,
      occurredAtEnd: null,
      experienceDate,
      tags: input.tags ?? {},
      evidenceIds: [evidence.evidenceId],
      currentRound: 0,
      now: "2026-11-03T12:00:00.000Z",
    });
    return {
      eventId: event.eventId,
      evidenceId: evidence.evidenceId,
      messageId: submitted.message.messageId,
      occurredAt: input.occurredAt,
      experienceDate,
    };
  });
}
