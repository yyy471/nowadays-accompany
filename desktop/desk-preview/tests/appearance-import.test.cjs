"use strict";

// 角色素材目录识别与导入计划的纯逻辑测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/appearance-import.js")).href);

const image = (relativePath) => ({
  relativePath,
  file: { name: relativePath.split("/").pop() }
});

const byId = (entries, id) => entries.find((entry) => entry.id === id);
const reasonsFor = (skipped) => skipped.map((item) => item.reason).sort();

test("千叶：识别 standees 与 expressions，按同名配对，跳过 outfits 锚点", async () => {
  const { scanAppearanceFolder } = await load();
  const result = scanAppearanceFolder([
    image("千叶诗织/standees/02_classic/qysz_02_classic_main.png"),
    image("千叶诗织/expressions/02_classic/happy.png"),
    image("千叶诗织/expressions/02_classic/listen.png"),
    image("千叶诗织/standees/06_white_knit_barelegs/main.png"),
    image("千叶诗织/expressions/06_white_knit/happy.png"),
    image("千叶诗织/standees/01_white_knit_stockings/main.png"),
    image("千叶诗织/outfits/02_classic/anchor.png")
  ]);

  assert.equal(result.format, "standees");
  assert.equal(result.root, "千叶诗织");
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["01_white_knit_stockings", "02_classic", "06_white_knit", "06_white_knit_barelegs"],
    "同名目录合成一套，不同名的立绘与差分目录各算一套"
  );

  const classic = byId(result.entries, "02_classic");
  assert.equal(classic.home.name, "qysz_02_classic_main.png");
  assert.deepEqual(classic.sprites.map((file) => file.name), ["happy.png", "listen.png"]);
  assert.equal(classic.standeeDir, "02_classic");
  assert.equal(classic.expressionDir, "02_classic");

  assert.deepEqual(reasonsFor(result.skipped), ["OUTFITS_SKIPPED"], "outfits 里的锚点图不进预览");
  const anchorNames = result.entries.flatMap((entry) => [
    ...entry.homeCandidates.map((file) => file.name),
    ...entry.sprites.map((file) => file.name)
  ]);
  assert.ok(!anchorNames.includes("anchor.png"));
});

test("千叶：编号唯一且服饰目录前缀一致时预先归并，可撤销", async () => {
  const { scanAppearanceFolder, mergeOutfitEntries } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/standees/06_white_knit_barelegs/main.png"),
    image("千叶诗织/expressions/06_white_knit/happy.png"),
    image("千叶诗织/expressions/06_white_knit/握手.webp")
  ]);

  assert.equal(scan.entries.length, 2, "归并前是两个只含单边素材的条目");
  assert.deepEqual(scan.suggestedMerges, { "06_white_knit": "06_white_knit_barelegs" });
  const merged = mergeOutfitEntries(scan.entries, scan.suggestedMerges);
  assert.equal(merged.length, 1);
  const outfit = merged[0];
  assert.equal(outfit.id, "06_white_knit_barelegs");
  assert.equal(outfit.home.name, "main.png");
  assert.deepEqual(outfit.sprites.map((file) => file.name).sort(), ["happy.png", "握手.webp"]);
  assert.deepEqual(outfit.mergedFrom, ["06_white_knit"]);
  assert.deepEqual(mergeOutfitEntries(scan.entries, {}).map((entry) => entry.id), [
    "06_white_knit", "06_white_knit_barelegs"
  ]);
});

test("编号有歧义或只是编号相同时保留各服饰", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/standees/06_white_knit_barelegs/main.png"),
    image("千叶诗织/standees/06_white_knit_stockings/main.png"),
    image("千叶诗织/expressions/06_white_knit/握手.png"),
    image("千叶诗织/standees/08_dress/main.png"),
    image("千叶诗织/expressions/08_coat/握手.png")
  ]);
  assert.deepEqual(scan.suggestedMerges, {});
  assert.equal(scan.entries.length, 5);
});

test("现代格式只扫描角色直属的 standees 和 expressions", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/backup/expressions/旧衣/旧图.png"),
    image("千叶诗织/outfits/standees/锚点/main.png"),
    image("千叶诗织/qysz_anchor_v3.png"),
    image("千叶诗织/standees/02_classic/main.png"),
    image("千叶诗织/expressions/02_classic/自定义名字.jpg")
  ]);
  assert.deepEqual(scan.issues, []);
  assert.deepEqual(scan.entries.map((entry) => entry.id), ["02_classic"]);
  assert.equal(scan.entries[0].sprites[0].name, "自定义名字.jpg");
  assert.deepEqual(reasonsFor(scan.skipped), ["OUTFITS_SKIPPED", "OUTSIDE_SOURCE", "OUTSIDE_SOURCE"]);
  assert.equal(scanAppearanceFolder([image("千叶诗织/backup/expressions/旧衣/旧图.png")]).format, "none");
});

test("归并保留目标原有主页图，来源主页图只作为候选补充", async () => {
  const { scanAppearanceFolder, mergeOutfitEntries } = await load();
  const scan = scanAppearanceFolder([
    image("樱/standees/initial_white_dress/keep.png"),
    image("樱/standees/initial_white_dress/extra.png")
  ]);
  const merged = mergeOutfitEntries(scan.entries, {});
  assert.equal(merged[0].home.name, "extra.png", "多张候选按文件名排序取第一张");
  assert.equal(merged[0].homeCandidates.length, 2);
});

test("樱：两套只有主页立绘，说明文件跳过且不阻塞导入", async () => {
  const { scanAppearanceFolder, planOutfitImport } = await load();
  const scan = scanAppearanceFolder([
    image("樱/standees/idol_sweet_white_thighhigh/main.png"),
    image("樱/standees/initial_white_dress/main.png"),
    image("樱/expressions/idol_sweet_white_thighhigh/manifest.md"),
    image("樱/expressions/initial_white_dress/表情清单.md")
  ]);

  assert.deepEqual(
    scan.entries.map((entry) => entry.id),
    ["idol_sweet_white_thighhigh", "initial_white_dress"]
  );
  assert.deepEqual(reasonsFor(scan.skipped), ["DOCUMENT", "DOCUMENT"]);

  const plans = planOutfitImport(scan.entries, { existingNames: [] });
  for (const plan of plans) {
    assert.equal(plan.status, "ready", "缺差分不影响先导入主页图");
    assert.equal(plan.missingHome, false);
    assert.equal(plan.missingSprites, true);
    assert.match(plan.notes.join(" "), /没有对话差分/);
  }
});

test("旧格式：outfits/<服饰名>/home.* 与 sprites/ 继续可用", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/outfits/黑白长裙/home.png"),
    image("千叶诗织/outfits/黑白长裙/sprites/happy.png"),
    image("千叶诗织/outfits/黑白长裙/sprites/listen.png"),
    image("千叶诗织/outfits/黑白长裙/notes.md")
  ]);

  assert.equal(scan.format, "legacy");
  assert.equal(scan.entries.length, 1);
  const outfit = scan.entries[0];
  assert.equal(outfit.name, "黑白长裙");
  assert.equal(outfit.source, "legacy");
  assert.equal(outfit.home.name, "home.png");
  assert.deepEqual(outfit.sprites.map((file) => file.name), ["happy.png", "listen.png"]);
  assert.deepEqual(reasonsFor(scan.skipped), ["DOCUMENT"]);
});

test("新旧格式并存时按新格式处理，旧 outfits 目录整体跳过", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/standees/02_classic/main.png"),
    image("千叶诗织/outfits/黑白长裙/home.png"),
    image("千叶诗织/outfits/黑白长裙/sprites/happy.png")
  ]);

  assert.equal(scan.format, "standees");
  assert.deepEqual(scan.entries.map((entry) => entry.id), ["02_classic"]);
  assert.deepEqual(reasonsFor(scan.skipped), ["OUTFITS_SKIPPED", "OUTFITS_SKIPPED"]);
});

test("同一服饰有多张主页立绘候选时提示由用户指定", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/standees/02_classic/b.png"),
    image("千叶诗织/standees/02_classic/a.png")
  ]);

  const outfit = scan.entries[0];
  assert.deepEqual(outfit.homeCandidates.map((file) => file.name), ["a.png", "b.png"]);
  assert.equal(outfit.home.name, "a.png");
  assert.deepEqual(scan.issues, [{ code: "MULTIPLE_HOME_CANDIDATES", id: "02_classic" }]);
});

test("嵌套的差分目录按文件名登记，隐藏文件跳过", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/expressions/02_classic/眨眼/happy.png"),
    image("千叶诗织/.DS_Store"),
    image("千叶诗织/standees/02_classic/.gitkeep")
  ]);

  const outfit = scan.entries[0];
  assert.deepEqual(outfit.sprites.map((file) => file.name), ["happy.png"]);
  assert.equal(outfit.home, null);
  assert.deepEqual(reasonsFor(scan.skipped), ["HIDDEN", "HIDDEN"]);
});

test("导入计划标出重名与缺项，并汇总套数与差分数量", async () => {
  const { scanAppearanceFolder, planOutfitImport, summarizeOutfitPlan } = await load();
  const scan = scanAppearanceFolder([
    image("千叶诗织/standees/02_classic/main.png"),
    image("千叶诗织/expressions/02_classic/happy.png"),
    image("千叶诗织/standees/01_white_knit_stockings/main.png"),
    image("千叶诗织/expressions/03_new/new.png")
  ]);

  const plans = planOutfitImport(scan.entries, { existingNames: ["02_classic"] });
  const classic = plans.find((plan) => plan.id === "02_classic");
  assert.equal(classic.status, "duplicate");
  assert.match(classic.notes.join(" "), /已存在同名服饰/);

  const stockings = plans.find((plan) => plan.id === "01_white_knit_stockings");
  assert.equal(stockings.status, "ready");
  assert.equal(stockings.missingSprites, true);

  const onlySprites = plans.find((plan) => plan.id === "03_new");
  assert.equal(onlySprites.status, "ready");
  assert.equal(onlySprites.missingHome, true);

  assert.deepEqual(summarizeOutfitPlan(plans), {
    total: 3,
    ready: 2,
    duplicate: 1,
    missingHome: 1,
    missingSprites: 1,
    spriteCount: 2
  });
});

test("名称可改写，空名称回落到目录标识", async () => {
  const { scanAppearanceFolder, planOutfitImport } = await load();
  const scan = scanAppearanceFolder([image("樱/standees/initial_white_dress/main.png")]);
  const [renamed] = planOutfitImport([{ ...scan.entries[0], name: "  初雪白裙  " }], {});
  assert.equal(renamed.name, "初雪白裙");

  const [fallback] = planOutfitImport([{ ...scan.entries[0], name: "   " }], {});
  assert.equal(fallback.name, "initial_white_dress");
});

test("选择多个角色目录时给出提示，仍以第一个为根", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    image("角色A/standees/一套/a.png"),
    image("角色B/standees/另一套/b.png")
  ]);

  assert.equal(scan.issues[0].code, "MULTIPLE_ROOTS");
  assert.equal(scan.root, "角色A");
  assert.deepEqual(scan.entries.map((entry) => entry.id), ["一套"]);
  assert.deepEqual(reasonsFor(scan.skipped), ["OUTSIDE_SOURCE"]);
});

test("没有素材目录时明确报缺，而不是静默返回空列表", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([image("千叶诗织/readme.md"), image("千叶诗织/standees/")]);
  assert.equal(scan.format, "none");
  assert.deepEqual(scan.entries, []);
  assert.deepEqual(scan.issues, [{ code: "NO_OUTFITS" }]);
});

test("接受原生 File 列表，回落到 webkitRelativePath", async () => {
  const { scanAppearanceFolder } = await load();
  const scan = scanAppearanceFolder([
    { name: "main.png", webkitRelativePath: "千叶诗织/standees/02_classic/main.png" },
    { name: "happy.png", webkitRelativePath: "千叶诗织/expressions/02_classic/happy.png" }
  ]);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0].home.name, "main.png");
  assert.equal(scan.entries[0].sprites.length, 1);
});

test("本轮已导入的套不再进入重试集合，列表刷新失败也不重复上传", async () => {
  const { markImportedPlans } = await load();
  const plans = [
    { id: "a", name: "甲", status: "ready", missingHome: false, missingSprites: false, notes: [] },
    { id: "b", name: "乙", status: "ready", missingHome: false, missingSprites: false, notes: [] }
  ];
  const marked = markImportedPlans(plans, { a: true });
  assert.equal(marked.find((plan) => plan.id === "a").status, "duplicate");
  assert.equal(marked.find((plan) => plan.id === "b").status, "ready");
  assert.ok(marked.find((plan) => plan.id === "a").notes.includes("本次已导入"));
  assert.equal(
    marked.filter((plan) => plan.status === "ready").length,
    1,
    "重试只应包含失败套"
  );
});

test("renderer CSP allows blob images for appearance import previews", () => {
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  assert.match(html, /img-src[^;]*blob:/);
});
