import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelMessage, ModelProtocol } from "../src/domain/model.js";
import { HttpModelAdapter } from "../src/model/protocols.js";

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;
async function collect(adapter: HttpModelAdapter, messages: ModelMessage[]): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of adapter.stream({ modelName: "offline", system: "test", messages, tools: [] })) {
    events.push(event);
  }
  return events;
}

for (const protocol of ["openai-responses", "anthropic-messages"] satisfies ModelProtocol[]) {
  test(`${protocol} replays complete provider output after JSON persistence`, async () => {
    const fetchBefore = globalThis.fetch;
    const output = protocol === "openai-responses"
      ? [
          { type: "reasoning", id: "rs_review", summary: [], encrypted_content: "opaque-review-reasoning" },
          { type: "message", id: "msg_review", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "先读取", annotations: [] }] },
          { type: "function_call", id: "fc_review", call_id: "call_review", name: "workspace_read", arguments: '{"path":"a.md"}', status: "completed" },
        ]
      : [
          { type: "thinking", thinking: "先考虑", signature: "signed-review" },
          { type: "redacted_thinking", data: "opaque-redacted-review" },
          { type: "text", text: "先读取" },
          { type: "tool_use", id: "call_review", name: "workspace_read", input: { path: "a.md" } },
        ];
    const firstBody = protocol === "openai-responses"
      ? sse({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_review", call_id: "call_review", name: "workspace_read", arguments: "" } }) +
        sse({ type: "response.function_call_arguments.done", item_id: "fc_review", arguments: '{"path":"a.md"}' }) +
        sse({ type: "response.completed", response: { status: "completed", output } })
      : sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先考虑" } }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-review" } }) +
        sse({ type: "content_block_start", index: 1, content_block: output[1] }) +
        sse({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }) +
        sse({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "先读取" } }) +
        sse({ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "call_review", name: "workspace_read", input: {} } }) +
        sse({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"a.md"}' } }) +
        sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }) + sse({ type: "message_stop" });
    const terminal = protocol === "openai-responses"
      ? sse({ type: "response.completed", response: { status: "completed", output: [] } })
      : sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + sse({ type: "message_stop" });
    let wire: Record<string, unknown> = {};
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(calls++ === 0 ? firstBody : terminal, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const adapter = new HttpModelAdapter({ protocol, baseUrl: "http://offline.invalid/v1" }, undefined);
      const first = await collect(adapter, [{ role: "user", content: "读取" }]);
      const completed = first.find((event) => event.type === "completed");
      assert.ok(completed);
      const continuation = completed.continuation;
      assert.ok(continuation, "provider output must have an explicit replay path");
      const assistant = JSON.parse(JSON.stringify({ role: "assistant", content: "先读取", toolCalls: [{ callId: "call_review", name: "workspace_read", arguments: { path: "a.md" } }], continuation })) as ModelMessage;
      await collect(adapter, [
        { role: "user", content: "读取" }, assistant,
        { role: "tool", toolCallId: "call_review", content: "a.md contents" },
      ]);
      if (protocol === "openai-responses") {
        assert.deepEqual((wire.input as unknown[]).slice(1, -1), output);
        assert.equal((wire.input as unknown[]).length, 5, "do not duplicate normalized text or calls");
      } else {
        const messages = wire.messages as Array<{ role: string; content: unknown[] }>;
        assert.deepEqual(messages[1]?.content, output);
        assert.equal(messages.length, 3);
      }
      // 服务配置变更后使用归一化历史，不把旧服务的加密／签名块发给新服务。
      const otherService = new HttpModelAdapter({ protocol, baseUrl: "http://different.invalid/v1" }, undefined);
      await collect(otherService, [assistant, { role: "tool", toolCallId: "call_review", content: "a.md contents" }]);
      assert.doesNotMatch(JSON.stringify(wire), /opaque-review-reasoning|signed-review|opaque-redacted-review/);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });
}
