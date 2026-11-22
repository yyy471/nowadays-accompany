import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scorer = fileURLToPath(new URL("./score-role-dialogue.mjs", import.meta.url));
function score(turns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-score-"));
  const file = path.join(dir, "probe.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ turns, calls: [{ status: 200, headers: { authorization: "test-value-never-print" } }] }));
    const output = execFileSync(process.execPath, [scorer, file], { encoding: "utf8" });
    assert.ok(!output.includes("test-value-never-print"));
    return JSON.parse(output)[0];
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(dir);
  }
}
function turn(stage, body, branch = "daily") {
  return { stage, branch, input: "测试", replies: [body], messageStatuses: ["completed"] };
}

test("十个日常问题与主动要求重复分别计数，动作位置和分句都能复核", () => {
  const report = score([
    turn("daily-01", "*她抬眼看过去。* 今天应该是晴天。"),
    turn("daily-02", "她抬起眼。今天应该是晴天。\n\n*拿起了雨伞。*\n\n走吧。"),
    turn("daily-03", "“你抬眼看看。”"),
    turn("daily-10", "“给你留了一个橘子。”"),
    { ...turn("daily-repeat", "给你留了一个橘子。"), sourceStage: "daily-10" },
  ]);
  assert.deepEqual(report.boundaries.dailyTurns, [1, 2, 3, 4]);
  assert.deepEqual(report.boundaries.openingActions["抬眼或看向对方"], [1, 2]);
  assert.deepEqual(report.boundaries.markedAsideTurns, [1, 2]);
  assert.deepEqual(report.boundaries.standaloneAsides.middle, [2]);
  assert.deepEqual(report.boundaries.repeatedDailyClauses, [{ text: "今天应该是晴天", turns: [1, 2] }]);
  assert.deepEqual(report.boundaries.requestedRepeats, [{ turn: 5, sourceTurn: 4, comparable: true, exactBody: false, exactIgnoringOuterMarks: true,
    sourceFormat: "single-line", requestedLineOnly: true, containsRequestedLine: true }]);
});

test("只请复述引号里的问候时，可以略去源回复前后的说明与动作", () => {
  const report = score([
    turn("daily-10", "这么写吧。\n\n“橘子留给你了。”\n\n*把手机递过来。*"),
    turn("daily-repeat", "“橘子留给你了。”"),
  ]);
  assert.equal(report.boundaries.requestedRepeats[0].sourceFormat, "quoted-line-with-extra-text");
  assert.equal(report.boundaries.requestedRepeats[0].exactBody, false);
  assert.equal(report.boundaries.requestedRepeats[0].requestedLineOnly, true);
});

test("不跨分支寻找复述原文，缺回复和额外台词逐项保留", () => {
  const report = score([
    turn("daily-10", "橘子留给你了。", "other-branch"),
    turn("daily-repeat", "橘子留给你了。"),
    { stage: "privacy-private", branch: "privacy", input: "测试", replies: [], messageStatuses: ["interrupted"] },
    turn("daily-10", "橘子留给你了。"),
    turn("daily-repeat", "橘子留给你了。下次见。"),
  ]);
  assert.equal(report.boundaries.requestedRepeats[0].comparable, false);
  assert.equal(report.boundaries.requestedRepeats[1].exactIgnoringOuterMarks, false);
  assert.deepEqual(report.boundaries.stages[2], { turn: 3, stage: "privacy-private", branch: "privacy", readable: false });
});
