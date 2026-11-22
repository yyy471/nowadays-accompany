// 在 backend 目录用 Node 24 --import tsx --test scripts/role-boundary-wire.test.mjs 运行。
import assert from "node:assert/strict";
import test from "node:test";
import { serializeModelRequest } from "../src/model/protocols.ts";
import { inspectRepairWire } from "./role-boundary-wire.mjs";

const fixture = { user: "我今天来了。", assistant: "今天确实到了。", sentAt: "2026-12-15T16:02:00Z" };
const today = "2026-12-22";
const question = "后来是什么时候到的？";
const tag = "[消息发送日 2026-12-16]\n";
for (const [protocol, modelName, provider, expectedNative] of [
  ["openai-chat", "deepseek-flash", "deepseek", "user"], ["google-gemini", "gemini-4-hydrogen", undefined, "model"],
]) {
  test("使用业务协议序列化真实讲话人与两个日期：" + protocol, () => {
    const model = {
      modelName, system: "本轮当地日期 " + today + "。本轮自动召回没有命中相关概况。",
      tools: [{ name: "lookup", description: "测试声明", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: tag + fixture.user, source: { messageId: "u" } },
        { role: "assistant", content: tag + fixture.assistant, source: { messageId: "a" } },
        { role: "user", content: question, source: { messageId: "now", currentUserRequest: true } },
      ],
    };
    const base = protocol === "openai-chat" ? "https://api.deepseek.com" : "https://offline.invalid";
    const raw = serializeModelRequest(protocol, base, model, provider);
    const audit = inspectRepairWire(JSON.parse(raw), protocol, fixture, question, today);
    assert.equal(audit.probeQuestionPresent, true);
    assert.equal(audit.isToolContinuation, false);
    assert.equal(audit.expectedTodayInSystem, true);
    assert.equal(audit.memoryNoMatchNotice, true);
    for (const role of ["user", "assistant"]) {
      assert.equal(audit[role].exactText, true);
      assert.equal(audit[role].expectedSentDatePresent, true);
      assert.equal(audit[role].attributedRole, role);
      assert.equal(JSON.stringify(audit).includes(fixture[role]), false);
    }
    assert.deepEqual(audit.assistant.wireNativeRoles, [expectedNative]);
    assert.equal(audit.assistant.attributedByEnvelope, protocol === "openai-chat");
    const wrongDate = inspectRepairWire(JSON.parse(raw.replaceAll("发送日 2026-12-16", "发送日 2026-12-15")), protocol, fixture, question, today);
    assert.equal(wrongDate.assistant.exactText, true);
    assert.equal(wrongDate.assistant.expectedSentDatePresent, false);
  });
}
