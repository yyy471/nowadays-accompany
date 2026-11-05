import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { listen } from "../src/bootstrap/app.js";
import { createFixture } from "./p2-05-fixture.js";

interface Frame {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const id = lines.find((line) => line.startsWith("id: "));
    const event = lines.find((line) => line.startsWith("event: "));
    const data = lines.find((line) => line.startsWith("data: "));
    if (!id || !event || !data) {
      continue;
    }
    frames.push({
      id: Number(id.slice(4)),
      event: event.slice(7),
      data: JSON.parse(data.slice(6)) as Record<string, unknown>,
    });
  }
  return frames;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  timeoutMs = 5000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
    if (text.includes(marker)) {
      return text;
    }
  }
  throw new Error(`SSE_MARKER_TIMEOUT:${marker}`);
}

test("SSE replays persisted events by cursor and rejects an invalid cursor", { timeout: 20_000 }, async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "流式" },
      { type: "text_delta", text: "回复" },
      { type: "completed", stopReason: "stop" },
    ],
    [
      { type: "text_delta", text: "只推新事件。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const controller = new AbortController();
  try {
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "请流式回复",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`;

    const invalid = await fetch(`${base}/events?after=999999`);
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as {
      error: { code: string };
    };
    assert.equal(invalidBody.error.code, "SSE_CURSOR_INVALID");

    const response = await fetch(`${base}/events?after=0&clientId=sse-client`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    assert.ok(response.body);
    const reader = response.body.getReader();
    const text = await readUntil(reader, "message_completed");
    controller.abort();
    await reader.cancel().catch(() => {});
    const frames = parseFrames(text);
    assert.ok(frames.length >= 3);
    assert.deepEqual(
      frames.map((frame) => frame.event),
      frames.map(() => "execution"),
    );
    assert.deepEqual(
      frames.map((frame) => frame.id),
      [...frames.map((frame) => frame.id)].sort((left, right) => left - right),
    );
    assert.ok(frames.some((frame) => frame.data.type === "execution_started"));
    assert.ok(frames.some((frame) => frame.data.type === "message_delta"));
    const completed = frames.find(
      (frame) => frame.data.type === "message_completed",
    );
    assert.ok(completed);
    assert.equal(typeof completed.data.replyMessageId, "string");
    assert.equal(completed.data.decisionRound, 1);
    assert.ok(
      frames.every(
        (frame) =>
          frame.data.executionId !== undefined &&
          frame.data.windowId === fixture.windowId,
      ),
    );
    const model = fixture.model as unknown as { requests: unknown[] };
    assert.equal(model.requests.length, 1);

    fixture.app.conversation.updateInputState({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      clientId: "sse-client",
      typing: true,
    });
    const controller2 = new AbortController();
    const response2 = await fetch(
      `${base}/events?clientId=sse-client&after=${frames.at(-1)?.id ?? 0}`,
      { signal: controller2.signal },
    );
    assert.equal(response2.status, 200);
    controller2.abort();
    await response2.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      fixture.app.conversation.inputStates.isTyping(
        fixture.roleId,
        fixture.windowId,
      ),
      false,
    );

    const controller3 = new AbortController();
    const fresh = await fetch(`${base}/events?clientId=fresh-client`, {
      signal: controller3.signal,
    });
    assert.equal(fresh.status, 200);
    assert.ok(fresh.body);
    const reader3 = fresh.body.getReader();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "新事件从这里开始",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    const freshText = await readUntil(reader3, "message_completed");
    controller3.abort();
    await reader3.cancel().catch(() => {});
    const freshFrames = parseFrames(freshText);
    assert.equal(freshFrames[0]?.data.type, "execution_started");
    const firstStreamLastId = frames.at(-1)?.id ?? 0;
    assert.ok(freshFrames.every((frame) => frame.id > firstStreamLastId));
    assert.equal(freshText.includes("流式"), false);
  } finally {
    controller.abort();
    await fixture.close();
  }
});
