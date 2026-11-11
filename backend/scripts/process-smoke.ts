import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpToolClient, type McpServerConfig } from "../src/mcp/client.js";
import { SkillLibrary } from "../src/skills/skill-library.js";

const backend = fileURLToPath(new URL("../", import.meta.url));
const outputValue = process.env.NOWADAYS_REVIEW_OUTPUT;
if (!outputValue) throw new Error("SMOKE_OUTPUT_REQUIRED");
const output = path.resolve(outputValue);
fs.mkdirSync(output, { recursive: true });
const appRoot = path.join(output, "app");
let server: ChildProcess | undefined;
let stderr = "";
const launches: number[] = [];

async function start(): Promise<number> {
  let stdout = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--app-root", appRoot, "--port", "0"], { cwd: backend, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server = child;
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMOKE_START_TIMEOUT")), 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("SMOKE_SERVER_EXITED")); });
    child.stdout!.on("data", () => {
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const data = JSON.parse(line) as { event: string; host: string; port: number };
          if (data.event === "listening") {
            assert.equal(data.host, "127.0.0.1");
            clearTimeout(timer);
            launches.push(data.port);
            resolve(data.port);
            return;
          }
        } catch { /* 等待完整的一行 JSON。 */ }
      }
    });
  });
}

async function stop(): Promise<void> {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("SMOKE_STOP_TIMEOUT")); }, 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function cli(port: number, args: string[]): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--base-url", `http://127.0.0.1:${port}`, ...args], { cwd: backend, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = ""; let err = "";
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("SMOKE_CLI_TIMEOUT")); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`SMOKE_CLI_FAILED:${err}`)); return; }
      try { resolve(JSON.parse(out) as Record<string, unknown>); } catch (error) { reject(error); }
    });
  });
}

/**
 * 配置写入的 CLI 作用域（DL-148 / 252 第一包）。
 * 后端统一要求写入前由活动接口确认角色已停止；这里用 CLI 自身的 activity
 * 命令完成停止与恢复，既不绕过路由守卫，也顺便覆盖活动命令组。
 */
async function configCli(
  port: number,
  roleId: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const stopped = await cli(port, ["activity", "stop", "--role", roleId]);
  assert.equal(stopped.confirmed, true, "冒烟阶段没有执行在跑，停止应由后端立即确认");
  assert.equal((stopped.activity as { state: string }).state, "stopped");
  try {
    return await cli(port, args);
  } finally {
    const resumed = await cli(port, ["activity", "resume", "--role", roleId]);
    assert.equal((resumed.activity as { state: string }).state, "active");
  }
}

let report: Record<string, unknown>;
try {
  const port = await start();
  assert.equal((await cli(port, ["health"])).status, "ok");
  const role = await cli(port, ["role", "create", "--name", "交付冒烟角色", "--definition", "@examples/role.md"]);
  assert.equal(typeof role.roleId, "string");
  assert.equal(typeof role.defaultWindowId, "string");
  const roleId = role.roleId as string;
  const activityBefore = await cli(port, ["activity", "get", "--role", roleId]);
  assert.equal((activityBefore.activity as { state: string }).state, "active");
  const activities = await cli(port, ["activity", "list"]);
  assert.equal((activities.items as unknown[]).length, 1);
  const revised = await configCli(port, roleId, ["role", "update", "--role", roleId, "--definition", "修订设定后保持原身份", "--expected-revision", "1"]);
  assert.equal(revised.definitionRevision, 2);
  assert.equal((await cli(port, ["role", "get", "--role", roleId])).roleId, roleId);
  const models = [];
  for (const file of ["model-anthropic.json", "model-openai-chat.json", "model-openai-responses.json"]) {
    models.push(await cli(port, ["resource", "create", "--kind", "model", "--json", `@examples/${file}`]));
  }
  const workspace = path.join(appRoot, "data", "roles", roleId, "workspace");
  const mcp = JSON.parse(fs.readFileSync(path.join(backend, "examples/mcp-local.json"), "utf8")) as { config: McpServerConfig };
  mcp.config.command = process.execPath;
  mcp.config.args = ["--import", pathToFileURL(path.join(backend, "node_modules/tsx/dist/loader.mjs")).href, path.join(backend, "src/mcp/local-server.ts")];
  mcp.config.env.NOWADAYS_WORKSPACE = workspace;
  fs.writeFileSync(path.join(output, "mcp.json"), JSON.stringify(mcp));
  const mcpResource = await cli(port, ["resource", "create", "--kind", "mcp", "--json", `@${path.join(output, "mcp.json")}`]);
  const tool = await McpToolClient.connect(mcp.config, { cwd: workspace });
  try {
    assert.ok((await tool.listTools()).some((item) => item.name === "workspace_write"));
    assert.equal((await tool.callTool("workspace_write", { path: "notes/p5.md", content: "交付样例实际写入" })).isError, false);
    assert.equal(fs.readFileSync(path.join(workspace, "notes/p5.md"), "utf8"), "交付样例实际写入");
  } finally { await tool.close(); }
  const skill = JSON.parse(fs.readFileSync(path.join(backend, "examples/skill.json"), "utf8")) as { config: { sourcePath: string } };
  skill.config.sourcePath = path.join(backend, "examples/skills");
  assert.ok(new SkillLibrary(skill.config.sourcePath).read("daily-note").body.includes("未知结果"));
  fs.writeFileSync(path.join(output, "skill.json"), JSON.stringify(skill));
  const skillResource = await cli(port, ["resource", "create", "--kind", "skill", "--json", `@${path.join(output, "skill.json")}`]);
  const bindings = fs.readFileSync(path.join(backend, "examples/bindings.json"), "utf8")
    .replaceAll("__MODEL_RESOURCE_ID__", String(models[0]!.resourceId)).replaceAll("__MODEL_ID__", "offline-not-dispatched")
    .replaceAll("__MCP_RESOURCE_ID__", String(mcpResource.resourceId)).replaceAll("__SKILL_RESOURCE_ID__", String(skillResource.resourceId));
  fs.writeFileSync(path.join(output, "bindings.json"), bindings);
  await configCli(port, roleId, ["binding", "put", "--role", roleId, "--json", `@${path.join(output, "bindings.json")}`]);
  await stop();
  const secondPort = await start();
  const restored = await cli(secondPort, ["role", "get", "--role", roleId]);
  const restoredActivity = await cli(secondPort, ["activity", "get", "--role", roleId]);
  assert.equal((restoredActivity.activity as { state: string }).state, "active", "配置写入作用域恢复后的活动状态应随 app 库持久化");
  assert.equal(restored.roleId, roleId);
  assert.equal(restored.defaultWindowId, role.defaultWindowId);
  assert.equal(restored.definitionRevision, 2);
  assert.equal((restored.definition as { text: string }).text, "修订设定后保持原身份");
  const roleDir = path.join(appRoot, "data", "roles", roleId);
  assert.ok(fs.existsSync(path.join(roleDir, "business.sqlite")));
  assert.ok(fs.existsSync(path.join(roleDir, "execution.sqlite")));
  assert.ok(fs.statSync(path.join(roleDir, "workspace")).isDirectory());
  const savedBindings = await cli(secondPort, ["binding", "get", "--role", roleId]);
  assert.equal((savedBindings.items as unknown[]).length, 4);
  assert.equal(fs.readFileSync(path.join(workspace, "notes/p5.md"), "utf8"), "交付样例实际写入");
  report = { id: "process-cli-restart", passed: true, observed: { role, restored, launches, appRoot, modelExamplesRegistered: models.length, savedBindings, activityBefore, activities, restoredActivity, note: "notes/p5.md" } };
} catch (error) {
  report = { id: "process-cli-restart", passed: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  process.exitCode = 1;
} finally {
  await stop();
  fs.writeFileSync(path.join(output, "server-stderr.log"), stderr);
}
fs.writeFileSync(path.join(output, "smoke-report.json"), JSON.stringify([report], null, 2));
console.log(JSON.stringify({ id: report.id, passed: report.passed }));
