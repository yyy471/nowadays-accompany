import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelBindingResolver } from "../src/application/model-binding-resolver.js";
import { RoleAccess } from "../src/application/role-access.js";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { ModelBindingMissingError } from "../src/domain/errors.js";
import type {
  ModelEvent,
  ModelMessage,
  ModelProtocol,
  ModelToolSpec,
} from "../src/domain/model.js";
import { HttpModelAdapter } from "../src/model/protocols.js";

interface MockServer {
  baseUrl: string;
  requests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: unknown;
  }>;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
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
    if (
      request.method === "GET" &&
      request.url?.endsWith("/models")
    ) {
      respondJson(response, { data: [{ id: "mock-model" }] });
      return;
    }
    if (
      request.method === "POST" &&
      request.url?.endsWith("/chat/completions")
    ) {
      respondSse(response, [
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_chat","function":{"name":"workspace_read","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"note.md\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]);
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/responses")) {
      respondSse(response, [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","call_id":"call_resp","name":"workspace_read","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"path\\":\\"note.md\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":6}}}\n\n',
      ]);
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/messages")) {
      respondSse(response, [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_anth","name":"workspace_read","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"note.md\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
      return;
    }
    if (
      request.method === "POST" &&
      request.url?.includes(":streamGenerateContent?alt=sse")
    ) {
      respondSse(response, [
        sse({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "你好" },
                  {
                    functionCall: {
                      name: "workspace_read",
                      args: { path: "note.md" },
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 5 },
        }),
      ]);
      return;
    }
    respondJson(response, { error: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function respondJson(
  response: http.ServerResponse,
  payload: unknown,
  status = 200,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function respondSse(
  response: http.ServerResponse,
  chunks: readonly string[],
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) {
    response.write(chunk);
  }
  response.end();
}

const TOOL: ModelToolSpec = {
  name: "workspace_read",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

async function collect(
  adapter: HttpModelAdapter,
): Promise<ModelEvent[]> {
  return collectWith(adapter, [{ role: "user", content: "读取 note.md" }]);
}

async function collectWith(
  adapter: HttpModelAdapter,
  messages: ModelMessage[],
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of adapter.stream({
    modelName: "mock-model",
    system: "你是测试角色。",
    messages,
    tools: [TOOL],
    maxOutputTokens: 32,
  })) {
    events.push(event);
  }
  return events;
}

interface RawServer {
  baseUrl: string;
  requests: Array<{ url: string; body: unknown }>;
  close(): Promise<void>;
}

async function startRawServer(
  handler: (input: {
    url: string;
    body: unknown;
    index: number;
  }) => {
    status?: number;
    contentType?: string;
    body?: string;
  },
): Promise<RawServer> {
  const requests: RawServer["requests"] = [];
  let index = 0;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody.length === 0 ? null : (JSON.parse(rawBody) as unknown);
    const current = index;
    index += 1;
    requests.push({ url: request.url ?? "", body });
    const result = handler({
      url: request.url ?? "",
      body,
      index: current,
    });
    response.writeHead(result.status ?? 200, {
      "content-type": result.contentType ?? "text/event-stream",
    });
    response.end(result.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const ENDINGS: Record<ModelProtocol, string> = {
  "openai-chat":
    sse({ choices: [{ finish_reason: "stop", delta: {} }] }) +
    "data: [DONE]\n\n",
  "openai-responses": sse({
    type: "response.completed",
    response: { status: "completed" },
  }),
  "anthropic-messages":
    sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
    sse({ type: "message_stop" }),
  "google-gemini": sse({
    candidates: [{ finishReason: "STOP" }],
  }),
};

function textDelta(protocol: ModelProtocol, text: string): string {
  if (protocol === "openai-chat") {
    return sse({ choices: [{ delta: { content: text } }] });
  }
  if (protocol === "openai-responses") {
    return sse({ type: "response.output_text.delta", delta: text });
  }
  if (protocol === "google-gemini") {
    return sse({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
    });
  }
  return sse({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

function twoToolCalls(protocol: ModelProtocol): string {
  if (protocol === "openai-chat") {
    return (
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "chat_call_a",
                  function: {
                    name: "workspace_read",
                    arguments: '{"path":"a.md"}',
                  },
                },
              ],
            },
          },
        ],
      }) +
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "chat_call_b",
                  function: {
                    name: "workspace_read",
                    arguments: '{"path":"b.md"}',
                  },
                },
              ],
            },
          },
        ],
      }) +
      sse({ choices: [{ finish_reason: "tool_calls", delta: {} }] }) +
      "data: [DONE]\n\n"
    );
  }
  if (protocol === "openai-responses") {
    const items = ["a", "b"].map((suffix) =>
      [
        sse({
          type: "response.output_item.added",
          item: {
            id: `item_${suffix}`,
            type: "function_call",
            call_id: `resp_call_${suffix}`,
            name: "workspace_read",
            arguments: "",
          },
        }),
        sse({
          type: "response.function_call_arguments.delta",
          item_id: `item_${suffix}`,
          delta: `{"path":"${suffix}.md"}`,
        }),
      ].join(""),
    );
    return (
      items.join("") +
      sse({ type: "response.completed", response: { status: "completed" } })
    );
  }
  if (protocol === "google-gemini") {
    return (
      sse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "workspace_read",
                    args: { path: "a.md" },
                  },
                },
                {
                  functionCall: {
                    name: "workspace_read",
                    args: { path: "b.md" },
                  },
                },
              ],
            },
          },
        ],
      }) + ENDINGS["google-gemini"]
    );
  }
  return (
    sse({
      type: "message_start",
      message: { usage: { input_tokens: 1 } },
    }) +
    sse({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "anth_call_a",
        name: "workspace_read",
        input: {},
      },
    }) +
    sse({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"path":"a.md"}',
      },
    }) +
    sse({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "anth_call_b",
        name: "workspace_read",
        input: {},
      },
    }) +
    sse({
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: '{"path":"b.md"}',
      },
    }) +
    sse({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    }) +
    sse({ type: "message_stop" })
  );
}

function assertToolHistory(
  protocol: ModelProtocol,
  wire: Record<string, unknown>,
  expectedCallIds: readonly string[],
): void {
  if (protocol === "openai-chat") {
    const messages = wire.messages as Array<Record<string, unknown>>;
    const assistant = messages.find(
      (message) =>
        message.role === "assistant" && Array.isArray(message.tool_calls),
    );
    assert.ok(assistant);
    const calls = assistant.tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    assert.deepEqual(
      calls.map((call) => [call.id, call.function.name]),
      [
        [expectedCallIds[0], "workspace_read"],
        [expectedCallIds[1], "workspace_read"],
      ],
    );
    assert.deepEqual(
      calls.map((call) => JSON.parse(call.function.arguments) as unknown),
      [{ path: "a.md" }, { path: "b.md" }],
    );
    assert.deepEqual(
      messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
      expectedCallIds,
    );
    return;
  }
  if (protocol === "openai-responses") {
    const input = wire.input as Array<Record<string, unknown>>;
    assert.deepEqual(
      input
        .filter((item) => item.type === "function_call")
        .map((item) => [item.call_id, item.name]),
      [
        [expectedCallIds[0], "workspace_read"],
        [expectedCallIds[1], "workspace_read"],
      ],
    );
    assert.deepEqual(
      input
        .filter((item) => item.type === "function_call_output")
        .map((item) => item.call_id),
      expectedCallIds,
    );
    assert.equal(
      input.some(
        (item) => item.type === "message" && item.role === "assistant",
      ),
      true,
    );
    assert.equal(
      input.some((item) => item.type === "message" && item.role === "user"),
      true,
    );
    return;
  }
  if (protocol === "google-gemini") {
    const contents = wire.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const modelTurn = contents.find((turn) => turn.role === "model");
    assert.ok(modelTurn);
    const calls = modelTurn.parts
      .map((part) => part.functionCall as { name: string; args: unknown } | undefined)
      .filter((item): item is { name: string; args: unknown } => item !== undefined);
    assert.deepEqual(
      calls.map((call) => [call.name, call.args]),
      [
        ["workspace_read", { path: "a.md" }],
        ["workspace_read", { path: "b.md" }],
      ],
    );
    const toolTurn = contents.filter(
      (turn) =>
        turn.role === "user" &&
        turn.parts.some((part) => part.functionResponse !== undefined),
    );
    assert.equal(toolTurn.length, 1);
    const responses = toolTurn[0]!.parts.map(
      (part) =>
        part.functionResponse as { name: string; response: { output: string } },
    );
    assert.deepEqual(
      responses.map((item) => [item.name, item.response.output]),
      [
        ["workspace_read", `result:${expectedCallIds[0]}`],
        ["workspace_read", `result:${expectedCallIds[1]}`],
      ],
    );
    return;
  }
  const messages = wire.messages as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
  const assistant = messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.deepEqual(
    assistant.content
      .filter((block) => block.type === "tool_use")
      .map((block) => [block.id, block.name]),
    [
      [expectedCallIds[0], "workspace_read"],
      [expectedCallIds[1], "workspace_read"],
    ],
  );
  const toolResults = messages.flatMap((message) =>
    message.content.filter((block) => block.type === "tool_result"),
  );
  assert.deepEqual(
    toolResults.map((block) => block.tool_use_id),
    expectedCallIds,
  );
  assert.equal(
    messages.filter(
      (message) =>
        message.role === "user" &&
        message.content.some((block) => block.type === "tool_result"),
    ).length,
    1,
  );
}

test("tool results continue the same model turn for all protocols", async () => {
  for (const protocol of [
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "google-gemini",
  ] as const) {
    const server = await startRawServer(({ index }) => ({
      body:
        index === 0
          ? textDelta(protocol, "我先读取。") + twoToolCalls(protocol)
          : textDelta(protocol, "两个文件都读完了") + ENDINGS[protocol],
    }));
    try {
      const adapter = new HttpModelAdapter(
        { protocol, baseUrl: server.baseUrl },
        undefined,
      );
      const userMessage: ModelMessage = {
        role: "user",
        content: "读取 a.md 和 b.md",
      };
      const first = await collectWith(adapter, [userMessage]);
      const toolCalls = first.filter((event) => event.type === "tool_call");
      assert.equal(toolCalls.length, 2, protocol);
      const assistantText = first
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join("");
      const businessCallIds = ["biz_call_a", "biz_call_b"];
      const assistant: ModelMessage = {
        role: "assistant",
        content: assistantText,
        toolCalls: toolCalls.map((event, index) => ({
          callId: businessCallIds[index] ?? `biz_call_${index}`,
          name: event.name,
          arguments: event.arguments,
        })),
      };
      const toolMessages: ModelMessage[] = toolCalls.map((event, index) => ({
        role: "tool",
        toolCallId: businessCallIds[index] ?? `biz_call_${index}`,
        toolName: event.name,
        content: `result:${businessCallIds[index] ?? index}`,
      }));
      const second = await collectWith(adapter, [
        userMessage,
        assistant,
        ...toolMessages,
      ]);
      assert.equal(
        second
          .filter((event) => event.type === "text_delta")
          .map((event) => event.text)
          .join(""),
        "两个文件都读完了",
        protocol,
      );
      const wire = server.requests[1]?.body as Record<string, unknown>;
      assertToolHistory(protocol, wire, businessCallIds);
    } finally {
      await server.close();
    }
  }
});

test("responses continuation falls back to completed output items", async () => {
  const items = [
    {
      type: "reasoning",
      id: "rs_fallback",
      encrypted_content: "opaque-fallback-reasoning",
    },
    {
      type: "message",
      id: "msg_fallback",
      role: "assistant",
      content: [{ type: "output_text", text: "你好" }],
    },
  ];
  const server = await startRawServer(() => ({
    body:
      items
        .map((item, index) =>
          sse({
            type: "response.output_item.done",
            output_index: index,
            item,
          }),
        )
        .join("") +
      sse({
        type: "response.completed",
        response: { status: "completed", output: [] },
      }),
  }));
  try {
    const adapter = new HttpModelAdapter(
      { protocol: "openai-responses", baseUrl: server.baseUrl },
      undefined,
    );
    const events = await collectWith(adapter, [
      { role: "user", content: "hi" },
    ]);
    const completed = events.find((event) => event.type === "completed");
    assert.ok(completed);
    assert.deepEqual(completed.continuation?.items, items);
  } finally {
    await server.close();
  }
});

test("streams require a complete protocol terminal and mark explicit incompletes", async () => {
  for (const protocol of [
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "google-gemini",
  ] as const) {
    const cases: Array<{
      body: string;
      incomplete: boolean;
      stopReason: string;
    }> = [
      {
        body: textDelta(protocol, "partial"),
        incomplete: true,
        stopReason: "truncated",
      },
      { body: "", incomplete: true, stopReason: "empty" },
    ];
    for (const item of cases) {
      const server = await startRawServer(() => ({ body: item.body }));
      try {
        const adapter = new HttpModelAdapter(
          { protocol, baseUrl: server.baseUrl },
          undefined,
        );
        const events: ModelEvent[] = [];
        await assert.rejects(
          async () => {
            for await (const event of adapter.stream({
              modelName: "mock-model",
              system: "test",
              messages: [{ role: "user", content: "hello" }],
              tools: [TOOL],
            })) {
              events.push(event);
            }
          },
          (error: unknown) =>
            (error as { code?: string }).code === "MODEL_REQUEST_FAILED",
          `${protocol}:${item.stopReason}`,
        );
        assert.equal(
          events.some((event) => event.type === "completed"),
          false,
          `${protocol}:${item.stopReason}`,
        );
      } finally {
        await server.close();
      }
    }

    const incompleteBody =
      protocol === "openai-chat"
        ? sse({ choices: [{ finish_reason: "length", delta: {} }] }) +
          "data: [DONE]\n\n"
        : protocol === "openai-responses"
          ? sse({ type: "response.incomplete", response: { status: "incomplete" } })
          : protocol === "google-gemini"
            ? sse({ candidates: [{ finishReason: "MAX_TOKENS" }] })
            : sse({
                type: "message_delta",
                delta: { stop_reason: "max_tokens" },
              }) + sse({ type: "message_stop" });
    const incompleteServer = await startRawServer(() => ({
      body: textDelta(protocol, "partial") + incompleteBody,
    }));
    try {
      const adapter = new HttpModelAdapter(
        { protocol, baseUrl: incompleteServer.baseUrl },
        undefined,
      );
      const events = await collectWith(adapter, [
        { role: "user", content: "hello" },
      ]);
      const completed = events.find((event) => event.type === "completed");
      assert.ok(completed, protocol);
      assert.equal(completed.incomplete, true, protocol);
    } finally {
      await incompleteServer.close();
    }

    const toolOnly = twoToolCalls(protocol).replace(
      protocol === "openai-chat"
        ? sse({ choices: [{ finish_reason: "tool_calls", delta: {} }] }) +
            "data: [DONE]\n\n"
        : protocol === "openai-responses"
          ? sse({ type: "response.completed", response: { status: "completed" } })
          : protocol === "google-gemini"
            ? ENDINGS["google-gemini"]
            : sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }) +
              sse({ type: "message_stop" }),
      "",
    );
    const toolServer = await startRawServer(() => ({ body: toolOnly }));
    try {
      const adapter = new HttpModelAdapter(
        { protocol, baseUrl: toolServer.baseUrl },
        undefined,
      );
      const events: ModelEvent[] = [];
      await assert.rejects(async () => {
        for await (const event of adapter.stream({
          modelName: "mock-model",
          system: "test",
          messages: [{ role: "user", content: "hello" }],
          tools: [TOOL],
        })) {
          events.push(event);
        }
      });
      assert.equal(
        events.some((event) => event.type === "tool_call"),
        false,
        protocol,
      );
      assert.equal(
        events.some((event) => event.type === "completed"),
        false,
        protocol,
      );
    } finally {
      await toolServer.close();
    }
  }
});

test("connection tests reject empty streams and upstream errors leak no body", async () => {
  const emptyServer = await startRawServer(() => ({
    body: "",
    contentType: "text/event-stream",
  }));
  const errorServer = await startRawServer(() => ({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        code: "invalid_api_key",
        message: "Incorrect API key provided: DUMMY_SECRET_VALUE; request body ping",
      },
    }),
  }));
  const codeEchoServer = await startRawServer(() => ({
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "DUMMY_SECRET_VALUE", message: "request body ping" },
    }),
  }));
  const plainErrorServer = await startRawServer(() => ({
    status: 500,
    contentType: "text/plain",
    body: "internal error DUMMY_SECRET_VALUE and request body ping",
  }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-errors-"));
  const app = createBackendApp(
    parseBackendConfig(["--app-root", root, "--port", "0"]),
  );
  try {
    fs.writeFileSync(path.join(root, "dummy-key.txt"), "DUMMY_SECRET_VALUE");
    const empty = await app.services.modelServices.test({
      protocol: "openai-chat",
      baseUrl: emptyServer.baseUrl,
      model: "mock-model",
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.error?.code, "MODEL_REQUEST_FAILED");

    await assert.rejects(
      () =>
        app.services.modelServices.listModels({
          protocol: "openai-chat",
          baseUrl: errorServer.baseUrl,
          credentialRef: "file:dummy-key.txt",
        }),
      (error: unknown) => {
        const appError = error as {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(appError.code, "MODEL_REQUEST_FAILED");
        assert.equal(
          JSON.stringify(appError).includes("DUMMY_SECRET_VALUE"),
          false,
        );
        assert.equal(appError.details?.status, 401);
        assert.equal(appError.details?.reason, "invalid_api_key");
        assert.equal("body" in (appError.details ?? {}), false);
        return true;
      },
    );
    const failedTest = await app.services.modelServices.test({
      protocol: "openai-chat",
      baseUrl: errorServer.baseUrl,
      model: "mock-model",
      credentialRef: "file:dummy-key.txt",
    });
    assert.equal(failedTest.ok, false);
    assert.equal(failedTest.error?.code, "MODEL_REQUEST_FAILED");
    assert.equal(
      JSON.stringify(failedTest).includes("DUMMY_SECRET_VALUE"),
      false,
    );

    await assert.rejects(
      () =>
        app.services.modelServices.listModels({
          protocol: "openai-chat",
          baseUrl: codeEchoServer.baseUrl,
          credentialRef: "file:dummy-key.txt",
        }),
      (error: unknown) => {
        const appError = error as {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(appError.code, "MODEL_REQUEST_FAILED");
        assert.equal(
          JSON.stringify(appError).includes("DUMMY_SECRET_VALUE"),
          false,
        );
        assert.equal(appError.details?.status, 403);
        assert.equal(appError.details?.reason, "http_403");
        return true;
      },
    );
    await assert.rejects(
      () =>
        app.services.modelServices.listModels({
          protocol: "anthropic-messages",
          baseUrl: plainErrorServer.baseUrl,
          credentialRef: "file:dummy-key.txt",
        }),
      (error: unknown) => {
        const appError = error as {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(appError.code, "MODEL_REQUEST_FAILED");
        assert.equal(
          JSON.stringify(appError).includes("DUMMY_SECRET_VALUE"),
          false,
        );
        assert.equal(appError.details?.status, 500);
        assert.equal(appError.details?.reason, "http_500");
        return true;
      },
    );

    const port = await listen(app.server, 0, "127.0.0.1");
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/model-services/models`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: "openai-chat",
          baseUrl: errorServer.baseUrl,
          credentialRef: "file:dummy-key.txt",
        }),
      },
    );
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(text.includes("DUMMY_SECRET_VALUE"), false);
    assert.equal(text.includes("request body ping"), false);
    assert.match(text, /invalid_api_key/);
    const rows = app.appStore.db
      .prepare("SELECT status, error_code FROM model_test_calls")
      .all() as Array<{ status: string; error_code: string | null }>;
    assert.equal(rows[0]?.status, "failed");
    assert.equal(rows[0]?.error_code, "MODEL_REQUEST_FAILED");
  } finally {
    await app.close();
    await emptyServer.close();
    await errorServer.close();
    await codeEchoServer.close();
    await plainErrorServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("connection tests use an internal output budget and accept explicit truncation", async () => {
  const maxTokensEnding =
    sse({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
      usage: { output_tokens: 1024 },
    }) + sse({ type: "message_stop" });
  const responses: Array<{
    status?: number;
    contentType?: string;
    body: string;
  }> = [
    {
      body:
        textDelta("anthropic-messages", "pong") +
        ENDINGS["anthropic-messages"],
    },
    {
      body:
        sse({
          type: "message_start",
          message: { usage: { input_tokens: 39 } },
        }) +
        sse({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }) +
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "思考" },
        }) +
        maxTokensEnding,
    },
    {
      body: textDelta("anthropic-messages", "par") + maxTokensEnding,
    },
    { body: ENDINGS["anthropic-messages"] },
    { body: "" },
    {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "upstream unavailable" } }),
    },
  ];
  const server = await startRawServer(({ index }) => responses[index]!);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-06-r09-"));
  const app = createBackendApp(
    parseBackendConfig(["--app-root", root, "--port", "0"]),
  );
  try {
    const config = {
      protocol: "anthropic-messages" as const,
      baseUrl: server.baseUrl,
      model: "mock-model",
    };
    const normal = await app.services.modelServices.test(config);
    assert.equal(normal.ok, true);
    const thinkingOnly = await app.services.modelServices.test(config);
    assert.equal(thinkingOnly.ok, true);
    const partial = await app.services.modelServices.test(config);
    assert.equal(partial.ok, true);
    const completedEmpty = await app.services.modelServices.test(config);
    assert.equal(completedEmpty.ok, false);
    assert.equal(completedEmpty.error?.code, "MODEL_REQUEST_FAILED");
    assert.match(completedEmpty.error?.message ?? "", /未收到有效输出/);
    const emptyStream = await app.services.modelServices.test(config);
    assert.equal(emptyStream.ok, false);
    assert.equal(emptyStream.error?.code, "MODEL_REQUEST_FAILED");
    assert.match(emptyStream.error?.message ?? "", /未收到完整终态/);
    const upstream = await app.services.modelServices.test(config);
    assert.equal(upstream.ok, false);
    assert.equal(upstream.error?.code, "MODEL_REQUEST_FAILED");

    const requestBody = server.requests[0]?.body as {
      max_tokens?: number;
      system?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: unknown;
    };
    assert.ok((requestBody.max_tokens ?? 0) >= 256);
    assert.equal(requestBody.system, "Reply with the single word pong.");
    assert.deepEqual(requestBody.messages, [
      { role: "user", content: [{ type: "text", text: "ping" }] },
    ]);
    assert.equal("tools" in requestBody, false);

    const rows = app.appStore.db
      .prepare(
        "SELECT status FROM model_test_calls ORDER BY rowid ASC",
      )
      .all() as Array<{ status: string }>;
    assert.deepEqual(rows.map((row) => row.status), [
      "succeeded",
      "succeeded",
      "succeeded",
      "failed",
      "failed",
      "failed",
    ]);
  } finally {
    await app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model protocols stream text, tool calls and usage", async () => {
  const server = await startMockServer();
  try {
    for (const protocol of [
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "google-gemini",
    ] as const) {
      const adapter = new HttpModelAdapter(
        { protocol, baseUrl: server.baseUrl },
        undefined,
      );
      const events = await collect(adapter);
      const text = events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join("");
      assert.equal(text, "你好");
      const toolCall = events.find((event) => event.type === "tool_call");
      assert.ok(toolCall, protocol);
      assert.equal(toolCall.name, "workspace_read");
      assert.deepEqual(toolCall.arguments, { path: "note.md" });
      const usage = events.find((event) => event.type === "usage");
      assert.ok(usage, protocol);
      const completed = events.find((event) => event.type === "completed");
      assert.ok(completed, protocol);
      assert.equal(completed.stopReason.length > 0, true);
      assert.equal(Array.isArray(completed.rawResponse), true, protocol);
      assert.equal(
        server.requests.some(
          (request) =>
            protocol === "google-gemini"
              ? request.url?.endsWith(
                  "/models/mock-model:streamGenerateContent?alt=sse",
                )
              : request.url?.endsWith(
                  protocol === "openai-chat"
                    ? "/chat/completions"
                    : protocol === "openai-responses"
                      ? "/responses"
                      : "/messages",
                ) && (request.body as { stream?: boolean }).stream === true,
        ),
        true,
      );
    }
  } finally {
    await server.close();
  }
});

test("model list and connection tests use credentials and record results", async () => {
  const server = await startMockServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-model-"));
  const app = createBackendApp(
    parseBackendConfig(["--app-root", root, "--port", "0"]),
  );
  try {
    process.env.NOWADAYS_TEST_MODEL_KEY = "secret-key";
    fs.writeFileSync(
      path.join(root, "model-key.txt"),
      "file-secret\n",
      "utf8",
    );
    const service = app.services.modelServices;
    const models = await service.listModels({
      protocol: "openai-chat",
      baseUrl: server.baseUrl,
      credentialRef: "env:NOWADAYS_TEST_MODEL_KEY",
    });
    assert.deepEqual(models, { models: ["mock-model"] });
    assert.equal(
      server.requests.at(-1)?.headers.authorization,
      "Bearer secret-key",
    );
    const anthopicModels = await service.listModels({
      protocol: "anthropic-messages",
      baseUrl: server.baseUrl,
      credentialRef: "file:model-key.txt",
    });
    assert.deepEqual(anthopicModels.models, ["mock-model"]);
    assert.equal(server.requests.at(-1)?.headers["x-api-key"], "file-secret");

    const chatTest = await service.test({
      protocol: "openai-chat",
      baseUrl: server.baseUrl,
      model: "mock-model",
    });
    assert.equal(chatTest.ok, true);
    const responseTest = await service.test({
      protocol: "openai-responses",
      baseUrl: server.baseUrl,
      model: "mock-model",
    });
    assert.equal(responseTest.ok, true);
    const anthropicTest = await service.test({
      protocol: "anthropic-messages",
      baseUrl: server.baseUrl,
      model: "mock-model",
    });
    assert.equal(anthropicTest.ok, true);
    const failed = await service.test({
      protocol: "openai-chat",
      baseUrl: server.baseUrl,
      model: "mock-model",
      credentialRef: "env:NOWADAYS_MISSING_MODEL_KEY",
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "MODEL_CREDENTIAL_UNAVAILABLE");
    const rows = app.appStore.db
      .prepare(
        "SELECT protocol, status, error_code FROM model_test_calls ORDER BY rowid ASC",
      )
      .all() as Array<{
      protocol: string;
      status: string;
      error_code: string | null;
    }>;
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => [row.protocol, row.status]),
      [
        ["openai-chat", "succeeded"],
        ["openai-responses", "succeeded"],
        ["anthropic-messages", "succeeded"],
        ["openai-chat", "failed"],
      ],
    );
    assert.equal(rows[3]?.error_code, "MODEL_CREDENTIAL_UNAVAILABLE");
  } finally {
    delete process.env.NOWADAYS_TEST_MODEL_KEY;
    await app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model binding resolver selects chat and memory bindings with fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-bind-"));
  const app = createBackendApp(
    parseBackendConfig(["--app-root", root, "--port", "0"]),
  );
  try {
    const role = app.services.roles.createRole({
      displayName: "模型绑定角色",
      definition: { text: "用于模型绑定验证。" },
    });
    const chat = app.services.resources.create({
      kind: "model",
      name: "对话模型",
      config: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
      },
    });
    const memory = app.services.resources.create({
      kind: "model",
      name: "整理模型",
      config: {
        protocol: "openai-responses",
        baseUrl: "http://127.0.0.1:1/v1",
      },
    });
    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: chat.resourceId,
        modelName: "chat-model",
        enabled: true,
      },
    ]);
    const resolver = new ModelBindingResolver(
      app.appStore,
      new RoleAccess(app.appStore, app.config.dataRoot),
    );
    const chatBinding = resolver.resolveChat(role.roleId);
    assert.equal(chatBinding.modelName, "chat-model");
    assert.equal(chatBinding.config.protocol, "openai-chat");
    assert.equal(resolver.resolveMemory(role.roleId).capability, "chat_model");

    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: chat.resourceId,
        modelName: "chat-model",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: memory.resourceId,
        modelName: "memory-model",
        enabled: true,
      },
    ]);
    const memoryBinding = resolver.resolveMemory(role.roleId);
    assert.equal(memoryBinding.capability, "memory_model");
    assert.equal(memoryBinding.modelName, "memory-model");
    assert.equal(memoryBinding.config.protocol, "openai-responses");

    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: chat.resourceId,
        modelName: "chat-model",
        enabled: true,
      },
      {
        capability: "memory_model",
        resourceId: memory.resourceId,
        modelName: "memory-model",
        enabled: false,
      },
    ]);
    assert.equal(resolver.resolveMemory(role.roleId).capability, "chat_model");

    app.services.resources.update(chat.resourceId, { enabled: false });
    assert.throws(
      () => resolver.resolveChat(role.roleId),
      (error: unknown) => error instanceof ModelBindingMissingError,
    );
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model service HTTP routes and CLI use the same adapter", async () => {
  const server = await startMockServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-http-"));
  const app = createBackendApp(
    parseBackendConfig(["--app-root", root, "--port", "0"]),
  );
  try {
    const port = await listen(app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = {
      protocol: "openai-chat",
      baseUrl: server.baseUrl,
    };
    const modelsResponse = await fetch(`${baseUrl}/v1/model-services/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      models: ["mock-model"],
    });
    const testResponse = await fetch(`${baseUrl}/v1/model-services/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...config, model: "mock-model" }),
    });
    assert.equal(testResponse.status, 200);
    const testBody = (await testResponse.json()) as { ok: boolean };
    assert.equal(testBody.ok, true);
    const cliModels = await runCli(baseUrl, [
      "model",
      "models",
      "--json",
      JSON.stringify(config),
    ]);
    assert.deepEqual(cliModels, { models: ["mock-model"] });
    const cliTest = await runCli(baseUrl, [
      "model",
      "test",
      "--json",
      JSON.stringify(config),
      "--model",
      "mock-model",
    ]);
    assert.equal((cliTest as { ok: boolean }).ok, true);
  } finally {
    await app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function runCli(baseUrl: string, args: readonly string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--base-url", baseUrl, ...args],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`CLI_EXIT_${code}:${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch {
        reject(new Error(`CLI_INVALID_JSON:${stdout}`));
      }
    });
  });
}
