import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ModelEvent, ModelRequest } from "../../src/domain/model.js";
import { historyLookupTool } from "../../src/application/conversation/conversation-history.js";
import { RoleAccess } from "../../src/application/role/role-access.js";
import { registerMessageEvidence } from "../../src/storage/memory/evidence.js";
import {
  GatedChatModel,
  createFixture,
  createFixtureWithModel,
  seedEvent,
  withStorage,
} from "../fixtures/conversation-fixture.js";

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

test("继承本机窗口的非本机消息不能使用 user_quote 回查其他直接对话", async () => {
  const found: string[] = [];
  const reply = (text: string): ModelEvent[] => [
    { type: "text_delta", text }, { type: "completed", stopReason: "stop" },
  ];
  const lookup: ModelEvent[] = [
    { type: "tool_call", callId: "look-up-ticket", name: "history_lookup", arguments: { scope: "user_quote", query: "西风票根" } },
    { type: "completed", stopReason: "tool_calls" },
  ];
  const collect = (request: ModelRequest): ModelEvent[] => {
    const outcome = request.messages.filter(message => message.role === "tool").at(-1);
    assert.ok(outcome);
    found.push(outcome.content);
    return reply("查过了。");
  };
  const original = "西风票根的编号是六七一九。";
  const fixture = createFixture([reply("记下了。"), lookup, collect, lookup, collect, lookup, collect]);
  try {
    const { app, roleId } = fixture;
    submit(fixture, original);
    await app.conversation.waitForIdle(roleId);
    for (const platforms of [["qq"], ["nowadays", "qq", "nowadays"], ["nowadays"]]) {
      const direct = app.services.roles.createWindow(roleId, { kind: "custom", source: "nowadays" });
      withStorage(fixture, ({ business }) => {
        for (const sourcePlatform of platforms.slice(0, -1)) {
          business.submitMessage(roleId, direct.windowId, {
            content: "同一批待处理的消息。", sourcePlatform, submissionId: randomUUID(),
          });
        }
      });
      app.conversation.submitMessage(roleId, direct.windowId, {
        content: "请回查票根编号。", sourcePlatform: platforms.at(-1)!, submissionId: randomUUID(),
      });
      await app.conversation.waitForIdle(roleId);
    }
    assert.equal(found.length, 3);
    assert.doesNotMatch(found[0]!, /六七一九/);
    assert.doesNotMatch(found[1]!, /六七一九/);
    assert.match(found[2]!, /西风票根的编号是六七一九/);
  } finally {
    await fixture.close();
  }
});

test("user_quote 只返回同角色、本机直接对话里已处理的用户原文", async () => {
  const reply = (text: string): ModelEvent[] => [
    { type: "text_delta", text }, { type: "completed", stopReason: "stop" },
  ];
  const fixture = createFixture([
    reply("蓝签是我说过的角色台词。"), reply("收到一份对照。"), reply("收到。"), reply("收到。"), reply("我来查一下。"),
  ]);
  try {
    const { app, roleId, windowId } = fixture;
    const original = "蓝签是我姐姐选的，不是我。";
    const submitTo = async (targetWindow: string, sourcePlatform: string, content: string) => {
      const { message } = app.conversation.submitMessage(roleId, targetWindow, {
        content, sourcePlatform, submissionId: randomUUID(),
      });
      await app.conversation.waitForIdle(roleId);
      const record = withStorage(fixture, ({ business }) => business.db.prepare(`SELECT m.message_id AS id,
        m.processed_by_execution_id AS executionId, e.evidence_id AS evidenceId
        FROM messages m JOIN evidence_records e ON e.source_id=m.message_id AND e.source_kind='message'
        WHERE m.message_id=?`).get(message.messageId) as { id: string; executionId: string; evidenceId: string } | undefined);
      assert.ok(record?.executionId);
      return record;
    };
    const makeWindow = (source: string) => app.services.roles.createWindow(roleId, { kind: "custom", source }).windowId;
    const direct = makeWindow("nowadays");
    const privateWindow = makeWindow("nowadays-autonomy");
    const foreign = makeWindow("qq");
    const saved = await submitTo(windowId, "nowadays", original);
    await submitTo(windowId, "qq", "蓝签外部消息混入本机窗口。");
    const privateCall = await submitTo(privateWindow, "nowadays", "蓝签在自主窗口的原文。");
    const foreignCall = await submitTo(foreign, "qq", "蓝签在其他平台窗口说过。");
    const directCall = await submitTo(direct, "nowadays", "请回查我以前说过的话。");
    withStorage(fixture, ({ business }) => {
      const { message } = business.submitMessage(roleId, windowId, {
        content: "蓝签尚未确认处理。", submissionId: randomUUID(), sourcePlatform: "nowadays",
      });
      registerMessageEvidence(business.db, { roleId, messageIds: [message.messageId], executionId: saved.executionId });
    });
    const access = new RoleAccess(app.appStore, app.config.dataRoot);
    const lookup = (target: string, window: string, executionId: string, args: Record<string, unknown>) =>
      historyLookupTool(target, access).execute(args, {
        roleId: target, windowId: window, executionId, taskId: null, signal: new AbortController().signal,
      });
    const search = { scope: "user_quote", query: "蓝签" };
    const matches = (await lookup(roleId, direct, directCall.executionId, search)).adaptedResult as {
      entries: Array<{ id: string; label: string; snippet: string }>;
    };
    assert.deepEqual(matches.entries.map(row => [row.id, row.label, row.snippet]), [[saved.id, "user", original]]);
    for (const id of [saved.id, saved.evidenceId]) {
      const result = (await lookup(roleId, direct, directCall.executionId, { scope: "user_quote", id })).adaptedResult as {
        entry: { id: string; content: string; label: string };
      };
      assert.deepEqual([result.entry.id, result.entry.content, result.entry.label], [saved.id, original, "user"]);
    }
    for (const [window, executionId] of [
      [privateWindow, privateCall.executionId], [foreign, foreignCall.executionId], [direct, randomUUID()], [direct, saved.executionId],
    ] as const) {
      assert.deepEqual((await lookup(roleId, window, executionId, search)).adaptedResult, { entries: [], nextOffset: null });
    }
    const other = app.services.roles.createRole({ displayName: "隔离角色", definition: { text: "另一位角色" } });
    assert.deepEqual(
      (await lookup(other.roleId, other.defaultWindowId, directCall.executionId, { scope: "user_quote", id: saved.id })).adaptedResult,
      { entry: null, nextOffset: null },
    );
    assert.equal((await lookup(roleId, direct, directCall.executionId, { scope: "user_quote" })).diagnosticCode, "HISTORY_QUERY_REQUIRED");
  } finally {
    await fixture.close();
  }
});

test("跨越业务本地午夜时为出站旧消息标记发送日，保留数据库和本轮原话", async () => {
  let now = "2026-11-20T15:59:59.000Z";
  const answer = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
  const fixture = createFixture([
    request => {
      assert.equal(request.messages.at(-1)?.content, "今天我按约来了。");
      return answer("今天确实见到了。");
    },
    request => {
      const label = "[消息发送日 2026-11-20]\n";
      assert.equal(request.system.split("本轮当地日期 2026-11-21").length - 1, 1);
      assert.ok(request.messages.some(m => m.role === "user" && m.content === label + "今天我按约来了。"));
      assert.ok(request.messages.some(m => m.role === "assistant" && m.content === label + "今天确实见到了。"));
      assert.equal(request.messages.at(-1)?.content, "那是今天的事吗？");
      return answer("昨天。");
    },
  ], { now: () => new Date(now), timeZone: "Asia/Shanghai" });
  try {
    submit(fixture, "今天我按约来了。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    now = "2026-11-20T16:00:01.000Z";
    submit(fixture, "那是今天的事吗？");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const items = fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 10).items;
    assert.deepEqual(items.map(message => message.content), ["今天我按约来了。", "今天确实见到了。", "那是今天的事吗？", "昨天。"]);
  } finally {
    await fixture.close();
  }
});

test("recall follows topic changes and spoken lookup only returns published role replies across windows", { timeout: 20_000 }, async () => {
  const reply = (text: string): ModelEvent[] => [
    { type: "text_delta", text }, { type: "completed", stopReason: "stop" },
  ];
  let lookup = "";
  const fixture = createFixture([
    reply("旧地图上有一道折痕。"), reply("今晚吃面。"), reply("加点葱。"),
    [
      { type: "tool_call", callId: "lookup-spoken", name: "history_lookup", arguments: { scope: "spoken", query: "旧地图" } },
      { type: "completed", stopReason: "tool_calls" },
    ],
    (request) => {
      lookup = String(request.messages.find((message) => message.role === "tool")?.content);
      return reply("我讲过折痕。");
    },
  ]);
  try {
    for (const user of ["旧地图上我还写过个秘密。", "今晚吃什么？", "然后呢？"]) {
      submit(fixture, user);
      await fixture.app.conversation.waitForIdle(fixture.roleId);
    }
    const queries = withStorage(fixture, ({ business }) => business.db.prepare(
      "SELECT json_extract(query_json, '$.query') AS query FROM retrieval_queries WHERE mode='auto' ORDER BY rowid",
    ).all()) as Array<{ query: string }>;
    assert.equal(queries[1]?.query, "今晚吃什么？");
    assert.match(queries[2]!.query, /今晚吃面/);
    assert.doesNotMatch(queries[2]!.query, /旧地图/);
    const privateWindow = fixture.app.services.roles.createWindow(fixture.roleId, { kind: "custom", source: "nowadays-autonomy" });
    withStorage(fixture, ({ business }) => {
      const seed = business.db.prepare(`INSERT INTO messages
        (message_id, window_id, sender, content, source_platform, status, sequence, created_at, updated_at)
        VALUES (?, ?, 'assistant', ?, 'nowadays', ?, 100, '2026-10-01', '2026-10-01')`);
      seed.run(randomUUID(), fixture.windowId, "旧地图的背面有铅笔字", "interrupted");
      seed.run(randomUUID(), privateWindow.windowId, "旧地图上的密印只在独处时想过", "completed");
    });
    const second = fixture.app.services.roles.createWindow(fixture.roleId, { kind: "custom", source: "nowadays" });
    fixture.app.conversation.submitMessage(fixture.roleId, second.windowId, {
      content: "你刚才讲过地图哪部分？", submissionId: randomUUID(), sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.match(lookup, /一道折痕/);
    assert.match(lookup, /背面有铅笔字/);
    assert.doesNotMatch(lookup, /写过个秘密|密印/);
  } finally {
    await fixture.close();
  }
});

test("ordinary role output rules follow a long card and preserve an explicitly requested JSON reply", async () => {
  const body = '{"items":["地图"]}';
  let prompt = "";
  const fixture = createFixture([(request) => {
    prompt = request.system;
    return [{ type: "text_delta", text: body }, { type: "completed", stopReason: "stop" }];
  }]);
  try {
    fixture.app.services.activity.requestStop(fixture.roleId);
    fixture.app.services.roles.updateDefinition(fixture.roleId, {
      definition: { text: "她曾在旧书店工作。".repeat(260) + "每次展示卡片状态面板。",
        payload: { data: { mes_example: "把围巾留在码头", first_mes: "在码头等船", description: "向往海岛" } } },
    });
    fixture.app.services.activity.resume(fixture.roleId);
    submit(fixture, "请用 JSON 列出物品");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.ok(prompt.includes("每次展示卡片状态面板。"));
    assert.match(prompt, /向往海岛/);
    assert.doesNotMatch(prompt, /码头/);
    assert.ok(prompt.indexOf("普通角色对话的可见回复") > prompt.indexOf("每次展示卡片状态面板。"));
    assert.match(prompt, /示例用户的动作、台词、物品归属和约定，只有在实际对话发生过才算双方经历/);
    assert.match(prompt, /本轮明确索要 JSON/);
    assert.equal(fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 20).items.at(-1)?.content, body);
  } finally {
    await fixture.close();
  }
});

test("typing state delays the decision and multiple pending messages share one turn", { timeout: 15_000 }, async () => {
  // 输入窗口留出余量，避免满载并行测试时在两次提交之间提前到期。
  const fixture = createFixture(
    [
      [
        { type: "text_delta", text: "我一起回应。" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    // 输入状态窗口留足余量：满载并行时两次提交加一次查询也可能超过三秒。
    { typingMs: 15_000 },
  );
  const earlier = "第一句".repeat(200);
  const latest = "第二句".repeat(200) + "最终更正";
  try {
    fixture.app.conversation.updateInputState({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      clientId: "client-1",
      typing: true,
    });
    submit(fixture, earlier);
    submit(fixture, latest);
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
        ["user", earlier],
        ["user", latest],
        ["assistant", "我一起回应。"],
      ],
    );
    const model = fixture.model as unknown as { requests: Array<{ messages: Array<{ role: string; content: string }> }> };
    const row = withStorage(fixture, ({ business }) => business.db.prepare("SELECT query_json AS json FROM retrieval_queries WHERE mode = 'auto'").get()) as { json: string };
    assert.match(JSON.parse(row.json).query, /最终更正$/);
    assert.equal(model.requests.length, 1);
    assert.deepEqual(
      model.requests[0]?.messages.map((message) => [message.role, message.content]),
      [
        ["user", earlier],
        ["user", latest],
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

test("only an explicit user self-correction gets a source attribution note", async () => {
  const notes: boolean[] = [];
  const fixture = createFixture(Array.from({ length: 3 }, () => (request: import("../../src/domain/model.js").ModelRequest): ModelEvent[] => {
    notes.push(request.system.includes("用户明确更正自己的前述说法"));
    return [{ type: "text_delta", text: "知道了。" }, { type: "completed", stopReason: "stop" }];
  }));
  try {
    for (const content of ["我刚才说错了，是下周一。", "我刚才说错了吗？", "他说：我刚才说错了。"]) {
      submit(fixture, content);
      await fixture.app.conversation.waitForIdle(fixture.roleId);
    }
    assert.deepEqual(notes, [true, false, false]);
  } finally {
    await fixture.close();
  }
});

test("a two-character cue in a fresh window retrieves the agreed roles without other chat history", async () => {
  let prompt = "";
  const fixture = createFixture([(request) => {
    prompt = request.system;
    assert.deepEqual(request.messages.filter(m => m.role === "user").map(m => m.content), ["乌桕。"]);
    return [{ type: "text_delta", text: "稿子给你。"}, { type: "completed", stopReason: "stop" }];
  }]);
  try {
    seedEvent(fixture, {
      content: "我们说好：我报乌桕，你把讲稿递给我。", title: "排练的约定",
      summary: "两人约好用户报乌桕，角色把讲稿递给用户。", occurredAt: "2026-10-01T03:00:00.000Z",
    });
    const second = fixture.app.services.roles.createWindow(fixture.roleId, { kind: "custom", source: "nowadays" });
    fixture.app.conversation.submitMessage(fixture.roleId, second.windowId, {
      content: "乌桕。", submissionId: randomUUID(), sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.match(prompt, /用户报乌桕，角色把讲稿递给用户/);
    assert.match(prompt, /先对得上那个人的原话/);
  } finally {
    await fixture.close();
  }
});

test("a newly declared task step brings relevant dated experience into its next model request", { timeout: 15_000 }, async () => {
  const prompts: string[] = [];
  const fixture = createFixture([
    (request) => {
      prompts.push(request.system);
      return [
        { type: "tool_call", callId: "declare-step", name: "task_progress", arguments: { note: "检查版权页版次" } },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      prompts.push(request.system);
      return [
        { type: "tool_call", callId: "another-step", name: "state_update", arguments: { patch: { mood: "平静" } } },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      prompts.push(request.system);
      return [{ type: "text_delta", text: "我先看版次。" }, { type: "completed", stopReason: "stop" }];
    },
  ]);
  try {
    seedEvent(fixture, {
      content: "检查版权页版次时发现封面被换过。", title: "版权页版次",
      summary: "检查版权页版次再估价。", occurredAt: "2026-11-04T03:00:00.000Z",
    });
    submit(fixture, "整理礼物清单");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(prompts[0]!, /版权页版次/);
    assert.match(prompts[1]!, /版权页版次〔经历日期 2026-11-04〕/);
    assert.doesNotMatch(prompts[2]!, /版权页版次〔经历日期/);
  } finally {
    await fixture.close();
  }
});

test("automatic recall and agent deep search use real events and original evidence", { timeout: 20_000 }, async () => {
  const contextual: import("../../src/domain/model.js").ModelPort = {
    stream: async function* (request) {
      const system = request.system;
      const match = /id=([0-9a-f-]{36})/.exec(system);
      const toolMessages = request.messages.filter(
        (message) => message.role === "tool",
      );
      if (toolMessages.length === 0) {
        if (!system.includes("杭州旧书店") || match === null) throw new Error("AUTO_RECALL_MISSING");
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
