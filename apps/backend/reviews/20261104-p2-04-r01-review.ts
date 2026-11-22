import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ModelContinuation, ModelEvent, ModelMessage, ModelProtocol } from "../src/domain/model.js";
import { HttpModelAdapter } from "../src/model/protocols.js";

// 独立复验实施方 179 的最新版本；仅注入本地响应，续轮经文件保存再读取。
const root = path.resolve("test-results/p2-04-final-20261104");
fs.mkdirSync(root, { recursive: true });
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const results: Array<{ id: string; passed: boolean; error?: string }> = [];
const originalFetch = globalThis.fetch;
async function probe(id: string, run: () => Promise<void>): Promise<void> {
  try { await run(); results.push({ id, passed: true }); }
  catch (error) { results.push({ id, passed: false, error: String(error) }); }
  finally { globalThis.fetch = originalFetch; }
}
async function events(protocol: ModelProtocol, messages: ModelMessage[], modelName = "review-model", baseUrl = "http://offline.invalid/v1"): Promise<ModelEvent[]> {
  const adapter = new HttpModelAdapter({ protocol, baseUrl }, undefined);
  const output: ModelEvent[] = [];
  for await (const event of adapter.stream({ modelName, system: "offline review", messages, tools: [] })) output.push(event);
  return output;
}
const items = [
  { type: "reasoning", id: "rs_final", encrypted_content: "opaque-final", summary: [] },
  { type: "message", id: "msg_final", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "读取两个文件", annotations: [] }] },
  { type: "function_call", id: "fc_a", call_id: "wire_a", name: "read", arguments: '{"path":"a.md"}', status: "completed" },
  { type: "function_call", id: "fc_b", call_id: "wire_b", name: "read", arguments: '{"path":"b.md"}', status: "completed" },
];
const finalResponse = sse({ type: "response.completed", response: { status: "completed", output: [] } });
for (const mode of ["full", "empty", "absent"] as const) {
  await probe(`responses-${mode}-output-replay`, async () => {
    let body = "";
    for (const item of items.slice(2)) {
      body += sse({ type: "response.output_item.added", item: { ...item, arguments: "" } });
      body += sse({ type: "response.function_call_arguments.done", item_id: item.id, arguments: item.arguments });
    }
    // 完成项以不同到达顺序提供；应按 output_index 恢复原顺序。
    for (const index of [3, 1, 0, 2]) body += sse({ type: "response.output_item.done", output_index: index, item: items[index] });
    body += sse({ type: "response.completed", response: { status: "completed", ...(mode === "absent" ? {} : { output: mode === "empty" ? [] : items }) } });
    let requests = 0;
    let wire: Record<string, unknown> = {};
    globalThis.fetch = async (_url, init) => {
      wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(requests++ === 0 ? body : finalResponse);
    };
    const first = await events("openai-responses", [{ role: "user", content: "读取" }]);
    const calls = first.filter((event) => event.type === "tool_call");
    assert.deepEqual(calls.map((call) => call.callId), ["wire_a", "wire_b"]);
    const completed = first.find((event) => event.type === "completed");
    assert.ok(completed?.continuation);
    const saved = path.join(root, `${mode}-continuation.json`);
    fs.writeFileSync(saved, JSON.stringify(completed.continuation));
    const continuation = JSON.parse(fs.readFileSync(saved, "utf8")) as ModelContinuation;
    assert.deepEqual(continuation.items, items);
    await events("openai-responses", [
      { role: "user", content: "读取" },
      { role: "assistant", content: "读取两个文件", toolCalls: calls, continuation },
      ...calls.map((call): ModelMessage => ({ role: "tool", toolCallId: call.callId, content: `result-${call.callId}` })),
    ]);
    const input = wire.input as Array<Record<string, unknown>>;
    assert.deepEqual(input.slice(1, 5), items);
    assert.deepEqual(input.slice(5).map((item) => item.call_id), ["wire_a", "wire_b"]);
    assert.equal(input.length, 7);
  });
}

await probe("anthropic-split-signature-replay", async () => {
  const expected = [
    { type: "thinking", thinking: "思考内容", signature: "sig-part-1-part-2" },
    { type: "redacted_thinking", data: "opaque-redacted" },
    { type: "text", text: "读取" },
    { type: "tool_use", id: "wire_x", name: "read", input: { path: "文件.md" } },
  ];
  const body = [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "思考" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "内容" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-part-1" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-part-2" } },
    { type: "content_block_start", index: 1, content_block: expected[1] },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "读取" } },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "wire_x", name: "read", input: {} } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '"文件.md"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ].map(sse).join("");
  let requests = 0;
  let wire: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(requests++ === 0 ? body : sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + sse({ type: "message_stop" }));
  };
  const first = await events("anthropic-messages", [{ role: "user", content: "读取" }]);
  const continuation = first.find((event) => event.type === "completed")?.continuation;
  assert.deepEqual(continuation?.items, expected);
  const saved = path.join(root, "anthropic-continuation.json");
  fs.writeFileSync(saved, JSON.stringify(continuation));
  const restored = JSON.parse(fs.readFileSync(saved, "utf8")) as ModelContinuation;
  await events("anthropic-messages", [
    { role: "user", content: "读取" }, { role: "assistant", content: "读取", continuation: restored },
    { role: "tool", toolCallId: "wire_x", content: "文件内容" },
  ]);
  assert.deepEqual((wire.messages as Array<{ content: unknown }>)[1]?.content, expected);
});

for (const changed of ["protocol", "model", "service"] as const) {
  await probe(`continuation-source-change-${changed}`, async () => {
    let wire: Record<string, unknown> = {};
    const protocol = changed === "protocol" ? "openai-chat" : "openai-responses";
    globalThis.fetch = async (_url, init) => {
      wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(protocol === "openai-chat" ? sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n" : finalResponse);
    };
    await events(protocol, [{ role: "assistant", content: "历史文字", toolCalls: [{ callId: "wire_a", name: "read", arguments: {} }], continuation: { protocol: "openai-responses", modelName: "review-model", baseUrl: "http://offline.invalid/v1", items } }], changed === "model" ? "another-model" : "review-model", changed === "service" ? "http://another.invalid/v1" : "http://offline.invalid/v1");
    assert.doesNotMatch(JSON.stringify(wire), /opaque-final|rs_final|msg_final/);
    assert.match(JSON.stringify(wire), /历史文字/);
    assert.match(JSON.stringify(wire), /wire_a/);
  });
}
fs.writeFileSync(path.join(root, "r01-report.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.passed)) process.exitCode = 1;
