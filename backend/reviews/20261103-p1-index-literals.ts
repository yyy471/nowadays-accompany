// R04 独立复验：规范化可以忽略 SQL 关键字格式，不能改变字符串常量的含义。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { RoleStore } from "../src/storage/role-store.js";

const runId = `p1-literal-review-${Date.now()}-${randomUUID().slice(0, 8)}`;
const outputRoot = path.resolve("test-results", runId);
fs.mkdirSync(outputRoot, { recursive: true });
const reports: unknown[] = [];
for (const sample of [
  { name: "keyword-format-control", predicate: "where CAPABILITY = 'chat_model'", expected: 200 },
  { name: "changed-literal-case", predicate: "WHERE capability = 'CHAT_MODEL'", expected: 500 },
  { name: "changed-literal-whitespace", predicate: "WHERE capability = 'chat_model '", expected: 500 },
  { name: "changed-literal-parentheses", predicate: "WHERE capability = 'chat_(model)'", expected: 500 },
]) {
  const config = parseBackendConfig(["--app-root", path.join(outputRoot, sample.name), "--port", "0"], {});
  const app = createBackendApp(config);
  const role = app.services.roles.createRole({ displayName: "literal review", definition: { text: "definition" } });
  await app.close();
  const paths = rolePaths(config.dataRoot, role.roleId);
  const store = new RoleStore(paths.businessDatabasePath, { create: false });
  const literalEquality = store.db.prepare("SELECT 'chat_model' = 'CHAT_MODEL' AS same_case, 'chat_model' = 'chat_model ' AS same_whitespace, 'chat_model' = 'chat_(model)' AS same_parentheses").get();
  store.db.exec(`DROP INDEX idx_role_single_chat_model; CREATE UNIQUE INDEX idx_role_single_chat_model ON role_bindings(role_id) ${sample.predicate};`);
  store.close();
  const reopened = createBackendApp(config);
  try {
    const port = await listen(reopened.server, 0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/v1/roles/${role.roleId}`, { signal: AbortSignal.timeout(5000) });
    reports.push({ ...sample, actualStatus: response.status, body: await response.json(), literalEquality, contractPassed: response.status === sample.expected });
  } finally { await reopened.close(); }
}
const reportPath = path.join(outputRoot, "report.json");
fs.writeFileSync(reportPath, JSON.stringify({ runId, timestamp: new Date().toISOString(), executor: "Codex independent P1 literal predicate review", node: process.version, reports }, null, 2));
console.log(JSON.stringify({ reportPath, reports }, null, 2));
