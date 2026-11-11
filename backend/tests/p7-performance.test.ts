import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { listen } from "../src/bootstrap/app.js";
import {
  parseSegmentAnnotationOutput,
} from "../src/application/segment-annotation-service.js";
import type { MessageSegmentRecord } from "../src/domain/conversation.js";
import type { OutfitRecord } from "../src/domain/appearance.js";
import { segmentMessage, settledMessageSegments } from "../src/domain/message-segments.js";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import { resolveCredential } from "../src/model/credentials.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import {
  createFixture,
  createFixtureWithModel,
  deferred,
  GatedChatModel,
  ScriptedChatModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ModelEvent[] {
  return [
    { type: "tool_call", callId, name, arguments: args },
    { type: "completed", stopReason: "tool_calls" },
  ];
}

function reply(text: string): ModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop" },
  ];
}

function userContent(request: ModelRequest): string {
  const message = request.messages[0];
  return message !== undefined && message.role === "user" ? message.content : "";
}

async function importOutfit(
  fixture: Fixture,
  name: string,
  spriteNames: readonly string[],
): Promise<OutfitRecord> {
  return fixture.app.services.appearance.importOutfit(fixture.roleId, {
    name,
    home: { fileName: "home.png", data: PNG_1X1 },
    sprites: spriteNames.map((spriteName) => ({
      fileName: `${spriteName}.png`,
      data: PNG_1X1,
    })),
  });
}

function countTableRows(
  fixture: Fixture,
  table: "model_calls" | "call_metering",
): number {
  return withStorage(
    fixture,
    (storage) =>
      (
        storage.business.db
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as { count: number }
      ).count,
  );
}

function executionEvents(
  fixture: Fixture,
  executionId: string,
): Array<{ event_type: string; payload_json: string }> {
  return withStorage(fixture, (storage) =>
    storage.business.db
      .prepare(
        "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
      )
      .all(executionId) as Array<{
      event_type: string;
      payload_json: string;
    }>,
  );
}

function messageExecutionId(fixture: Fixture, messageId: string): string {
  return withStorage(fixture, (storage) => {
    const row = storage.business.db
      .prepare("SELECT execution_id FROM messages WHERE message_id = ?")
      .get(messageId) as { execution_id: string | null } | undefined;
    const executionId = row?.execution_id ?? null;
    assert.ok(executionId);
    return executionId;
  });
}

function assertSegmentSlices(
  segments: readonly MessageSegmentRecord[],
  content: string,
): void {
  for (const segment of segments) {
    assert.equal(
      content.slice(segment.startOffset, segment.endOffset),
      segment.text,
    );
  }
}

interface Frame {
  id: number;
  data: Record<string, unknown>;
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const id = lines.find((line) => line.startsWith("id: "));
    const data = lines.find((line) => line.startsWith("data: "));
    if (!id || !data) {
      continue;
    }
    frames.push({
      id: Number(id.slice(4)),
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

test("natural segmentation keeps source ranges, merges short clauses and marks narration", () => {
  const content =
    "早。今天去哪里？\n（她放下书，看向你）车站吧。\n\n旁白：窗外开始下雨。";
  const segments = segmentMessage(content);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["speech", "narration", "speech", "narration"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.text),
    [
      "早。今天去哪里？",
      "（她放下书，看向你）",
      "车站吧。",
      "窗外开始下雨。",
    ],
  );
  assert.deepEqual(
    segments.map((segment) => segment.ordinal),
    [0, 1, 2, 3],
  );
  for (const segment of segments) {
    assert.equal(
      content.slice(segment.startOffset, segment.endOffset),
      segment.text,
    );
  }

  const explicit = segmentMessage("旁白：她低下头。窗外开始下雨。");
  assert.deepEqual(
    explicit.map((segment) => segment.kind),
    ["narration"],
  );
  assert.deepEqual(
    explicit.map((segment) => segment.text),
    ["她低下头。窗外开始下雨。"],
  );

  const starred = segmentMessage("*她低下头。窗外开始下雨。*");
  assert.deepEqual(
    starred.map((segment) => segment.kind),
    ["narration"],
  );
  assert.deepEqual(
    starred.map((segment) => segment.text),
    ["她低下头。窗外开始下雨。"],
  );

  const mixed = segmentMessage("旁白：她低下头。台词：走吧。");
  assert.deepEqual(
    mixed.map((segment) => segment.kind),
    ["narration", "speech"],
  );
  assert.deepEqual(
    mixed.map((segment) => segment.text),
    ["她低下头。", "走吧。"],
  );

  const quoted = segmentMessage("旁白：她低下头。她说：“走吧。”");
  assert.deepEqual(
    quoted.map((segment) => segment.kind),
    ["narration", "speech"],
  );
  assert.deepEqual(
    quoted.map((segment) => segment.text),
    ["她低下头。她说：", "“走吧。”"],
  );

  const inline = segmentMessage("她笑了*转身离开。*");
  assert.deepEqual(
    inline.map((segment) => segment.kind),
    ["speech", "narration"],
  );

  const inlineActions = segmentMessage("*她微笑* 你好！ *她挥手*");
  assert.deepEqual(
    inlineActions.map((segment) => segment.kind),
    ["narration", "speech", "narration"],
  );
  assert.deepEqual(
    inlineActions.map((segment) => segment.text),
    ["她微笑", "你好！", "她挥手"],
  );

  for (const [source, drafts] of [
    ["旁白：她低下头。窗外开始下雨。", explicit],
    ["*她低下头。窗外开始下雨。*", starred],
    ["旁白：她低下头。台词：走吧。", mixed],
    ["旁白：她低下头。她说：“走吧。”", quoted],
    ["她笑了*转身离开。*", inline],
    ["*她微笑* 你好！ *她挥手*", inlineActions],
  ] as const) {
    for (const segment of drafts) {
      assert.equal(
        source.slice(segment.startOffset, segment.endOffset),
        segment.text,
      );
    }
  }

  assert.equal(segmentMessage("嗯。我知道了，我会去的。").length, 1);
  assert.equal(
    segmentMessage("今天天气很好，我们一起出门散步吧。不过你得先把手头的事情做完。")
      .length,
    2,
  );
  assert.equal(
    segmentMessage("This sentence is long enough. Another sentence is also long.")
      .length,
    2,
  );
  assert.deepEqual(segmentMessage("  \n\n  "), []);
  assert.deepEqual(settledMessageSegments("嗯。（她转身。）（"), []);
  assert.deepEqual(
    settledMessageSegments("第一句话说得比较完整。第二句话也足够长，还没写完")
      .map((segment) => segment.text),
    ["第一句话说得比较完整。"],
  );
});

test("one reply keeps one message with stable segments and replayable events", { timeout: 30_000 }, async () => {
  const content =
    "第一句话说得比较完整。第二句话也足够长，单独成为一段。\n（她轻轻点头）";
  const fixture = createFixture([reply(content)]);
  try {
    submit(fixture, "说点什么");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const listed = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    const assistantMessages = listed.items.filter(
      (message) => message.sender === "assistant",
    );
    assert.equal(assistantMessages.length, 1);
    const message = assistantMessages[0]!;
    assert.equal(message.content, content);

    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      message.messageId,
    );
    assert.deepEqual(
      listed.segments.map((segment) => segment.segmentId),
      detail.segments.map((segment) => segment.segmentId),
    );
    assert.equal(listed.activeReply, null);
    assert.equal(detail.message.messageId, message.messageId);
    assert.deepEqual(
      detail.segments.map((segment) => segment.kind),
      ["speech", "speech", "narration"],
    );
    assert.deepEqual(
      detail.segments.map((segment) => segment.text),
      [
        "第一句话说得比较完整。",
        "第二句话也足够长，单独成为一段。",
        "（她轻轻点头）",
      ],
    );
    assertSegmentSlices(detail.segments, content);

    const events = executionEvents(
      fixture,
      messageExecutionId(fixture, message.messageId),
    );
    const eventTypes = events.map((event) => event.event_type);
    const segmentsIndex = events.findIndex((event) =>
      event.event_type === "message_segments" && JSON.parse(event.payload_json).partial !== true,
    );
    const completedIndex = eventTypes.indexOf("message_completed");
    assert.ok(segmentsIndex >= 0);
    assert.ok(completedIndex > segmentsIndex);
    const payload = JSON.parse(events[segmentsIndex]!.payload_json) as {
      replyMessageId: string;
      segments: Array<{ segmentId: string; text: string }>;
    };
    assert.equal(payload.replyMessageId, message.messageId);
    assert.deepEqual(
      payload.segments.map((segment) => segment.segmentId),
      detail.segments.map((segment) => segment.segmentId),
    );

    const replay = withStorage(fixture, (storage) =>
      new ConversationStore(
        storage.business.db,
        fixture.roleId,
      ).listStreamEventsAfter(fixture.windowId, 0),
    );
    const replayedSegments = replay.find(
      (event) => event.type === "message_segments" && event.payload.partial !== true,
    );
    assert.ok(replayedSegments);
    assert.deepEqual(
      (replayedSegments.payload.segments as Array<{ segmentId: string }>).map(
        (segment) => segment.segmentId,
      ),
      detail.segments.map((segment) => segment.segmentId),
    );

    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`;
    const response = await fetch(`${base}/messages/${message.messageId}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      message: { messageId: string };
      segments: Array<{ segmentId: string; text: string }>;
    };
    assert.equal(body.message.messageId, message.messageId);
    assert.deepEqual(
      body.segments.map((segment) => segment.segmentId),
      detail.segments.map((segment) => segment.segmentId),
    );

    const missing = await fetch(`${base}/messages/${randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      "MESSAGE_NOT_FOUND",
    );
    const otherWindow = fixture.app.services.roles.createWindow(
      fixture.roleId,
      { kind: "custom", source: "nowadays" },
    );
    const wrongWindow = await fetch(
      `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${otherWindow.windowId}/messages/${message.messageId}`,
    );
    assert.equal(wrongWindow.status, 404);
  } finally {
    await fixture.close();
  }
});

test("a running reply publishes settled segments and keeps their IDs after completion", { timeout: 30_000 }, async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const first = "我在这里。\n*她挥挥手*\n";
  const fixture = createFixtureWithModel({
    async *stream() {
      yield { type: "text_delta", text: first + "那我们" };
      started.resolve();
      await release.promise;
      yield { type: "text_delta", text: "出发吧。" };
      yield { type: "completed", stopReason: "stop" };
    },
  });
  try {
    submit(fixture, "你好");
    await started.promise;
    const live = fixture.app.services.messages.list(fixture.roleId, fixture.windowId, null, 50);
    assert.ok(live.activeReply);
    assert.deepEqual(live.segments.map(({ text, kind }) => [text, kind]), [
      ["我在这里。", "speech"], ["她挥挥手", "narration"],
    ]);
    const events = executionEvents(fixture, live.activeReply.executionId);
    const liveEvent = events.find((event) => event.event_type === "message_segments");
    assert.ok(liveEvent);
    assert.equal(JSON.parse(liveEvent.payload_json).partial, true);
    release.resolve();
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const saved = fixture.app.services.messages.get(fixture.roleId, fixture.windowId, live.activeReply.messageId);
    assert.deepEqual(saved.segments.slice(0, 2), live.segments);
    assert.equal(saved.segments[2]?.text, "那我们出发吧。");
  } finally {
    release.resolve();
    await fixture.close();
  }
});

test("an interrupted reply finalizes its partial text into segments before the interruption event", { timeout: 30_000 }, async () => {
  const model = new GatedChatModel();
  const fixture = createFixtureWithModel(model);
  try {
    submit(fixture, "旧问题");
    await model.started.promise;
    const snapshot = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    assert.ok(snapshot.activeReply);
    assert.equal(snapshot.activeReply.text, "旧");
    assert.deepEqual(snapshot.segments, []);
    submit(fixture, "换个问题");
    model.release.resolve(undefined);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const afterIdle = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    assert.equal(afterIdle.activeReply, null);

    const listed = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    const interrupted = listed.items.find(
      (message) => message.status === "interrupted",
    );
    assert.ok(interrupted);
    assert.equal(interrupted.content, "旧");
    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      interrupted.messageId,
    );
    assert.deepEqual(
      detail.segments.map((segment) => segment.text),
      ["旧"],
    );

    const eventTypes = executionEvents(
      fixture,
      messageExecutionId(fixture, interrupted.messageId),
    ).map((event) => event.event_type);
    const segmentsIndex = eventTypes.indexOf("message_segments");
    const interruptedIndex = eventTypes.indexOf("message_interrupted");
    assert.ok(segmentsIndex >= 0);
    assert.ok(interruptedIndex > segmentsIndex);
    assert.ok(eventTypes.includes("execution_superseded"));
  } finally {
    await fixture.close();
  }
});

test("a proactive share also stores segments and publishes them before completion", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const execution = withStorage(fixture, (storage) =>
      storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "autonomous",
      }),
    );
    const content = "我刚看到窗外的云很好看。\n（她望向窗外）";
    const shared = fixture.app.services.autonomy.shareMessage(fixture.roleId, {
      content,
      executionId: execution.executionId,
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      shared.windowId,
      shared.messageId,
    );
    assert.equal(detail.message.content, content);
    assert.deepEqual(
      detail.segments.map((segment) => segment.kind),
      ["speech", "narration"],
    );
    assertSegmentSlices(detail.segments, content);
    assert.deepEqual(
      executionEvents(fixture, execution.executionId).map(
        (event) => event.event_type,
      ),
      ["message_segments", "message_completed"],
    );
  } finally {
    await fixture.close();
  }
});

test("annotation selects a sprite from the committed outfit and ignores unknown ids", { timeout: 60_000 }, async () => {
  const ids = { black: "", blackSprite: "", blackHome: "", white: "", whiteSprite: "" };
  const fixture = createFixture([
    () =>
      toolCall("wire-outfit-black", "state_update", {
        patch: { outfitId: ids.black },
      }),
    reply("今天穿黑白长裙。\n（她理了理裙摆）环顾四周。"),
    (request) => {
      assert.match(request.system, /立绘标注器/);
      assert.match(request.system, /黑白长裙/);
      const payload = JSON.parse(userContent(request)) as {
        segments: Array<{ segmentId: string; text: string }>;
        sprites: Array<{ spriteAssetId: string; displayName: string }>;
      };
      assert.deepEqual(
        payload.segments.map((segment) => segment.text),
        ["今天穿黑白长裙。", "（她理了理裙摆）", "环顾四周。"],
      );
      assert.deepEqual(
        payload.sprites.map((sprite) => sprite.displayName),
        ["微笑", "侧目"],
      );
      assert.equal(payload.sprites[0]!.spriteAssetId, ids.blackSprite);
      return reply(
        JSON.stringify({
          segments: [
            {
              segmentId: payload.segments[0]!.segmentId,
              spriteAssetId: payload.sprites[0]!.spriteAssetId,
            },
            {
              segmentId: "not-a-segment",
              spriteAssetId: payload.sprites[0]!.spriteAssetId,
            },
            {
              segmentId: payload.segments[2]!.segmentId,
              spriteAssetId: "not-a-sprite",
            },
          ],
        }),
      );
    },
    () =>
      toolCall("wire-outfit-white", "state_update", {
        patch: { outfitId: ids.white },
      }),
    reply("换上白色针织裙。"),
    (request) => {
      assert.match(request.system, /白色针织裙/);
      const payload = JSON.parse(userContent(request)) as {
        segments: Array<{ segmentId: string }>;
        sprites: Array<{ spriteAssetId: string }>;
      };
      return reply(
        JSON.stringify({
          segments: [
            {
              segmentId: payload.segments[0]!.segmentId,
              spriteAssetId: payload.sprites[0]!.spriteAssetId,
            },
          ],
        }),
      );
    },
  ]);
  try {
    const black = await importOutfit(fixture, "黑白长裙", ["微笑", "侧目"]);
    ids.black = black.outfitId;
    ids.blackSprite = black.sprites[0]!.assetId;
    ids.blackHome = black.home!.assetId;
    const white = await importOutfit(fixture, "白色针织裙", ["浅笑"]);
    ids.white = white.outfitId;
    ids.whiteSprite = white.sprites[0]!.assetId;

    submit(fixture, "今天穿什么？");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const listed = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    const first = listed.items.find(
      (message) =>
        message.sender === "assistant" &&
        message.content.startsWith("今天穿黑白长裙"),
    );
    assert.ok(first);
    const firstDetail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      first.messageId,
    );
    assert.equal(firstDetail.segments.length, 3);
    assert.equal(firstDetail.segments[0]!.outfitId, ids.black);
    assert.equal(firstDetail.segments[0]!.spriteAssetId, ids.blackSprite);
    assert.equal(firstDetail.segments[0]!.homeAssetId, ids.blackHome);
    assert.notEqual(firstDetail.segments[0]!.annotatedAt, null);
    assert.equal(firstDetail.segments[1]!.annotatedAt, null);
    assert.equal(firstDetail.segments[2]!.annotatedAt, null);

    const firstEvents = executionEvents(
      fixture,
      messageExecutionId(fixture, first.messageId),
    );
    const firstTypes = firstEvents.map((event) => event.event_type);
    const completedIndex = firstTypes.indexOf("message_completed");
    const annotationIndex = firstTypes.indexOf("segment_annotations");
    assert.ok(completedIndex >= 0);
    assert.ok(annotationIndex > completedIndex);
    const annotationPayload = JSON.parse(
      firstEvents[annotationIndex]!.payload_json,
    ) as {
      messageId: string;
      items: Array<{
        segmentId: string;
        outfitId: string;
        spriteAssetId: string;
        homeAssetId: string | null;
      }>;
    };
    assert.equal(annotationPayload.messageId, first.messageId);
    assert.deepEqual(annotationPayload.items, [
      {
        segmentId: firstDetail.segments[0]!.segmentId,
        outfitId: ids.black,
        spriteAssetId: ids.blackSprite,
        homeAssetId: ids.blackHome,
      },
    ]);

    submit(fixture, "换一套");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const replayDetail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      first.messageId,
    );
    assert.equal(replayDetail.segments[0]!.outfitId, ids.black);
    assert.equal(replayDetail.segments[0]!.spriteAssetId, ids.blackSprite);

    const afterSwitch = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    const second = afterSwitch.items.find(
      (message) =>
        message.sender === "assistant" &&
        message.content.startsWith("换上白色针织裙"),
    );
    assert.ok(second);
    const secondDetail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      second.messageId,
    );
    assert.equal(secondDetail.segments[0]!.outfitId, ids.white);
    assert.equal(secondDetail.segments[0]!.spriteAssetId, ids.whiteSprite);
    assert.equal(
      (fixture.model as ScriptedChatModel).requests.length,
      6,
    );
    assert.deepEqual(
      fixture.app.services.roles.getState(fixture.roleId).state.outfitId,
      ids.white,
    );
  } finally {
    await fixture.close();
  }
});

test("SSE replays segments before completion and late annotations after it", { timeout: 30_000 }, async () => {
  const ids = { outfit: "", sprite: "" };
  const fixture = createFixture([
    () =>
      toolCall("wire-sse-outfit", "state_update", {
        patch: { outfitId: ids.outfit },
      }),
    reply("第一句话说得比较完整。第二句话也足够长，单独成为一段。"),
    (request) => {
      const payload = JSON.parse(userContent(request)) as {
        segments: Array<{ segmentId: string }>;
      };
      return reply(
        JSON.stringify({
          segments: [
            {
              segmentId: payload.segments[0]!.segmentId,
              spriteAssetId: ids.sprite,
            },
          ],
        }),
      );
    },
  ]);
  const controller = new AbortController();
  try {
    const outfit = await importOutfit(fixture, "测试长裙", ["微笑"]);
    ids.outfit = outfit.outfitId;
    ids.sprite = outfit.sprites[0]!.assetId;
    submit(fixture, "开始");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}/events?after=0&clientId=sse-performance`,
      { signal: controller.signal },
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const text = await readUntil(reader, "segment_annotations");
    controller.abort();
    await reader.cancel().catch(() => {});

    const frames = parseFrames(text);
    const types = frames.map((frame) => String(frame.data.type));
    const liveFrame = frames.find(({ data }) => data.type === "message_segments" && data.partial === true);
    const segmentsIndex = frames.findIndex(({ data }) => data.type === "message_segments" && data.partial !== true);
    const completedIndex = types.indexOf("message_completed");
    const annotationsIndex = types.indexOf("segment_annotations");
    assert.ok(segmentsIndex >= 0);
    assert.ok(liveFrame);
    assert.ok(completedIndex > segmentsIndex);
    assert.ok(annotationsIndex > completedIndex);

    const segmentPayload = frames[segmentsIndex]!.data as {
      segments: Array<{ segmentId: string; text: string }>;
    };
    assert.deepEqual(
      segmentPayload.segments.map((segment) => segment.text),
      ["第一句话说得比较完整。", "第二句话也足够长，单独成为一段。"],
    );
    const liveSegments = liveFrame.data.segments as Array<{ segmentId: string }>;
    assert.deepEqual(liveSegments.map(({ segmentId }) => segmentId), [segmentPayload.segments[0]!.segmentId]);
    const annotationPayload = frames[annotationsIndex]!.data as {
      items: Array<{
        segmentId: string;
        outfitId: string;
        spriteAssetId: string;
        homeAssetId: string | null;
      }>;
    };
    assert.deepEqual(annotationPayload.items, [
      {
        segmentId: segmentPayload.segments[0]!.segmentId,
        outfitId: ids.outfit,
        spriteAssetId: ids.sprite,
        homeAssetId: outfit.home!.assetId,
      },
    ]);
  } finally {
    controller.abort();
    await fixture.close();
  }
});

test("an outfit without sprites saves segments without calling the annotation model", { timeout: 30_000 }, async () => {
  const fixture = createFixture([reply("这一套没有差分。")]);
  try {
    const outfit = await importOutfit(fixture, "简约常服", []);
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { outfitId: outfit.outfitId },
    });
    submit(fixture, "随口说一句");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const listed = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    const assistant = listed.items.find(
      (message) => message.sender === "assistant",
    );
    assert.ok(assistant);
    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      assistant.messageId,
    );
    assert.ok(detail.segments.length > 0);
    assert.ok(
      detail.segments.every(
        (segment) =>
          segment.annotatedAt === null &&
          segment.outfitId === outfit.outfitId &&
          segment.spriteAssetId === null,
      ),
    );
    const eventTypes = executionEvents(
      fixture,
      messageExecutionId(fixture, assistant.messageId),
    ).map((event) => event.event_type);
    assert.equal(eventTypes.includes("segment_annotations"), false);
    assert.equal(
      (fixture.model as ScriptedChatModel).requests.length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("window snapshot carries the SSE cursor across a reply that finishes before connect", { timeout: 30_000 }, async () => {
  const model = new GatedChatModel();
  const fixture = createFixtureWithModel(model);
  const controller = new AbortController();
  try {
    submit(fixture, "开始");
    await model.started.promise;

    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`;
    const snapshotResponse = await fetch(`${base}/messages`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      items: Array<{ messageId: string; sender: string }>;
      activeReply: {
        messageId: string;
        executionId: string;
        text: string;
      } | null;
      cursor: number;
    };
    assert.ok(snapshot.activeReply);
    assert.equal(snapshot.activeReply.text, "旧");
    const expectedCursor = withStorage(fixture, (storage) =>
      new ConversationStore(
        storage.business.db,
        fixture.roleId,
      ).latestEventId(fixture.windowId),
    );
    assert.equal(snapshot.cursor, expectedCursor);
    assert.ok(
      snapshot.items.some(
        (message) => message.messageId === snapshot.activeReply?.messageId,
      ),
    );

    // 终态在快照返回之后、SSE 建连之前写入。
    model.release.resolve(undefined);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const response = await fetch(
      `${base}/events?after=${snapshot.cursor}&clientId=snapshot-client`,
      { signal: controller.signal },
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const text = await readUntil(reader, "message_completed");
    controller.abort();
    await reader.cancel().catch(() => {});

    const frames = parseFrames(text);
    assert.ok(frames.every((frame) => frame.id > snapshot.cursor));
    assert.equal(
      frames.some((frame) => frame.data.type === "execution_started"),
      false,
    );
    const newText = frames
      .filter((frame) => frame.data.type === "message_delta")
      .map((frame) => String(frame.data.delta ?? ""))
      .join("");
    assert.equal(snapshot.activeReply.text + newText, "旧回复");
    assert.ok(
      frames.some((frame) => frame.data.type === "message_segments"),
    );
    assert.ok(
      frames.some((frame) => frame.data.type === "message_completed"),
    );

    const finalPage = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      null,
      50,
    );
    const reply = finalPage.items.find(
      (message) => message.sender === "assistant",
    );
    assert.equal(reply?.content, "旧回复");
    assert.equal(finalPage.activeReply, null);
  } finally {
    controller.abort();
    await fixture.close();
  }
});

test("SSE reconnect continues from the newer Last-Event-ID instead of the URL cursor", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    reply("第一轮回复也足够长。"),
    reply("第二轮回复也足够长。"),
  ]);
  const controller = new AbortController();
  try {
    submit(fixture, "第一问");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const eventsUrl = `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}/events`;

    // 中途断开：只读到第一轮完成事件。
    const firstResponse = await fetch(`${eventsUrl}?after=0`, {
      signal: controller.signal,
    });
    assert.equal(firstResponse.status, 200);
    const firstReader = firstResponse.body!.getReader();
    const firstText = await readUntil(firstReader, "message_completed");
    const firstFrames = parseFrames(firstText);
    const lastSeen = firstFrames.at(-1)?.id;
    assert.ok(lastSeen !== undefined);
    assert.equal(firstFrames.at(-1)?.data.type, "message_completed");
    await firstReader.cancel().catch(() => {});

    submit(fixture, "第二问");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    // EventSource 自动重连保留原地址并补上 Last-Event-ID；
    // URL 中的 after=0 不应让已经收到的事件再次重放。
    const reconnectResponse = await fetch(`${eventsUrl}?after=0`, {
      signal: controller.signal,
      headers: { "Last-Event-ID": String(lastSeen) },
    });
    assert.equal(reconnectResponse.status, 200);
    const reconnectReader = reconnectResponse.body!.getReader();
    const reconnectText = await readUntil(reconnectReader, "message_completed");
    controller.abort();
    await reconnectReader.cancel().catch(() => {});

    const frames = parseFrames(reconnectText);
    assert.ok(frames.length > 0);
    assert.ok(frames.every((frame) => frame.id > lastSeen));
    assert.equal(
      frames.some((frame) => frame.data.type === "execution_started"),
      true,
    );
    assert.equal(
      frames
        .filter((frame) => frame.data.type === "message_delta")
        .map((frame) => String(frame.data.delta ?? ""))
        .join(""),
      "第二轮回复也足够长。",
    );
    assert.equal(
      frames.filter((frame) => frame.data.type === "message_completed").length,
      1,
    );
  } finally {
    controller.abort();
    await fixture.close();
  }
});

test("message list returns the newest page and pages backwards with before", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    withStorage(fixture, (storage) => {
      for (let index = 1; index <= 5; index += 1) {
        storage.business.submitMessage(fixture.roleId, fixture.windowId, {
          content: `第${index}条`,
          submissionId: `sub-${index}`,
          sourcePlatform: "nowadays",
        });
      }
    });
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}/messages`;

    const latest = (await (await fetch(`${base}?limit=2`)).json()) as {
      items: Array<{ sequence: number }>;
      nextBefore: number | null;
      nextAfter: number | null;
      cursor: number;
      activeReply: unknown;
    };
    assert.deepEqual(
      latest.items.map((message) => message.sequence),
      [4, 5],
    );
    assert.equal(latest.nextBefore, 4);
    assert.equal(latest.nextAfter, null);
    assert.equal(latest.cursor, 0);
    assert.equal(latest.activeReply, null);

    const middle = (await (
      await fetch(`${base}?before=4&limit=2`)
    ).json()) as {
      items: Array<{ sequence: number }>;
      nextBefore: number | null;
    };
    assert.deepEqual(
      middle.items.map((message) => message.sequence),
      [2, 3],
    );
    assert.equal(middle.nextBefore, 2);

    const oldest = (await (
      await fetch(`${base}?before=2&limit=2`)
    ).json()) as {
      items: Array<{ sequence: number }>;
      nextBefore: number | null;
    };
    assert.deepEqual(
      oldest.items.map((message) => message.sequence),
      [1],
    );
    assert.equal(oldest.nextBefore, null);

    const forward = (await (
      await fetch(`${base}?after=0&limit=2`)
    ).json()) as {
      items: Array<{ sequence: number }>;
      nextAfter: number | null;
      nextBefore: number | null;
    };
    assert.deepEqual(
      forward.items.map((message) => message.sequence),
      [1, 2],
    );
    assert.equal(forward.nextAfter, 2);
    assert.equal(forward.nextBefore, null);
  } finally {
    await fixture.close();
  }
});

test("segments keep the committed outfit even when annotation is omitted", { timeout: 60_000 }, async () => {
  const ids = { black: "", blackSprite: "", white: "", whiteSprite: "" };
  const fixture = createFixture([
    () =>
      toolCall("wire-black-1", "state_update", {
        patch: { outfitId: ids.black },
      }),
    reply("今天穿黑白长裙。"),
    (request) => {
      const payload = JSON.parse(userContent(request)) as {
        segments: Array<{ segmentId: string }>;
        sprites: Array<{ spriteAssetId: string }>;
      };
      return reply(
        JSON.stringify({
          segments: [
            {
              segmentId: payload.segments[0]!.segmentId,
              spriteAssetId: payload.sprites[0]!.spriteAssetId,
            },
          ],
        }),
      );
    },
    () =>
      toolCall("wire-white", "state_update", {
        patch: { outfitId: ids.white },
      }),
    reply("换上白色针织裙。"),
    () => reply(JSON.stringify({ segments: [] })),
    () =>
      toolCall("wire-black-2", "state_update", {
        patch: { outfitId: ids.black },
      }),
    reply("又换回黑白长裙。"),
    (request) => {
      const payload = JSON.parse(userContent(request)) as {
        segments: Array<{ segmentId: string }>;
        sprites: Array<{ spriteAssetId: string }>;
      };
      return reply(
        JSON.stringify({
          segments: [
            {
              segmentId: payload.segments[0]!.segmentId,
              spriteAssetId: payload.sprites[0]!.spriteAssetId,
            },
          ],
        }),
      );
    },
  ]);
  try {
    const black = await importOutfit(fixture, "黑白长裙", ["微笑"]);
    const white = await importOutfit(fixture, "白色针织裙", ["浅笑"]);
    ids.black = black.outfitId;
    ids.blackSprite = black.sprites[0]!.assetId;
    ids.white = white.outfitId;
    ids.whiteSprite = white.sprites[0]!.assetId;
    const usedBefore = fixture.app.services.autonomy.getBudget(
      fixture.roleId,
    ).usedPoints;

    submit(fixture, "第一套");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    submit(fixture, "第二套");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    submit(fixture, "第三套");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const assistantMessages = fixture.app.services.messages
      .list(fixture.roleId, fixture.windowId, 0, 50)
      .items.filter((message) => message.sender === "assistant");
    const first = assistantMessages.find((message) =>
      message.content.startsWith("今天穿黑白长裙"),
    );
    const second = assistantMessages.find((message) =>
      message.content.startsWith("换上白色针织裙"),
    );
    const third = assistantMessages.find((message) =>
      message.content.startsWith("又换回黑白长裙"),
    );
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);

    const firstDetail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      first.messageId,
    );
    const secondDetail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      second.messageId,
    );
    const thirdDetail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      third.messageId,
    );
    assert.equal(firstDetail.segments[0]!.outfitId, ids.black);
    assert.equal(firstDetail.segments[0]!.spriteAssetId, ids.blackSprite);
    assert.equal(secondDetail.segments[0]!.outfitId, ids.white);
    assert.equal(secondDetail.segments[0]!.spriteAssetId, null);
    assert.equal(secondDetail.segments[0]!.annotatedAt, null);
    assert.equal(thirdDetail.segments[0]!.outfitId, ids.black);
    assert.equal(thirdDetail.segments[0]!.spriteAssetId, ids.blackSprite);

    const secondAgain = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      second.messageId,
    );
    assert.equal(secondAgain.segments[0]!.outfitId, ids.white);
    assert.equal(secondAgain.segments[0]!.spriteAssetId, null);

    const modelCalls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT purpose, COUNT(*) AS count,
                  SUM(status = 'succeeded') AS succeeded
             FROM model_calls WHERE role_id = ? GROUP BY purpose`,
        )
        .all(fixture.roleId) as Array<{
        purpose: string;
        count: number;
        succeeded: number;
      }>,
    );
    assert.deepEqual(modelCalls, [
      { purpose: "user_chat", count: 9, succeeded: 9 },
    ]);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT COUNT(*) AS count, SUM(counted) AS counted
             FROM call_metering WHERE role_id = ? AND call_kind = 'model'`,
        )
        .get(fixture.roleId) as { count: number; counted: number },
    );
    assert.deepEqual(metering, { count: 9, counted: 0 });
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      usedBefore,
    );
    assert.equal(
      (fixture.model as ScriptedChatModel).requests.length,
      9,
    );
  } finally {
    await fixture.close();
  }
});

test("autonomous annotation respects the budget and records its model call", { timeout: 60_000 }, async () => {
  const ids = { outfit: "", sprite: "" };
  const fixture = createFixture([
    (request) => {
      const payload = JSON.parse(userContent(request)) as {
        segments: Array<{ segmentId: string }>;
      };
      return [
        { type: "usage", inputTokens: 11, outputTokens: 7 },
        {
          type: "text_delta",
          text: JSON.stringify({
            segments: [
              {
                segmentId: payload.segments[0]!.segmentId,
                spriteAssetId: ids.sprite,
              },
            ],
          }),
        },
        { type: "completed", stopReason: "stop" },
      ];
    },
  ]);
  try {
    const outfit = await importOutfit(fixture, "自主长裙", ["微笑"]);
    ids.outfit = outfit.outfitId;
    ids.sprite = outfit.sprites[0]!.assetId;
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { outfitId: outfit.outfitId },
    });
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: false,
    });
    const consumed = fixture.app.services.autonomy.consumePoint(
      fixture.roleId,
    );
    assert.equal(consumed.exhausted, false);

    const firstExecution = withStorage(fixture, (storage) =>
      storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "autonomous",
      }),
    );
    const first = fixture.app.services.autonomy.shareMessage(
      fixture.roleId,
      {
        content: "预算用完了吗？",
        executionId: firstExecution.executionId,
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal((fixture.model as ScriptedChatModel).requests.length, 0);
    const firstDetail = fixture.app.services.messages.get(
      fixture.roleId,
      first.windowId,
      first.messageId,
    );
    assert.equal(firstDetail.segments[0]!.outfitId, ids.outfit);
    assert.equal(firstDetail.segments[0]!.spriteAssetId, null);
    const firstCalls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM model_calls WHERE execution_id = ?",
        )
        .get(firstExecution.executionId) as { count: number },
    );
    assert.equal(firstCalls.count, 0);

    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 5,
      unlimited: false,
    });
    const secondExecution = withStorage(fixture, (storage) =>
      storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "autonomous",
      }),
    );
    const second = fixture.app.services.autonomy.shareMessage(
      fixture.roleId,
      {
        content: "这次有额度了。",
        executionId: secondExecution.executionId,
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal((fixture.model as ScriptedChatModel).requests.length, 1);
    assert.match(
      (fixture.model as ScriptedChatModel).requests[0]!.system,
      /立绘标注器/,
    );
    const secondDetail = fixture.app.services.messages.get(
      fixture.roleId,
      second.windowId,
      second.messageId,
    );
    assert.equal(secondDetail.segments[0]!.outfitId, ids.outfit);
    assert.equal(secondDetail.segments[0]!.spriteAssetId, ids.sprite);
    const calls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT purpose, status, usage_json FROM model_calls
            WHERE execution_id = ?`,
        )
        .all(secondExecution.executionId) as Array<{
        purpose: string;
        status: string;
        usage_json: string | null;
      }>,
    );
    assert.deepEqual(calls, [
      {
        purpose: "autonomous",
        status: "succeeded",
        usage_json: JSON.stringify({ inputTokens: 11, outputTokens: 7 }),
      },
    ]);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT COUNT(*) AS count, SUM(counted) AS counted
             FROM call_metering WHERE execution_id = ? AND call_kind = 'model'`,
        )
        .get(secondExecution.executionId) as {
        count: number;
        counted: number;
      },
    );
    assert.deepEqual(metering, { count: 1, counted: 1 });
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      2,
    );
  } finally {
    await fixture.close();
  }
});

test("a failed annotation registration rolls back the autonomy point", { timeout: 60_000 }, async () => {
  const ids = { outfit: "", sprite: "" };
  const fixture = createFixture([
    (request) => {
      const payload = JSON.parse(userContent(request)) as {
        segments: Array<{ segmentId: string }>;
      };
      return reply(
        JSON.stringify({
          segments: [
            {
              segmentId: payload.segments[0]!.segmentId,
              spriteAssetId: ids.sprite,
            },
          ],
        }),
      );
    },
  ]);
  const modelCallCount = (): number => countTableRows(fixture, "model_calls");
  const meteringCount = (): number => countTableRows(fixture, "call_metering");
  try {
    const outfit = await importOutfit(fixture, "登记故障长裙", ["微笑"]);
    ids.outfit = outfit.outfitId;
    ids.sprite = outfit.sprites[0]!.assetId;
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { outfitId: outfit.outfitId },
    });
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 5,
      unlimited: false,
    });
    const execution = withStorage(fixture, (storage) =>
      storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "autonomous",
      }),
    );
    const before = {
      points:
        fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      calls: modelCallCount(),
      metering: meteringCount(),
      requests: (fixture.model as ScriptedChatModel).requests.length,
    };

    // 派发前的调用登记失败：扣点与调用记录必须一起回滚。
    withStorage(fixture, (storage) =>
      storage.business.db.exec(
        `CREATE TRIGGER p7_metering_failure BEFORE INSERT ON call_metering
           WHEN NEW.call_kind = 'model'
         BEGIN SELECT RAISE(ABORT, 'injected call_metering failure'); END`,
      ),
    );
    const failed = fixture.app.services.autonomy.shareMessage(fixture.roleId, {
      content: "这次登记会失败。",
      executionId: execution.executionId,
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const failedDetail = fixture.app.services.messages.get(
      fixture.roleId,
      failed.windowId,
      failed.messageId,
    );
    assert.equal(failedDetail.message.content, "这次登记会失败。");
    assert.equal(failedDetail.segments[0]!.outfitId, ids.outfit);
    assert.equal(failedDetail.segments[0]!.spriteAssetId, null);
    assert.equal(
      (fixture.model as ScriptedChatModel).requests.length,
      before.requests,
    );
    assert.equal(modelCallCount(), before.calls);
    assert.equal(meteringCount(), before.metering);
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      before.points,
    );

    withStorage(fixture, (storage) =>
      storage.business.db.exec("DROP TRIGGER p7_metering_failure"),
    );
    const secondExecution = withStorage(fixture, (storage) =>
      storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "autonomous",
      }),
    );
    const recovered = fixture.app.services.autonomy.shareMessage(
      fixture.roleId,
      {
        content: "这次登记成功。",
        executionId: secondExecution.executionId,
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const recoveredDetail = fixture.app.services.messages.get(
      fixture.roleId,
      recovered.windowId,
      recovered.messageId,
    );
    assert.equal(recoveredDetail.segments[0]!.spriteAssetId, ids.sprite);
    assert.equal(
      (fixture.model as ScriptedChatModel).requests.length,
      before.requests + 1,
    );
    assert.equal(modelCallCount(), before.calls + 1);
    assert.equal(meteringCount(), before.metering + 1);
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      before.points + 1,
    );
  } finally {
    await fixture.close();
  }
});

test("annotation with a missing model credential keeps points and call records untouched", { timeout: 30_000 }, async () => {
  let appRoot = "";
  const fixture = createFixture([], {
    modelPortFactory: (binding) => {
      resolveCredential(appRoot, binding.config.credentialRef);
      throw new Error("unreachable model factory");
    },
  });
  appRoot = fixture.root;
  try {
    const outfit = await importOutfit(fixture, "凭据缺失长裙", ["微笑"]);
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { outfitId: outfit.outfitId },
    });
    const resource = fixture.app.services.resources.create({
      kind: "model",
      name: "缺失凭据模型",
      config: {
        protocol: "openai-chat",
        baseUrl: "http://offline.invalid/v1",
        credentialRef: "file:missing-credential.txt",
      },
    });
    fixture.app.services.resources.replaceBindings(fixture.roleId, [
      {
        capability: "chat_model",
        resourceId: resource.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 5,
      unlimited: false,
    });
    const execution = withStorage(fixture, (storage) =>
      storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "autonomous",
      }),
    );
    const before = {
      points:
        fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      calls: countTableRows(fixture, "model_calls"),
      metering: countTableRows(fixture, "call_metering"),
    };

    const shared = fixture.app.services.autonomy.shareMessage(fixture.roleId, {
      content: "缺少凭据时也要保留分享。",
      executionId: execution.executionId,
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      shared.windowId,
      shared.messageId,
    );
    assert.equal(detail.message.content, "缺少凭据时也要保留分享。");
    assert.equal(detail.segments[0]!.outfitId, outfit.outfitId);
    assert.equal(detail.segments[0]!.spriteAssetId, null);
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      before.points,
    );
    assert.equal(countTableRows(fixture, "model_calls"), before.calls);
    assert.equal(countTableRows(fixture, "call_metering"), before.metering);
  } finally {
    await fixture.close();
  }
});

test("an autonomous annotation failure after dispatch keeps its failed call and point", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    () => {
      throw new Error("offline annotation failed");
    },
  ]);
  try {
    const outfit = await importOutfit(fixture, "派发失败长裙", ["微笑"]);
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { outfitId: outfit.outfitId },
    });
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 5,
      unlimited: false,
    });
    const execution = withStorage(fixture, (storage) =>
      storage.business.createExecution({
        roleId: fixture.roleId,
        windowId: fixture.windowId,
        triggerType: "autonomous",
      }),
    );
    const before =
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints;
    const shared = fixture.app.services.autonomy.shareMessage(fixture.roleId, {
      content: "派发后失败也要留痕。",
      executionId: execution.executionId,
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      shared.windowId,
      shared.messageId,
    );
    assert.equal(detail.message.content, "派发后失败也要留痕。");
    assert.equal(detail.segments[0]!.spriteAssetId, null);
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      before + 1,
    );
    const calls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT status, error_code, purpose FROM model_calls
            WHERE execution_id = ?`,
        )
        .all(execution.executionId),
    );
    assert.deepEqual(calls, [
      {
        status: "failed",
        error_code: "MODEL_REQUEST_FAILED",
        purpose: "autonomous",
      },
    ]);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT purpose, counted FROM call_metering
            WHERE execution_id = ? AND call_kind = 'model'`,
        )
        .all(execution.executionId),
    );
    assert.deepEqual(metering, [{ purpose: "autonomous", counted: 1 }]);
  } finally {
    await fixture.close();
  }
});

test("a failed annotation leaves the reply and segments intact and records the failure", { timeout: 30_000 }, async () => {
  const ids = { outfit: "" };
  const fixture = createFixture([
    () =>
      toolCall("wire-failure-outfit", "state_update", {
        patch: { outfitId: ids.outfit },
      }),
    reply("这条回复会保留。"),
    () => {
      throw new Error("offline annotation failed");
    },
  ]);
  try {
    const outfit = await importOutfit(fixture, "失败长裙", ["微笑"]);
    ids.outfit = outfit.outfitId;
    submit(fixture, "试一下");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const assistant = fixture.app.services.messages
      .list(fixture.roleId, fixture.windowId, 0, 50)
      .items.find((message) => message.sender === "assistant");
    assert.equal(assistant?.content, "这条回复会保留。");
    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      assistant!.messageId,
    );
    assert.equal(detail.segments[0]!.outfitId, ids.outfit);
    assert.equal(detail.segments[0]!.spriteAssetId, null);
    assert.equal(detail.segments[0]!.annotatedAt, null);

    const calls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT status, error_code, purpose FROM model_calls
            WHERE role_id = ? ORDER BY started_at ASC, rowid ASC`,
        )
        .all(fixture.roleId) as Array<{
        status: string;
        error_code: string | null;
        purpose: string;
      }>,
    );
    assert.deepEqual(
      calls.map((call) => call.status),
      ["succeeded", "succeeded", "failed"],
    );
    assert.equal(calls[2]!.error_code, "MODEL_REQUEST_FAILED");
    assert.equal(calls[2]!.purpose, "user_chat");
  } finally {
    await fixture.close();
  }
});

test("annotation parser only accepts known segments and sprites", () => {
  const allowed = {
    segmentIds: new Set(["segment-1", "segment-2"]),
    spriteAssetIds: new Set(["asset-1"]),
  };
  const content = [
    "```json",
    JSON.stringify({
      segments: [
        { segmentId: "segment-1", spriteAssetId: "asset-1" },
        { segmentId: "segment-2", spriteAssetId: "missing-asset" },
        { segmentId: "missing-segment", spriteAssetId: "asset-1" },
        { segmentId: "segment-1", spriteAssetId: "asset-1" },
        { segmentId: 3, spriteAssetId: "asset-1" },
      ],
    }),
    "```",
  ].join("\n");
  assert.deepEqual(parseSegmentAnnotationOutput(content, allowed), [
    { segmentId: "segment-1", spriteAssetId: "asset-1" },
  ]);
  assert.deepEqual(parseSegmentAnnotationOutput("not json", allowed), []);
  assert.deepEqual(
    parseSegmentAnnotationOutput('{"segments":"nope"}', allowed),
    [],
  );
});
