"use strict";

// 模型名称候选过滤与测试文案。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(
    pathToFileURL(
      path.join(__dirname, "../renderer/src/components/model/model-picker.js")
    ).href
  );

test("模型候选按输入过滤、去重并保留手填", async () => {
  const { filterModelNames } = await load();
  const models = ["gpt-a", "gpt-b", "claude-x", "gpt-a", 42, ""];
  assert.deepEqual(filterModelNames(models, ""), ["gpt-a", "gpt-b", "claude-x"]);
  assert.deepEqual(filterModelNames(models, "GPT"), ["gpt-a", "gpt-b"]);
  assert.deepEqual(filterModelNames(models, "claude"), ["claude-x"]);
  assert.deepEqual(filterModelNames(models, "missing"), []);
  assert.deepEqual(filterModelNames(undefined, "x"), []);
});

test("测试结果文案区分成功与失败", async () => {
  const { modelTestNote } = await load();
  assert.equal(modelTestNote(null), "");
  assert.equal(modelTestNote({ ok: true, elapsedMs: 12.4 }), "测试通过 · 12 ms");
  assert.equal(
    modelTestNote({ ok: false, error: { message: "模型返回 401" } }),
    "测试失败：模型返回 401"
  );
});

test("切换接口协议时自动补齐 Gemini 请求路径并保留自定义地址", async () => {
  const {
    GOOGLE_GEMINI_DEFAULT_BASE_URL,
    defaultModelBaseUrl,
    resolveModelBaseUrlOnProtocolChange,
  } = await load();

  assert.equal(defaultModelBaseUrl("google-gemini"), GOOGLE_GEMINI_DEFAULT_BASE_URL);
  assert.equal(defaultModelBaseUrl("openai-chat"), "");

  // 空地址切到 google-gemini 自动补齐默认路径
  assert.equal(
    resolveModelBaseUrlOnProtocolChange("", "google-gemini"),
    GOOGLE_GEMINI_DEFAULT_BASE_URL
  );
  assert.equal(
    resolveModelBaseUrlOnProtocolChange("   ", "google-gemini"),
    GOOGLE_GEMINI_DEFAULT_BASE_URL
  );

  // 未改过的默认 Gemini 路径切回其他协议时自动清空
  assert.equal(
    resolveModelBaseUrlOnProtocolChange(GOOGLE_GEMINI_DEFAULT_BASE_URL, "openai-chat"),
    ""
  );

  // 用户手填的自定义地址或 AI Studio 地址在任何切换下都不覆盖
  assert.equal(
    resolveModelBaseUrlOnProtocolChange("https://generativelanguage.googleapis.com/v1beta", "openai-chat"),
    "https://generativelanguage.googleapis.com/v1beta"
  );
  assert.equal(
    resolveModelBaseUrlOnProtocolChange("http://127.0.0.1:8000", "google-gemini"),
    "http://127.0.0.1:8000"
  );
});

test("点击日志按来源相互覆盖，并在更换未测模型名后隐藏旧测试结果", async () => {
  const { visibleProbeNotice } = await load();

  const listNotice = { source: "list", role: "status", text: "已读取 3 个模型" };
  assert.deepEqual(visibleProbeNotice(listNotice, ""), listNotice);
  assert.deepEqual(visibleProbeNotice(listNotice, "gemini-2.5-flash"), listNotice);

  const testNotice = { source: "test", role: "status", text: "测试通过 · 12 ms", model: "gemini-2.5-flash" };
  assert.deepEqual(visibleProbeNotice(testNotice, " gemini-2.5-flash "), testNotice);
  assert.equal(visibleProbeNotice(testNotice, "gemini-2.5-pro"), null);
  assert.equal(visibleProbeNotice(null, "gemini-2.5-flash"), null);
});

test("模型密钥文本框草稿正确处理掩码、清空、替换、显隐与保存意图", async () => {
  const {
    SECRET_MASK_SENTINEL,
    createSecretDraft,
    nextSecretDraftOnInput,
    applyRevealedSecret,
    hideUneditedSecret,
    secretOperationOf,
  } = await load();

  // 无已存密钥
  let emptyDraft = createSecretDraft("missing");
  assert.equal(emptyDraft.hasExisting, false);
  assert.equal(emptyDraft.value, "");
  assert.deepEqual(secretOperationOf(emptyDraft), { action: "keep" });

  emptyDraft = nextSecretDraftOnInput(emptyDraft, "sk-created");
  assert.deepEqual(secretOperationOf(emptyDraft), { action: "replace", secret: "sk-created" });
  emptyDraft = nextSecretDraftOnInput(emptyDraft, "");
  assert.deepEqual(secretOperationOf(emptyDraft), { action: "keep" });

  // 已有保存的密钥：默认掩码保留
  const stored = createSecretDraft("stored");
  assert.equal(stored.hasExisting, true);
  assert.equal(stored.value, SECRET_MASK_SENTINEL);
  assert.deepEqual(secretOperationOf(stored), { action: "keep" });

  // 退格删掉一位掩码视作用户清空密钥
  const backspaced = nextSecretDraftOnInput(stored, SECRET_MASK_SENTINEL.slice(0, -1));
  assert.equal(backspaced.value, "");
  assert.deepEqual(secretOperationOf(backspaced), { action: "clear" });

  // 未选全即在末尾粘贴新密钥时自动剥离掩码前缀
  const pastedAtEnd = nextSecretDraftOnInput(stored, `${SECRET_MASK_SENTINEL}sk-pasted`);
  assert.equal(pastedAtEnd.value, "sk-pasted");
  assert.deepEqual(secretOperationOf(pastedAtEnd), { action: "replace", secret: "sk-pasted" });

  // 点击显示拿到原文：未改时仍为 keep；改写后为 replace；改回原文恢复 keep；隐藏未改状态切回掩码
  let revealed = applyRevealedSecret(stored, "sk-original");
  assert.equal(revealed.value, "sk-original");
  assert.deepEqual(secretOperationOf(revealed), { action: "keep" });

  const hiddenAgain = hideUneditedSecret(revealed);
  assert.equal(hiddenAgain.value, SECRET_MASK_SENTINEL);
  assert.equal(hiddenAgain.baselineSecret, null);
  assert.deepEqual(secretOperationOf(hiddenAgain), { action: "keep" });

  revealed = applyRevealedSecret(stored, "sk-original");
  const edited = nextSecretDraftOnInput(revealed, "sk-new");
  assert.deepEqual(secretOperationOf(edited), { action: "replace", secret: "sk-new" });

  // 已开始编辑时隐藏，不丢失用户的未保存输入
  const hiddenWhileEdited = hideUneditedSecret(edited);
  assert.equal(hiddenWhileEdited.value, "sk-new");
  assert.deepEqual(secretOperationOf(hiddenWhileEdited), { action: "replace", secret: "sk-new" });

  const reverted = nextSecretDraftOnInput(edited, "sk-original");
  assert.deepEqual(secretOperationOf(reverted), { action: "keep" });

  const clearedAfterReveal = nextSecretDraftOnInput(revealed, "");
  assert.deepEqual(secretOperationOf(clearedAfterReveal), { action: "clear" });

  // 用户已编辑新密钥时迟到的显隐回包不覆盖用户输入
  const lateReveal = applyRevealedSecret(edited, "sk-original");
  assert.equal(lateReveal.value, "sk-new");
  assert.deepEqual(secretOperationOf(lateReveal), { action: "replace", secret: "sk-new" });
});
