// P1 独立复核：只操作本次唯一测试目录，不修改正式实现或原自验数据。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { RoleStore } from "../src/storage/role-store.js";

const runId = `p1-independent-${Date.now()}-${randomUUID().slice(0, 8)}`;
const outputRoot = path.resolve("test-results", runId);
fs.mkdirSync(outputRoot, { recursive: true });
const reports: Record<string, unknown>[] = [];
const serializeError = (error: unknown) => ({
  name: error instanceof Error ? error.name : "Unknown",
  message: error instanceof Error ? error.message : String(error),
  code: (error as { code?: string })?.code,
});
const initial = { displayName: "review role", definition: { text: "definition" }, state: { preserved: true } };
function setup(name: string) {
  const config = parseBackendConfig(["--app-root", path.join(outputRoot, name), "--port", "0"], {});
  const app = createBackendApp(config);
  const role = app.services.roles.createRole(initial);
  return { config, app, role, paths: rolePaths(config.dataRoot, role.roleId) };
}
async function queryRole(app: ReturnType<typeof createBackendApp>, roleId: string) {
  const port = await listen(app.server, 0, "127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${port}/v1/roles/${roleId}`, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}

for (const kind of ["business", "execution"] as const) {
  const { config, app, role, paths } = setup(`missing-${kind}`);
  await app.close();
  const target = kind === "business" ? paths.businessDatabasePath : paths.executionDatabasePath;
  assert.ok(path.resolve(target).startsWith(outputRoot + path.sep));
  const backup = target + ".review-backup";
  fs.renameSync(target, backup);
  const reopened = createBackendApp(config);
  try {
    const result = await queryRole(reopened, role.roleId);
    const recreated = fs.existsSync(target);
    reports.push({ probe: `missing-${kind}-database`, result, recreated, backup,
      index: reopened.appStore.getRoleIndex(role.roleId), contractPassed: result.status >= 500 && !recreated });
  } finally { await reopened.close(); }
}

{
  const { app, role, paths } = setup("repositories");
  const store = new RoleStore(paths.businessDatabasePath);
  try {
    const roleId = role.roleId;
    const taskA = store.createTask({ roleId, goal: "A" });
    const taskB = store.createTask({ roleId, goal: "B" });
    const execution = store.createExecution({ roleId, triggerType: "recovery" });
    for (const task of [taskA, taskB]) store.linkExecutionTask({ roleId, executionId: execution.executionId, taskId: task.taskId, relation: "continues" });
    const base = { roleId, executionId: execution.executionId, stepKey: "same-step", toolName: "sample", args: {} };
    const first = store.beginToolCall({ ...base, taskId: taskA.taskId });
    let second: unknown; let mismatchError: unknown;
    try { second = store.beginToolCall({ ...base, taskId: taskB.taskId }); }
    catch (error) { mismatchError = serializeError(error); }
    reports.push({ probe: "idempotency-task-ownership", requestedTaskId: taskB.taskId, first, second, error: mismatchError, contractPassed: mismatchError !== undefined });

    const callId = first.toolCall.toolCallId;
    store.markToolCallRunning(roleId, callId);
    store.saveToolResult({ roleId, toolCallId: callId, status: "unknown", diagnosticCode: "RESPONSE_LOST" });
    let reconcileError: unknown; let finishError: unknown;
    try { store.saveToolResult({ roleId, toolCallId: callId, status: "success", rawResponse: { confirmed: true }, adaptedResult: "confirmed" }); }
    catch (error) { reconcileError = serializeError(error); }
    try { store.finishToolCall(roleId, callId, "success"); }
    catch (error) { finishError = serializeError(error); }
    reports.push({ probe: "unknown-result-later-confirmed", reconcileError, finishError, saved: store.getToolResult(roleId, callId),
      contractPassed: reconcileError === undefined && store.getToolResult(roleId, callId).status === "success" });
  } finally { store.close(); await app.close(); }
}

{
  const { config, app, role, paths } = setup("missing-index");
  await app.close();
  const store = new RoleStore(paths.businessDatabasePath);
  store.db.exec("DROP INDEX idx_messages_window_submission; DROP INDEX idx_role_single_chat_model;");
  store.close();
  const reopened = createBackendApp(config);
  try {
    const result = await queryRole(reopened, role.roleId);
    reports.push({ probe: "missing-required-index", result, contractPassed: result.status >= 500 });
  } finally { await reopened.close(); }
}

{
  const { app } = setup("oversized-body");
  try {
    const port = await listen(app.server, 0, "127.0.0.1");
    let result: { status?: number; body?: unknown; error?: unknown };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/roles`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "large", definition: { text: "x".repeat(1024 * 1024 + 100) } }), signal: AbortSignal.timeout(5000) });
      result = { status: response.status, body: await response.json() };
    } catch (error) { result = { error: serializeError(error) }; }
    reports.push({ probe: "oversized-body-json-error", result, contractPassed: result.status === 413 });
  } finally { await app.close(); }
}

const reportPath = path.join(outputRoot, "report.json");
fs.writeFileSync(reportPath, JSON.stringify({ runId, executor: "Codex independent P1 review", timestamp: new Date().toISOString(), node: process.version, reports }, null, 2));
console.log(JSON.stringify({ reportPath, reports }, null, 2));
