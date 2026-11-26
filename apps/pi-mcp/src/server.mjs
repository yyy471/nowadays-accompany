import { fork } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProcessGroup } from "./process-tree.mjs";

const attach = await createProcessGroup();
const jobs = new Map();
const active = new Map();
const server = new Server({ name: "nowadays-pi", version: "1" }, { capabilities: { tools: {} } });
const schema = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string", minLength: 1 };
const tools = [
  { name: "pi_task_start", description: "在 Mod 草稿区后台编写、测试与修复工程；立即返回 jobId。", inputSchema: schema({ extId: string, prompt: string }) },
  ...[["status", "查看后台工程状态"], ["result", "读取后台工程最终摘要"], ["cancel", "取消工程并回收子进程"]]
    .map(([action, description]) => ({ name: "pi_task_" + action, description, inputSchema: schema({ jobId: string }) })),
];
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
const reply = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

async function start(prompt, job) {
  if (!job?.jobId || !job.lease || !path.isAbsolute(job.cwd) || new URL(job.baseUrl).hostname !== "127.0.0.1")
    throw new Error("PI_HOST_LEASE_REQUIRED");
  if (jobs.has(job.jobId)) throw new Error("PI_JOB_DUPLICATE");
  const agentDir = mkdtempSync(path.join(tmpdir(), "nowadays-pi-"));
  const child = fork(new URL("./worker.mjs", import.meta.url), [], { cwd: job.cwd, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    env: {
      ...Object.fromEntries(["SystemRoot", "ComSpec", "TEMP", "TMP", "PATHEXT", "PATH", "WINDIR", "USERPROFILE",
        "HOME", "LANG", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])),
      PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
    } });
  let stopping = false;
  let result = { state: "failed", error: "PI_WORKER_EXIT" };
  let kill = () => child.kill();
  const view = { jobId: job.jobId, state: "running" };
  jobs.set(job.jobId, view);
  let resolve;
  const done = new Promise(r => { resolve = r; });
  function stop(state) {
    if (!stopping) {
      stopping = true;
      result = { state };
      kill();
    }
    return done;
  }
  const timer = setTimeout(() => void stop("timed_out"), Math.max(1, job.expiresAt - Date.now()));
  active.set(job.jobId, { stop });
  child.once("message", data => { if (!stopping) result = data; });
  child.on("error", () => { result = { state: "failed", error: "PI_WORKER_ERROR" }; });
  child.once("close", async () => {
    clearTimeout(timer);
    kill();
    try {
      await fetch(job.baseUrl + "/release", { method: "POST", headers: { Authorization: "Bearer " + job.lease }, signal: AbortSignal.timeout(3000) });
    } catch { /* 宿主关闭时租约由宿主统一撤销。 */ }
    try { await rm(agentDir, { recursive: true, force: true, maxRetries: 3 }); }
    finally { Object.assign(view, result); active.delete(job.jobId); resolve(); }
  });
  try { kill = attach(child); child.send({ ...job, prompt, agentDir }); }
  catch (error) { await stop("failed"); throw error; }
  return view;
}
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  if (params.name === "pi_task_start") return reply(await start(args.prompt, params._meta?.nowadays));
  const view = jobs.get(args.jobId);
  if (!view || !tools.some(t => t.name === params.name)) throw new Error("PI_JOB_NOT_FOUND");
  if (params.name === "pi_task_cancel") await active.get(args.jobId)?.stop("cancelled");
  return reply(params.name === "pi_task_status" ? { jobId: view.jobId, state: view.state } : view);
});
let closing;
function close() {
  closing ??= Promise.all([...active.values()].map(job => job.stop("cancelled"))).finally(() => server.close());
  return closing;
}
process.stdin.on("end", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
await server.connect(new StdioServerTransport());
