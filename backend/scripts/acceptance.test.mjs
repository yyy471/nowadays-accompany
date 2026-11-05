import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCases, readTestTotals } from "./acceptance-lib.mjs";

test("验收汇总拒绝缺报告、缺用例、重复编号和错误用例", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p5-report-"));
  const file = path.join(root, "report.json");
  try {
    assert.throws(() => readCases(file, 2, "passed"));
    for (const data of [[], [{ id: "a", passed: true }], [{ id: "a", passed: true }, { id: "a", passed: true }], [{ id: "a", passed: true }, { id: "b", passed: true, error: "fixture failure" }]]) {
      fs.writeFileSync(file, JSON.stringify(data));
      assert.throws(() => readCases(file, 2, "passed"));
    }
    fs.writeFileSync(file, JSON.stringify([{ id: "a", passed: true }, { id: "b", passed: false }]));
    assert.throws(() => readCases(file, 2, "passed"));
    fs.writeFileSync(file, JSON.stringify([{ id: "a", passed: true }, { id: "b", passed: true }]));
    assert.deepEqual(readCases(file, 2, "passed"), ["a", "b"]);
    fs.writeFileSync(file, JSON.stringify({ contractPassed: true }));
    assert.deepEqual(readCases(file, 1, "contractPassed", "single-case"), ["single-case"]);
    assert.throws(() => readCases(file, 1, "contractPassed"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("正式测试汇总拒绝空测试、缺尾部、失败、取消和跳过", () => {
  const good = "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.equal(readTestTotals(good).tests, 2);
  for (const bad of ["", good.replace("# tests 2", "# tests 0"), good.replace("# fail 0", "# fail 1"), good.replace("# cancelled 0", "# cancelled 1"), good.replace("# skipped 0", "# skipped 1"), good.replace("# pass 2", "# pass 1")]) assert.throws(() => readTestTotals(bad));
});
