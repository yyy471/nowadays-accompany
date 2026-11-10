import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { listen } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import {
  TtsCanceledError,
  TtsProtocolInvalidError,
  TtsServiceUnavailableError,
  TtsSynthesisFailedError,
  TtsTimeoutError,
} from "../src/domain/errors.js";
import type { VoiceCapabilities } from "../src/domain/voice.js";
import { UnifiedTtsClient } from "../src/tts/unified-tts-client.js";
import {
  createFixture,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

function wavAudio(payload: Buffer = Buffer.alloc(4)): Buffer {
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

const WAV_AUDIO = wavAudio();

const CAPABILITIES: VoiceCapabilities = {
  referenceModes: [
    { id: "clone", label: "参考音频", requiresReferenceText: false },
    { id: "clone-text", label: "参考音频与原文", requiresReferenceText: true },
  ],
  presetVoices: true,
  languages: ["zh", "en"],
  speed: { min: 0.5, max: 2 },
};

interface UnifiedTtsRequest {
  text: string;
  mode: string | null;
  referenceMode: string | null;
  referenceText: string | null;
  voiceId: string | null;
  language: string | null;
  speed: string | null;
  emotion: string | null;
  audio: { fileName: string; mediaType: string; data: Buffer } | null;
}

type FakeTtsMode = "ok" | "error" | "slow" | "invalid" | "corrupt";

interface FakeUnifiedTts {
  baseUrl: string;
  requests: UnifiedTtsRequest[];
  paths: string[];
  setMode(mode: FakeTtsMode): void;
  setHealth(patch: Record<string, unknown>): void;
  setVoices(voices: Array<{ id: string; label: string }>): void;
  setRedirect(path: "/health" | "/voices" | "/tts", location: string | null): void;
  close(): Promise<void>;
}

async function startFakeUnifiedTts(): Promise<FakeUnifiedTts> {
  const requests: UnifiedTtsRequest[] = [];
  const paths: string[] = [];
  let mode: FakeTtsMode = "ok";
  let health: Record<string, unknown> = {
    protocol: "nowadays-tts-v1",
    service: "Local speech",
    model: "fake-model",
    ready: true,
    capabilities: CAPABILITIES,
  };
  let voices = [
    { id: "speaker-01", label: "示例音色一" },
    { id: "speaker-02", label: "示例音色二" },
  ];
  let redirect: {
    path: "/health" | "/voices" | "/tts";
    location: string;
  } | null = null;
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const route =
      pathname === "/bridge"
        ? "/"
        : pathname.startsWith("/bridge/")
          ? pathname.slice("/bridge".length)
          : pathname;
    paths.push(pathname);
    if (
      redirect !== null &&
      redirect.path === route
    ) {
      response.writeHead(307, { location: `${redirect.location}${route}` });
      response.end();
      return;
    }
    if (request.method === "GET" && route === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(health));
      return;
    }
    if (request.method === "GET" && route === "/voices") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ voices }));
      return;
    }
    if (request.method !== "POST" || route !== "/tts") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: {
        "content-type": request.headers["content-type"] ?? "",
      },
    }).formData();
    const audio = form.get("reference_audio");
    requests.push({
      text: String(form.get("text") ?? ""),
      mode: optionalField(form, "mode"),
      referenceMode: optionalField(form, "reference_mode"),
      referenceText: optionalField(form, "reference_text"),
      voiceId: optionalField(form, "voice_id"),
      language: optionalField(form, "language"),
      speed: optionalField(form, "speed"),
      emotion: optionalField(form, "emotion"),
      audio:
        audio instanceof File
          ? {
              fileName: audio.name,
              mediaType: audio.type,
              data: Buffer.from(await audio.arrayBuffer()),
            }
          : null,
    });
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (mode === "error") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: "REFERENCE_TEXT_REQUIRED",
          detail: "当前参考模式需要录音原文",
        }),
      );
      return;
    }
    if (mode === "invalid") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("not audio");
      return;
    }
    if (mode === "corrupt") {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end("not a wav");
      return;
    }
    response.writeHead(200, { "content-type": "audio/wav" });
    response.end(WAV_AUDIO);
  });
  const port = await listen(server, 0, "127.0.0.1");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    paths,
    setMode(next) {
      mode = next;
    },
    setHealth(patch) {
      health = { ...health, ...patch };
    },
    setVoices(next) {
      voices = next;
    },
    setRedirect(path, location) {
      redirect = location === null ? null : { path, location };
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function optionalField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function roleBase(fixture: Fixture, port: number): string {
  return `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}`;
}

async function uploadReference(
  base: string,
  data: Buffer = WAV_AUDIO,
  fileName = "参考.wav",
): Promise<{ assetId: string; relativePath: string }> {
  const form = new FormData();
  form.set("file", new Blob([data], { type: "audio/wav" }), fileName);
  const response = await fetch(`${base}/voice/reference`, {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    reference: { assetId: string; relativePath: string };
  };
  return body.reference;
}

async function saveVoice(
  base: string,
  input: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/voice`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function probeVoice(
  base: string,
  baseUrl: string,
): Promise<Response> {
  return fetch(`${base}/voice/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl }),
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

function downgradeVoiceSettingsToV10(fixture: Fixture): void {
  const paths = rolePaths(fixture.app.config.dataRoot, fixture.roleId);
  const db = new Database(paths.businessDatabasePath);
  try {
    db.pragma("user_version = 10");
    db.exec(
      "ALTER TABLE role_voice_settings DROP COLUMN reference_mode_confirmed",
    );
  } finally {
    db.close();
  }
}

function storedReferenceModeConfirmed(fixture: Fixture): number {
  return withStorage(fixture, (storage) => {
    const row = storage.business.db
      .prepare(
        `SELECT reference_mode_confirmed AS value
           FROM role_voice_settings WHERE role_id = ?`,
      )
      .get(fixture.roleId) as { value: number } | undefined;
    assert.ok(row);
    return row.value;
  });
}

function simulatePreviousV11Migration(fixture: Fixture): void {
  const paths = rolePaths(fixture.app.config.dataRoot, fixture.roleId);
  const db = new Database(paths.businessDatabasePath);
  try {
    db.pragma("user_version = 11");
    db.prepare(
      `UPDATE role_voice_settings
          SET reference_mode_confirmed = 1
        WHERE role_id = ?`,
    ).run(fixture.roleId);
  } finally {
    db.close();
  }
}

async function createSpeechSegments(
  fixture: Fixture,
): Promise<{
  speech: { segmentId: string; text: string };
  narration: { segmentId: string; text: string };
}> {  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content: "打个招呼",
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
  await fixture.app.conversation.waitForIdle(fixture.roleId);
  const assistant = fixture.app.services.messages
    .list(fixture.roleId, fixture.windowId, 0, 50)
    .items.find((message) => message.sender === "assistant");
  assert.ok(assistant);
  const detail = fixture.app.services.messages.get(
    fixture.roleId,
    fixture.windowId,
    assistant.messageId,
  );
  const speech = detail.segments.find((segment) => segment.kind === "speech");
  const narration = detail.segments.find(
    (segment) => segment.kind === "narration",
  );
  assert.ok(speech);
  assert.ok(narration);
  return { speech, narration };
}

test("voice probe discovers capabilities and preset voices", async () => {
  const fake = await startFakeUnifiedTts();
  fake.setHealth({ capabilities: {
    ...CAPABILITIES,
    engines: { cosyvoice: { ready: true, active: true }, indextts: { ready: false, active: false } },
    defaultEngine: "cosyvoice",
  } });
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const probe = await probeVoice(base, `${fake.baseUrl}/bridge`);
    assert.equal(probe.status, 200);
    const body = (await probe.json()) as {
      probe: {
        protocol: string;
        service: string;
        model: string;
        ready: boolean;
        capabilities: VoiceCapabilities;
        voices: Array<{ id: string; label: string }> | null;
      };
    };
    assert.equal(body.probe.protocol, "nowadays-tts-v1");
    assert.equal(body.probe.service, "Local speech");
    assert.equal(body.probe.model, "fake-model");
    assert.equal(body.probe.ready, true);
    assert.deepEqual(body.probe.capabilities, CAPABILITIES);
    assert.deepEqual(body.probe.voices, [
      { id: "speaker-01", label: "示例音色一" },
      { id: "speaker-02", label: "示例音色二" },
    ]);
    assert.deepEqual(fake.paths, ["/bridge/health", "/bridge/voices"]);

    fake.setHealth({ ready: false });
    const notReady = await probeVoice(base, fake.baseUrl);
    assert.equal(notReady.status, 200);
    const notReadyBody = (await notReady.json()) as {
      probe: { ready: boolean; voices: unknown };
    };
    assert.equal(notReadyBody.probe.ready, false);
    assert.equal(notReadyBody.probe.voices, null);
    assert.equal(fake.paths.filter((item) => item === "/voices").length, 0);

    fake.setHealth({ ready: true, protocol: "other-tts-v1" });
    const invalid = await probeVoice(base, fake.baseUrl);
    assert.equal(invalid.status, 502);
    assert.equal(await errorCode(invalid), "TTS_PROTOCOL_INVALID");
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("unified clone preview uploads the managed reference audio", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    const saved = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone",
      },
      capabilities: CAPABILITIES,
      language: "en",
      speed: 1.25,
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as {
      voice: {
        engine: string;
        protocol: string;
        baseUrl: string;
        voiceSource: {
          kind: string;
          referenceAssetId: string;
          referenceMode: string;
          referenceText: null;
        };
        reference: { assetId: string } | null;
        capabilities: VoiceCapabilities;
        language: string;
        speed: number;
      };
    };
    assert.equal(savedBody.voice.engine, "nowadays-tts-v1");
    assert.equal(savedBody.voice.protocol, "nowadays-tts-v1");
    assert.equal(savedBody.voice.reference?.assetId, reference.assetId);
    assert.deepEqual(savedBody.voice.voiceSource, {
      kind: "reference",
      referenceAssetId: reference.assetId,
      referenceMode: "clone",
      referenceText: null,
    });
    assert.deepEqual(savedBody.voice.capabilities, CAPABILITIES);
    assert.equal(savedBody.voice.language, "en");
    assert.equal(savedBody.voice.speed, 1.25);

    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好，今天过得怎么样？" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "audio/wav");
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), WAV_AUDIO);
    assert.equal(fake.requests.length, 1);
    const request = fake.requests[0]!;
    assert.equal(request.text, "你好，今天过得怎么样？");
    assert.equal(request.mode, "reference");
    assert.equal(request.referenceMode, "clone");
    assert.equal(request.referenceText, null);
    assert.equal(request.voiceId, null);
    assert.equal(request.language, "en");
    assert.equal(request.speed, "1.25");
    assert.ok(request.audio);
    assert.equal(request.audio.fileName, "参考.wav");
    assert.equal(request.audio.mediaType, "audio/wav");
    assert.deepEqual(request.audio.data, WAV_AUDIO);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("unified clone requires and forwards reference text", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([
    [
      { type: "text_delta", text: "你好呀。\n（她挥手）" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    const saved = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone-text",
      },
      capabilities: CAPABILITIES,
    });
    assert.equal(saved.status, 200);

    const missing = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "缺少原文。" }),
    });
    assert.equal(missing.status, 400);
    assert.equal(await errorCode(missing), "VOICE_REFERENCE_TEXT_REQUIRED");
    assert.equal(fake.requests.length, 0);

    const updated = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone-text",
        referenceText: "这是录音中实际说的话。",
      },
    });
    assert.equal(updated.status, 200);

    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "试听一句。", emotion: "温柔" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.referenceText, "这是录音中实际说的话。");
    assert.equal(fake.requests[0]!.emotion, "温柔");

    const { speech, narration } = await createSpeechSegments(fixture);
    const spoken = await fetch(
      `${base}/windows/${fixture.windowId}/segments/${speech.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(spoken.status, 200);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1]!.text, speech.text);
    assert.equal(fake.requests[1]!.mode, "reference");
    assert.equal(fake.requests[1]!.referenceMode, "clone-text");
    assert.equal(fake.requests[1]!.emotion, null);
    assert.equal(
      fake.requests[1]!.referenceText,
      "这是录音中实际说的话。",
    );

    const narrationResponse = await fetch(
      `${base}/windows/${fixture.windowId}/segments/${narration.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(narrationResponse.status, 400);
    assert.equal(
      await errorCode(narrationResponse),
      "VOICE_SEGMENT_NOT_SPEAKABLE",
    );
    assert.equal(fake.requests.length, 2);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("unified preset voice previews and synthesizes without reference audio", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([
    [
      { type: "text_delta", text: "你好呀。\n（她挥手）" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const saved = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: { kind: "preset", voiceId: "speaker-01" },
      capabilities: CAPABILITIES,
      language: "zh",
      speed: 0.9,
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as {
      voice: {
        voiceSource: { kind: string; voiceId: string };
        reference: unknown;
      };
    };
    assert.deepEqual(savedBody.voice.voiceSource, {
      kind: "preset",
      voiceId: "speaker-01",
    });
    assert.equal(savedBody.voice.reference, null);

    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "使用预置音色。" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.mode, "preset");
    assert.equal(fake.requests[0]!.voiceId, "speaker-01");
    assert.equal(fake.requests[0]!.referenceMode, null);
    assert.equal(fake.requests[0]!.audio, null);
    assert.equal(fake.requests[0]!.speed, "0.9");

    const { speech } = await createSpeechSegments(fixture);
    const spoken = await fetch(
      `${base}/windows/${fixture.windowId}/segments/${speech.segmentId}/speech`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emotion: "开心" }),
      },
    );
    assert.equal(spoken.status, 200);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1]!.text, speech.text);
    assert.equal(fake.requests[1]!.voiceId, "speaker-01");
    assert.equal(fake.requests[1]!.emotion, "开心");
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("voice source validation follows declared capabilities", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);

    const legacyPreset = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "indextts",
      voiceSource: { kind: "preset", voiceId: "speaker-01" },
    });
    assert.equal(legacyPreset.status, 400);
    assert.equal(await errorCode(legacyPreset), "VOICE_SOURCE_UNSUPPORTED");

    const invalidMode = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "unknown-mode",
      },
      capabilities: CAPABILITIES,
    });
    assert.equal(invalidMode.status, 400);
    assert.equal(await errorCode(invalidMode), "VOICE_REFERENCE_MODE_INVALID");

    const invalidLanguage = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone",
      },
      capabilities: CAPABILITIES,
      language: "ja",
    });
    assert.equal(invalidLanguage.status, 400);
    assert.equal(await errorCode(invalidLanguage), "VOICE_LANGUAGE_UNSUPPORTED");

    const invalidSpeed = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone",
      },
      capabilities: { ...CAPABILITIES, speed: { min: 0.5, max: 1.5 } },
      speed: 2,
    });
    assert.equal(invalidSpeed.status, 400);
    assert.equal(await errorCode(invalidSpeed), "VOICE_SPEED_OUT_OF_RANGE");

    const noPresetSupport = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: { kind: "preset", voiceId: "speaker-01" },
      capabilities: { ...CAPABILITIES, presetVoices: false },
    });
    assert.equal(noPresetSupport.status, 400);
    assert.equal(await errorCode(noPresetSupport), "VOICE_PRESET_UNSUPPORTED");

    const singleModeCapabilities: VoiceCapabilities = {
      ...CAPABILITIES,
      referenceModes: [CAPABILITIES.referenceModes[0]!],
    };
    const autoMode = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
      },
      capabilities: singleModeCapabilities,
    });
    assert.equal(autoMode.status, 200);
    const autoModeBody = (await autoMode.json()) as {
      voice: { voiceSource: { referenceMode: string } };
    };
    assert.equal(autoModeBody.voice.voiceSource.referenceMode, "clone");

    const noCapabilities = await saveVoice(base, {
      baseUrl: "http://127.0.0.1:9890",
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone",
        referenceText: "原文",
      },
    });
    assert.equal(noCapabilities.status, 200);
    const fetched = await fetch(`${base}/voice`);
    const fetchedBody = (await fetched.json()) as {
      voice: {
        capabilities: unknown;
        voiceSource: { referenceText: string };
      };
    };
    assert.equal(fetchedBody.voice.capabilities, null);
    assert.equal(fetchedBody.voice.voiceSource.referenceText, "原文");

    const draft = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: null,
        referenceMode: null,
        referenceText: null,
      },
    });
    assert.equal(draft.status, 200);
    const draftPreview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "草稿还不能试听。" }),
    });
    assert.equal(draftPreview.status, 400);
    assert.equal(
      await errorCode(draftPreview),
      "VOICE_REFERENCE_REQUIRED",
    );
    assert.equal(fake.requests.length, 0);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("legacy voice rows stay readable as the reference source", async () => {
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    const timestamp = "2026-11-09T00:00:00.000Z";
    withStorage(fixture, (storage) => {
      storage.business.db
        .prepare(
          `INSERT INTO role_voice_settings
             (role_id, engine, base_url, reference_asset_id, language, speed,
              emo_alpha, created_at, updated_at)
           VALUES (?, 'indextts', 'http://127.0.0.1:9890', ?, 'zh', 1, 1, ?, ?)`,
        )
        .run(fixture.roleId, reference.assetId, timestamp, timestamp);
    });

    const fetched = await fetch(`${base}/voice`);
    assert.equal(fetched.status, 200);
    const body = (await fetched.json()) as {
      voice: {
        engine: string;
        protocol: string;
        voiceSource: {
          kind: string;
          referenceAssetId: string;
          referenceMode: null;
          referenceText: null;
        };
        reference: { assetId: string } | null;
        capabilities: unknown;
      };
    };
    assert.equal(body.voice.engine, "indextts");
    assert.equal(body.voice.protocol, "indextts");
    assert.deepEqual(body.voice.voiceSource, {
      kind: "reference",
      referenceAssetId: reference.assetId,
      referenceMode: null,
      referenceText: null,
    });
    assert.equal(body.voice.reference?.assetId, reference.assetId);
    assert.equal(body.voice.capabilities, null);

    const columns = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(`PRAGMA table_info("role_voice_settings")`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
    for (const column of [
      "protocol",
      "voice_source",
      "reference_mode",
      "reference_text",
      "preset_voice_id",
      "capabilities_json",
      "reference_mode_confirmed",
    ]) {
      assert.ok(columns.includes(column), `missing column ${column}`);
    }
    assert.equal(
      withStorage(fixture, (storage) => storage.business.schemaVersion),
      13,
    );
  } finally {
    await fixture.close();
  }
});

test("preview drafts do not change the saved voice configuration", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: fake.baseUrl,
          referenceAssetId: reference.assetId,
        })
      ).status,
      200,
    );
    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "用候选统一协议试听。",
        protocol: "nowadays-tts-v1",
        voiceSource: {
          kind: "reference",
          referenceAssetId: reference.assetId,
          referenceMode: "clone",
        },
        capabilities: CAPABILITIES,
      }),
    });
    assert.equal(preview.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.mode, "reference");

    const saved = (await (await fetch(`${base}/voice`)).json()) as {
      voice: { protocol: string; voiceSource: { kind: string } };
    };
    assert.equal(saved.voice.protocol, "indextts");
    assert.equal(saved.voice.voiceSource.kind, "reference");
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("unified client maps failures, timeouts and cancellation", async () => {
  const fake = await startFakeUnifiedTts();
  try {
    const client = new UnifiedTtsClient(fake.baseUrl, 500);
    fake.setMode("error");
    await assert.rejects(
      client.synthesize({
        text: "失败",
        source: { kind: "preset", voiceId: "speaker-01" },
        language: "zh",
        speed: 1,
      }),
      (error: unknown) =>
        error instanceof TtsSynthesisFailedError &&
        error.message === "当前参考模式需要录音原文",
    );

    fake.setHealth({ protocol: "other-tts-v1" });
    await assert.rejects(
      client.probe(),
      (error: unknown) => error instanceof TtsProtocolInvalidError,
    );

    fake.setHealth({ protocol: "nowadays-tts-v1" });
    fake.setMode("invalid");
    await assert.rejects(
      client.synthesize({
        text: "非音频",
        source: { kind: "preset", voiceId: "speaker-01" },
        language: null,
        speed: null,
      }),
      (error: unknown) => error instanceof TtsSynthesisFailedError,
    );

    fake.setMode("corrupt");
    await assert.rejects(
      client.synthesize({
        text: "坏 WAV",
        source: { kind: "preset", voiceId: "speaker-01" },
        language: null,
        speed: null,
      }),
      (error: unknown) => error instanceof TtsSynthesisFailedError,
    );
  } finally {
    await fake.close();
  }

  const unreachable = new UnifiedTtsClient("http://127.0.0.1:1", 200);
  await assert.rejects(
    unreachable.probe(),
    (error: unknown) => error instanceof TtsServiceUnavailableError,
  );

  const slow = await startFakeUnifiedTts();
  try {
    slow.setMode("slow");
    const timeoutClient = new UnifiedTtsClient(slow.baseUrl, 50);
    await assert.rejects(
      timeoutClient.synthesize({
        text: "超时",
        source: { kind: "preset", voiceId: "speaker-01" },
        language: null,
        speed: null,
      }),
      (error: unknown) => error instanceof TtsTimeoutError,
    );

    const controller = new AbortController();
    const cancelClient = new UnifiedTtsClient(slow.baseUrl, 5_000);
    const pending = cancelClient.synthesize({
      text: "取消",
      source: { kind: "preset", voiceId: "speaker-01" },
      language: null,
      speed: null,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof TtsCanceledError,
    );
  } finally {
    await slow.close();
  }
});

test("unified requests omit language and speed when the service does not declare them", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const capabilities: VoiceCapabilities = {
      ...CAPABILITIES,
      languages: [],
      speed: null,
    };
    const saved = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: { kind: "preset", voiceId: "speaker-02" },
      capabilities,
      language: "zh",
      speed: 1.5,
    });
    assert.equal(saved.status, 200);
    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "服务自行决定语言和语速。" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.language, null);
    assert.equal(fake.requests[0]!.speed, null);
    assert.equal(fake.requests[0]!.voiceId, "speaker-02");
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("unified reference files are re-read from the role voice directory", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: fake.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: reference.assetId,
            referenceMode: "clone",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );
    const file = path.join(
      rolePaths(fixture.app.config.dataRoot, fixture.roleId).roleDir,
      reference.relativePath,
    );
    assert.ok(fs.existsSync(file));
    fs.rmSync(file);
    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "参考文件已缺失。" }),
    });
    assert.equal(preview.status, 404);
    assert.equal(await errorCode(preview), "VOICE_REFERENCE_FILE_MISSING");
    assert.equal(fake.requests.length, 0);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("v9 voice rows migrate to v12 without touching messages, segments or SSE cursors", async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "你好呀。\n（她挥手）" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: "http://127.0.0.1:9890",
          referenceAssetId: reference.assetId,
        })
      ).status,
      200,
    );
    await createSpeechSegments(fixture);

    const listBefore = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    const assistant = listBefore.items.find(
      (message) => message.sender === "assistant",
    );
    assert.ok(assistant);
    const detailBefore = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      assistant.messageId,
    );
    const countsBefore = withStorage(fixture, (storage) => ({
      messages: (
        storage.business.db
          .prepare("SELECT COUNT(*) AS total FROM messages")
          .get() as { total: number }
      ).total,
      segments: (
        storage.business.db
          .prepare("SELECT COUNT(*) AS total FROM message_segments")
          .get() as { total: number }
      ).total,
      events: (
        storage.business.db
          .prepare("SELECT COUNT(*) AS total FROM execution_stream_events")
          .get() as { total: number }
      ).total,
      lastEvent: (
        storage.business.db
          .prepare(
            "SELECT MAX(stream_event_id) AS latest FROM execution_stream_events",
          )
          .get() as { latest: number | null }
      ).latest,
    }));
    assert.ok(countsBefore.events > 0);
    assert.ok(countsBefore.lastEvent !== null);

    const paths = rolePaths(fixture.app.config.dataRoot, fixture.roleId);
    const raw = new Database(paths.businessDatabasePath);
    try {
      raw.pragma("user_version = 9");
      for (const column of [
        "protocol",
        "voice_source",
        "reference_mode",
        "reference_text",
        "preset_voice_id",
        "capabilities_json",
        "reference_mode_confirmed",
      ]) {
        raw.exec(`ALTER TABLE role_voice_settings DROP COLUMN ${column}`);
      }
    } finally {
      raw.close();
    }

    const voice = fixture.app.services.voice.getVoice(fixture.roleId);
    assert.equal(voice.voice?.protocol, "indextts");
    assert.equal(voice.voice?.engine, "indextts");
    assert.equal(voice.voice?.reference?.assetId, reference.assetId);
    assert.deepEqual(voice.voice?.voiceSource, {
      kind: "reference",
      referenceAssetId: reference.assetId,
      referenceMode: null,
      referenceText: null,
    });
    assert.equal(storedReferenceModeConfirmed(fixture), 1);

    const listAfter = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      50,
    );
    assert.deepEqual(
      listAfter.items.map((message) => ({
        messageId: message.messageId,
        sender: message.sender,
        content: message.content,
        status: message.status,
      })),
      listBefore.items.map((message) => ({
        messageId: message.messageId,
        sender: message.sender,
        content: message.content,
        status: message.status,
      })),
    );
    const detailAfter = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      assistant.messageId,
    );
    assert.deepEqual(
      detailAfter.segments.map((segment) => segment.segmentId),
      detailBefore.segments.map((segment) => segment.segmentId),
    );
    assert.deepEqual(
      detailAfter.segments.map((segment) => segment.text),
      detailBefore.segments.map((segment) => segment.text),
    );

    const countsAfter = withStorage(fixture, (storage) => ({
      schemaVersion: storage.business.schemaVersion,
      messages: (
        storage.business.db
          .prepare("SELECT COUNT(*) AS total FROM messages")
          .get() as { total: number }
      ).total,
      segments: (
        storage.business.db
          .prepare("SELECT COUNT(*) AS total FROM message_segments")
          .get() as { total: number }
      ).total,
      events: (
        storage.business.db
          .prepare("SELECT COUNT(*) AS total FROM execution_stream_events")
          .get() as { total: number }
      ).total,
      lastEvent: (
        storage.business.db
          .prepare(
            "SELECT MAX(stream_event_id) AS latest FROM execution_stream_events",
          )
          .get() as { latest: number | null }
      ).latest,
    }));
    assert.equal(countsAfter.schemaVersion, 13);
    assert.equal(countsAfter.messages, countsBefore.messages);
    assert.equal(countsAfter.segments, countsBefore.segments);
    assert.equal(countsAfter.events, countsBefore.events);
    assert.equal(countsAfter.lastEvent, countsBefore.lastEvent);
  } finally {
    await fixture.close();
  }
});

test("v10 pending reference mode stays unconfirmed after migration", async () => {
  const target = await startFakeUnifiedTts();
  const targetCapabilities: VoiceCapabilities = {
    ...CAPABILITIES,
    referenceModes: [
      { id: "clone-b", label: "B 的克隆模式", requiresReferenceText: false },
    ],
    presetVoices: false,
  };
  target.setHealth({ capabilities: targetCapabilities });
  const pending = createFixture([]);
  const bound = createFixture([]);
  try {
    const pendingPort = await listen(pending.app.server, 0, "127.0.0.1");
    const pendingBase = roleBase(pending, pendingPort);
    const pendingReference = await uploadReference(pendingBase);
    assert.equal(
      (
        await saveVoice(pendingBase, {
          baseUrl: "http://127.0.0.1:9890",
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: pendingReference.assetId,
            referenceMode: "clone",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await saveVoice(pendingBase, {
          baseUrl: target.baseUrl,
          protocol: "nowadays-tts-v1",
          capabilities: targetCapabilities,
        })
      ).status,
      200,
    );
    assert.equal(storedReferenceModeConfirmed(pending), 0);

    const boundPort = await listen(bound.app.server, 0, "127.0.0.1");
    const boundBase = roleBase(bound, boundPort);
    const boundReference = await uploadReference(boundBase);
    assert.equal(
      (
        await saveVoice(boundBase, {
          baseUrl: "http://127.0.0.1:9890",
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: boundReference.assetId,
            referenceMode: "clone",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );
    assert.equal(storedReferenceModeConfirmed(bound), 1);

    downgradeVoiceSettingsToV10(pending);
    downgradeVoiceSettingsToV10(bound);

    const pendingVoice = pending.app.services.voice.getVoice(pending.roleId);
    assert.equal(
      pendingVoice.voice?.voiceSource.kind === "reference"
        ? pendingVoice.voice.voiceSource.referenceMode
        : null,
      null,
    );
    assert.equal(storedReferenceModeConfirmed(pending), 0);
    const boundVoice = bound.app.services.voice.getVoice(bound.roleId);
    assert.equal(
      boundVoice.voice?.voiceSource.kind === "reference"
        ? boundVoice.voice.voiceSource.referenceMode
        : null,
      "clone",
    );
    assert.equal(storedReferenceModeConfirmed(bound), 1);

    const unrelated = await saveVoice(pendingBase, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      speed: 1.3,
    });
    assert.equal(unrelated.status, 200);
    const unrelatedBody = (await unrelated.json()) as {
      voice: { voiceSource: { referenceMode: string | null } };
    };
    assert.equal(unrelatedBody.voice.voiceSource.referenceMode, null);
    assert.equal(storedReferenceModeConfirmed(pending), 0);
    const blocked = await fetch(`${pendingBase}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "迁移后的待确认状态仍需显式选择。" }),
    });
    assert.equal(blocked.status, 400);
    assert.equal(await errorCode(blocked), "VOICE_REFERENCE_MODE_REQUIRED");
    assert.equal(target.requests.length, 0);

    const confirmed = await saveVoice(pendingBase, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: pendingReference.assetId,
        referenceMode: "clone-b",
      },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(storedReferenceModeConfirmed(pending), 1);
    const preview = await fetch(`${pendingBase}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "显式确认后恢复合成。" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0]!.referenceMode, "clone-b");
  } finally {
    await pending.close();
    await bound.close();
    await target.close();
  }
});

test("earlier v11 migration is repaired so pending reference mode stays unconfirmed", async () => {
  const target = await startFakeUnifiedTts();
  const targetCapabilities: VoiceCapabilities = {
    ...CAPABILITIES,
    referenceModes: [
      { id: "clone-b", label: "B 的克隆模式", requiresReferenceText: false },
    ],
    presetVoices: false,
  };
  target.setHealth({ capabilities: targetCapabilities });
  const pending = createFixture([]);
  const bound = createFixture([]);
  try {
    const pendingPort = await listen(pending.app.server, 0, "127.0.0.1");
    const pendingBase = roleBase(pending, pendingPort);
    const pendingReference = await uploadReference(pendingBase);
    assert.equal(
      (
        await saveVoice(pendingBase, {
          baseUrl: "http://127.0.0.1:9890",
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: pendingReference.assetId,
            referenceMode: "clone",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await saveVoice(pendingBase, {
          baseUrl: target.baseUrl,
          protocol: "nowadays-tts-v1",
          capabilities: targetCapabilities,
        })
      ).status,
      200,
    );
    simulatePreviousV11Migration(pending);

    const boundPort = await listen(bound.app.server, 0, "127.0.0.1");
    const boundBase = roleBase(bound, boundPort);
    const boundReference = await uploadReference(boundBase);
    assert.equal(
      (
        await saveVoice(boundBase, {
          baseUrl: "http://127.0.0.1:9890",
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: boundReference.assetId,
            referenceMode: "clone",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await saveVoice(boundBase, {
          baseUrl: target.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: boundReference.assetId,
            referenceMode: "clone-b",
          },
          capabilities: targetCapabilities,
        })
      ).status,
      200,
    );
    simulatePreviousV11Migration(bound);

    const pendingVoice = pending.app.services.voice.getVoice(pending.roleId);
    assert.equal(
      pendingVoice.voice?.voiceSource.kind === "reference"
        ? pendingVoice.voice.voiceSource.referenceMode
        : null,
      null,
    );
    assert.equal(storedReferenceModeConfirmed(pending), 0);
    const boundVoice = bound.app.services.voice.getVoice(bound.roleId);
    assert.equal(
      boundVoice.voice?.voiceSource.kind === "reference"
        ? boundVoice.voice.voiceSource.referenceMode
        : null,
      "clone-b",
    );
    assert.equal(storedReferenceModeConfirmed(bound), 1);

    const unrelated = await saveVoice(pendingBase, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      speed: 1.4,
    });
    assert.equal(unrelated.status, 200);
    const unrelatedBody = (await unrelated.json()) as {
      voice: { voiceSource: { referenceMode: string | null } };
    };
    assert.equal(unrelatedBody.voice.voiceSource.referenceMode, null);
    assert.equal(storedReferenceModeConfirmed(pending), 0);
    const blocked = await fetch(`${pendingBase}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "旧 v11 库仍需显式确认模式。" }),
    });
    assert.equal(blocked.status, 400);
    assert.equal(await errorCode(blocked), "VOICE_REFERENCE_MODE_REQUIRED");
    assert.equal(target.requests.length, 0);

    const confirmed = await saveVoice(pendingBase, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: pendingReference.assetId,
        referenceMode: "clone-b",
      },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(storedReferenceModeConfirmed(pending), 1);
    const preview = await fetch(`${pendingBase}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "显式确认后恢复合成。" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0]!.referenceMode, "clone-b");
  } finally {
    await pending.close();
    await bound.close();
    await target.close();
  }
});

test("voice assets are role scoped and synthesis failures keep segments readable", async () => {
  const fake = await startFakeUnifiedTts();
  const first = createFixture([
    [
      { type: "text_delta", text: "你好呀。\n（她挥手）" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const second = createFixture([]);
  try {
    const firstPort = await listen(first.app.server, 0, "127.0.0.1");
    const secondPort = await listen(second.app.server, 0, "127.0.0.1");
    const firstBase = roleBase(first, firstPort);
    const secondBase = roleBase(second, secondPort);
    const reference = await uploadReference(firstBase);

    const crossRole = await saveVoice(secondBase, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone",
      },
      capabilities: CAPABILITIES,
    });
    assert.equal(crossRole.status, 404);
    assert.equal(await errorCode(crossRole), "VOICE_REFERENCE_NOT_FOUND");

    assert.equal(
      (
        await saveVoice(firstBase, {
          baseUrl: fake.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: { kind: "preset", voiceId: "speaker-01" },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );
    const { speech } = await createSpeechSegments(first);
    const crossWindow = await fetch(
      `${secondBase}/windows/${first.windowId}/segments/${speech.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(crossWindow.status, 404);
    assert.equal(await errorCode(crossWindow), "MESSAGE_SEGMENT_NOT_FOUND");

    fake.setMode("error");
    const failed = await fetch(
      `${firstBase}/windows/${first.windowId}/segments/${speech.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(failed.status, 502);
    assert.equal(await errorCode(failed), "TTS_SYNTHESIS_FAILED");
    const detail = first.app.services.messages.get(
      first.roleId,
      first.windowId,
      (
        first.app.services.messages
          .list(first.roleId, first.windowId, 0, 50)
          .items.find((message) => message.sender === "assistant")
      )!.messageId,
    );
    assert.equal(
      detail.segments.find((segment) => segment.segmentId === speech.segmentId)
        ?.text,
      speech.text,
    );
  } finally {
    await first.close();
    await second.close();
    await fake.close();
  }
});

test("unified requests refuse redirects without contacting the target", async () => {
  const source = await startFakeUnifiedTts();
  const target = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: source.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: { kind: "preset", voiceId: "speaker-01" },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );

    source.setRedirect("/tts", target.baseUrl);
    const preset = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "预置模式不应跟随重定向。" }),
    });
    assert.equal(preset.status, 502);
    assert.equal(await errorCode(preset), "TTS_SYNTHESIS_FAILED");
    assert.equal(target.paths.length, 0);
    assert.equal(target.requests.length, 0);

    const reference = await uploadReference(base);
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: source.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: reference.assetId,
            referenceMode: "clone-text",
            referenceText: "录音原文。",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );
    const clone = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "克隆模式不应跟随重定向。" }),
    });
    assert.equal(clone.status, 502);
    assert.equal(await errorCode(clone), "TTS_SYNTHESIS_FAILED");
    assert.equal(target.paths.length, 0);
    assert.equal(target.requests.length, 0);

    source.setRedirect("/tts", null);
    source.setRedirect("/health", target.baseUrl);
    const probe = await probeVoice(base, source.baseUrl);
    assert.equal(probe.status, 502);
    assert.equal(await errorCode(probe), "TTS_PROBE_FAILED");
    assert.equal(target.paths.length, 0);
  } finally {
    await fixture.close();
    await source.close();
    await target.close();
  }
});

test("preview accepts the documented config envelope", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    const config = {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone",
      },
      capabilities: CAPABILITIES,
      language: "en",
      speed: 1.1,
    };
    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "按文档的 config 形状试听。", config }),
    });
    assert.equal(preview.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.mode, "reference");
    assert.equal(fake.requests[0]!.language, "en");
    assert.equal(fake.requests[0]!.speed, "1.1");

    const saved = (await (await fetch(`${base}/voice`)).json()) as {
      voice: unknown;
    };
    assert.equal(saved.voice, null);

    const mixed = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "不能同时使用两种形状。",
        config,
        language: "zh",
      }),
    });
    assert.equal(mixed.status, 400);
    assert.equal(await errorCode(mixed), "INVALID_REQUEST");
    assert.equal(fake.requests.length, 1);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("service switch requires reselecting the voice and resetting the reference mode", async () => {
  const target = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: "http://127.0.0.1:9890",
          protocol: "nowadays-tts-v1",
          voiceSource: { kind: "preset", voiceId: "speaker-a" },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );

    const switched = await saveVoice(base, { baseUrl: target.baseUrl });
    assert.equal(switched.status, 400);
    assert.equal(await errorCode(switched), "VOICE_SOURCE_REQUIRED");
    const switchedPreview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "候选地址不能复用旧音色。",
        config: { baseUrl: target.baseUrl },
      }),
    });
    assert.equal(switchedPreview.status, 400);
    assert.equal(await errorCode(switchedPreview), "VOICE_SOURCE_REQUIRED");
    assert.equal(target.requests.length, 0);

    const reselected = await saveVoice(base, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: { kind: "preset", voiceId: "speaker-b" },
      capabilities: CAPABILITIES,
    });
    assert.equal(reselected.status, 200);
    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "使用目标服务重新选择的音色。" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0]!.voiceId, "speaker-b");

    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: target.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: reference.assetId,
            referenceMode: "clone-text",
            referenceText: "第一段原文。",
          },
        })
      ).status,
      200,
    );
    const switchedBack = await saveVoice(base, {
      baseUrl: "http://127.0.0.1:9890",
    });
    assert.equal(switchedBack.status, 200);
    const switchedBody = (await switchedBack.json()) as {
      voice: {
        voiceSource: {
          referenceMode: string | null;
          referenceText: string | null;
        };
      };
    };
    assert.equal(switchedBody.voice.voiceSource.referenceMode, null);
    assert.equal(switchedBody.voice.voiceSource.referenceText, "第一段原文。");
    const noMode = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "旧模式不能带到新服务。" }),
    });
    assert.equal(noMode.status, 400);
    assert.equal(await errorCode(noMode), "VOICE_REFERENCE_MODE_REQUIRED");
  } finally {
    await fixture.close();
    await target.close();
  }
});

test("changing reference audio drops text that belongs to the previous recording", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const firstAudio = wavAudio(Buffer.from([1, 2, 3, 4]));
    const secondAudio = wavAudio(Buffer.from([5, 6, 7, 8]));
    const first = await uploadReference(base, firstAudio, "第一段.wav");
    const second = await uploadReference(base, secondAudio, "第二段.wav");
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: fake.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: first.assetId,
            referenceMode: "clone-text",
            referenceText: "第一段原文。",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );

    const sameAsset = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "同一素材只改模式参数。",
        config: {
          voiceSource: { kind: "reference", referenceAssetId: first.assetId },
        },
      }),
    });
    assert.equal(sameAsset.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(fake.requests[0]!.audio?.data, firstAudio);
    assert.equal(fake.requests[0]!.referenceText, "第一段原文。");

    const missingText = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "换素材后不能沿用旧原文。",
        config: {
          voiceSource: { kind: "reference", referenceAssetId: second.assetId },
        },
      }),
    });
    assert.equal(missingText.status, 400);
    assert.equal(await errorCode(missingText), "VOICE_REFERENCE_TEXT_REQUIRED");
    assert.equal(fake.requests.length, 1);

    const withNewText = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "换素材并补上新原文。",
        config: {
          voiceSource: {
            kind: "reference",
            referenceAssetId: second.assetId,
            referenceText: "第二段原文。",
          },
        },
      }),
    });
    assert.equal(withNewText.status, 200);
    assert.equal(fake.requests.length, 2);
    assert.deepEqual(fake.requests[1]!.audio?.data, secondAudio);
    assert.equal(fake.requests[1]!.referenceText, "第二段原文。");

    const saved = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: second.assetId,
      },
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as {
      voice: { voiceSource: { referenceText: string | null } };
    };
    assert.equal(savedBody.voice.voiceSource.referenceText, null);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("service switch does not auto-bind a single reference mode", async () => {
  const source = await startFakeUnifiedTts();
  const target = await startFakeUnifiedTts();
  const targetCapabilities: VoiceCapabilities = {
    ...CAPABILITIES,
    referenceModes: [
      { id: "clone-b", label: "B 的克隆模式", requiresReferenceText: false },
    ],
    presetVoices: false,
  };
  target.setHealth({ capabilities: targetCapabilities });
  const fixture = createFixture([
    [
      { type: "text_delta", text: "你好呀。\n（她挥手）" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: source.baseUrl,
          protocol: "nowadays-tts-v1",
          voiceSource: {
            kind: "reference",
            referenceAssetId: reference.assetId,
            referenceMode: "clone",
          },
          capabilities: CAPABILITIES,
        })
      ).status,
      200,
    );

    const switched = await saveVoice(base, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      capabilities: targetCapabilities,
    });
    assert.equal(switched.status, 200);
    const switchedBody = (await switched.json()) as {
      voice: {
        voiceSource: { referenceMode: string | null };
        capabilities: VoiceCapabilities;
      };
    };
    assert.equal(switchedBody.voice.voiceSource.referenceMode, null);
    assert.deepEqual(switchedBody.voice.capabilities, targetCapabilities);

    const unconfirmed = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "未确认新服务模式不能直接使用。" }),
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal(
      await errorCode(unconfirmed),
      "VOICE_REFERENCE_MODE_REQUIRED",
    );
    assert.equal(target.requests.length, 0);

    const secondSave = await saveVoice(base, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      speed: 1.2,
    });
    assert.equal(secondSave.status, 200);
    const secondBody = (await secondSave.json()) as {
      voice: { voiceSource: { referenceMode: string | null } };
    };
    assert.equal(secondBody.voice.voiceSource.referenceMode, null);
    assert.equal(target.requests.length, 0);

    const stillUnconfirmed = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "改语速也不能绕过模式确认。" }),
    });
    assert.equal(stillUnconfirmed.status, 400);
    assert.equal(
      await errorCode(stillUnconfirmed),
      "VOICE_REFERENCE_MODE_REQUIRED",
    );
    const { speech } = await createSpeechSegments(fixture);
    const unconfirmedSpeech = await fetch(
      `${base}/windows/${fixture.windowId}/segments/${speech.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(unconfirmedSpeech.status, 400);
    assert.equal(
      await errorCode(unconfirmedSpeech),
      "VOICE_REFERENCE_MODE_REQUIRED",
    );
    assert.equal(target.requests.length, 0);

    const confirmed = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "明确确认 B 的模式后试听。",
        config: {
          voiceSource: {
            kind: "reference",
            referenceAssetId: reference.assetId,
            referenceMode: "clone-b",
          },
        },
      }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0]!.referenceMode, "clone-b");

    const confirmedSave = await saveVoice(base, {
      baseUrl: target.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: {
        kind: "reference",
        referenceAssetId: reference.assetId,
        referenceMode: "clone-b",
      },
    });
    assert.equal(confirmedSave.status, 200);
    const confirmedSpeech = await fetch(
      `${base}/windows/${fixture.windowId}/segments/${speech.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(confirmedSpeech.status, 200);
    assert.equal(target.requests.length, 2);
    assert.equal(target.requests[1]!.referenceMode, "clone-b");
  } finally {
    await fixture.close();
    await source.close();
    await target.close();
  }
});

test("unified language codes and speed ranges follow the service declaration", async () => {
  const fake = await startFakeUnifiedTts();
  const fixture = createFixture([]);
  try {
    fake.setHealth({
      capabilities: {
        ...CAPABILITIES,
        languages: ["ko"],
        speed: { min: 0.05, max: 3 },
      },
    });
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const invalidProbe = await probeVoice(base, fake.baseUrl);
    assert.equal(invalidProbe.status, 502);
    assert.equal(await errorCode(invalidProbe), "TTS_PROTOCOL_INVALID");

    fake.setHealth({
      capabilities: {
        ...CAPABILITIES,
        languages: ["ko"],
        speed: { min: 2, max: 3 },
      },
    });
    const missingDefault = await probeVoice(base, fake.baseUrl);
    assert.equal(missingDefault.status, 502);
    assert.equal(await errorCode(missingDefault), "TTS_PROTOCOL_INVALID");

    const capabilities: VoiceCapabilities = {
      ...CAPABILITIES,
      languages: ["ko"],
      speed: { min: 0.1, max: 3 },
    };
    fake.setHealth({ capabilities });
    const probe = await probeVoice(base, fake.baseUrl);
    assert.equal(probe.status, 200);
    const probeBody = (await probe.json()) as {
      probe: { capabilities: VoiceCapabilities };
    };
    assert.deepEqual(probeBody.probe.capabilities, capabilities);

    const saved = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: { kind: "preset", voiceId: "speaker-01" },
      capabilities,
      language: "ko",
      speed: 2.5,
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as {
      voice: { language: string; speed: number };
    };
    assert.equal(savedBody.voice.language, "ko");
    assert.equal(savedBody.voice.speed, 2.5);
    const preview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "按服务声明的语言和语速合成。" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.language, "ko");
    assert.equal(fake.requests[0]!.speed, "2.5");

    const boundary = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "nowadays-tts-v1",
      voiceSource: { kind: "preset", voiceId: "speaker-01" },
      capabilities,
      language: "ko",
      speed: 0.1,
    });
    assert.equal(boundary.status, 200);
    const boundaryPreview = await fetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "使用声明下限的语速。" }),
    });
    assert.equal(boundaryPreview.status, 200);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1]!.language, "ko");
    assert.equal(fake.requests[1]!.speed, "0.1");

    const reference = await uploadReference(base);
    const legacyLanguage = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "indextts",
      referenceAssetId: reference.assetId,
      language: "ko",
    });
    assert.equal(legacyLanguage.status, 400);
    assert.equal(await errorCode(legacyLanguage), "VOICE_LANGUAGE_INVALID");
    const legacySpeed = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      protocol: "indextts",
      referenceAssetId: reference.assetId,
      speed: 2.5,
    });
    assert.equal(legacySpeed.status, 400);
    assert.equal(await errorCode(legacySpeed), "VOICE_SPEED_INVALID");
  } finally {
    await fixture.close();
    await fake.close();
  }
});
