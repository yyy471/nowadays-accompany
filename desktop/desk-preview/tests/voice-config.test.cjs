"use strict";

// 声音配置表单映射、能力校验与错误文案的纯逻辑测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/voice-config.js")).href);

const capabilities = {
  referenceModes: [
    { id: "same_language", label: "同语言", requiresReferenceText: false },
    { id: "cross_language", label: "跨语言", requiresReferenceText: true }
  ],
  presetVoices: true,
  languages: ["zh", "en", "ja"],
  speed: { min: 0.5, max: 2 }
};

const referenceConfig = {
  engine: "nowadays-tts-v1",
  protocol: "nowadays-tts-v1",
  baseUrl: "http://127.0.0.1:8000",
  voiceSource: { kind: "reference", referenceAssetId: "asset-1", referenceMode: "same_language", referenceText: null },
  reference: { assetId: "asset-1", fileName: "sample.wav", mediaType: "audio/wav", createdAt: "2026-11-10T00:00:00.000Z" },
  capabilities,
  language: "zh",
  speed: 1,
  emoAlpha: 0.8,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z"
};

test("没有保存过配置时给出可用的默认表单", async () => {
  const { createVoiceForm } = await load();
  const form = createVoiceForm(null);
  assert.equal(form.protocol, "nowadays-tts-v1");
  assert.equal(form.sourceKind, "reference");
  assert.equal(form.language, "zh");
  assert.equal(form.speed, 1);
  assert.equal(form.emoAlpha, 1);
  assert.equal(form.configured, false);
});

test("参考音频配置读成表单并保留能力声明", async () => {
  const { createVoiceForm } = await load();
  const form = createVoiceForm(referenceConfig);
  assert.equal(form.baseUrl, "http://127.0.0.1:8000");
  assert.equal(form.sourceKind, "reference");
  assert.equal(form.referenceAssetId, "asset-1");
  assert.equal(form.referenceMode, "same_language");
  assert.equal(form.emoAlpha, 0.8);
  assert.deepEqual(form.capabilities, capabilities);
});

test("预置音色配置读成表单时不带参考音频字段", async () => {
  const { createVoiceForm } = await load();
  const form = createVoiceForm({
    ...referenceConfig,
    voiceSource: { kind: "preset", voiceId: "voice-a" },
    reference: null
  });
  assert.equal(form.sourceKind, "preset");
  assert.equal(form.voiceId, "voice-a");
  assert.equal(form.referenceAssetId, "");
});

test("保存载荷按协议与音色来源收敛字段", async () => {
  const { createVoiceForm, toVoicePayload } = await load();
  // 能力未知时载荷不带 capabilities，让后端沿用同地址已保存的声明。
  const base = { ...createVoiceForm(referenceConfig), capabilities: null };

  assert.deepEqual(toVoicePayload({ ...base, sourceKind: "preset", voiceId: " voice-b " }), {
    baseUrl: "http://127.0.0.1:8000",
    protocol: "nowadays-tts-v1",
    language: "zh",
    speed: 1,
    emoAlpha: 0.8,
    voiceSource: { kind: "preset", voiceId: "voice-b" }
  });

  assert.deepEqual(toVoicePayload(base), {
    baseUrl: "http://127.0.0.1:8000",
    protocol: "nowadays-tts-v1",
    language: "zh",
    speed: 1,
    emoAlpha: 0.8,
    voiceSource: { kind: "reference", referenceAssetId: "asset-1", referenceMode: "same_language", referenceText: null }
  });

  const legacy = toVoicePayload({ ...base, protocol: "indextts", referenceMode: "same_language", referenceText: "示例" });
  assert.equal(legacy.voiceSource.referenceMode, null, "旧协议不接受参考模式");
  assert.equal(legacy.voiceSource.referenceText, null, "旧协议不接受参考文本");

  // 探测到的能力声明随请求提交：后端据此拒绝不支持的来源，并随配置保存下来。
  assert.deepEqual(toVoicePayload(createVoiceForm(referenceConfig)).capabilities, capabilities);
  assert.equal("capabilities" in toVoicePayload(base), false, "能力未知时不提交该字段");
});

test("地址改回原服务后，请求与校验用同一份能力声明", async () => {
  const { createVoiceForm, withVoiceService, resolveCapabilities, toVoicePayload, normalizeBaseUrl } =
    await load();
  const form = createVoiceForm(referenceConfig);
  const probe = {
    protocol: "nowadays-tts-v1",
    service: "probe-svc",
    model: "m",
    ready: true,
    capabilities,
    voices: []
  };
  const probeSource = { baseUrl: normalizeBaseUrl(form.baseUrl), protocol: form.protocol };

  // 先改到别的地址再改回来：表单里的声明已被清空，但探测结果仍属于原地址。
  const away = withVoiceService(form, { baseUrl: "http://127.0.0.1:9000" });
  const back = withVoiceService(away, { baseUrl: form.baseUrl });
  assert.equal(back.capabilities, null, "来回改地址后表单里的声明仍是空的");

  const resolved = resolveCapabilities({ config: referenceConfig, form: back, probe, probeSource });
  assert.deepEqual(resolved, capabilities, "改回原地址后重新采用该地址的探测结果");

  const payload = toVoicePayload({ ...back, referenceMode: "same_language" }, { capabilities: resolved });
  assert.deepEqual(payload.capabilities, capabilities, "请求必须带上展示与校验所用的声明");

  // 没有有效声明时仍然不带该字段，让后端沿用同地址已保存的声明。
  assert.equal("capabilities" in toVoicePayload(back, { capabilities: null }), false);
});

test("地址校验与后端一致：空、非 HTTP、带账号、带查询串", async () => {
  const { createVoiceForm, validateVoiceForm } = await load();
  const base = { ...createVoiceForm(referenceConfig), sourceKind: "preset", voiceId: "v" };
  const codes = (baseUrl) => validateVoiceForm({ ...base, baseUrl }).map((item) => item.code);

  assert.deepEqual(codes(""), ["BASE_URL_REQUIRED"]);
  assert.deepEqual(codes("ftp://127.0.0.1"), ["BASE_URL_INVALID"]);
  assert.deepEqual(codes("http://user:pw@127.0.0.1:8000"), ["BASE_URL_INVALID"]);
  assert.deepEqual(codes("http://127.0.0.1:8000/?a=1"), ["BASE_URL_INVALID"]);
  assert.deepEqual(codes("http://127.0.0.1:8000"), []);
});

test("音色来源缺项分别报预置音色与参考音频", async () => {
  const { createVoiceForm, validateVoiceForm } = await load();
  const base = createVoiceForm(referenceConfig);

  const preset = validateVoiceForm({ ...base, sourceKind: "preset", voiceId: "  " });
  assert.deepEqual(preset.map((item) => item.code), ["VOICE_ID_REQUIRED"]);

  const reference = validateVoiceForm({ ...base, referenceAssetId: "" });
  assert.deepEqual(reference.map((item) => item.code), ["REFERENCE_REQUIRED"]);

  const legacy = validateVoiceForm({ ...base, protocol: "indextts", referenceAssetId: "" });
  assert.deepEqual(legacy.map((item) => item.code), ["REFERENCE_REQUIRED"]);
});

test("按探测声明的能力校验语速、语言与参考模式", async () => {
  const { createVoiceForm, validateVoiceForm } = await load();
  const base = createVoiceForm(referenceConfig);

  assert.deepEqual(validateVoiceForm({ ...base, speed: 3 }).map((item) => item.code), ["SPEED_OUT_OF_RANGE"]);
  assert.deepEqual(validateVoiceForm({ ...base, language: "fr" }).map((item) => item.code), ["LANGUAGE_UNSUPPORTED"]);
  assert.deepEqual(validateVoiceForm({ ...base, referenceMode: "" }).map((item) => item.code), ["REFERENCE_MODE_REQUIRED"]);
  assert.deepEqual(
    validateVoiceForm({ ...base, referenceMode: "cross_language", referenceText: "  " }).map((item) => item.code),
    ["REFERENCE_TEXT_REQUIRED"]
  );
  assert.deepEqual(validateVoiceForm({ ...base, referenceMode: "cross_language", referenceText: "示例" }), []);
});

test("未探测时跳过能力校验，不因缺少声明挡住保存", async () => {
  const { createVoiceForm, validateVoiceForm } = await load();
  const form = { ...createVoiceForm(referenceConfig), capabilities: null, speed: 5, language: "fr", referenceMode: "" };
  assert.deepEqual(validateVoiceForm(form), []);
});

test("服务明确不支持某种音色来源时拒绝保存，与能力未知区分开", async () => {
  const { createVoiceForm, validateVoiceForm } = await load();
  const base = createVoiceForm(referenceConfig);

  assert.deepEqual(
    validateVoiceForm(base, { capabilities: { ...capabilities, referenceModes: [] } }).map((item) => item.code),
    ["REFERENCE_UNSUPPORTED"],
    "已知不支持参考音频时不能提交参考音频音色"
  );

  assert.deepEqual(
    validateVoiceForm(
      { ...base, sourceKind: "preset", voiceId: "voice-a" },
      { capabilities: { ...capabilities, presetVoices: false } }
    ).map((item) => item.code),
    ["PRESET_UNSUPPORTED"],
    "已知不支持预置音色时不能提交预置音色"
  );

  // 同一份表单，能力未知时不能当成「不支持」。
  assert.deepEqual(validateVoiceForm({ ...base, capabilities: null }), []);
});

test("旧协议不做参考模式与预置音色校验", async () => {
  const { createVoiceForm, validateVoiceForm } = await load();
  const form = {
    ...createVoiceForm(referenceConfig),
    protocol: "indextts",
    sourceKind: "preset",
    voiceId: "",
    referenceAssetId: "asset-1",
    referenceMode: ""
  };
  assert.deepEqual(validateVoiceForm(form), [], "旧协议即使表单停留在预置音色也按参考音频校验");
});

test("探测摘要保留展示需要的字段", async () => {
  const { summarizeProbe } = await load();
  const summary = summarizeProbe({
    protocol: "nowadays-tts-v1",
    service: "indextts-http",
    model: "v2",
    ready: true,
    capabilities,
    voices: [{ id: "a", label: "A" }, { id: "b", label: "B" }]
  });
  assert.equal(summary.service, "indextts-http");
  assert.equal(summary.ready, true);
  assert.equal(summary.presetVoiceCount, 2);
  assert.equal(summary.supportsPreset, true);
  assert.deepEqual(summary.speed, { min: 0.5, max: 2 });
  assert.equal(summarizeProbe(null), null);
});

test("预置音色是否仍在上架列表里", async () => {
  const { isPresetVoiceAvailable } = await load();
  assert.equal(isPresetVoiceAvailable([{ id: "a" }], "a"), true);
  assert.equal(isPresetVoiceAvailable([{ id: "a" }], "b"), false, "下架后返回 false 供页面提示");
  assert.equal(isPresetVoiceAvailable(null, "a"), null, "未探测时状态未知");
  assert.equal(isPresetVoiceAvailable([{ id: "a" }], "  "), null);
});

test("错误码翻译成配置页可读的提示", async () => {
  const { describeVoiceFailure } = await load();
  assert.match(describeVoiceFailure({ code: "TTS_VOICE_UNAVAILABLE" }), /下架/);
  assert.match(describeVoiceFailure({ code: "VOICE_REFERENCE_IN_USE" }), /正在使用/);
  assert.match(describeVoiceFailure({ code: "VOICE_REFERENCE_NOT_FOUND" }), /重新上传/);
  assert.match(describeVoiceFailure({ code: "TTS_SYNTHESIS_FAILED", message: "上游 500" }), /合成失败.*上游 500/);
  assert.equal(describeVoiceFailure({ code: "SOMETHING_ELSE", message: "自定义提示" }), "自定义提示");
  assert.equal(describeVoiceFailure({}), "请求失败，请稍后重试。");
});

test("面板摘要说明当前保存的音色", async () => {
  const { describeVoiceSummary } = await load();
  assert.match(describeVoiceSummary(null), /还没有保存/);
  assert.match(describeVoiceSummary(referenceConfig), /参考音频 sample\.wav/);
  assert.match(
    describeVoiceSummary({ ...referenceConfig, voiceSource: { kind: "preset", voiceId: "voice-a" }, reference: null }),
    /预置音色 voice-a/
  );
  assert.match(describeVoiceSummary({ ...referenceConfig, reference: null }), /参考音频缺失/);
});

test("旧协议提示由试听验证连接", async () => {
  const { createVoiceForm, describeProtocolHint } = await load();
  const base = createVoiceForm(referenceConfig);
  assert.match(describeProtocolHint({ ...base, protocol: "indextts" }), /试听/);
  assert.match(describeProtocolHint(base), /探测/);
});

test("更换参考录音时清空上一段录音的参考文本", async () => {
  const { createVoiceForm, withReferenceAudio, toVoicePayload } = await load();
  const form = {
    ...createVoiceForm(referenceConfig),
    referenceMode: "cross_language",
    referenceText: "上一段录音的原文"
  };

  const switched = withReferenceAudio(form, "asset-2");
  assert.equal(switched.referenceAssetId, "asset-2");
  assert.equal(switched.referenceText, "", "新录音不能沿用旧原文");
  assert.equal(toVoicePayload(switched).voiceSource.referenceText, null);

  assert.equal(withReferenceAudio(form, "asset-1"), form, "选择同一段录音不清空已填文本");
});

test("没有参考录音时不提交孤立参考文本", async () => {
  const { createVoiceForm, toVoicePayload } = await load();
  const payload = toVoicePayload({
    ...createVoiceForm(referenceConfig),
    referenceAssetId: "",
    referenceMode: "cross_language",
    referenceText: "没有对应录音的原文"
  });
  assert.equal(payload.voiceSource.referenceAssetId, null);
  assert.equal(payload.voiceSource.referenceText, null);
});

test("显式传入无能力时不再回落到表单里的旧声明", async () => {
  const { createVoiceForm, validateVoiceForm } = await load();
  const form = { ...createVoiceForm(referenceConfig), speed: 5, language: "fr", referenceMode: "" };
  assert.deepEqual(
    validateVoiceForm(form).map((item) => item.code),
    ["SPEED_OUT_OF_RANGE", "LANGUAGE_UNSUPPORTED", "REFERENCE_MODE_REQUIRED"],
    "默认沿用表单里的声明"
  );
  assert.deepEqual(
    validateVoiceForm(form, { capabilities: null }),
    [],
    "地址换了以后旧声明不再适用，应跳过能力校验"
  );
});

test("探测结果只在地址与协议都没变时有效", async () => {
  const { createVoiceForm, isProbeCurrent, normalizeBaseUrl } = await load();
  const form = createVoiceForm(referenceConfig);
  const source = { baseUrl: normalizeBaseUrl(form.baseUrl), protocol: form.protocol };

  assert.equal(isProbeCurrent(source, form), true);
  assert.equal(isProbeCurrent(source, { ...form, baseUrl: "http://127.0.0.1:8001" }), false, "换地址后旧探测失效");
  assert.equal(isProbeCurrent(source, { ...form, protocol: "indextts" }), false, "换协议后旧探测失效");
  assert.equal(isProbeCurrent(null, form), false);
  assert.equal(isProbeCurrent(source, { ...form, baseUrl: "http://127.0.0.1:8000/" }), true, "末尾斜杠不算改动");
});

test("能力声明优先当前地址的探测，其次已保存配置", async () => {
  const { createVoiceForm, resolveCapabilities, normalizeBaseUrl } = await load();
  const form = createVoiceForm(referenceConfig);
  const probe = {
    protocol: "nowadays-tts-v1",
    service: "probe-svc",
    model: "m",
    ready: true,
    capabilities: { ...capabilities, speed: { min: 0.8, max: 1.2 } },
    voices: null
  };
  const probeSource = { baseUrl: normalizeBaseUrl(form.baseUrl), protocol: form.protocol };

  assert.deepEqual(
    resolveCapabilities({ config: referenceConfig, form, probe: null, probeSource: null }),
    capabilities,
    "没有探测时用已保存配置的声明"
  );

  assert.deepEqual(
    resolveCapabilities({ config: referenceConfig, form, probe, probeSource }),
    probe.capabilities,
    "同一地址刚探测过时以探测为准，已保存声明不能挡住最新结果"
  );

  // 换服务后保存的配置没有能力声明，此时探测结果必须生效，否则模式选择器不出现。
  const savedWithoutCapabilities = { ...referenceConfig, capabilities: null };
  assert.deepEqual(
    resolveCapabilities({ config: savedWithoutCapabilities, form, probe, probeSource }),
    probe.capabilities,
    "已保存声明为空时仍用当前探测结果"
  );

  const probeWithoutCapabilities = { ...probe, capabilities: null };
  assert.deepEqual(
    resolveCapabilities({ config: referenceConfig, form, probe: probeWithoutCapabilities, probeSource }),
    capabilities,
    "探测没有带回声明时回落到已保存配置"
  );

  const moved = { ...form, baseUrl: "http://127.0.0.1:8001" };
  assert.deepEqual(
    resolveCapabilities({
      config: referenceConfig,
      form: moved,
      probe,
      probeSource: { ...probeSource, baseUrl: "http://127.0.0.1:8001" }
    }),
    probe.capabilities,
    "换地址后用新地址的探测声明"
  );

  assert.equal(
    resolveCapabilities({ config: referenceConfig, form: moved, probe, probeSource }),
    null,
    "探测来源仍是旧地址、配置也不匹配时不采用，宁可跳过能力校验"
  );
});

test("换服务后预置音色与参考模式失效，参考音频保留", async () => {
  const { createVoiceForm, withVoiceService, toVoicePayload } = await load();
  const form = {
    ...createVoiceForm(referenceConfig),
    sourceKind: "preset",
    voiceId: "voice-a",
    referenceMode: "same_language",
    referenceAssetId: "asset-1",
    referenceText: "原文"
  };

  const moved = withVoiceService(form, { baseUrl: "http://127.0.0.1:8001" });
  assert.equal(moved.voiceId, "", "换地址后旧音色不能继续随新地址提交");
  assert.equal(moved.referenceMode, "", "旧服务的参考模式同样失效，新服务未必支持");
  assert.equal(moved.capabilities, null, "旧服务的能力声明同时失效");
  assert.equal(moved.referenceAssetId, "asset-1", "参考音频是本地素材，换服务不受影响");
  assert.equal(moved.referenceText, "原文", "参考文本只随录音变化清理");

  // 不探测新服务直接保存时，载荷不能把旧模式带过去。
  const payload = toVoicePayload({ ...moved, sourceKind: "reference" });
  assert.equal(payload.voiceSource.kind, "reference");
  assert.equal(payload.voiceSource.referenceMode, null, "换服务后未重选模式，提交 null 而不是旧模式");
  assert.equal(payload.voiceSource.referenceAssetId, "asset-1", "录音照常提交");

  const changedPath = withVoiceService(form, { baseUrl: "http://127.0.0.1:8000/v2" });
  assert.equal(changedPath.voiceId, "", "地址变了就清空，同站点换路径也不例外");
  assert.equal(changedPath.referenceMode, "", "同站点换路径也清空参考模式");

  const trailing = withVoiceService(form, { baseUrl: "http://127.0.0.1:8000/" });
  assert.equal(trailing.voiceId, "voice-a", "只差末尾斜杠不算换服务");
  assert.equal(trailing.referenceMode, "same_language", "只差末尾斜杠保留参考模式");

  const protocol = withVoiceService(form, { protocol: "indextts" });
  assert.equal(protocol.voiceId, "", "换协议同样清空音色");
  assert.equal(protocol.referenceMode, "", "换协议同样清空参考模式");

  const renamed = withVoiceService(form, { speed: 1.2 });
  assert.equal(renamed.voiceId, "voice-a", "改其他字段不影响音色");
  assert.equal(renamed.referenceMode, "same_language", "改其他字段不影响参考模式");
  assert.deepEqual(renamed.capabilities, capabilities, "改其他字段不动能力声明");
});
