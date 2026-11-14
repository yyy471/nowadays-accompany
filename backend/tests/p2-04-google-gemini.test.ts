import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { isIncompleteCompletion, type ModelEvent, type ModelMessage, type ModelToolSpec } from "../src/domain/model.js";
import { HttpModelAdapter } from "../src/model/protocols.js";
import { AppStore } from "../src/storage/app-store.js";
import { RoleStore } from "../src/storage/role-store.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  jsonBody: unknown;
}

const SAMPLE_TOOL: ModelToolSpec = {
  name: "workspace_read",
  description: "读取工作区文件",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function startHttpMock(
  handler: (req: RecordedRequest, index: number) => {
    status?: number;
    headers?: Record<string, string>;
    body: string;
  },
): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      let jsonBody: unknown = null;
      if (rawBody.trim().startsWith("{")) {
        try {
          jsonBody = JSON.parse(rawBody);
        } catch {
          jsonBody = rawBody;
        }
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        rawBody,
        jsonBody,
      };
      const index = requests.length;
      requests.push(recorded);
      const reply = handler(recorded, index);
      res.statusCode = reply.status ?? 200;
      for (const [k, v] of Object.entries(reply.headers ?? {})) {
        res.setHeader(k, v);
      }
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("MOCK_SERVER_NO_ADDRESS");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function collectEvents(
  adapter: HttpModelAdapter,
  messages: ModelMessage[],
  tools: ModelToolSpec[] = [],
  modelName = "gemini-3.8-flash",
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of adapter.stream({
    modelName,
    system: "系统提示词",
    messages,
    tools,
    maxOutputTokens: 1024,
  })) {
    events.push(event);
  }
  return events;
}

test("google-gemini 适配 Vertex Express 路径、x-goog-api-key、思考过滤与用量合并", async () => {
  const server = await startHttpMock(() => ({
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    body:
      sse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ thought: true, text: "内部思考不应直接吐字" }],
            },
          },
        ],
      }) +
      sse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "你好" }],
            },
          },
        ],
      }) +
      sse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "世界", thoughtSignature: "SIG_VISIBLE" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 9,
          totalTokenCount: 28,
        },
      }),
  }));

  try {
    const adapter = new HttpModelAdapter(
      {
        protocol: "google-gemini",
        baseUrl: `${server.baseUrl}/v1/publishers/google`,
      },
      "AQ.offline-express-test-key",
    );
    const events = await collectEvents(
      adapter,
      [{ role: "user", content: "打个招呼" }],
      [],
      "models/gemini-3.8-flash",
    );

    const req = server.requests[0];
    assert.ok(req);
    assert.equal(req.method, "POST");
    assert.equal(
      req.url,
      "/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    );
    assert.equal(req.headers["x-goog-api-key"], "AQ.offline-express-test-key");
    assert.equal(req.headers.authorization, undefined);

    const wire = req.jsonBody as Record<string, unknown>;
    assert.deepEqual(wire.systemInstruction, { parts: [{ text: "系统提示词" }] });
    assert.deepEqual(wire.generationConfig, { maxOutputTokens: 1024 });

    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, "你好世界");

    const usage = events.find((event) => event.type === "usage");
    assert.deepEqual(usage, {
      type: "usage",
      inputTokens: 15,
      outputTokens: 13,
    });

    const completed = events.find((event) => event.type === "completed");
    assert.ok(completed);
    assert.equal(completed.stopReason, "stop");
    assert.equal(isIncompleteCompletion(completed), false);
    assert.deepEqual(completed.continuation?.items, [
      { thought: true, text: "内部思考不应直接吐字" },
      { text: "你好世界", thoughtSignature: "SIG_VISIBLE" },
    ]);
  } finally {
    await server.close();
  }
});

test("google-gemini 在多轮工具调用中保留 thoughtSignature 并按协议差异处理 wire id", async () => {
  const server = await startHttpMock((_req, index) => ({
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    body:
      index === 0
        ? sse({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    { thought: true, text: "先并发读两个文件" },
                    {
                      functionCall: {
                        name: "workspace_read",
                        args: { path: "a.md" },
                      },
                      thoughtSignature: "SIG_VERTEX_V1",
                    },
                    {
                      functionCall: {
                        name: "workspace_read",
                        args: { path: "b.md" },
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          })
        : index === 1
          ? sse({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: "两个文件都已核对。" }],
                  },
                  finishReason: "STOP",
                },
              ],
            })
          : index === 2
            ? sse({
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        {
                          functionCall: {
                            id: "wire_fc_1",
                            name: "workspace_read",
                            args: { path: "c.md" },
                          },
                          thoughtSignature: "SIG_V1BETA",
                        },
                      ],
                    },
                    finishReason: "STOP",
                  },
                ],
              })
            : sse({
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [{ text: "带 wire id 也完成。" }],
                    },
                    finishReason: "STOP",
                  },
                ],
              }),
  }));

  try {
    const adapter = new HttpModelAdapter(
      {
        protocol: "google-gemini",
        baseUrl: `${server.baseUrl}/v1/publishers/google`,
      },
      "AQ.offline-key",
    );

    // 情况一：Vertex v1 不下发 functionCall.id，续传应保留 thoughtSignature 且不注入 id。
    const first = await collectEvents(
      adapter,
      [{ role: "user", content: "读取 a.md 和 b.md" }],
      [SAMPLE_TOOL],
    );
    const firstTools = first.filter((event) => event.type === "tool_call");
    const firstDone = first.find((event) => event.type === "completed");
    assert.equal(firstTools.length, 2);
    assert.ok(firstDone?.continuation);

    const turn2 = await collectEvents(
      adapter,
      [
        { role: "user", content: "读取 a.md 和 b.md" },
        {
          role: "assistant",
          content: "",
          toolCalls: firstTools.map((call, idx) => ({
            callId: `biz_${idx}`,
            name: call.name,
            arguments: call.arguments,
          })),
          continuation: firstDone.continuation,
        },
        {
          role: "tool",
          toolCallId: "biz_0",
          toolName: "workspace_read",
          content: JSON.stringify({ content: "alpha" }),
        },
        {
          role: "tool",
          toolCallId: "biz_1",
          // 刻意省略 toolName，验证会从前置 assistant.toolCalls 自动回填。
          content: "plain beta text",
        },
      ],
      [SAMPLE_TOOL],
    );
    assert.equal(
      turn2
        .filter((e) => e.type === "text_delta")
        .map((e) => e.text)
        .join(""),
      "两个文件都已核对。",
    );

    const wire2 = server.requests[1]?.jsonBody as {
      tools?: Array<{ functionDeclarations?: Array<Record<string, unknown>> }>;
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    assert.ok(wire2.tools?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema);
    assert.equal(wire2.contents.length, 3);
    assert.equal(wire2.contents[1]?.role, "model");
    assert.equal(wire2.contents[1]?.parts[1]?.thoughtSignature, "SIG_VERTEX_V1");
    assert.equal(
      "id" in ((wire2.contents[1]?.parts[1]?.functionCall as Record<string, unknown>) ?? {}),
      false,
    );
    assert.equal(wire2.contents[2]?.role, "user");
    assert.equal(wire2.contents[2]?.parts.length, 2);
    assert.deepEqual(wire2.contents[2]?.parts[0], {
      functionResponse: {
        name: "workspace_read",
        response: { content: "alpha" },
      },
    });
    assert.deepEqual(wire2.contents[2]?.parts[1], {
      functionResponse: {
        name: "workspace_read",
        response: { output: "plain beta text" },
      },
    });

    // 情况二：AI Studio v1beta 下发 functionCall.id 时，functionResponse 应透传 wire id。
    const third = await collectEvents(
      adapter,
      [{ role: "user", content: "读取 c.md" }],
      [SAMPLE_TOOL],
    );
    const thirdTool = third.find((event) => event.type === "tool_call");
    const thirdDone = third.find((event) => event.type === "completed");
    assert.ok(thirdTool);
    assert.equal(thirdTool.callId, "wire_fc_1");
    assert.ok(thirdDone?.continuation);

    await collectEvents(
      adapter,
      [
        { role: "user", content: "读取 c.md" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              callId: thirdTool.callId,
              name: thirdTool.name,
              arguments: thirdTool.arguments,
            },
          ],
          continuation: thirdDone.continuation,
        },
        {
          role: "tool",
          toolCallId: thirdTool.callId,
          toolName: "workspace_read",
          content: JSON.stringify({ content: "gamma" }),
        },
      ],
      [SAMPLE_TOOL],
    );
    const wire4 = server.requests[3]?.jsonBody as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(wire4.contents[2]?.parts[0], {
      functionResponse: {
        name: "workspace_read",
        id: "wire_fc_1",
        response: { content: "gamma" },
      },
    });

    // 情况三：切换 baseUrl 或 modelName 时不回传旧服务的 thoughtSignature continuation。
    const changedAdapter = new HttpModelAdapter(
      {
        protocol: "google-gemini",
        baseUrl: `${server.baseUrl}/v1beta`,
      },
      "AQ.offline-key",
    );
    await collectEvents(
      changedAdapter,
      [
        { role: "user", content: "读取 a.md 和 b.md" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              callId: "biz_0",
              name: "workspace_read",
              arguments: { path: "a.md" },
            },
          ],
          continuation: firstDone.continuation,
        },
        {
          role: "tool",
          toolCallId: "biz_0",
          toolName: "workspace_read",
          content: "ok",
        },
      ],
      [SAMPLE_TOOL],
    );
    const changedWire = server.requests[4]?.jsonBody as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    assert.equal(
      JSON.stringify(changedWire).includes("SIG_VERTEX_V1"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("google-gemini 终态、安全拦截、截断与错误状态映射", async () => {
  const cases = [
    {
      name: "MAX_TOKENS 标记未完成",
      response: () => ({
        body: sse({
          candidates: [
            { content: { role: "model", parts: [{ text: "半截" }] }, finishReason: "MAX_TOKENS" },
          ],
        }),
      }),
      verify: async (adapter: HttpModelAdapter) => {
        const events = await collectEvents(adapter, [{ role: "user", content: "hi" }]);
        const done = events.find((e) => e.type === "completed");
        assert.ok(done);
        assert.equal(done.stopReason, "max_tokens");
        assert.equal(isIncompleteCompletion(done), true);
      },
    },
    {
      name: "SAFETY candidate finishReason 标记未完成",
      response: () => ({
        body: sse({
          candidates: [{ finishReason: "SAFETY" }],
        }),
      }),
      verify: async (adapter: HttpModelAdapter) => {
        const events = await collectEvents(adapter, [{ role: "user", content: "hi" }]);
        const done = events.find((e) => e.type === "completed");
        assert.ok(done);
        assert.equal(done.stopReason, "safety");
        assert.equal(isIncompleteCompletion(done), true);
      },
    },
    {
      name: "promptFeedback.blockReason 拒绝请求",
      response: () => ({
        body: sse({
          promptFeedback: { blockReason: "SAFETY" },
        }),
      }),
      verify: async (adapter: HttpModelAdapter) => {
        await assert.rejects(
          () => collectEvents(adapter, [{ role: "user", content: "hi" }]),
          (err: { code?: string; details?: { reason?: string } }) =>
            err.code === "MODEL_REQUEST_FAILED" &&
            err.details?.reason === "content_policy_violation",
        );
      },
    },
    {
      name: "无 finishReason 提前断流触发 STREAM_TRUNCATED",
      response: () => ({
        body: sse({
          candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }],
        }),
      }),
      verify: async (adapter: HttpModelAdapter) => {
        await assert.rejects(
          () => collectEvents(adapter, [{ role: "user", content: "hi" }]),
          (err: { code?: string; details?: { reason?: string } }) =>
            err.code === "MODEL_REQUEST_FAILED" &&
            err.details?.reason === "STREAM_TRUNCATED",
        );
      },
    },
    {
      name: "HTTP 400 INVALID_ARGUMENT 安全映射原因且不泄密原文",
      response: () => ({
        status: 400,
        body: JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "secret-should-not-leak-in-details",
          },
        }),
      }),
      verify: async (adapter: HttpModelAdapter) => {
        await assert.rejects(
          () => collectEvents(adapter, [{ role: "user", content: "hi" }]),
          (err: {
            code?: string;
            message?: string;
            details?: { status?: number; reason?: string };
          }) =>
            err.code === "MODEL_REQUEST_FAILED" &&
            err.details?.status === 400 &&
            err.details?.reason === "invalid_request_error" &&
            !String(err.message).includes("secret-should-not-leak"),
        );
      },
    },
    {
      name: "SSE 内联 error 帧映射为安全原因码",
      response: () => ({
        body: sse({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "quota exceeded",
          },
        }),
      }),
      verify: async (adapter: HttpModelAdapter) => {
        await assert.rejects(
          () => collectEvents(adapter, [{ role: "user", content: "hi" }]),
          (err: { code?: string; details?: { reason?: string } }) =>
            err.code === "MODEL_REQUEST_FAILED" &&
            err.details?.reason === "rate_limit_exceeded",
        );
      },
    },
  ];

  for (const item of cases) {
    const server = await startHttpMock(() => item.response());
    try {
      const adapter = new HttpModelAdapter(
        { protocol: "google-gemini", baseUrl: server.baseUrl },
        "AQ.test",
      );
      await item.verify(adapter);
    } finally {
      await server.close();
    }
  }
});

test("google-gemini listModels 支持 AI Studio 与 Vertex 格式，并支持 GCP 服务账号 OAuth2 JWT 换签与实例缓存", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const server = await startHttpMock((req) => {
    if (req.url === "/token") {
      const params = new URLSearchParams(req.rawBody);
      assert.equal(
        params.get("grant_type"),
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      const assertion = params.get("assertion") ?? "";
      const [headerB64, claimB64, sigB64] = assertion.split(".");
      assert.ok(headerB64 && claimB64 && sigB64);
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${headerB64}.${claimB64}`);
      verifier.end();
      assert.equal(
        verifier.verify(publicKey, Buffer.from(sigB64, "base64url")),
        true,
      );
      const claims = JSON.parse(
        Buffer.from(claimB64, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      assert.equal(claims.iss, "bot@demo.iam.gserviceaccount.com");
      return {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          access_token: "ya29.offline-oauth-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      };
    }
    if (req.url === "/v1beta/models") {
      return {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-flash",
              supportedGenerationMethods: ["generateContent", "countTokens"],
            },
            {
              name: "models/text-embedding-004",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        }),
      };
    }
    if (req.url === "/vertex/models") {
      return {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publisherModels: [
            { name: "publishers/google/models/gemini-2.5-pro", versionId: "001" },
          ],
        }),
      };
    }
    if (req.url === "/v1/publishers/google/models") {
      return {
        status: 404,
        headers: { "content-type": "text/html" },
        body: "<title>Error 404 (Not Found)!!1</title>",
      };
    }
    return {
      headers: { "content-type": "text/event-stream" },
      body: sse({
        candidates: [
          { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
        ],
      }),
    };
  });

  try {
    const aiStudioAdapter = new HttpModelAdapter(
      { protocol: "google-gemini", baseUrl: `${server.baseUrl}/v1beta` },
      "AIza.offline",
    );
    assert.deepEqual(await aiStudioAdapter.listModels(), ["gemini-2.5-flash"]);
    assert.equal(server.requests[0]?.headers["x-goog-api-key"], "AIza.offline");

    const vertexExpressAdapter = new HttpModelAdapter(
      { protocol: "google-gemini", baseUrl: `${server.baseUrl}/v1/publishers/google` },
      "AQ.offline",
    );
    await assert.rejects(
      () => vertexExpressAdapter.listModels(),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Vertex AI Express") &&
        error.message.includes("HTTP 404"),
    );

    const saJson = JSON.stringify({
      type: "service_account",
      client_email: "bot@demo.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: `${server.baseUrl}/token`,
    });
    const vertexOAuthAdapter = new HttpModelAdapter(
      { protocol: "google-gemini", baseUrl: `${server.baseUrl}/vertex` },
      saJson,
    );
    assert.deepEqual(await vertexOAuthAdapter.listModels(), ["gemini-2.5-pro"]);
    await collectEvents(vertexOAuthAdapter, [{ role: "user", content: "ping" }]);

    const tokenCalls = server.requests.filter((r) => r.url === "/token");
    assert.equal(tokenCalls.length, 1, "同一适配器实例应缓存未过期 OAuth token");
    assert.equal(
      server.requests.at(-1)?.headers.authorization,
      "Bearer ya29.offline-oauth-token",
    );
    assert.equal(server.requests.at(-1)?.headers["x-goog-api-key"], undefined);
  } finally {
    await server.close();
  }
});

test("SQLite 老库迁移（v7->v8 与 v17->v18）及 ModelService / 资源创建联调通过", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-gemini-db-"));
  const server = await startHttpMock((req) => {
    if (req.url.endsWith("/models")) {
      return {
        status: 404,
        body: JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "not supported" } }),
      };
    }
    return {
      headers: { "content-type": "text/event-stream" },
      body: sse({
        candidates: [
          { content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      }),
    };
  });

  try {
    // 1. 先创建当前最新版库，再刻意降级回旧 CHECK 约束（v7 / v17），验证实际在线迁移与既有数据留存。
    const migrateAppConfig = parseBackendConfig(["--app-root", path.join(root, "mig"), "--port", "0"]);
    const migApp = createBackendApp(migrateAppConfig);
    const createdRole = migApp.services.roles.createRole({
      displayName: "迁移验证角色",
      definition: { text: "测试约束升级" },
    });
    const oldTestCallId = randomUUID();
    migApp.appStore.db
      .prepare(
        `INSERT INTO model_test_calls
         (test_call_id, resource_id, model_name, protocol, status, error_code, started_at, finished_at, usage_json, config_fingerprint)
         VALUES (?, NULL, 'gpt-4.1-mini', 'openai-chat', 'succeeded', NULL, ?, ?, NULL, 'fp-old')`,
      )
      .run(oldTestCallId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");

    const paths = rolePaths(migrateAppConfig.dataRoot, createdRole.roleId);
    const oldModelCallId = randomUUID();
    const roleDb = new Database(paths.businessDatabasePath);
    roleDb
      .prepare(
        `INSERT INTO model_calls
         (model_call_id, role_id, execution_id, batch_id, purpose, resource_id, model_name, protocol, status, error_code, started_at, finished_at, usage_json, raw_response_json)
         VALUES (?, ?, NULL, NULL, 'user_chat', NULL, 'gpt-4.1-mini', 'openai-chat', 'succeeded', NULL, ?, ?, NULL, NULL)`,
      )
      .run(oldModelCallId, createdRole.roleId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");
    roleDb.close();
    await migApp.close();

    // 将两张表回退为 v7/v17 旧约束，同时保留已有数据行。
    const rawApp = new Database(migrateAppConfig.appDatabasePath);
    rawApp.exec(`
      ALTER TABLE model_test_calls RENAME TO _tmp_old_test_calls;
      DROP INDEX IF EXISTS idx_model_test_calls_resource;
      CREATE TABLE model_test_calls (
        test_call_id TEXT PRIMARY KEY,
        resource_id TEXT,
        model_name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('openai-chat', 'openai-responses', 'anthropic-messages')),
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        usage_json TEXT,
        config_fingerprint TEXT
      );
      INSERT INTO model_test_calls SELECT * FROM _tmp_old_test_calls;
      DROP TABLE _tmp_old_test_calls;
      CREATE INDEX idx_model_test_calls_resource ON model_test_calls (resource_id, finished_at);
    `);
    rawApp.pragma("user_version = 7");
    rawApp.close();

    const rawBiz = new Database(paths.businessDatabasePath);
    rawBiz.exec(`
      ALTER TABLE model_calls RENAME TO _tmp_old_calls;
      DROP INDEX IF EXISTS idx_model_calls_role_time;
      CREATE TABLE model_calls (
        model_call_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL REFERENCES roles(role_id),
        execution_id TEXT REFERENCES executions(execution_id),
        batch_id TEXT REFERENCES memory_batches(batch_id),
        purpose TEXT NOT NULL CHECK (purpose IN ('user_chat', 'user_task', 'memory_maintenance', 'autonomous', 'connection_test')),
        resource_id TEXT,
        model_name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('openai-chat', 'openai-responses', 'anthropic-messages')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        usage_json TEXT,
        raw_response_json TEXT
      );
      INSERT INTO model_calls SELECT * FROM _tmp_old_calls;
      DROP TABLE _tmp_old_calls;
      CREATE INDEX idx_model_calls_role_time ON model_calls (role_id, started_at);
    `);
    rawBiz.pragma("user_version = 17");
    rawBiz.close();

    const upgradedApp = new AppStore(migrateAppConfig.appDatabasePath);
    const upgradedBiz = new RoleStore(paths.businessDatabasePath, { create: false });
    try {
      assert.equal(upgradedApp.schemaVersion, 8);
      assert.equal(upgradedBiz.schemaVersion, 18);
      const oldAppRow = upgradedApp.db
        .prepare("SELECT protocol FROM model_test_calls WHERE test_call_id = ?")
        .get(oldTestCallId) as { protocol: string } | undefined;
      assert.equal(oldAppRow?.protocol, "openai-chat");
      upgradedApp.saveModelTestCall({
        resourceId: null,
        modelName: "gemini-3.8-flash",
        protocol: "google-gemini",
        status: "succeeded",
        errorCode: null,
        configFingerprint: "fp-gem",
        startedAt: "2026-01-01T00:00:02.000Z",
        finishedAt: "2026-01-01T00:00:03.000Z",
        usageJson: null,
      });

      const oldBizRow = upgradedBiz.db
        .prepare("SELECT protocol FROM model_calls WHERE model_call_id = ?")
        .get(oldModelCallId) as { protocol: string } | undefined;
      assert.equal(oldBizRow?.protocol, "openai-chat");
      upgradedBiz.db
        .prepare(
          `INSERT INTO model_calls
           (model_call_id, role_id, execution_id, batch_id, purpose, resource_id, model_name, protocol, status, error_code, started_at, finished_at, usage_json, raw_response_json)
           VALUES (?, ?, NULL, NULL, 'user_chat', NULL, 'gemini-3.8-flash', 'google-gemini', 'succeeded', NULL, ?, ?, NULL, NULL)`,
        )
        .run(
          randomUUID(),
          createdRole.roleId,
          "2026-01-01T00:00:02.000Z",
          "2026-01-01T00:00:03.000Z",
        );
    } finally {
      upgradedBiz.close();
      upgradedApp.close();
    }

    // 2. 通过 HTTP API 创建 google-gemini 资源并执行连接测试，验证全链路落库。
    const liveConfig = parseBackendConfig(["--app-root", path.join(root, "http"), "--port", "0"]);
    const liveApp = createBackendApp(liveConfig);
    try {
      const port = await listen(liveApp.server, 0, "127.0.0.1");
      const base = `http://127.0.0.1:${port}`;
      const createRes = await fetch(`${base}/v1/resources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "model",
          name: "Vertex Express",
          config: {
            protocol: "google-gemini",
            baseUrl: `${server.baseUrl}/v1/publishers/google`,
          },
          secret: "AQ.http-test-secret",
        }),
      });
      assert.equal(createRes.status, 201);
      const resource = (await createRes.json()) as {
        resourceId: string;
        config: { protocol: string };
      };
      assert.equal(resource.config.protocol, "google-gemini");

      const testRes = await fetch(`${base}/v1/model-services/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceId: resource.resourceId,
          protocol: "google-gemini",
          baseUrl: `${server.baseUrl}/v1/publishers/google`,
          model: "gemini-3.8-flash",
        }),
      });
      assert.equal(testRes.status, 200);
      const testBody = (await testRes.json()) as { ok: boolean };
      assert.equal(testBody.ok, true);
      assert.equal(server.requests.at(-1)?.headers["x-goog-api-key"], "AQ.http-test-secret");

      // 3. 绑定角色并发起端到端对话，验证 AgentGraph -> ConversationStore -> model_calls 全链路通过。
      const roleRes = await fetch(`${base}/v1/roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Gemini 对话角色",
          definition: { text: "测试 google-gemini 对话主链路" },
        }),
      });
      assert.equal(roleRes.status, 201);
      const roleJson = (await roleRes.json()) as {
        roleId: string;
        defaultWindowId: string;
      };
      const bindRes = await fetch(
        `${base}/v1/roles/${roleJson.roleId}/bindings`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bindings: [
              {
                capability: "chat_model",
                resourceId: resource.resourceId,
                modelName: "gemini-3.8-flash",
              },
            ],
          }),
        },
      );
      assert.equal(bindRes.status, 200);
      const resumeRes = await fetch(
        `${base}/v1/roles/${roleJson.roleId}/activity/resume`,
        { method: "POST" },
      );
      assert.equal(resumeRes.status, 200);
      const msgRes = await fetch(
        `${base}/v1/roles/${roleJson.roleId}/windows/${roleJson.defaultWindowId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "你好 Gemini", submissionId: randomUUID() }),
        },
      );
      assert.equal(msgRes.status, 201);
      await liveApp.conversation.waitForIdle(roleJson.roleId);

      const chatReq = server.requests.find(
        (r) =>
          r.url ===
          "/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse" &&
          JSON.stringify(r.jsonBody).includes("你好 Gemini"),
      );
      assert.ok(chatReq, "对话应按 Vertex Express 路径发出流式生成请求");
      assert.equal(chatReq.headers["x-goog-api-key"], "AQ.http-test-secret");

      const livePaths = rolePaths(liveConfig.dataRoot, roleJson.roleId);
      const liveBizDb = new Database(livePaths.businessDatabasePath, { readonly: true });
      try {
        const callRow = liveBizDb
          .prepare("SELECT protocol, model_name, status FROM model_calls WHERE purpose = 'user_chat'")
          .get() as { protocol: string; model_name: string; status: string } | undefined;
        assert.deepEqual(callRow, {
          protocol: "google-gemini",
          model_name: "gemini-3.8-flash",
          status: "succeeded",
        });
      } finally {
        liveBizDb.close();
      }
    } finally {
      await liveApp.close();
    }
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
