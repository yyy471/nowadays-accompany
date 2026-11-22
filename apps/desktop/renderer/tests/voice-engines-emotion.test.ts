// 双 TTS 引擎选择与对话语音情绪标注的前端纯逻辑测试。
import test from "node:test";
import assert from "node:assert/strict";
import * as voiceConfigModule from "../src/voice-config.ts";
import * as windowModelModule from "../src/conversation/window-model.ts";
import * as voiceCacheModule from "../src/components/voice/voice-cache.ts";

const loadVoiceConfig = async () => voiceConfigModule;

const loadWindowModel = async () => windowModelModule;

const CAPABILITIES = {
  referenceModes: [{ id: "clone", label: "参考音频", requiresReferenceText: false }],
  presetVoices: true,
  languages: ["zh", "en"],
  speed: { min: 0.5, max: 2.0 },
};

const ENGINES = {
  cosyvoice: { ready: true, active: true, onDemand: true },
  indextts: { ready: false, active: false, onDemand: true },
};

test("resolveEngines 从当前探测或已保存配置解析引擎状态，并在换服务后清空", async () => {
  const { createVoiceForm, resolveEngines, withVoiceService, normalizeBaseUrl } =
    await loadVoiceConfig();

  const savedConfig = {
    protocol: "nowadays-tts-v1",
    baseUrl: "http://127.0.0.1:9890",
    ttsEngine: "indextts",
    engines: ENGINES,
    defaultEngine: "cosyvoice",
    capabilities: CAPABILITIES,
    voiceSource: { kind: "preset", voiceId: "index:v1" },
    reference: null,
    language: "zh",
    speed: 1,
    enabled: true,
  };
  const savedForm = createVoiceForm(savedConfig);
  assert.equal(savedForm.ttsEngine, "indextts");

  // 同一地址保留已保存的引擎元数据
  const fromSaved = resolveEngines({
    config: savedConfig,
    form: savedForm,
    probe: null,
    probeSource: null,
  });
  assert.deepEqual(fromSaved.engines, ENGINES);
  assert.equal(fromSaved.defaultEngine, "cosyvoice");

  // 切换到新地址时重置 ttsEngine 且不再沿用旧服务 engines
  const moved = withVoiceService(savedForm, { baseUrl: "http://127.0.0.1:9900" });
  assert.equal(moved.ttsEngine, "");
  const afterMove = resolveEngines({
    config: savedConfig,
    form: moved,
    probe: null,
    probeSource: null,
  });
  assert.deepEqual(afterMove, { engines: null, defaultEngine: null });

  // 对新地址做探测后优先采用新探测返回的 engines 与 defaultEngine
  const freshProbe = {
    ready: true,
    service: "Local Bridge",
    capabilities: CAPABILITIES,
    engines: { cosyvoice: { ready: true, active: true, onDemand: true } },
    defaultEngine: "cosyvoice",
  };
  const fromProbe = resolveEngines({
    config: savedConfig,
    form: moved,
    probe: freshProbe,
    probeSource: {
      baseUrl: normalizeBaseUrl(moved.baseUrl),
      protocol: moved.protocol,
    },
  });
  assert.deepEqual(fromProbe.engines, freshProbe.engines);
  assert.equal(fromProbe.defaultEngine, "cosyvoice");
});

test("toVoicePayload 与 validateVoiceForm 正确处理 ttsEngine 与未支持引擎错误", async () => {
  const { createVoiceForm, toVoicePayload, validateVoiceForm, describeVoiceFailure } =
    await loadVoiceConfig();

  const base = {
    ...createVoiceForm(null),
    protocol: "nowadays-tts-v1",
    baseUrl: "http://127.0.0.1:9890",
    sourceKind: "preset",
    voiceId: "cosy:v1",
    language: "zh",
    speed: 1,
    capabilities: CAPABILITIES,
  };

  // 未选引擎时不写入 ttsEngine，确保旧服务与已有单测契约兼容
  const withoutEngine = toVoicePayload(base);
  assert.equal("ttsEngine" in withoutEngine, false);

  const withEngine = toVoicePayload(
    { ...base, ttsEngine: "indextts", voiceId: "index:v1" },
    { engines: ENGINES, defaultEngine: "cosyvoice" },
  );
  assert.equal(withEngine.ttsEngine, "indextts");
  assert.equal(withEngine.defaultEngine, "cosyvoice");
  assert.deepEqual(withEngine.engines, ENGINES);

  // 未在 engines 中的引擎名被 validateVoiceForm 拒绝
  const invalidErrors = validateVoiceForm(
    { ...base, ttsEngine: "unknown-tts" },
    { capabilities: CAPABILITIES, engines: ENGINES },
  );
  assert.equal(invalidErrors.length, 1);
  assert.equal(invalidErrors[0].code, "ENGINE_UNSUPPORTED");

  assert.equal(
    describeVoiceFailure({ code: "VOICE_ENGINE_UNSUPPORTED" }),
    "所选语音引擎不在当前服务支持的列表中。",
  );
});

test("pickPresetVoiceForEngine 在 cosy 与 index 预置前缀间自动映射", async () => {
  const { pickPresetVoiceForEngine } = await loadVoiceConfig();
  const voices = [
    { id: "cosy:v1a", label: "秧秧" },
    { id: "index:v1a", label: "秧秧" },
    { id: "cosy:only", label: "仅Cosy" },
  ];

  assert.equal(pickPresetVoiceForEngine(voices, "cosy:v1a", "indextts"), "index:v1a");
  assert.equal(pickPresetVoiceForEngine(voices, "index:v1a", "cosyvoice"), "cosy:v1a");
  assert.equal(pickPresetVoiceForEngine(voices, "cosy:only", "indextts"), "cosy:only");
  assert.equal(pickPresetVoiceForEngine(voices, "", "indextts"), "");
});

test("summarizeProbe 返回多引擎摘要信息", async () => {
  const { summarizeProbe } = await loadVoiceConfig();
  const summary = summarizeProbe({
    ready: true,
    service: "Nowadays local bridge",
    capabilities: CAPABILITIES,
    engines: ENGINES,
    defaultEngine: "cosyvoice",
  });
  assert.ok(summary);
  assert.deepEqual(summary.engines, ENGINES);
  assert.equal(summary.defaultEngine, "cosyvoice");
});

test("window-model 将句段 voiceEmotion 正确传播到消息行并忽略旁白与空覆盖", async () => {
  const { applySegmentAnnotations, rowsForMessage, createRowIdRegistry } =
    await loadWindowModel();

  const segments = [
    {
      segmentId: "seg-speech-0",
      messageId: "m-emo",
      ordinal: 0,
      kind: "speech",
      text: "快坐下休息吧。",
      startOffset: 0,
      endOffset: 7,
      outfitId: null,
      spriteAssetId: null,
      homeAssetId: null,
      voiceEmotion: null,
      annotatedAt: null,
    },
    {
      segmentId: "seg-narr-1",
      messageId: "m-emo",
      ordinal: 1,
      kind: "narration",
      text: "（她轻手轻脚走过来）",
      startOffset: 8,
      endOffset: 19,
      outfitId: null,
      spriteAssetId: null,
      homeAssetId: null,
      voiceEmotion: null,
      annotatedAt: null,
    },
  ];

  const annotated = applySegmentAnnotations(segments, [
    { segmentId: "seg-speech-0", voiceEmotion: "温柔轻声哄人" },
    { segmentId: "seg-narr-1", voiceEmotion: null },
  ]);
  assert.equal(annotated[0].voiceEmotion, "温柔轻声哄人");
  assert.equal(annotated[1].voiceEmotion, null);

  // 仅包含立绘字段、未携带 voiceEmotion 时保留已标注的情绪
  const kept = applySegmentAnnotations(annotated, [
    { segmentId: "seg-speech-0", spriteAssetId: "sprite-1" },
  ]);
  assert.equal(kept[0].voiceEmotion, "温柔轻声哄人");

  const rows = rowsForMessage(
    {
      messageId: "m-emo",
      sender: "assistant",
      status: "completed",
      content: "快坐下休息吧。\n（她轻手轻脚走过来）",
      createdAt: "2026-11-14T12:00:00.000Z",
    },
    kept,
    createRowIdRegistry().id,
  );
  assert.equal(rows[0].role, "assistant");
  assert.equal(rows[0].text, "快坐下休息吧。");
  assert.equal(rows[0].voiceEmotion, "温柔轻声哄人");
  assert.equal(rows[1].role, "assistant");
  assert.equal(rows[1].actionVisible, true);
  assert.equal(rows[1].voiceEmotion ?? null, null);
});

test("全局语音服务草稿校验、serviceId 载荷及 voice-cache 隔离正确", async () => {
  const {
    createVoiceForm,
    withVoiceService,
    toVoicePayload,
    validateVoiceForm,
    validateVoiceServiceDraft,
    toVoiceServiceConfig,
    describeVoiceFailure,
    describeVoiceSummary,
  } = await loadVoiceConfig();
  const voiceCache = voiceCacheModule;

  // 1. validateVoiceServiceDraft / toVoiceServiceConfig
  assert.ok(validateVoiceServiceDraft({ name: "  ", protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9890" }));
  assert.ok(validateVoiceServiceDraft({ name: "本机", protocol: "nowadays-tts-v1", baseUrl: "ftp://127.0.0.1:9890" }));
  assert.equal(validateVoiceServiceDraft({ name: "本机", protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9890/" }), null);
  assert.deepEqual(
    toVoiceServiceConfig({ protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9890/", defaultEngine: "cosyvoice" }),
    { protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9890", defaultEngine: "cosyvoice" },
  );
  assert.deepEqual(
    toVoiceServiceConfig({ protocol: "indextts", baseUrl: "http://127.0.0.1:8000/", defaultEngine: "cosyvoice" }),
    { protocol: "indextts", baseUrl: "http://127.0.0.1:8000" },
  );

  // 2. requireService 校验 & withVoiceService / toVoicePayload / clearEngine
  const emptyForm = createVoiceForm(null);
  assert.equal(validateVoiceForm(emptyForm, { requireService: true })[0].code, "VOICE_SERVICE_REQUIRED");

  const bound = {
    ...createVoiceForm({
      serviceId: "vs-1",
      service: { serviceId: "vs-1", name: "WSL 桥接", enabled: true, protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9890" },
      engine: "nowadays-tts-v1",
      protocol: "nowadays-tts-v1",
      ttsEngine: "indextts",
      baseUrl: "http://127.0.0.1:9890",
      voiceSource: { kind: "preset", voiceId: "index:v1" },
      reference: null,
      capabilities: CAPABILITIES,
      enabled: true,
      language: "zh",
      speed: 1,
      emoAlpha: 1,
      createdAt: "2026-11-16T00:00:00Z",
      updatedAt: "2026-11-16T00:00:00Z",
    }),
  };
  assert.match(describeVoiceSummary({
    serviceId: "vs-1",
    service: { serviceId: "vs-1", name: "WSL 桥接", enabled: true, protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9890" },
    protocol: "nowadays-tts-v1",
    voiceSource: { kind: "preset", voiceId: "cosy:v1" },
    enabled: true,
  }), /WSL 桥接.*预置音色 cosy:v1/);

  const clearedPayload = toVoicePayload({ ...bound, ttsEngine: "" }, { clearEngine: true });
  assert.equal(clearedPayload.serviceId, "vs-1");
  assert.equal(clearedPayload.ttsEngine, null);

  const switchedSvc = withVoiceService(bound, { serviceId: "vs-2", protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9891" });
  assert.equal(switchedSvc.serviceId, "vs-2");
  assert.equal(switchedSvc.ttsEngine, "");
  assert.equal(switchedSvc.voiceId, "");

  assert.match(describeVoiceFailure({ code: "VOICE_SERVICE_NOT_FOUND" }), /已不存在/);
  assert.match(describeVoiceFailure({ code: "VOICE_SERVICE_DISABLED" }), /已停用/);
  assert.match(describeVoiceFailure({ code: "VOICE_PROBE_UNSUPPORTED" }), /试听/);

  // 3. voice-cache 隔离与失效推进
  const key = voiceCache.voiceServiceCacheKey({
    serviceId: "vs-1",
    config: { protocol: "nowadays-tts-v1", baseUrl: "http://127.0.0.1:9890" },
  });
  const epoch0 = voiceCache.getVoiceProbeCacheEpoch(key);
  voiceCache.writeVoiceProbeCache(key, { ready: true, service: "ok", capabilities: CAPABILITIES });
  assert.equal(voiceCache.readVoiceProbeCache(key).service, "ok");
  voiceCache.clearVoiceProbeCache(key);
  assert.equal(voiceCache.readVoiceProbeCache(key), null);
  assert.equal(voiceCache.getVoiceProbeCacheEpoch(key), epoch0 + 1);
});
