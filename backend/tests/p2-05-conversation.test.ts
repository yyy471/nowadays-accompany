import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ModelEvent } from "../src/domain/model.js";
import {
  GatedChatModel,
  createFixture,
  createFixtureWithModel,
  seedEvent,
  withStorage,
} from "./p2-05-fixture.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function submit(fixture: ReturnType<typeof createFixture>, content: string): string {
  const submissionId = randomUUID();
  fixture.app.conversation.submitMessage(
    fixture.roleId,
    fixture.windowId,
    { content, submissionId, sourcePlatform: "nowadays" },
  );
  return submissionId;
}

test("typing state delays the decision and multiple pending messages share one turn", { timeout: 15_000 }, async () => {
  // 输入窗口留出余量，避免满载并行测试时在两次提交之间提前到期。
  const fixture = createFixture(
    [
      [
        { type: "text_delta", text: "我一起回应。" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    { typingMs: 3000 },
  );
  try {
    fixture.app.conversation.updateInputState({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      clientId: "client-1",
      typing: true,
    });
    submit(fixture, "第一句");
    submit(fixture, "第二句");
    const before = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM executions WHERE role_id = ?")
        .get(fixture.roleId) as { count: number },
    );
    assert.equal(before.count, 0);
    fixture.app.conversation.updateInputState({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      clientId: "client-1",
      typing: false,
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.deepEqual(
      messages.items.map((message) => [message.sender, message.content]),
      [
        ["user", "第一句"],
        ["user", "第二句"],
        ["assistant", "我一起回应。"],
      ],
    );
    const model = fixture.model as unknown as { requests: Array<{ messages: Array<{ role: string; content: string }> }> };
    assert.equal(model.requests.length, 1);
    assert.deepEqual(
      model.requests[0]?.messages.map((message) => [message.role, message.content]),
      [
        ["user", "第一句"],
        ["user", "第二句"],
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("duplicate submission neither interrupts nor starts a second decision", { timeout: 15_000 }, async () => {
  const model = new GatedChatModel();
  const fixture = createFixtureWithModel(model);
  try {
    const submissionId = randomUUID();
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      { content: "先回答这个", submissionId, sourcePlatform: "nowadays" },
    );
    await model.started.promise;
    const duplicate = fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      { content: "先回答这个", submissionId, sourcePlatform: "nowadays" },
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.decisionScheduled, false);
    const running = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT status FROM executions WHERE role_id = ?")
        .all(fixture.roleId) as Array<{ status: string }>,
    );
    assert.deepEqual(running.map((row) => row.status), ["running"]);
    model.release.resolve(undefined);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.filter((message) => message.sender === "assistant").length, 1);
    assert.equal(model.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("a real new message supersedes the running reply and preserves its partial text in order", { timeout: 15_000 }, async () => {
  const model = new GatedChatModel();
  const fixture = createFixtureWithModel(model);
  try {
    const first = randomUUID();
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      { content: "旧问题", submissionId: first, sourcePlatform: "nowadays" },
    );
    await model.started.promise;
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      { content: "换个问题", submissionId: randomUUID(), sourcePlatform: "nowadays" },
    );
    const afterSupersede = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC")
        .all(fixture.roleId) as Array<{ status: string }>,
    );
    assert.deepEqual(
      afterSupersede.map((row) => row.status),
      ["superseded", "running"],
    );
    model.release.resolve(undefined);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.deepEqual(
      messages.items.map((message) => [message.sender, message.status, message.content]),
      [
        ["user", "received", "旧问题"],
        ["assistant", "interrupted", "旧"],
        ["user", "received", "换个问题"],
        ["assistant", "completed", "新回复"],
      ],
    );
    const detail = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare("SELECT execution_id, status, decision_round FROM executions WHERE role_id = ? ORDER BY rowid ASC")
        .all(fixture.roleId) as Array<{
        execution_id: string;
        status: string;
        decision_round: number | null;
      }>;
      const events = storage.business.db
        .prepare("SELECT event_type FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC")
        .all(executions[0]!.execution_id) as Array<{ event_type: string }>;
      return { executions, events };
    });
    assert.deepEqual(detail.executions.map((row) => row.status), ["superseded", "completed"]);
    assert.equal(detail.executions[0]?.decision_round, null);
    assert.equal(detail.executions[1]?.decision_round, 1);
    assert.ok(detail.events.some((event) => event.event_type === "message_interrupted"));
    assert.ok(detail.events.some((event) => event.event_type === "execution_superseded"));
    assert.equal(model.requests.length, 2);
    assert.deepEqual(
      model.requests[1]?.messages.map((message) => [message.role, message.content]),
      [
        ["user", "旧问题"],
        ["assistant", "旧\n[以上回复中断，未完成]"],
        ["user", "换个问题"],
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("each model round resolves the same resource's latest config", { timeout: 15_000 }, async () => {
  const observed: string[] = [];
  let fixture: ReturnType<typeof createFixtureWithModel>;
  let rounds = 0;
  fixture = createFixtureWithModel(
    { async *stream() {} },
    {
      modelPortFactory(binding) {
        return {
          async *stream(): AsyncIterable<ModelEvent> {
            observed.push(binding.config.baseUrl);
            rounds += 1;
            if (rounds === 1) {
              fixture.app.services.resources.update(binding.resourceId, {
                config: {
                  ...binding.config,
                  baseUrl: "http://new-config.invalid/v1",
                },
              });
              yield {
                type: "tool_call",
                callId: "wire-refresh",
                name: "memory_search",
                arguments: { query: "无匹配" },
              };
              yield { type: "completed", stopReason: "tool_calls" };
              return;
            }
            yield { type: "text_delta", text: "配置已更新。" };
            yield { type: "completed", stopReason: "stop" };
          },
        };
      },
    },
  );
  try {
    submit(fixture, "测试配置刷新");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.deepEqual(observed, [
      "http://offline.invalid/v1",
      "http://new-config.invalid/v1",
    ]);
    const calls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT resource_id FROM model_calls WHERE execution_id = (SELECT execution_id FROM executions WHERE role_id = ? ORDER BY rowid DESC LIMIT 1) ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{ resource_id: string }>,
    );
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map((call) => call.resource_id)).size, 1);
  } finally {
    await fixture.close();
  }
});

test("state_update patches are merged only in the completion transaction", { timeout: 15_000 }, async () => {
  const fixture = createFixture([
    [
      {
        type: "tool_call",
        callId: "wire-state-1",
        name: "state_update",
        arguments: { patch: { mood: "开心" } },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "现在心情很好。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    submit(fixture, "今天感觉怎么样？");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const role = withStorage(fixture, (storage) =>
      storage.business.getRole(fixture.roleId),
    );
    assert.deepEqual(role.state, { mood: "开心" });
    assert.equal(role.stateVersion, 2);
    const model = fixture.model as unknown as {
      requests: Array<{
        messages: Array<{ role: string; toolCallId?: string; content?: string }>;
      }>;
    };
    assert.equal(model.requests.length, 2);
    assert.deepEqual(
      model.requests[1]?.messages.map((message) => message.role),
      ["user", "assistant", "tool"],
    );
    assert.equal(model.requests[1]?.messages[2]?.toolCallId, "wire-state-1");
    const toolMessage = model.requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    assert.equal(
      (JSON.parse(toolMessage?.content ?? "{}") as { status?: string }).status,
      "success",
    );
  } finally {
    await fixture.close();
  }
});

test("a rejected state_update leaves the role state unchanged", { timeout: 15_000 }, async () => {
  const fixture = createFixture([
    [
      {
        type: "tool_call",
        callId: "wire-state-bad",
        name: "state_update",
        arguments: { patch: "不是对象" },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "状态没有更新。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    submit(fixture, "试着更新状态");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const role = withStorage(fixture, (storage) =>
      storage.business.getRole(fixture.roleId),
    );
    assert.deepEqual(role.state, { mood: "平静" });
    const model = fixture.model as unknown as {
      requests: Array<{ messages: Array<{ role: string; content: string }> }>;
    };
    const toolMessage = model.requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    const result = JSON.parse(toolMessage?.content ?? "{}") as {
      status?: string;
      diagnosticCode?: string;
    };
    assert.equal(result.status, "failed");
    assert.equal(result.diagnosticCode, "INVALID_TOOL_ARGUMENTS");
  } finally {
    await fixture.close();
  }
});

test("typing expiry automatically starts the decision at the fixed short test interval", { timeout: 15_000 }, async () => {
  const fixture = createFixture(
    [
      [
        { type: "text_delta", text: "收到。" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    { typingMs: 40 },
  );
  try {
    fixture.app.conversation.updateInputState({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      clientId: "client-expire",
      typing: true,
    });
    submit(fixture, "打完后自动回复");
    await delay(120);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.at(-1)?.content, "收到。");
  } finally {
    await fixture.close();
  }
});

test("decisions across windows stay serial in earliest-message order", { timeout: 15_000 }, async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "先回主窗口。" },
      { type: "completed", stopReason: "stop" },
    ],
    [
      { type: "text_delta", text: "再回另一个窗口。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const secondWindow = fixture.app.services.roles.createWindow(
      fixture.roleId,
      { kind: "custom", source: "nowadays" },
    );
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "主窗口先说",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await delay(5);
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      secondWindow.windowId,
      {
        content: "另一个窗口后说",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const model = fixture.model as unknown as {
      requests: Array<{ messages: Array<{ role: string; content: string }> }>;
    };
    assert.equal(model.requests.length, 2);
    assert.equal(model.requests[0]?.messages.at(-1)?.content, "主窗口先说");
    assert.equal(model.requests[1]?.messages.at(-1)?.content, "另一个窗口后说");
    const executions = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT window_id, status FROM executions WHERE role_id = ? ORDER BY rowid ASC")
        .all(fixture.roleId) as Array<{ window_id: string; status: string }>,
    );
    assert.deepEqual(
      executions.map((execution) => [execution.window_id, execution.status]),
      [
        [fixture.windowId, "completed"],
        [secondWindow.windowId, "completed"],
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("automatic recall and agent deep search use real events and original evidence", { timeout: 20_000 }, async () => {
  const contextual: import("../src/domain/model.js").ModelPort = {
    stream: async function* (request) {
      const system = request.system;
      const match = /id=([0-9a-f-]{36})/.exec(system);
      const toolMessages = request.messages.filter(
        (message) => message.role === "tool",
      );
      if (!system.includes("杭州旧书店") || match === null) {
        throw new Error("AUTO_RECALL_MISSING");
      }
      if (toolMessages.length === 0) {
        yield {
          type: "tool_call",
          callId: "wire-memory-event",
          name: "memory_event",
          arguments: { eventId: match[1] },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      if (toolMessages.length === 1) {
        const content = String(toolMessages[0]?.content ?? "");
        const evidenceId = /"evidenceId":"([0-9a-f-]{36})"/.exec(content)?.[1];
        if (evidenceId === undefined) {
          throw new Error("EVIDENCE_ID_MISSING");
        }
        yield {
          type: "tool_call",
          callId: "wire-memory-evidence",
          name: "memory_evidence",
          arguments: { evidenceId },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      yield {
        type: "text_delta",
        text: "记得，是那天在杭州旧书店看到旧地图。",
      };
      yield { type: "completed", stopReason: "stop" };
    },
  };
  const fixture = createFixtureWithModel(contextual);
  try {
    const seeded = seedEvent(fixture, {
      content: "那天我和小林去了杭州旧书店，买了植物书和旧地图。",
      title: "杭州旧书店",
      summary: "和小林去杭州旧书店，买了植物书和旧地图。",
      occurredAt: "2026-11-04T03:00:00.000Z",
      tags: { place: ["杭州"], person: ["小林"], topic: ["旧书店"] },
    });
    submit(fixture, "你还记得杭州旧书店吗？");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const detail = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare("SELECT execution_id FROM executions WHERE role_id = ? AND status = 'completed' ORDER BY rowid DESC LIMIT 1")
        .get(fixture.roleId) as { execution_id: string };
      const recalls = storage.business.db
        .prepare("SELECT record_id, COUNT(*) AS count FROM memory_recalls WHERE execution_id = ? GROUP BY record_id")
        .all(execution.execution_id) as Array<{ record_id: string; count: number }>;
      const retrievals = storage.business.db
        .prepare("SELECT mode, status FROM retrieval_queries WHERE execution_id = ? ORDER BY rowid ASC")
        .all(execution.execution_id) as Array<{ mode: string; status: string }>;
      const toolCalls = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE execution_id = ?")
        .get(execution.execution_id) as { count: number };
      return { execution, recalls, retrievals, toolCalls };
    });
    assert.deepEqual(detail.recalls, [{ record_id: seeded.eventId, count: 1 }]);
    assert.ok(detail.retrievals.some((item) => item.mode === "auto" && item.status === "succeeded"));
    assert.equal(detail.toolCalls.count, 0);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    const reply = messages.items.at(-1);
    assert.equal(reply?.sender, "assistant");
    assert.match(reply?.content ?? "", /杭州旧书店/);
  } finally {
    await fixture.close();
  }
});
