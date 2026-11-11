import assert from "node:assert/strict";
import { configFetch } from "./config-write.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { listen } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { inspectAudio, isPcmWav } from "../src/application/audio-inspect.js";
import {
  IndexTtsClient,
  durationFactor,
  type IndexTtsSynthesisInput,
} from "../src/tts/indextts-client.js";
import {
  TtsCanceledError,
  TtsServiceUnavailableError,
  TtsSynthesisFailedError,
  TtsTimeoutError,
} from "../src/domain/errors.js";
import {
  createFixture,
  deferred,
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

function wavWithChunks(chunks: ReadonlyArray<{ id: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  let size = 4;
  for (const chunk of chunks) {
    const header = Buffer.alloc(8);
    header.write(chunk.id, 0, "ascii");
    header.writeUInt32LE(chunk.data.length, 4);
    parts.push(header, chunk.data);
    size += 8 + chunk.data.length;
    if (chunk.data.length % 2 === 1) {
      parts.push(Buffer.from([0]));
      size += 1;
    }
  }
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(size, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, ...parts]);
}

function pcmFormatChunk(): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(1, 0);
  data.writeUInt16LE(1, 2);
  data.writeUInt32LE(24_000, 4);
  data.writeUInt32LE(48_000, 8);
  data.writeUInt16LE(2, 12);
  data.writeUInt16LE(16, 14);
  return data;
}

type FakeMode =
  | "ok"
  | "error"
  | "errorSlow"
  | "successSlow"
  | "slow"
  | "invalid"
  | "corrupt"
  | "short"
  | "oversized";

interface FakeTts {
  baseUrl: string;
  requests: TtsRequestBody[];
  paths: string[];
  setMode(mode: FakeMode): void;
  close(): Promise<void>;
}

interface TtsRequestBody {
  text: string;
  lang: string;
  spk_audio_path: string;
  emo_audio_path: string | null;
  emo_vector: number[] | null;
  emo_alpha: number;
  duration_factor: number;
}

async function startFakeTts(): Promise<FakeTts> {
  const requests: TtsRequestBody[] = [];
  const paths: string[] = [];
  let mode: FakeMode = "ok";
  const server = http.createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      request.url === undefined ||
      !request.url.endsWith("/tts")
    ) {
      response.writeHead(404).end();
      return;
    }
    paths.push(request.url);
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    requests.push(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as TtsRequestBody,
    );
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (mode === "error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "IndexTTS 推理失败" }));
      return;
    }
    if (mode === "errorSlow") {
      response.writeHead(500, { "content-type": "application/json" });
      response.write('{"detail":"半截');
      await new Promise((resolve) => setTimeout(resolve, 200));
      response.end('"}');
      return;
    }
    if (mode === "successSlow") {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.write(WAV_AUDIO.subarray(0, 44));
      await new Promise((resolve) => setTimeout(resolve, 200));
      response.end(WAV_AUDIO.subarray(44));
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
    if (mode === "short") {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(WAV_AUDIO.subarray(0, 20));
      return;
    }
    if (mode === "oversized") {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(wavAudio(Buffer.alloc(100)));
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
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
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
  const response = await configFetch(`${base}/voice/reference`, {
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
  return configFetch(`${base}/voice`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

function synthesisInput(
  overrides: Partial<IndexTtsSynthesisInput> = {},
): IndexTtsSynthesisInput {
  return {
    text: "测试合成",
    language: "zh",
    referencePath: "C:\\ref.wav",
    speed: 1,
    emoAlpha: 1,
    ...overrides,
  };
}

test("voice settings and reference audio persist with the current schema", async () => {
  const fake = await startFakeTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);
    const saved = await saveVoice(base, {
      baseUrl: fake.baseUrl,
      referenceAssetId: reference.assetId,
      language: "ja",
      speed: 0.8,
      emoAlpha: 0.7,
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as {
      voice: {
        engine: string;
        baseUrl: string;
        reference: { assetId: string; fileName: string } | null;
        language: string;
        speed: number;
        emoAlpha: number;
      };
    };
    assert.equal(savedBody.voice.engine, "indextts");
    assert.equal(savedBody.voice.baseUrl, fake.baseUrl);
    assert.equal(savedBody.voice.reference?.assetId, reference.assetId);
    assert.equal(savedBody.voice.language, "ja");
    assert.equal(savedBody.voice.speed, 0.8);
    assert.equal(savedBody.voice.emoAlpha, 0.7);

    const fetched = await configFetch(`${base}/voice`);
    assert.equal(fetched.status, 200);
    const fetchedBody = (await fetched.json()) as typeof savedBody;
    assert.deepEqual(fetchedBody.voice, savedBody.voice);

    const paths = rolePaths(fixture.app.config.dataRoot, fixture.roleId);
    const referenceFile = path.join(
      paths.roleDir,
      reference.relativePath,
    );
    assert.ok(fs.existsSync(referenceFile));
    assert.ok(referenceFile.startsWith(`${paths.voiceDir}${path.sep}`));

    const tables = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN ('voice_assets', 'role_voice_settings')
            ORDER BY name ASC`,
        )
        .all()
        .map((row) => (row as { name: string }).name),
    );
    assert.deepEqual(tables, ["role_voice_settings", "voice_assets"]);
    assert.equal(
      withStorage(fixture, (storage) => storage.business.schemaVersion),
      17,
    );
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("preview uses candidate settings and sends the managed reference path", async () => {
  const fake = await startFakeTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const reference = await uploadReference(base);

    const preview = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "你好，今天过得怎么样？",
        baseUrl: fake.baseUrl,
        referenceAssetId: reference.assetId,
        language: "en",
        speed: 0.5,
        emoAlpha: 0.3,
      }),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "audio/wav");
    assert.deepEqual(
      Buffer.from(await preview.arrayBuffer()),
      WAV_AUDIO,
    );

    assert.equal(fake.requests.length, 1);
    const request = fake.requests[0]!;
    const expectedPath = path.join(
      rolePaths(fixture.app.config.dataRoot, fixture.roleId).roleDir,
      reference.relativePath,
    );
    assert.equal(request.text, "你好，今天过得怎么样？");
    assert.equal(request.lang, "en");
    assert.equal(request.spk_audio_path, expectedPath);
    assert.ok(path.isAbsolute(request.spk_audio_path));
    assert.equal(request.emo_audio_path, null);
    assert.equal(request.emo_vector, null);
    assert.equal(request.emo_alpha, 0.3);
    assert.equal(request.duration_factor, 2);

    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: fake.baseUrl,
          referenceAssetId: reference.assetId,
          language: "zh",
          speed: 1,
          emoAlpha: 1,
        })
      ).status,
      200,
    );
    const savedPreview = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "用保存的音色试听。" }),
    });
    assert.equal(savedPreview.status, 200);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1]!.spk_audio_path, expectedPath);
    assert.equal(fake.requests[1]!.duration_factor, 1);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("segment speech synthesizes speech and rejects narration", async () => {
  const fake = await startFakeTts();
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
    await saveVoice(base, {
      baseUrl: fake.baseUrl,
      referenceAssetId: reference.assetId,
    });
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "打个招呼",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
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

    const spoken = await configFetch(
      `${base}/windows/${fixture.windowId}/segments/${speech.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(spoken.status, 200);
    assert.equal(spoken.headers.get("content-type"), "audio/wav");
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.text, speech.text);

    const narrationResponse = await configFetch(
      `${base}/windows/${fixture.windowId}/segments/${narration.segmentId}/speech`,
      { method: "POST" },
    );
    assert.equal(narrationResponse.status, 400);
    const narrationError = (await narrationResponse.json()) as {
      error: { code: string };
    };
    assert.equal(narrationError.error.code, "VOICE_SEGMENT_NOT_SPEAKABLE");
    assert.equal(fake.requests.length, 1);

    const missing = await configFetch(
      `${base}/windows/${fixture.windowId}/segments/${randomUUID()}/speech`,
      { method: "POST" },
    );
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      "MESSAGE_SEGMENT_NOT_FOUND",
    );
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("voice routes require configuration and a reference", async () => {
  const fake = await startFakeTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);

    const notConfigured = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "还没配置。", baseUrl: fake.baseUrl }),
    });
    assert.equal(notConfigured.status, 400);
    assert.equal(
      ((await notConfigured.json()) as { error: { code: string } }).error.code,
      "VOICE_REFERENCE_REQUIRED",
    );

    const noBaseUrl = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "没有服务地址。" }),
    });
    assert.equal(noBaseUrl.status, 400);
    assert.equal(
      ((await noBaseUrl.json()) as { error: { code: string } }).error.code,
      "VOICE_NOT_CONFIGURED",
    );

    assert.equal(
      (
        await saveVoice(base, {
          baseUrl: fake.baseUrl,
        })
      ).status,
      200,
    );
    const noReference = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "配置了服务但没参考音色。" }),
    });
    assert.equal(noReference.status, 400);
    assert.equal(
      ((await noReference.json()) as { error: { code: string } }).error.code,
      "VOICE_REFERENCE_REQUIRED",
    );
    assert.equal(fake.requests.length, 0);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("voice reference upload rejects unsupported and empty audio", async () => {
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    const form = new FormData();
    form.set("file", new Blob(["not audio"], { type: "text/plain" }), "a.txt");
    const unsupported = await configFetch(`${base}/voice/reference`, {
      method: "POST",
      body: form,
    });
    assert.equal(unsupported.status, 400);
    assert.equal(
      ((await unsupported.json()) as { error: { code: string } }).error.code,
      "AUDIO_FORMAT_UNSUPPORTED",
    );

    const emptyForm = new FormData();
    emptyForm.set("file", new Blob([], { type: "audio/wav" }), "empty.wav");
    const empty = await configFetch(`${base}/voice/reference`, {
      method: "POST",
      body: emptyForm,
    });
    assert.equal(empty.status, 400);
    assert.equal(
      ((await empty.json()) as { error: { code: string } }).error.code,
      "AUDIO_FILE_EMPTY",
    );
  } finally {
    await fixture.close();
  }
});

test("IndexTTS client maps service failures, timeouts and cancellation", async () => {
  const fake = await startFakeTts();
  try {
    const client = new IndexTtsClient(fake.baseUrl, 500);
    fake.setMode("error");
    await assert.rejects(
      client.synthesize({
        text: "失败",
        language: "zh",
        referencePath: "C:\\ref.wav",
        speed: 1,
        emoAlpha: 1,
      }),
      (error: unknown) =>
        error instanceof TtsSynthesisFailedError &&
        error.message === "IndexTTS 推理失败",
    );

    fake.setMode("invalid");
    await assert.rejects(
      client.synthesize({
        text: "无效响应",
        language: "zh",
        referencePath: "C:\\ref.wav",
        speed: 1,
        emoAlpha: 1,
      }),
      (error: unknown) => error instanceof TtsSynthesisFailedError,
    );
  } finally {
    await fake.close();
  }

  const unreachable = new IndexTtsClient("http://127.0.0.1:1", 200);
  await assert.rejects(
    unreachable.synthesize({
      text: "连不上",
      language: "zh",
      referencePath: "C:\\ref.wav",
      speed: 1,
      emoAlpha: 1,
    }),
    (error: unknown) => error instanceof TtsServiceUnavailableError,
  );

  const slow = await startFakeTts();
  try {
    slow.setMode("slow");
    const timeoutClient = new IndexTtsClient(slow.baseUrl, 50);
    await assert.rejects(
      timeoutClient.synthesize({
        text: "超时",
        language: "zh",
        referencePath: "C:\\ref.wav",
        speed: 1,
        emoAlpha: 1,
      }),
      (error: unknown) => error instanceof TtsTimeoutError,
    );

    const controller = new AbortController();
    const canceledClient = new IndexTtsClient(slow.baseUrl, 5_000);
    const pending = canceledClient.synthesize({
      text: "取消",
      language: "zh",
      referencePath: "C:\\ref.wav",
      speed: 1,
      emoAlpha: 1,
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

test("IndexTTS response validation rejects non-WAV, truncated and oversized audio", async () => {
  const fake = await startFakeTts();
  try {
    const client = new IndexTtsClient(fake.baseUrl, 500);
    for (const mode of ["invalid", "corrupt", "short"] as const) {
      fake.setMode(mode);
      await assert.rejects(
        client.synthesize(synthesisInput()),
        (error: unknown) => error instanceof TtsSynthesisFailedError,
      );
    }
    fake.setMode("oversized");
    const limited = new IndexTtsClient(fake.baseUrl, 500, 64);
    await assert.rejects(
      limited.synthesize(synthesisInput()),
      (error: unknown) => error instanceof TtsSynthesisFailedError,
    );
  } finally {
    await fake.close();
  }
});

test("IndexTTS error body reads preserve timeout and cancellation", async () => {
  const fake = await startFakeTts();
  try {
    fake.setMode("errorSlow");
    const timeoutClient = new IndexTtsClient(fake.baseUrl, 50);
    await assert.rejects(
      timeoutClient.synthesize(synthesisInput()),
      (error: unknown) => error instanceof TtsTimeoutError,
    );

    const controller = new AbortController();
    const cancelClient = new IndexTtsClient(fake.baseUrl, 5_000);
    const pending = cancelClient.synthesize(
      synthesisInput({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof TtsCanceledError,
    );

    fake.setMode("successSlow");
    const bodyTimeoutClient = new IndexTtsClient(fake.baseUrl, 50);
    await assert.rejects(
      bodyTimeoutClient.synthesize(synthesisInput()),
      (error: unknown) => error instanceof TtsTimeoutError,
    );
  } finally {
    await fake.close();
  }
});

test("IndexTTS closes the upstream response when its media type is rejected", async () => {
  const upstreamClosed = deferred<void>();
  const server = http.createServer((request, response) => {
    request.resume();
    response.once("close", () => upstreamClosed.resolve());
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("unfinished response");
  });
  const port = await listen(server, 0, "127.0.0.1");
  try {
    const client = new IndexTtsClient(`http://127.0.0.1:${port}`, 500);
    await assert.rejects(client.synthesize(synthesisInput()), TtsSynthesisFailedError);
    assert.equal(
      await Promise.race([
        upstreamClosed.promise.then(() => true),
        delay(1000, false, { ref: false }),
      ]),
      true,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test("voice base url rejects query and fragment and keeps the path prefix", async () => {
  const fake = await startFakeTts();
  const fixture = createFixture([]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = roleBase(fixture, port);
    for (const suffix of ["?name=x", "#frag", "?", "#"]) {
      const response = await saveVoice(base, {
        baseUrl: `${fake.baseUrl}/bridge${suffix}`,
      });
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "VOICE_BASE_URL_INVALID",
      );
    }

    const reference = await uploadReference(base);
    const saved = await saveVoice(base, {
      baseUrl: `${fake.baseUrl}/bridge/`,
      referenceAssetId: reference.assetId,
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as { voice: { baseUrl: string } };
    assert.equal(savedBody.voice.baseUrl, `${fake.baseUrl}/bridge`);

    const preview = await configFetch(`${base}/voice/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "前缀测试。" }),
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(fake.paths, ["/bridge/tts"]);
  } finally {
    await fixture.close();
    await fake.close();
  }
});

test("duration factor and audio inspection keep their boundaries", () => {
  assert.equal(durationFactor(1), 1);
  assert.equal(durationFactor(2), 0.5);
  assert.equal(durationFactor(0.5), 2);
  assert.equal(durationFactor(10), 0.5);
  assert.equal(durationFactor(0.1), 2);
  assert.equal(durationFactor(0), 1);

  assert.deepEqual(inspectAudio(WAV_AUDIO), {
    mediaType: "audio/wav",
    extension: ".wav",
  });
  assert.deepEqual(inspectAudio(Buffer.from("ID3xxxx", "ascii")), {
    mediaType: "audio/mpeg",
    extension: ".mp3",
  });
  assert.deepEqual(inspectAudio(Buffer.from("fLaCxxxx", "ascii")), {
    mediaType: "audio/flac",
    extension: ".flac",
  });
  assert.deepEqual(inspectAudio(Buffer.from("OggSxxxx", "ascii")), {
    mediaType: "audio/ogg",
    extension: ".ogg",
  });
  assert.equal(inspectAudio(Buffer.from("plain text", "ascii")), null);

  assert.equal(isPcmWav(WAV_AUDIO), true);
  assert.equal(isPcmWav(Buffer.from("not a wav", "ascii")), false);
  assert.equal(isPcmWav(WAV_AUDIO.subarray(0, 20)), false);
  assert.equal(isPcmWav(wavAudio(Buffer.alloc(0))), false);

  const partialFrame = Buffer.concat([wavAudio(Buffer.alloc(3)), Buffer.alloc(1)]);
  partialFrame.writeUInt32LE(partialFrame.length - 8, 4);
  assert.equal(isPcmWav(partialFrame), false);

  const invalidByteRate = Buffer.from(WAV_AUDIO);
  invalidByteRate.writeUInt32LE(123, 28);
  assert.equal(isPcmWav(invalidByteRate), false);

  const invalidAlignment = Buffer.from(WAV_AUDIO);
  invalidAlignment.writeUInt16LE(1, 32);
  assert.equal(isPcmWav(invalidAlignment), false);

  const oddMetadata = wavWithChunks([
    { id: "fmt ", data: pcmFormatChunk() },
    { id: "LIST", data: Buffer.from("abc", "ascii") },
    { id: "data", data: Buffer.alloc(4) },
  ]);
  assert.equal(isPcmWav(oddMetadata), true);
});
