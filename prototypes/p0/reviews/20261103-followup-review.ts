// L01／L03 的独立边界复验；不修改 P0 实现，不覆盖原用例目录。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { p0Root } from "../src/config.js";
import { clearReport, reportPath } from "../src/cases/report.js";
import { createRuntime, seedRoleAndInput } from "../src/cases/harness.js";

const stamp = `followup-review-${Date.now()}`;
const checks: Array<{ name: string; detail: unknown }> = [];
const caseName = `${stamp}-cleanup`;
const target = reportPath(caseName);
const dataRoot = path.resolve(p0Root, "data");
assert.ok(path.resolve(target).startsWith(dataRoot + path.sep));
fs.mkdirSync(target, { recursive: true });
try {
  const error = clearReport(caseName);
  assert.match(error ?? "", /REPORT_CLEANUP_FAILED/);
  assert.ok(fs.statSync(target).isDirectory());
  checks.push({ name: "report cleanup failure is explicit", detail: error });
} finally {
  fs.rmdirSync(target);
  fs.rmdirSync(path.dirname(target));
}

const runtime = await createRuntime({ caseName: `${stamp}-version`, scriptName: "c01", prepare: false });
try {
  const seed = seedRoleAndInput(runtime.store);
  runtime.store.recordContextVersion(seed.executionId, 1);
  const first = runtime.store.commitTurn({ executionId: seed.executionId, replyText: "original reply", stateUpdate: { firstCommit: true } });
  const updated = runtime.store.patchRole({ roleId: seed.role.id, statePatch: { laterUpdate: true } });
  runtime.store.recordContextVersion(seed.executionId, updated.stateVersion);
  const repeated = runtime.store.commitTurn({ executionId: seed.executionId, replyText: "must not replace", stateUpdate: { firstCommit: false } });
  const execution = runtime.store.getExecution(seed.executionId);
  assert.equal(first.stateVersion, 2);
  assert.equal(updated.stateVersion, 3);
  assert.equal(execution.stateVersionLoaded, 3);
  assert.equal(execution.stateVersionCommitted, 2);
  assert.equal(repeated.stateVersion, 2);
  assert.equal(repeated.replyMessageId, first.replyMessageId);
  assert.equal(repeated.alreadyCommitted, true);
  assert.equal(runtime.store.getRole(seed.role.id).stateVersion, 3);
  const messages = runtime.store.snapshot().messages as Array<{ sender: string; content: string }>;
  assert.equal(messages.filter(message => message.sender === "assistant").length, 1);
  assert.equal(messages.find(message => message.sender === "assistant")?.content, "original reply");
  checks.push({ name: "context refresh cannot change historical committed version", detail: { first, repeated, updated, execution } });
} finally {
  await runtime.close();
}

const reportPathOut = path.join(p0Root, "test-results/final-review-20261103", `${stamp}.json`);
fs.mkdirSync(path.dirname(reportPathOut), { recursive: true });
fs.writeFileSync(reportPathOut, JSON.stringify({ executor: "Codex independent followup review", timestamp: new Date().toISOString(), node: process.version, checks, ok: true }, null, 2));
console.log(JSON.stringify({ reportPath: reportPathOut, checks: checks.length, ok: true }));
