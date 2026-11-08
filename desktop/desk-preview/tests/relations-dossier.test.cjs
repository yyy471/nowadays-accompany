"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { readFileSync } = require("node:fs");
const nodePath = require("node:path");

const load = () => import(pathToFileURL(nodePath.join(__dirname, "../renderer/src/relations/dossier.js")).href);
const loadFold = () => import(pathToFileURL(nodePath.join(__dirname, "../renderer/src/relations/fold-marks.js")).href);

test("介绍页换角色时丢掉上一份设定，晚到的旧请求不能写回", async () => {
  const { createRoleRequestGate, initialRelationUi, profileModel, reduceRelation } = await load();
  const gate = createRoleRequestGate();
  let state = reduceRelation(initialRelationUi("role-a"), { type: "view", view: "profile" });
  state = reduceRelation(state, {
    type: "loaded",
    roleId: "role-a",
    packet: { roleId: "role-a", displayName: "甲", definitionText: "甲的介绍", definitionRevision: 1, createdAt: "", stateLines: [], sentence: "甲的近况", portraitUrl: null, events: [], diaries: [], summaries: [], memoryError: "" }
  });
  assert.equal(profileModel(state, "甲").definition, "甲的介绍");
  const first = gate.begin("role-a");
  const second = gate.begin("role-b");
  state = reduceRelation(state, { type: "switch", roleId: "role-b" });
  assert.equal(state.view, "profile");
  assert.equal(profileModel(state, "乙").definition, "");
  assert.equal(profileModel(state, "乙").name, "乙");
  assert.equal(profileModel(state, "乙").loading, true);
  assert.equal(gate.accept(first), false);
  state = reduceRelation(state, {
    type: "loaded",
    roleId: "role-a",
    packet: { roleId: "role-a", displayName: "甲", definitionText: "过期的介绍", definitionRevision: 1, createdAt: "", stateLines: [], sentence: "", portraitUrl: null, events: [], diaries: [], summaries: [], memoryError: "" }
  });
  assert.equal(profileModel(state, "乙").definition, "", "过期响应不能回到介绍页");
  assert.equal(gate.accept(second), true);
  state = reduceRelation(state, {
    type: "loaded",
    roleId: "role-b",
    packet: { roleId: "role-b", displayName: "乙", definitionText: "乙的介绍", definitionRevision: 2, createdAt: "", stateLines: [{ key: "目标", label: "目标", value: "把话说完" }], sentence: "把话说完", portraitUrl: null, events: [], diaries: [], summaries: [], memoryError: "" }
  });
  assert.equal(profileModel(state, "乙").definition, "乙的介绍");
  assert.equal(profileModel(state, "乙").lines[0].value, "把话说完");
});

test("近况只取已保存的字符串，不补心情", async () => {
  const { stateSentence, stateLines, splitDefinition, diaryTitle } = await load();
  assert.equal(stateSentence({ outfitId: "cloth", 目标: " 散步 " }), "散步");
  assert.equal(stateSentence({}), "");
  assert.equal(stateLines({ outfitId: "x", note: "刚合上书", extra: { hidden: true } }).map(line => line.value).join("|"), "刚合上书");
  assert.equal(splitDefinition("第一段\n\n第二段").quote, "第一段");
  assert.equal(diaryTitle("# 雨停之前\n\n正文", "2026-11-08"), "雨停之前");
});

test("纸线与刻度成对，装饰层不替代导航", async () => {
  const { buildFoldMarks } = await loadFold();
  const marks = buildFoldMarks({ left: 100, top: 200, width: 400, height: 500 }, { left: 300, top: 40, width: 600, height: 70 }, 41);
  assert.equal(marks.length, 41);
  assert.ok(marks[0].lineW > 0);
  assert.notEqual(marks[0].tickX, marks[40].tickX);
});

test("关系页源码不再携带示例文案、掀纸按钮和职员图", () => {
  const source = readFileSync(nodePath.join(__dirname, "../renderer/src/Relations.tsx"), "utf8");
  for (const banned of ["示例内容", "未连接后端", "掀纸透光", "信笺调谐", "clerk.svg", "阿柚", "林可", "那场没有赶路的雨"]) {
    assert.equal(source.includes(banned), false, banned);
  }
  assert.match(source, /换一位/);
  assert.match(source, /plate-switch/);
  assert.doesNotMatch(source, /page-tools[\s\S]{0,180}换一位/);
});
