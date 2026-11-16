import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import type { VoiceCapabilities, VoiceEngineStatus } from "../src/domain/voice.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import { configFetch } from "./config-write.js";
import {
  createFixture,
  createFixtureWithModel,
  deferred,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

function createWav(payload: Buffer = Buffer.alloc(16, 0x22)): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + payload.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

const WAV_AUDIO = createWav();

const BASE_CAPABILITIES: VoiceCapabilities = {
  referenceModes: [
    { id: "clone", label: "参考音频", requiresReferenceText: false },
  ],
  presetVoices: true,
  languages: ["zh", "en"],
  speed: { min: 0.5, max: 2.0 },
};

interface RecordedTtsCall {
  mode: string | null;
  text: string | null;
  voiceId: string | null;
  engine: string | null;
  emotion: string | null;
  language: string | null;
  speed: string | null;
}

async function startDualEngineFakeTts() {
  const calls: RecordedTtsCall[] = [];
  let healthPayload: Record<string, unknown> = {
    protocol: "nowadays-tts-v1",
    service: "Fake Dual Bridge",
    model: "CosyVoice3-0.5B",
    ready: true,
    capabilities: {
      ...BASE_CAPABILITIES,
      engines: {
        cosyvoice: { ready: true, active: true, onDemand: true },
        indextts: { ready: false, active: false, onDemand: true },
      },
      defaultEngine: "cosyvoice",
    },
  };
  let voices = [
    { id: "cosy:v1", label: "秧秧" },
    { id: "index:v1", label: "秧秧" },
    { id: "cosy:reference", label: "当前默认音色" },
    { id: "index:reference", label: "当前默认音色" },
  ];

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthPayload));
      return;
    }
    if (req.method === "GET" && pathname === "/voices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices }));
      return;
    }
    if (req.method === "POST" && pathname === "/tts") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] ?? "application/octet-stream";
      const form = await new Response(raw, {
        headers: { "content-type": contentType },
      }).formData();
      const field = (name: string): string | null => {
        const value = form.get(name);
        return typeof value === "string" ? value : null;
      };
      calls.push({
        mode: field("mode"),
        text: field("text"),
        voiceId: field("voice_id"),
        engine: field("engine"),
        emotion: field("emotion"),
        language: field("language"),
        speed: field("speed"),
      });
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(WAV_AUDIO);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    setHealth(next: Record<string, unknown>) {
      healthPayload = next;
    },
    setVoices(next: Array<{ id: string; label: string }>) {
      voices = next;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function roleBase(fixture: Fixture, port: number): string {
  return `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}`;
}

test("probe exposes engines and defaultEngine while keeping capabilities pure and validates ttsEngine", async () => {
  const fake = await startDualEngineFakeTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);

    const probed = await configFetch(`${base}/voice/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: fake.baseUrl }),
    });
    assert.equal(probed.status, 200);
    const probedBody = (await probed.json()) as {
      probe: {
        capabilities: Record<string, unknown>;
        engines?: Record<string, VoiceEngineStatus>;
        defaultEngine?: string;
      };
    };
    assert.deepEqual(probedBody.probe.capabilities, BASE_CAPABILITIES);
    assert.equal("engines" in probedBody.probe.capabilities, false);
    assert.deepEqual(probedBody.probe.engines, {
      cosyvoice: { ready: true, active: true, onDemand: true },
      indextts: { ready: false, active: false, onDemand: true },
    });
    assert.equal(probedBody.probe.defaultEngine, "cosyvoice");

    const invalidEngine = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: fake.baseUrl,
        protocol: "nowadays-tts-v1",
        ttsEngine: "unknown-engine",
        engines: probedBody.probe.engines,
        defaultEngine: "cosyvoice",
        voiceSource: { kind: "preset", voiceId: "cosy:v1" },
        capabilities: BASE_CAPABILITIES,
        language: "zh",
        speed: 1,
      }),
    });
    assert.equal(invalidEngine.status, 400);
    const invalidErr = (await invalidEngine.json()) as { error: { code: string } };
    assert.equal(invalidErr.error.code, "VOICE_ENGINE_UNSUPPORTED");

    const saved = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: fake.baseUrl,
        protocol: "nowadays-tts-v1",
        ttsEngine: "indextts",
        engines: probedBody.probe.engines,
        defaultEngine: "cosyvoice",
        voiceSource: { kind: "preset", voiceId: "index:v1" },
        capabilities: BASE_CAPABILITIES,
        language: "zh",
        speed: 1.1,
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as {
      voice: {
        ttsEngine?: string | null;
        defaultEngine?: string | null;
        engines?: Record<string, VoiceEngineStatus> | null;
        capabilities: Record<string, unknown>;
      };
    };
    assert.equal(savedBody.voice.ttsEngine, "indextts");
    assert.equal(savedBody.voice.defaultEngine, "cosyvoice");
    assert.deepEqual(savedBody.voice.engines, probedBody.probe.engines);
    assert.deepEqual(savedBody.voice.capabilities, BASE_CAPABILITIES);

    const preview = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "试听情绪指令。",
        emotion: "温柔轻声哄人",
      }),
    });
    assert.equal(preview.status, 200);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.engine, "indextts");
    assert.equal(fake.calls[0]!.voiceId, "index:v1");
    assert.equal(fake.calls[0]!.emotion, "温柔轻声哄人");

    // 切换到无多引擎声明的服务时，旧 ttsEngine / engines / defaultEngine 被清空。
    const secondary = await startDualEngineFakeTts();
    try {
      secondary.setHealth({
        protocol: "nowadays-tts-v1",
        ready: true,
        capabilities: BASE_CAPABILITIES,
      });
      secondary.setVoices([{ id: "single-voice", label: "单一音色" }]);
      const switched = await configFetch(`${base}/voice`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: secondary.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: { kind: "preset", voiceId: "single-voice" },
          capabilities: BASE_CAPABILITIES,
          language: "zh",
          speed: 1,
        }),
      });
      assert.equal(switched.status, 200);
      const switchedBody = (await switched.json()) as {
        voice: {
          ttsEngine?: string | null;
          defaultEngine?: string | null;
          engines?: Record<string, VoiceEngineStatus> | null;
        };
      };
      assert.equal(switchedBody.voice.ttsEngine ?? null, null);
      assert.equal(switchedBody.voice.defaultEngine ?? null, null);
      assert.equal(switchedBody.voice.engines ?? null, null);
    } finally {
      await secondary.close();
    }
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("V18 database migrates to V19 while preserving voice config, messages and SSE cursors", async () => {
  const fake = await startDualEngineFakeTts();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-v18-v19-"));
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const model = {
    requests: [] as ModelRequest[],
    calls: 0,
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      this.requests.push(request);
      this.calls += 1;
      if (this.calls === 1) {
        yield { type: "text_delta", text: "你好呀。\n（她挥挥手）" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      const userMsg = request.messages[0];
      const parsed = JSON.parse(
        userMsg && userMsg.role === "user" ? userMsg.content : "{}",
      ) as { segments?: Array<{ segmentId: string }> };
      yield {
        type: "text_delta",
        text: JSON.stringify({
          segments: (parsed.segments ?? []).map((s) => ({
            segmentId: s.segmentId,
            voiceEmotion: "明亮",
          })),
        }),
      };
      yield { type: "completed", stopReason: "stop" };
    },
  };
  let app = createBackendApp(config, {
    typingMs: 1000,
    timeZone: "Asia/Shanghai",
    modelPortFactory: () => model,
    disableMemoryRuntime: true,
  });
  let roleId = "";
  let windowId = "";
  let messageId = "";
  try {
    const role = app.services.roles.createRole({
      displayName: "秧秧",
      definition: { text: "温柔细致的陪伴者。" },
      state: { mood: "平静" },
    });
    roleId = role.roleId;
    windowId = role.defaultWindowId;
    const res = app.services.resources.create({
      kind: "model",
      name: "离线对话模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    app.services.resources.replaceBindings(roleId, [
      {
        capability: "chat_model",
        resourceId: res.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);
    app.services.activity.resume(roleId);

    const port = await listen(app.server, 0, "127.0.0.1");
    const saved = await configFetch(
      `http://127.0.0.1:${port}/v1/roles/${roleId}/voice`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: fake.baseUrl,
          protocol: "nowadays-tts-v1",
          ttsEngine: "cosyvoice",
          voiceSource: { kind: "preset", voiceId: "cosy:v1" },
          capabilities: BASE_CAPABILITIES,
          language: "zh",
          speed: 1,
        }),
      },
    );
    assert.equal(saved.status, 200);

    app.conversation.submitMessage(roleId, windowId, {
      content: "打个招呼",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await app.conversation.waitForIdle(roleId);
    const assistant = app.services.messages
      .list(roleId, windowId, 0, 50)
      .items.find((m) => m.sender === "assistant");
    assert.ok(assistant);
    messageId = assistant.messageId;
    await app.close();

    // 回退到 V18 表结构：清空新增列并降级 user_version。
    const paths = rolePaths(config.dataRoot, roleId);
    const db = new Database(paths.businessDatabasePath);
    try {
      db.exec("ALTER TABLE role_voice_settings DROP COLUMN service_id");
      db.exec("ALTER TABLE role_voice_settings DROP COLUMN tts_engine");
      db.exec("ALTER TABLE role_voice_settings DROP COLUMN engines_json");
      db.exec("ALTER TABLE role_voice_settings DROP COLUMN default_engine");
      db.exec("ALTER TABLE message_segments DROP COLUMN voice_emotion");
      db.pragma("user_version = 18");
    } finally {
      db.close();
    }

    app = createBackendApp(config, {
      typingMs: 1000,
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
    });
    const voice = app.services.voice.getVoice(roleId);
    assert.equal(voice.voice?.baseUrl, fake.baseUrl);
    assert.ok(voice.voice?.serviceId, "启动自动迁移应为旧角色生成并绑定全局语音服务");
    assert.equal(app.services.voiceServices.list().length, 1);
    assert.equal(voice.voice?.ttsEngine ?? null, null);
    const detail = app.services.messages.get(roleId, windowId, messageId);
    assert.ok(detail.segments.length >= 1);
    assert.equal(detail.segments[0]!.voiceEmotion ?? null, null);

    const storage = RoleStorage.openExisting(paths);
    try {
      assert.equal(storage.business.schemaVersion, 20);
    } finally {
      storage.close();
    }
  } finally {
    await app.close();
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("dialogue-first voiceEmotion runs without outfits, injects persona and history, omits narration, and Segment-0 waits for annotation", { timeout: 30_000 }, async () => {
  const fake = await startDualEngineFakeTts();
  let callIndex = 0;
  let annotationStarted = deferred<void>();
  let releaseAnnotation = deferred<void>();
  let holdSecondAnnotation = false;
  const recordedRequests: ModelRequest[] = [];

  const gatedModel: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      recordedRequests.push(request);
      callIndex += 1;
      // Call 1: turn 1 reply
      if (callIndex === 1) {
        yield { type: "text_delta", text: "好呀，我刚才也在想这个！" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      // Call 2: turn 1 annotation
      if (callIndex === 2) {
        const userMsg = request.messages[0];
        const parsed = JSON.parse(userMsg && userMsg.role === "user" ? userMsg.content : "{}") as {
          segments: Array<{ segmentId: string; kind: string }>;
        };
        yield {
          type: "text_delta",
          text: JSON.stringify({
            segments: parsed.segments.map((s) => ({
              segmentId: s.segmentId,
              voiceEmotion: "明亮轻快带点期待",
            })),
          }),
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      // Call 3: turn 2 reply (mixed speech + narration + speech)
      if (callIndex === 3) {
        yield {
          type: "text_delta",
          text: "哎呀，怎么这么辛苦。\n（她轻轻抱住你）\n快坐下休息吧。",
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      // Call 4: turn 2 annotation (holds on gate so Segment-0 /speech must wait)
      const userMsg = request.messages[0];
      const parsed = JSON.parse(userMsg && userMsg.role === "user" ? userMsg.content : "{}") as {
        segments: Array<{ segmentId: string; kind: string; text: string }>;
      };
      if (holdSecondAnnotation) {
        annotationStarted.resolve();
        await releaseAnnotation.promise;
      }
      yield {
        type: "text_delta",
        text: JSON.stringify({
          segments: parsed.segments.map((s) => ({
            segmentId: s.segmentId,
            // Deliberately attempt to annotate narration too to verify server filters narration out
            voiceEmotion: s.kind === "narration" ? "错误旁白情绪" : "温柔轻声哄人",
          })),
        }),
      };
      yield { type: "completed", stopReason: "stop" };
    },
  };

  const fixture = createFixtureWithModel(gatedModel);
  const sseAbort = new AbortController();
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);

    // No outfits configured at all; only nowadays-tts-v1 preset voice enabled.
    const saved = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: fake.baseUrl,
        protocol: "nowadays-tts-v1",
        ttsEngine: "cosyvoice",
        engines: {
          cosyvoice: { ready: true, active: true, onDemand: true },
          indextts: { ready: false, active: false, onDemand: true },
        },
        defaultEngine: "cosyvoice",
        voiceSource: { kind: "preset", voiceId: "cosy:v1" },
        capabilities: BASE_CAPABILITIES,
        language: "zh",
        speed: 1,
      }),
    });
    assert.equal(saved.status, 200);

    // Turn 1: establishes preceding context
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "今晚要不要一起吃火锅？",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(recordedRequests.length, 2);

    // Prepare gated annotation for Turn 2
    annotationStarted = deferred<void>();
    releaseAnnotation = deferred<void>();
    holdSecondAnnotation = true;

    // Subscribe to SSE before turn 2
    const sseRes = await fetch(
      `${base}/windows/${fixture.windowId}/events?after=0&clientId=emotion-test`,
      { signal: sseAbort.signal },
    );
    assert.equal(sseRes.status, 200);
    assert.ok(sseRes.body);
    const reader = sseRes.body.getReader();

    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "其实我今天加班好累...",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });

    // Wait until annotation call has actually entered gatedModel (reply already completed)
    await annotationStarted.promise;

    const assistantTurn2 = fixture.app.services.messages
      .list(fixture.roleId, fixture.windowId, 0, 50)
      .items.filter((m) => m.sender === "assistant")
      .at(-1);
    assert.ok(assistantTurn2);
    const detailWhilePending = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      assistantTurn2.messageId,
    );
    const speechSeg0 = detailWhilePending.segments.find((s) => s.ordinal === 0);
    const narrationSeg = detailWhilePending.segments.find((s) => s.kind === "narration");
    assert.ok(speechSeg0);
    assert.ok(narrationSeg);

    // Kick off Segment-0 speech WHILE turn-2 annotation is still in-flight
    const speechPromise = configFetch(
      `${base}/windows/${fixture.windowId}/segments/${speechSeg0.segmentId}/speech`,
      { method: "POST" },
    );

    // Confirm TTS has NOT been called prematurely without annotated emotion
    await delay(150);
    assert.equal(fake.calls.length, 0);

    // Release annotation now
    releaseAnnotation.resolve();

    const speechRes = await speechPromise;
    assert.equal(speechRes.status, 200);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    // Verify TTS received annotated voiceEmotion + ttsEngine!
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.engine, "cosyvoice");
    assert.equal(fake.calls[0]!.emotion, "温柔轻声哄人");

    // Verify annotation prompt included persona, history, and cosyvoice guidance
    const annReq = recordedRequests[3]!;
    const serializedPrompt = `${annReq.system ?? ""}\n${annReq.messages.map((m) => ("content" in m ? m.content : JSON.stringify(m))).join("\n")}`;
    assert.ok(serializedPrompt.includes("阿澄"), `missing persona in: ${serializedPrompt}`);
    assert.ok(serializedPrompt.includes("其实我今天加班好累"), `missing history in: ${serializedPrompt}`);
    assert.ok(serializedPrompt.includes("CosyVoice3"), `missing engine guidance in: ${serializedPrompt}`);

    // Verify stored segments omit voiceEmotion on narration
    const detailAfter = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      assistantTurn2.messageId,
    );
    const storedSpeech0 = detailAfter.segments.find((s) => s.segmentId === speechSeg0.segmentId);
    const storedNarration = detailAfter.segments.find((s) => s.segmentId === narrationSeg.segmentId);
    assert.equal(storedSpeech0?.voiceEmotion, "温柔轻声哄人");
    assert.equal(storedNarration?.voiceEmotion ?? null, null);

    // Verify SSE stream emitted segment_annotations with voiceEmotion only on speech
    const decoder = new TextDecoder();
    let sseText = "";
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !sseText.includes("温柔轻声哄人")) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value, { stream: true });
    }
    sseAbort.abort();
    await reader.cancel().catch(() => {});
    assert.ok(sseText.includes("segment_annotations"));
    assert.ok(sseText.includes("温柔轻声哄人"));
    assert.equal(sseText.includes("错误旁白情绪"), false);
  } finally {
    sseAbort.abort();
    await fixture.close();
    await fake.close();
  }
});

test("Segment-0 speech respects bounded annotation timeout and degrades gracefully when annotation hangs", { timeout: 30_000 }, async () => {
  const fake = await startDualEngineFakeTts();
  let callIndex = 0;
  const hangGate = deferred<void>();
  const annotationStarted = deferred<void>();

  const slowModel: ModelPort = {
    async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
      callIndex += 1;
      if (callIndex === 1) {
        yield { type: "text_delta", text: "这是一句不等待太久的台词。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      annotationStarted.resolve();
      await hangGate.promise;
    },
  };

  const fixture = createFixtureWithModel(slowModel);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const saved = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: fake.baseUrl,
        protocol: "nowadays-tts-v1",
        ttsEngine: "indextts",
        engines: {
          cosyvoice: { ready: false, active: false, onDemand: true },
          indextts: { ready: true, active: true, onDemand: true },
        },
        defaultEngine: "cosyvoice",
        voiceSource: { kind: "preset", voiceId: "index:v1" },
        capabilities: BASE_CAPABILITIES,
        language: "zh",
        speed: 1,
      }),
    });
    assert.equal(saved.status, 200);

    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "你好",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await annotationStarted.promise;

    const assistant = fixture.app.services.messages
      .list(fixture.roleId, fixture.windowId, 0, 50)
      .items.find((m) => m.sender === "assistant");
    assert.ok(assistant);
    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      assistant.messageId,
    );
    const seg0 = detail.segments[0]!;

    const startedAt = Date.now();
    const res = await configFetch(
      `${base}/windows/${fixture.windowId}/segments/${seg0.segmentId}/speech`,
      { method: "POST" },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(res.status, 200);
    assert.ok(elapsedMs >= 1600 && elapsedMs < 4000, `elapsedMs=${elapsedMs}`);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.engine, "indextts");
    assert.equal(fake.calls[0]!.emotion, null);
  } finally {
    hangGate.resolve();
    await fixture.close();
    await fake.close();
  }
});

test("global voice services support CRUD, probe, global write guard, role binding, and runtime status", { timeout: 30_000 }, async () => {
  const fake = await startDualEngineFakeTts();
  const secondary = await startDualEngineFakeTts();
  const capturedEngineHints: Array<string | null> = [];
  let callIndex = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      callIndex += 1;
      if (callIndex % 2 === 1) {
        yield { type: "text_delta", text: "你好，这里已经切换好全局语音服务啦。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      const userMsg = request.messages[0];
      const parsed = JSON.parse(
        userMsg && userMsg.role === "user" ? userMsg.content : "{}",
      ) as {
        segments?: Array<{ segmentId: string }>;
      };
      capturedEngineHints.push(request.system ?? null);
      yield {
        type: "text_delta",
        text: JSON.stringify({
          segments: (parsed.segments ?? []).map((s) => ({
            segmentId: s.segmentId,
            voiceEmotion: "柔和开心",
          })),
        }),
      };
      yield { type: "completed", stopReason: "stop" };
    },
  };

  const fixture = createFixtureWithModel(model);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const rootUrl = `http://127.0.0.1:${port}/v1`;
    const base = roleBase(fixture, port);

    // 1. 探测未保存语音服务草稿
    const probeDraft = await fetch(`${rootUrl}/voice-services/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: { protocol: "nowadays-tts-v1", baseUrl: fake.baseUrl },
      }),
    });
    assert.equal(probeDraft.status, 200);
    const probeBody = (await probeDraft.json()) as {
      probe: { defaultEngine?: string; engines?: Record<string, VoiceEngineStatus> };
      elapsedMs: number;
    };
    assert.equal(probeBody.probe.defaultEngine, "cosyvoice");

    // 旧 IndexTTS 协议拒绝探测
    const probeLegacy = await fetch(`${rootUrl}/voice-services/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: { protocol: "indextts", baseUrl: fake.baseUrl },
      }),
    });
    assert.equal(probeLegacy.status, 400);
    assert.equal(((await probeLegacy.json()) as { error: { code: string } }).error.code, "VOICE_PROBE_UNSUPPORTED");

    // 2. 创建全局语音服务
    const created = await fetch(`${rootUrl}/voice-services`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "本机 WSL 语音",
        config: {
          protocol: "nowadays-tts-v1",
          baseUrl: `${fake.baseUrl}/`,
          defaultEngine: "indextts",
        },
      }),
    });
    assert.equal(created.status, 201);
    const svc = ((await created.json()) as { service: { serviceId: string; config: { baseUrl: string; defaultEngine?: string }; enabled: boolean } }).service;
    assert.equal(svc.config.baseUrl, fake.baseUrl);
    assert.equal(svc.config.defaultEngine, "indextts");
    assert.equal(svc.enabled, true);

    const listed = await (await fetch(`${rootUrl}/voice-services`)).json() as { items: Array<{ serviceId: string }> };
    assert.equal(listed.items.length, 1);

    const probeSaved = await fetch(`${rootUrl}/voice-services/${svc.serviceId}/probe`, { method: "POST" });
    assert.equal(probeSaved.status, 200);

    // 3. 角色绑定该全局服务（不传 ttsEngine -> 跟随服务默认 indextts）
    const roleSaved = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId: svc.serviceId,
        engines: probeBody.probe.engines,
        voiceSource: { kind: "preset", voiceId: "cosy:v1" },
        capabilities: BASE_CAPABILITIES,
        language: "zh",
        speed: 1,
      }),
    });
    assert.equal(roleSaved.status, 200);
    const roleSavedBody = (await roleSaved.json()) as {
      voice: {
        serviceId?: string | null;
        service?: { serviceId: string; name: string; enabled: boolean } | null;
        ttsEngine?: string | null;
        defaultEngine?: string | null;
      };
    };
    assert.equal(roleSavedBody.voice.serviceId, svc.serviceId);
    assert.equal(roleSavedBody.voice.service?.name, "本机 WSL 语音");
    assert.equal(roleSavedBody.voice.ttsEngine, null);
    assert.equal(roleSavedBody.voice.defaultEngine, "indextts");

    // 角色发送消息 + 合成时动态继承全局 defaultEngine = indextts
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "测试全局默认引擎",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const msg1 = fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 50).items.find((m) => m.sender === "assistant")!;
    const seg1 = fixture.app.services.messages.get(fixture.roleId, fixture.windowId, msg1.messageId).segments[0]!;
    const sp1 = await configFetch(`${base}/windows/${fixture.windowId}/segments/${seg1.segmentId}/speech`, { method: "POST" });
    assert.equal(sp1.status, 200);
    assert.equal(fake.calls.at(-1)!.engine, "indextts");
    assert.ok((capturedEngineHints[0] ?? "").includes("IndexTTS"));

    // 4. 活跃角色未停止时修改全局语音服务被 GLOBAL_CONFIG_WRITES 拦截 (409 ROLES_NOT_STOPPED)
    const blockedPatch = await fetch(`${rootUrl}/voice-services/${svc.serviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(blockedPatch.status, 409);
    assert.equal(((await blockedPatch.json()) as { error: { code: string } }).error.code, "ROLES_NOT_STOPPED");

    // 通过 configFetch 停机后停用全局服务 -> 角色试听、保存和语音合成均一并拒绝 409 VOICE_SERVICE_DISABLED
    const disabledPatch = await configFetch(`${rootUrl}/voice-services/${svc.serviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabledPatch.status, 200);

    const previewDisabled = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "停用后不应试听成功。" }),
    });
    assert.equal(previewDisabled.status, 409);
    assert.equal(((await previewDisabled.json()) as { error: { code: string } }).error.code, "VOICE_SERVICE_DISABLED");

    const speechDisabled = await configFetch(`${base}/windows/${fixture.windowId}/segments/${seg1.segmentId}/speech`, { method: "POST" });
    assert.equal(speechDisabled.status, 409);
    assert.equal(((await speechDisabled.json()) as { error: { code: string } }).error.code, "VOICE_SERVICE_DISABLED");

    const saveDisabled = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId: svc.serviceId,
        voiceSource: { kind: "preset", voiceId: "cosy:v1" },
        capabilities: BASE_CAPABILITIES,
      }),
    });
    assert.equal(saveDisabled.status, 409);
    assert.equal(((await saveDisabled.json()) as { error: { code: string } }).error.code, "VOICE_SERVICE_DISABLED");

    // 重新启用并切全局 defaultEngine -> cosyvoice
    const reEnabled = await configFetch(`${rootUrl}/voice-services/${svc.serviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        config: { protocol: "nowadays-tts-v1", baseUrl: fake.baseUrl, defaultEngine: "cosyvoice" },
      }),
    });
    assert.equal(reEnabled.status, 200);
    const previewReenabled = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "切回默认 CosyVoice。" }),
    });
    assert.equal(previewReenabled.status, 200);
    assert.equal(fake.calls.at(-1)!.engine, "cosyvoice");

    // 5. 角色显式切到 indextts，随后传 ttsEngine: null 清空覆盖 -> 重新回到全局 defaultEngine (cosyvoice)
    assert.equal((await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId: svc.serviceId,
        ttsEngine: "indextts",
        engines: probeBody.probe.engines,
        voiceSource: { kind: "preset", voiceId: "index:v1" },
        capabilities: BASE_CAPABILITIES,
      }),
    })).status, 200);
    assert.equal((await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "角色显式覆盖 IndexTTS。" }),
    })).status, 200);
    assert.equal(fake.calls.at(-1)!.engine, "indextts");

    const clearedOverride = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId: svc.serviceId,
        ttsEngine: null,
        engines: probeBody.probe.engines,
        voiceSource: { kind: "preset", voiceId: "cosy:v1" },
        capabilities: BASE_CAPABILITIES,
      }),
    });
    assert.equal(clearedOverride.status, 200);
    assert.equal(((await clearedOverride.json()) as { voice: { ttsEngine: string | null } }).voice.ttsEngine, null);
    assert.equal((await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "清除后继承全局默认。" }),
    })).status, 200);
    assert.equal(fake.calls.at(-1)!.engine, "cosyvoice");

    // 6. 删除全局语音服务：角色读视图返回 service: null，播放/保存返回 404 VOICE_SERVICE_NOT_FOUND
    const deletedRes = await configFetch(`${rootUrl}/voice-services/${svc.serviceId}`, { method: "DELETE" });
    assert.equal(deletedRes.status, 200);
    const readAfterDelete = await (await fetch(`${base}/voice`)).json() as { voice: { serviceId: string; service: unknown } };
    assert.equal(readAfterDelete.voice.serviceId, svc.serviceId);
    assert.equal(readAfterDelete.voice.service, null);

    const speechDeleted = await configFetch(`${base}/windows/${fixture.windowId}/segments/${seg1.segmentId}/speech`, { method: "POST" });
    assert.equal(speechDeleted.status, 404);
    assert.equal(((await speechDeleted.json()) as { error: { code: string } }).error.code, "VOICE_SERVICE_NOT_FOUND");

    // 切到第二台全局服务时，原 preset 被 serviceChanged 拦截要求重新选择音色
    const created2 = await fetch(`${rootUrl}/voice-services`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "第二台服务",
        config: { protocol: "nowadays-tts-v1", baseUrl: secondary.baseUrl },
      }),
    });
    const svc2 = ((await created2.json()) as { service: { serviceId: string } }).service;
    const switchMissingSource = await configFetch(`${base}/voice`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: svc2.serviceId, capabilities: BASE_CAPABILITIES }),
    });
    assert.equal(switchMissingSource.status, 400);
    assert.equal(((await switchMissingSource.json()) as { error: { code: string } }).error.code, "VOICE_SOURCE_REQUIRED");
  } finally {
    await fixture.close();
    await fake.close();
    await secondary.close();
  }
});
