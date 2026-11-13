"use strict";

// 真实窗口数据的视图映射测试。运行：在 desktop/desk-preview 下执行 node --test。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/conversation/window-model.js")).href);

const message = (overrides = {}) => ({
  messageId: "m1",
  windowId: "w1",
  sender: "assistant",
  content: "",
  sourcePlatform: "nowadays",
  status: "completed",
  sequence: 1,
  submissionId: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
  ...overrides
});

const segment = (ordinal, kind, text, overrides = {}) => ({
  segmentId: `m1-${ordinal}`,
  messageId: "m1",
  windowId: "w1",
  ordinal,
  kind,
  text,
  startOffset: 0,
  endOffset: text.length,
  outfitId: null,
  spriteAssetId: null,
  annotatedAt: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  ...overrides
});

test("用户消息一行，角色回复按句段展开且动作归旁白", async () => {
  const { rowsForMessage, createRowIdRegistry } = await load();
  const registry = createRowIdRegistry();

  const user = rowsForMessage(message({ messageId: "u1", sender: "user", content: "今天有点累" }), [], registry.id);
  assert.equal(user.length, 1);
  assert.equal(user[0].role, "user");
  assert.equal(user[0].text, "今天有点累");
  assert.equal(user[0].actionVisible, false);

  const rows = rowsForMessage(message(), [
    segment(0, "speech", "那就先不催自己了。"),
    segment(1, "narration", "她把杯子轻轻放下"),
    segment(2, "speech", "我陪你坐一会儿。")
  ], registry.id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].text, "那就先不催自己了。");
  assert.equal(rows[0].action, "");
  assert.equal(rows[1].actionVisible, true);
  assert.equal(rows[1].action, "她把杯子轻轻放下");
  assert.equal(rows[1].text, "");
  assert.equal(rows[2].text, "我陪你坐一会儿。");
  assert.ok(rows.every(row => row.role === "assistant"));
  assert.ok(rows.every(row => row.messageId === "m1"));
});

test("同一锚点稳定复用行标识；中断消息只有末段标「未说完」", async () => {
  const { rowsForMessage, createRowIdRegistry } = await load();
  const registry = createRowIdRegistry();
  const interrupted = message({ status: "interrupted" });
  const segments = [segment(0, "speech", "第一段"), segment(1, "speech", "没说完的部分")];
  const first = rowsForMessage(interrupted, segments, registry.id);
  const second = rowsForMessage(interrupted, segments, registry.id);
  assert.deepEqual(first.map(row => row.id), second.map(row => row.id), "重新构建不改变行标识");
  assert.equal(first[0].status, "completed");
  assert.equal(first[1].status, "interrupted");
});

test("没有句段的旧回复仍可阅读，但不会伪造语音锚点", async () => {
  const { rowsForMessage, createRowIdRegistry } = await load();
  const registry = createRowIdRegistry();
  const saved = message({ content: "保留下来的旧回复", status: "interrupted" });
  const rows = rowsForMessage(saved, [], registry.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, saved.content);
  assert.equal(rows[0].segmentId, "");
  assert.equal(rows[0].status, "interrupted");
  assert.equal(rowsForMessage(saved, [], registry.id)[0].id, rows[0].id);
  assert.equal(rowsForMessage(message({ content: "" }), [], registry.id).length, 0);
  assert.equal(rowsForMessage(message({ content: "生成中", status: "generating" }), [], registry.id).length, 0);
});

test("过场图缺少起止句段时不映射到其他句段", async () => {
  const { sceneView } = await load();
  const task = { taskId: "t", messageId: "m1", layerMode: "background", startSegmentId: "missing", endSegmentId: "m1-0", status: "succeeded", trigger: "manual", result: null };
  const view = sceneView(task, new Map([["m1", [segment(0, "speech", "文字")]]]), "role");
  assert.equal(view.start, -1);
  assert.equal(view.end, -1);
});

test("终态句段合并沿用原标识并保留晚到内容", async () => {
  const { mergeSegments } = await load();
  const partial = [segment(0, "speech", "第一段"), segment(1, "speech", "第二段")];
  const terminal = [
    segment(0, "speech", "第一段", { spriteAssetId: "sprite-a" }),
    segment(1, "speech", "第二段改写"),
    segment(2, "narration", "她停了一下")
  ];
  const merged = mergeSegments(partial, terminal);
  assert.deepEqual(merged.map(item => item.segmentId), ["m1-0", "m1-1", "m1-2"]);
  assert.equal(merged[0].spriteAssetId, "sprite-a");
  assert.equal(merged[1].text, "第二段改写");
  assert.equal(merged[2].kind, "narration");
  assert.equal(merged.length, 3);
});

test("终态列表替换临时句段并按位置保留阅读进度", async () => {
  const { reconcileFinalSegments } = await load();
  const temporary = [segment(0, "speech", "临时"), segment(1, "speech", "临时二")];
  const official = [segment(0, "speech", "正式", { segmentId: "official" })];
  const result = reconcileFinalSegments(temporary, official, 2);
  assert.deepEqual(result.segments.map(row => row.segmentId), ["official"]);
  assert.equal(result.shown, 1);
  const extra = reconcileFinalSegments(temporary.slice(0, 1), [...official, segment(1, "speech", "后续")], 1);
  assert.equal(extra.shown, 1);
  assert.equal(extra.segments.length, 2);
  assert.deepEqual(reconcileFinalSegments(temporary, [], 1), { segments: [], shown: 0 });
});

test("窗口快照中同一提交标识已入库时结束重试记录", async () => {
  const { isSubmissionConfirmed } = await load();
  assert.equal(
    isSubmissionConfirmed({ submissionId: "sub-1" }, [
      message({ sender: "user", content: "在吗", submissionId: "sub-1" })
    ]),
    true,
    "已入库的原提交不应继续复用标识"
  );
  assert.equal(
    isSubmissionConfirmed({ submissionId: "sub-1" }, [
      message({ sender: "user", content: "别的内容", submissionId: "sub-2" })
    ]),
    false,
    "尚未确认的提交仍保留去重保护"
  );
  assert.equal(isSubmissionConfirmed(null, [message()]), false);
});

test("快照确认时只清空未编辑过的恢复草稿", async () => {
  const { shouldClearRecoveredDraft } = await load();
  assert.equal(
    shouldClearRecoveredDraft({ value: "在吗", edited: false }, "在吗"),
    true,
    "未编辑的恢复草稿应清除"
  );
  assert.equal(
    shouldClearRecoveredDraft({ value: "在吗", edited: true }, "在吗"),
    false,
    "用户手动改成相同文本也算编辑，应保留"
  );
  assert.equal(
    shouldClearRecoveredDraft({ value: "别的内容", edited: false }, "在吗"),
    false
  );
  assert.equal(shouldClearRecoveredDraft(null, "在吗"), false);
});

test("晚到表情标注只更新目标句段", async () => {
  const { applySegmentAnnotations } = await load();
  const segments = [segment(0, "speech", "第一段"), segment(1, "speech", "第二段")];
  const updated = applySegmentAnnotations(segments, [
    { segmentId: "m1-1", outfitId: "outfit-a", spriteAssetId: "sprite-b" }
  ]);
  assert.equal(updated[0], segments[0], "未命中的句段保持原引用");
  assert.equal(updated[1].spriteAssetId, "sprite-b");
  assert.equal(updated[1].outfitId, "outfit-a");
  assert.ok(updated[1].annotatedAt);
});

test("回看句段的服饰和差分只取该句之前的同轮数据", async () => {
  const { rowsForMessage, createRowIdRegistry, spriteForRow } = await load();
  const registry = createRowIdRegistry();
  const rows = rowsForMessage(message(), [
    segment(0, "speech", "第一段", { outfitId: "old-outfit", spriteAssetId: "first" }),
    segment(1, "speech", "第二段", { outfitId: "old-outfit", spriteAssetId: null }),
    segment(2, "speech", "第三段", { outfitId: "old-outfit", spriteAssetId: "later" })
  ], registry.id);
  assert.equal(rows[1].outfitId, "old-outfit");
  assert.equal(spriteForRow(rows, rows[1]), "first");
  assert.equal(spriteForRow(rows, rows[2]), "later");
});

test("历史立绘按句段素材快照回放，换服饰不沿用旧差分", async () => {
  const { rowsForMessage, createRowIdRegistry, spriteForRow, applySegmentAnnotations } = await load();
  const segments = [
    segment(0, "speech", "过去", { outfitId: "old", homeAssetId: "old-home", spriteAssetId: "old-sprite" }),
    segment(1, "speech", "后来", { outfitId: "new", homeAssetId: "new-home" }),
    segment(2, "speech", "没有服饰", { outfitId: null, homeAssetId: null })
  ];
  const rows = rowsForMessage(message(), segments, createRowIdRegistry().id);
  assert.equal(rows[0].homeAssetId, "old-home");
  assert.equal(rows[1].homeAssetId, "new-home");
  assert.equal(rows[2].homeAssetId, null);
  assert.equal(spriteForRow(rows, rows[1]), null);
  const updated = applySegmentAnnotations(segments, [{ segmentId: "m1-1", homeAssetId: "snapshot-home" }]);
  assert.equal(updated[1].homeAssetId, "snapshot-home");
});

test("过场图任务映射到同轮句段区间与素材地址", async () => {
  const { sceneView, groupSegments } = await load();
  const segments = [
    segment(0, "speech", "开场"),
    segment(1, "narration", "动作"),
    segment(2, "speech", "收束")
  ];
  const grouped = groupSegments(segments);
  const base = {
    taskId: "t1",
    roleId: "r1",
    windowId: "w1",
    messageId: "m1",
    executionId: "e1",
    trigger: "manual",
    layerMode: "background",
    startSegmentId: "m1-0",
    endSegmentId: "m1-2",
    status: "succeeded",
    attempt: 1,
    plan: null,
    errorCode: null,
    errorSummary: null,
    result: { assetId: "a1", mediaType: "image/png", width: 1024, height: 576, byteSize: 1024, createdAt: "2026-11-09T10:00:00.000Z" },
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-09T10:00:00.000Z"
  };
  const succeeded = sceneView(base, grouped, "r1");
  assert.equal(succeeded.start, 0);
  assert.equal(succeeded.end, 2);
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.assetUrl, "/v1/roles/r1/scene-images/assets/a1");
  assert.equal(succeeded.source, "manual");

  const generating = sceneView({ ...base, status: "generating", result: null, trigger: "auto" }, grouped, "r1");
  assert.equal(generating.status, "generating");
  assert.equal(generating.source, "auto");
  assert.equal(generating.assetUrl, null);

  const skipped = sceneView({ ...base, status: "skipped", result: null }, grouped, "r1");
  assert.equal(skipped.status, "failed");
  assert.equal(skipped.taskStatus, "skipped");

  const missing = sceneView({ ...base, startSegmentId: "unknown", endSegmentId: "unknown", status: "failed" }, grouped, "r1");
  assert.equal(missing.start, -1);
  assert.equal(missing.end, -1);
});

test("迟到的旧任务快照不会覆盖已完成的过场图", async () => {
  const { newerSceneTask } = await load();
  const done = { status: "succeeded", attempt: 1, updatedAt: "2026-11-09T10:01:00Z" };
  const stale = { status: "generating", attempt: 1, updatedAt: "2026-11-09T10:00:00Z" };
  assert.equal(newerSceneTask(done, stale), done);
  assert.equal(newerSceneTask(stale, done), done);
  const retry = { status: "queued", attempt: 2, updatedAt: "2026-11-09T10:02:00Z" };
  assert.equal(newerSceneTask(done, retry), retry);
  assert.equal(newerSceneTask(retry, done), retry);
});
