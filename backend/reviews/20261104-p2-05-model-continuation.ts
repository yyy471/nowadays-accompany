import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ModelPort } from "../src/domain/model.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { addBinding, createFixtureWithModel, withStorage } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p2-05-model-continuation-20261104");
fs.mkdirSync(output, { recursive: true });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("PROBE_WAIT_TIMEOUT");
    await delay(20);
  }
}
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let requests = 0;
const model: ModelPort = { async *stream(request) {
  requests += 1;
  if (requests === 1) {
    const tool = request.tools.find((item) => item.name.includes("workspace_read"));
    if (!tool) throw new Error("READ_TOOL_MISSING");
    yield { type: "tool_call", callId: "read", name: tool.name, arguments: { path: "note.md" } };
    yield { type: "completed", stopReason: "tool_calls" };
  } else if (requests === 2) {
    await gate;
    yield { type: "text_delta", text: "旧回复" };
    yield { type: "completed", stopReason: "stop" };
  } else if (requests === 3) {
    yield { type: "text_delta", text: "先回应新消息" };
    yield { type: "completed", stopReason: "stop" };
  } else if (requests === 4) {
    const tool = request.tools.find((item) => item.name.includes("workspace_write"));
    if (!tool) throw new Error("WRITE_TOOL_MISSING");
    yield { type: "tool_call", callId: "write", name: tool.name, arguments: { path: "result.md", content: "原任务完成" } };
    yield { type: "completed", stopReason: "tool_calls" };
  } else {
    yield { type: "text_delta", text: "原任务完成" };
    yield { type: "completed", stopReason: "stop" };
  }
} };
const fixture = createFixtureWithModel(model);
const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("PROBE_TIMEOUT"); process.exit(2); }, 30_000);
try {
  const mcp = fixture.app.services.resources.create({ kind: "mcp", name: "review", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace },
  } });
  addBinding(fixture, "mcp", mcp.resourceId);
  fs.writeFileSync(path.join(workspace, "note.md"), "已读取资料");
  const send = (content: string) => fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
  send("读取资料并保存结果");
  await until(() => requests === 2);
  send("先回复这条消息");
  await until(() => fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 20).items.some((message) => message.status === "completed" && message.content === "先回应新消息"));
  const chat = fixture.app.services.resources.listBindings(fixture.roleId).find((item) => item.capability === "chat_model");
  if (!chat) throw new Error("CHAT_BINDING_MISSING");
  fixture.app.services.resources.update(chat.resourceId, { enabled: false });
  release();
  await delay(600);
  const observed = {
    requests,
    saved: fs.existsSync(path.join(workspace, "result.md")),
    tasks: fixture.app.conversation.listTasks(fixture.roleId),
    executions: withStorage(fixture, (storage) => storage.business.db.prepare("SELECT status, trigger_type FROM executions ORDER BY rowid").all()),
  };
  const contractPassed = observed.saved && observed.tasks.every((task) => task.status === "completed");
  // 链结束后新消息不能借用已关闭的模型。
  const callsAfterChain = requests;
  send("关闭后不要启动新任务");
  await delay(100);
  const report = { contractPassed: contractPassed && requests === callsAfterChain, observed: { ...observed, newTaskBlocked: requests === callsAfterChain } };
  fs.writeFileSync(path.join(output, "model-continuation-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.contractPassed) process.exitCode = 1;
} finally {
  release();
  await fixture.close();
  clearInterval(alive);
  clearTimeout(watchdog);
}
