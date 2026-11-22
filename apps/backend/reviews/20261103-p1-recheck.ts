// 修正后的独立边界补查。仅写入本次唯一测试目录，不修改生产实现。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { RoleStore } from "../src/storage/role-store.js";

const runId = `p1-recheck-${Date.now()}-${randomUUID().slice(0, 8)}`;
const outputRoot = path.resolve("test-results", runId);
fs.mkdirSync(outputRoot, { recursive: true });
const reports: Record<string, unknown>[] = [];
const errorInfo = (error: unknown) => ({ message: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code });
function setup(name: string) {
  const config = parseBackendConfig(["--app-root", path.join(outputRoot, name), "--port", "0"], {});
  const app = createBackendApp(config);
  const role = app.services.roles.createRole({ displayName: "recheck", definition: { text: "definition" } });
  return { config, app, role, paths: rolePaths(config.dataRoot, role.roleId) };
}

{
  const { config, app, role, paths } = setup("predicate-suffix");
  await app.close();
  const store = new RoleStore(paths.businessDatabasePath);
  store.db.exec("DROP INDEX idx_role_single_chat_model; CREATE UNIQUE INDEX idx_role_single_chat_model ON role_bindings(role_id) WHERE capability = 'chat_model' AND 0;");
  store.close();
  const reopened = createBackendApp(config);
  try {
    const port = await listen(reopened.server, 0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/v1/roles/${role.roleId}`, { signal: AbortSignal.timeout(5000) });
    const result = { status: response.status, body: await response.json() };
    let duplicateModels: number | undefined;
    if (response.ok) {
      const accepted = new RoleStore(paths.businessDatabasePath, { create: false });
      try {
        const bindings = accepted.replaceRoleBindings(role.roleId, [
          { capability: "chat_model", resourceId: randomUUID(), modelName: "A", enabled: true },
          { capability: "chat_model", resourceId: randomUUID(), modelName: "B", enabled: true },
        ]);
        duplicateModels = bindings.length;
      } finally { accepted.close(); }
    }
    reports.push({ probe: "changed-index-predicate-suffix", result, duplicateModels, contractPassed: response.status === 500 });
  } finally { await reopened.close(); }
}

{
  const { app, role, paths } = setup("reconciliation");
  const store = new RoleStore(paths.businessDatabasePath, { create: false });
  try {
    const roleId = role.roleId;
    const task = store.createTask({ roleId, goal: "reconciliation" });
    const execution = store.createExecution({ roleId, triggerType: "recovery" });
    store.linkExecutionTask({ roleId, taskId: task.taskId, executionId: execution.executionId, relation: "continues" });
    const begin = (stepKey: string) => store.beginToolCall({ roleId, taskId: task.taskId, executionId: execution.executionId, stepKey, toolName: "sample", args: {} }).toolCall;

    const first = begin("only-status");
    store.markToolCallRunning(roleId, first.toolCallId);
    store.saveToolResult({ roleId, toolCallId: first.toolCallId, status: "unknown", diagnosticCode: "RESPONSE_LOST" });
    let statusOnlyError: unknown;
    try { store.saveToolResult({ roleId, toolCallId: first.toolCallId, status: "success" }); }
    catch (error) { statusOnlyError = errorInfo(error); }
    const result = store.getToolResult(roleId, first.toolCallId);
    reports.push({ probe: "unknown-reconciled-with-status-only", error: statusOnlyError, result, contractPassed: statusOnlyError !== undefined && result.status === "unknown" });

    const second = begin("call-unknown-without-result");
    store.markToolCallRunning(roleId, second.toolCallId);
    store.finishToolCall(roleId, second.toolCallId, "unknown");
    let confirmedError: unknown;
    try { store.saveToolResult({ roleId, toolCallId: second.toolCallId, status: "success", rawResponse: { confirmed: true }, adaptedResult: "confirmed" }); }
    catch (error) { confirmedError = errorInfo(error); }
    reports.push({ probe: "unknown-call-before-result-later-confirmed", error: confirmedError, call: store.getToolCall(roleId, second.toolCallId), contractPassed: confirmedError === undefined });
  } finally { store.close(); await app.close(); }
}

const reportPath = path.join(outputRoot, "report.json");
fs.writeFileSync(reportPath, JSON.stringify({ runId, timestamp: new Date().toISOString(), executor: "Codex independent P1 recheck", node: process.version, reports }, null, 2));
console.log(JSON.stringify({ reportPath, reports }, null, 2));
