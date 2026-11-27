import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const windows = process.platform === "win32";
const metrics = windows ? await import("../test-support/windows-metrics.mjs") : undefined;
const entry = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= end) throw Error("PI_TEST_WAIT_TIMEOUT"); await delay(35); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
for (const allowShell of [undefined, false, true]) test("模型工具集合 " + String(allowShell), async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-"));
  let names;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/release") { req.resume(); res.writeHead(204).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    names = JSON.parse(body).tools.map(tool => tool.function.name);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"id":"test","model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe",
    env: { PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH, PATHEXT: ".EXE;.COM;.CMD;.BAT" } });
  transport.stderr.on("data", () => {});
  try {
    await client.connect(transport);
    await client.callTool({ name: "pi_task_start", arguments: { extId: "test", prompt: "test" }, _meta: { nowadays: {
      cwd, baseUrl: "http://127.0.0.1:" + upstream.address().port, lease: "synthetic", jobId: "tool-list",
      modelName: "test", apiFlavor: "openai-completions", expiresAt: Date.now() + 30000, allowShell } } });
    await until(async () => {
      if (names) return true;
      const state = (await client.callTool({ name: "pi_task_result", arguments: { jobId: "tool-list" } })).structuredContent;
      if (state.state === "failed") throw Error(JSON.stringify(state));
      return false;
    });
    assert.deepEqual(names.sort(), ["read", "write", "edit", "draft_test", ...(allowShell === true ? [windows ? "powershell" : "bash"] : [])].sort());
  } finally {
    await client.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
  }
});
for (const mode of ["complete", "cancel", "timeout", "close"]) test("真实 Pi 会话回收进程树 " + mode, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifecycle-"));
  // 短命父进程派生长期运行的孙进程，覆盖单纯 taskkill /T 已无法枚举的退出父节点。
  fs.writeFileSync(path.join(cwd, "spawn.cjs"), `const fs=require("node:fs");const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},2000)"],{stdio:"ignore",windowsHide:true});fs.writeFileSync("pid",String(child.pid));child.unref();`);
  let calls = 0;
  let firstModelMs;
  const upstream = http.createServer(async (req, res) => {
    await req.resume();
    if (req.url === "/release") { res.writeHead(204).end(); return; }
    firstModelMs ??= Math.round(performance.now() - started);
    const n = calls++;
    if (n && mode !== "complete") return;
    const delta = n ? { content: "done" } : { tool_calls: [{ index: 0, id: "child", type: "function",
      function: { name: windows ? "powershell" : "bash", arguments: JSON.stringify({ command: "node spawn.cjs" }) } }] };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [{ delta: { role: "assistant", ...delta }, finish_reason: null }, { delta: {}, finish_reason: n ? "stop" : "tool_calls" }])
      res.write("data: " + JSON.stringify({ id: "test", model: "test", choices: [{ index: 0, ...choice }] }) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe",
    env: { PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH, PATHEXT: ".EXE;.COM;.CMD;.BAT" } });
  transport.stderr.on("data", () => {});
  const started = performance.now();
  const seen = new Set();
  let interval;
  let peak = 0;
  let childPid;
  try {
    await client.connect(transport);
    const readyMs = Math.round(performance.now() - started);
    const pid = transport.pid;
    seen.add(pid);
    if (metrics) interval = setInterval(() => { peak = Math.max(peak, metrics.sampleTree(pid, seen)); }, 25);
    const baseUrl = "http://127.0.0.1:" + upstream.address().port;
    const expiresAt = Date.now() + (mode === "timeout" ? 7000 : 60000);
    const id = "test-" + mode;
    const result = await client.callTool({ name: "pi_task_start", arguments: { extId: "test", prompt: "启动测试程序" },
      _meta: { nowadays: { cwd, baseUrl, lease: "synthetic", jobId: id, modelName: "test", apiFlavor: "openai-completions", expiresAt, allowShell: true } } });
    assert.equal(result.structuredContent?.state, "running");
    const status = async () => (await client.callTool({ name: "pi_task_status", arguments: { jobId: id } })).structuredContent.state;
    await until(() => fs.existsSync(path.join(cwd, "pid")));
    childPid = Number(fs.readFileSync(path.join(cwd, "pid"), "utf8"));
    seen.add(childPid);
    if (mode === "close") await client.close();
    else if (mode === "cancel") {
      assert.equal((await client.callTool({ name: "pi_task_cancel", arguments: { jobId: id } })).structuredContent.state, "cancelled");
    } else await until(async () => await status() === (mode === "timeout" ? "timed_out" : "completed"));
    await until(() => !alive(childPid));
    await client.close();
    clearInterval(interval);
    await until(() => [...seen].every(p => !alive(p)));
    t.diagnostic(JSON.stringify({ mode, initializeMs: readyMs, firstModelMs, sampledTreeWorkingSetBytes: peak, observedPids: [...seen], survivors: 0 }));
  } finally {
    clearInterval(interval);
    await client.close();
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
  }
});
