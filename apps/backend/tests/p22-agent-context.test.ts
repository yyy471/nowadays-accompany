import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { selectAgentContext } from "../src/application/agent-context.js";
import type { ModelMessage, ModelProtocol, ModelRequest } from "../src/domain/model.js";
import { HttpModelAdapter, serializeModelRequest } from "../src/model/protocols.js";
import { createFixtureWithModel, ScriptedChatModel, withStorage, type Fixture } from "./p2-05-fixture.js";

const protocols: ModelProtocol[] = ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"];

test("memory_search 在四种协议完整、部分及仅剩回查编号时按实际正文登记送达", () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const retrievalId = randomUUID();
  const snippet = "检索目标" + "木".repeat(360);
  const reads = ids.map(id => ({ type: "event" as const, id, retrievalId }));
  const messages = (count: number, text = snippet): ModelMessage[] => [
    { role: "user", content: "检索目标", source: { currentUserRequest: true } },
    {
      role: "assistant", content: "",
      toolCalls: [{ name: "memory_search", callId: "wire-search", arguments: { query: "检索目标" } }],
    },
    {
      role: "tool", toolCallId: "wire-search", toolName: "memory_search",
      source: { internalStepKey: "lookup-original", memoryReads: reads.slice(0, count) },
      content: JSON.stringify({ status: "success", result: {
        status: "succeeded", retrievalId, items: ids.slice(0, count).map(id => ({ id, type: "event", snippet: text })),
      } }),
    },
  ];
  for (const protocol of protocols) {
    const baseUrl = "https://offline.invalid/v1";
    const request = { modelName: "offline", system: "必要角色设定", tools: [], messages: messages(3) };
    const input = {
      request, prompt: { required: request.system, optional: [] }, protocol, baseUrl,
      maxOutputChars: 100, resuming: false, evidenceQuery: "检索目标",
    };
    const budgetForOne = (text: string) => serializeModelRequest(protocol, baseUrl, {
      ...request, messages: messages(1, text),
    }).length + input.maxOutputChars;
    assert.deepEqual(selectAgentContext(input).memoryReads, reads, protocol);
    for (const [text, expected] of [[snippet, 1], [snippet.slice(0, 100), 1], ["", 0]] as const) {
      const selected = selectAgentContext({ ...input, maxInputChars: budgetForOne(text) });
      const wire = serializeModelRequest(protocol, baseUrl, selected);
      assert.deepEqual(selected.memoryReads, reads.slice(0, expected), protocol);
      assert.deepEqual(ids.filter(id => wire.includes(id)), ids.slice(0, expected), protocol);
      if (expected === 0) {
        assert.match(wire, /history_lookup/);
      } else {
        assert.ok(wire.includes("检索目标木"), protocol);
        assert.equal(wire.includes(snippet), text === snippet, protocol);
      }
    }
  }
});

test("DL-164 以四种协议实际写入 HTTP 的请求体验证容量，接受后才登记送达", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const protocol of protocols) {
      const baseUrl = "https://offline.invalid/v1";
      const current: ModelMessage = {
        role: "user",
        content: '本轮问题含反斜杠 \\、引号 " 与换行\n',
        images: [{ mediaType: "image/png", dataBase64: "YQ==" }],
        source: { currentUserRequest: true },
      };
      const modelName = "offline-test";
      const core: ModelRequest = {
        modelName,
        system: "角色必要状态",
        messages: [current],
        tools: [{ name: "lookup", description: "查找原文", inputSchema: { type: "object" } }],
      };
      let body = "";
      let status = 400;
      let accepted = 0;
      globalThis.fetch = async (_input, init) => {
        body = String(init?.body);
        assert.equal(accepted, 0, protocol);
        return new Response(status === 204 ? null : "bad request", { status });
      };
      const limit = serializeModelRequest(protocol, baseUrl, core).length + 75;
      const input = {
        request: {
          ...core,
          messages: [{ role: "assistant", content: "旧对话".repeat(500), source: { messageId: randomUUID() } } as ModelMessage, current],
        },
        prompt: { required: core.system, optional: ["回忆".repeat(500)] },
        protocol,
        baseUrl,
        maxInputChars: limit,
        maxOutputChars: 75,
        evidenceQuery: current.content,
        resuming: false,
      };
      const request = selectAgentContext(input);
      assert.deepEqual(request.messages, [current], protocol);
      assert.throws(() => selectAgentContext({ ...input, maxInputChars: limit - 1 }), { code: "MODEL_CONTEXT_EXCEEDED" });
      const model = new HttpModelAdapter({ protocol, baseUrl }, undefined);
      const send = async () => {
        for await (const _event of model.stream({ ...request, onAccepted: () => accepted++ })) {
          assert.fail("204 未提供 SSE 事件");
        }
      };
      await assert.rejects(send);
      assert.equal(accepted, 0, protocol);
      status = 204;
      await assert.rejects(send);
      assert.equal(accepted, 1, protocol);
      assert.equal(body, serializeModelRequest(protocol, baseUrl, request), protocol);
      assert.equal(body.length + 75, limit, protocol);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DL-164 角色图超限在开始模型调用及计量前拒绝", async () => {
  const model = new ScriptedChatModel([]);
  const fixture = createFixtureWithModel(model);
  try {
    assert.equal(fixture.app.services.activity.requestStop(fixture.roleId).confirmed, true);
    const resource = fixture.app.services.resources.create({
      name: "小容量离线模型",
      kind: "model",
      config: {
        protocol: "openai-chat",
        baseUrl: "http://offline.invalid/v1",
        maxInputChars: 1_000,
        maxOutputChars: 500,
      },
    });
    fixture.app.services.resources.replaceBindings(fixture.roleId, [{
      capability: "chat_model",
      resourceId: resource.resourceId,
      modelName: "offline-chat",
      enabled: true,
    }]);
    fixture.app.services.activity.resume(fixture.roleId);
    submit(fixture, "请接收这个完整请求。".repeat(100));
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 0);
    withStorage(fixture, ({ business }) => {
      assert.deepEqual(business.db.prepare("SELECT count(*) AS n FROM model_calls").get(), { n: 0 });
      assert.deepEqual(business.db.prepare("SELECT count(*) AS n FROM call_metering").get(), { n: 0 });
      const failure = business.db.prepare(
        "SELECT payload_json FROM execution_stream_events WHERE event_type = 'execution_failed'",
      ).get() as { payload_json: string };
      assert.match(failure.payload_json, /MODEL_CONTEXT_EXCEEDED/);
    });
  } finally {
    await fixture.close();
  }
});

test("DL-164 当前步骤引用的旧原文优先，保留同服务双调用配对和原生续轮", () => {
  const baseUrl = "https://offline.invalid/v1";
  const modelName = "offline-test";
  const protocol = "anthropic-messages";
  const callIds = ["one", "two"];
  const request: ModelRequest = {
    modelName,
    system: "",
    tools: [],
    messages: [
      { role: "assistant", content: "已核对的原始事实 SHARE-2999", source: { messageId: "reference-old-fact" } },
      { role: "user", content: "使用 reference-old-fact", source: { currentUserRequest: true } },
      {
        role: "assistant",
        content: "",
        toolCalls: callIds.map((callId) => ({ callId, name: "read", arguments: {} })),
        continuation: {
          baseUrl, modelName, protocol,
          items: [
            { type: "thinking", thinking: "计划", signature: "private-original-signature" },
            ...callIds.map((id) => ({ type: "tool_use", id, name: "read", input: {} })),
          ],
        },
      },
      { role: "tool", toolName: "read", toolCallId: "one", content: "无关回执".repeat(900), source: { toolCallId: "stored-one" } },
      { role: "tool", toolName: "read", toolCallId: "two", content: "当前结果", source: { toolCallId: "stored-two" } },
    ],
  };
  const input: Parameters<typeof selectAgentContext>[0] = {
    baseUrl, protocol, request, prompt: { required: "角色状态", optional: [] },
    evidenceQuery: "使用 reference-old-fact", maxInputChars: 900, maxOutputChars: 50, resuming: true,
  };
  const chosen = selectAgentContext(input);
  assert.match(chosen.messages[0]!.content, /SHARE-2999/);
  assert.equal(chosen.messages[3]?.source?.summary, true);
  assert.match(chosen.messages[3]!.content, /history_lookup.*stored-one/);
  assert.equal(chosen.messages[4]?.content, "当前结果");
  const wire = serializeModelRequest(protocol, baseUrl, chosen);
  assert.match(wire, /private-original-signature/);
  assert.equal((wire.match(/"type":"tool_result"/g) ?? []).length, 2);
  const otherBaseUrl = "https://other.invalid/v1";
  const switched = serializeModelRequest(protocol, otherBaseUrl, selectAgentContext({ ...input, baseUrl: otherBaseUrl }));
  assert.doesNotMatch(switched, /private-original-signature|tool_result|tool_use/);
  assert.match(switched, /当前结果/);
});

test("DL-164 超长旧消息保留命中词附近的精确原文和分页位置", () => {
  const protocol = "openai-chat";
  const baseUrl = "https://offline.invalid/v1";
  const answer = '交接编号 MERCURY-77，封签是 "木桥和玉兰"。';
  const original = `${"往期轮班。".repeat(4_000)}\n${answer}\n${"旧记录。".repeat(2_000)}`;
  const question = "请从 old-ticket-218 查找 MERCURY-77 的封签。";
  const userMessage: ModelMessage = { role: "user", content: question, source: { currentUserRequest: true } };
  const out = selectAgentContext({
    protocol, baseUrl, evidenceQuery: question, resuming: false,
    prompt: { required: "正在办交接。", optional: [] },
    maxInputChars: 1_500, maxOutputChars: 350,
    request: {
      modelName: "offline-test", system: "", tools: [],
      messages: [{ role: "assistant", content: original, source: { messageId: "old-ticket-218" } }, userMessage],
    },
  });
  const excerpt = out.messages[0]?.content ?? "";
  const [, from, to, pageOffset, quoted] =
    /^\[原文摘录 UTF-16 (\d+)–(\d+)；回查：history_lookup\(kind="message", id="old-ticket-218", scope="window", offset=(\d+)\)\]\n([\s\S]+)$/.exec(excerpt) ?? [];
  assert.ok(quoted?.includes(answer));
  assert.equal(pageOffset, from);
  assert.equal(quoted, original.slice(Number(from), Number(to)));
  assert.deepEqual(out.messages.at(-1), userMessage);
  assert.ok(serializeModelRequest(protocol, baseUrl, out).length + 350 <= 1_500);
});

test("DL-164 正常角色图查得近期窗口以外的原消息和工具回执，并分页返回原文", async () => {
  let historicalIds: { messageId: string; callId: string };
  const receipt = "历史回执标记".repeat(330);
  const model = new ScriptedChatModel([
    (request) => {
      assert.equal(request.messages.filter((message) => message.source?.currentUserRequest).length, 2);
      assert.ok(request.messages.some((message) =>
        message.source?.messageId === historicalIds.messageId && message.content === "老凭条编号 ABC-sentinel-499" ));
      assert.ok(request.messages.some((message) =>
        message.source?.toolCallId === historicalIds.callId && message.content.includes(receipt)));
      assert.ok(request.tools.some((tool) => tool.name === "history_lookup"));
      return [
        { type: "tool_call", callId: "find-archive", name: "history_lookup", arguments: { kind: "tool", query: "历史回执标记" } },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const result = request.messages.at(-1);
      assert.equal(result?.role, "tool");
      assert.match(result.content, new RegExp(historicalIds.callId));
      return [
        { type: "tool_call", callId: "first-page", name: "history_lookup", arguments: { kind: "tool", id: historicalIds.callId } },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const result = request.messages.at(-1);
      assert.equal(result?.role, "tool");
      assert.match(result.content, /"nextOffset":2000/);
      return [
        { type: "tool_call", callId: "next-page", name: "history_lookup", arguments: { kind: "tool", id: historicalIds.callId, offset: 2000 } },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const result = request.messages.at(-1);
      assert.equal(result?.role, "tool");
      assert.match(result.content, /"nextOffset":null/);
      assert.match(result.content, /历史回执标记/);
      return [{ type: "text_delta", text: "已核对历史材料。" }, { type: "completed", stopReason: "stop" }];
    },
  ]);
  const fixture = createFixtureWithModel(model);
  try {
    historicalIds = withStorage(fixture, ({ business }) => {
      const { roleId, windowId } = fixture;
      const execution = business.createExecution({ roleId, windowId, triggerType: "recovery" });
      business.db.prepare("UPDATE executions SET status = 'completed' WHERE execution_id = ?").run(execution.executionId);
      const submitHistorical = (content: string) => business.submitMessage(roleId, windowId, {
        content, submissionId: randomUUID(), sourcePlatform: "nowadays",
      }).message.messageId;
      const messageId = submitHistorical("老凭条编号 ABC-sentinel-499");
      for (let i = 0; i < 34; i++) submitHistorical(`近期谈话 ${i}`);
      business.db.prepare("UPDATE messages SET processed_by_execution_id = ?").run(execution.executionId);
      const task = business.createTask({ roleId, goal: "保留原始资料", origin: "user", initiatorExecutionId: execution.executionId });
      business.linkExecutionTask({ roleId, taskId: task.taskId, executionId: execution.executionId, relation: "initiates" });
      const save = (i: number, content: string) => {
        const { toolCall } = business.beginToolCall({
          roleId, executionId: execution.executionId, taskId: task.taskId, toolName: "read_archive",
          stepKey: `stored-${i}`, args: { item: i },
        });
        business.saveToolResult({ roleId, toolCallId: toolCall.toolCallId, status: "success", adaptedResult: { content } });
        return toolCall.toolCallId;
      };
      const callId = save(0, receipt);
      for (let i = 1; i < 45; i++) save(i, `后来回执 ${i}`);
      return { messageId, callId };
    });
    submit(fixture, `读取老凭条 ${historicalIds.messageId} 的完整原文。`);
    submit(fixture, `同时核对回执 ${historicalIds.callId}。`);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 4);
    const saved = withStorage(fixture, ({ business }) =>
      business.listMessagePage(fixture.roleId, fixture.windowId, { limit: 1 }).items.at(-1));
    assert.equal(saved?.content, "已核对历史材料。");
  } finally {
    await fixture.close();
  }
});

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}
