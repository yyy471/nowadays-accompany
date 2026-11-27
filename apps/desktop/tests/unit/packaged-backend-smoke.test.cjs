"use strict";

// Run explicitly after staging: node --test tests/unit/packaged-backend-smoke.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");

const hostToken = require("node:crypto").randomBytes(32).toString("hex");
const hostHeaders = { "X-Nowadays-Host-Token": hostToken };

const staging = path.resolve(__dirname, "../../build-staging");
const hasStage = fs.existsSync(staging);

async function waitFor(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error("PACKAGED_SMOKE_TIMEOUT");
}

function cleanEnv(temp) {
  // No inherited NODE_PATH, NODE_OPTIONS, or NOWADAYS_* overrides. The backend
  // may use Windows system libraries, but cannot find a host Node or npm.
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: temp, TMP: temp, PATH: path.join(process.env.SystemRoot, "System32"),
    PATHEXT: ".EXE;.COM;.CMD;.BAT" };
}

function processOutput(child) {
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return { stdout: () => stdout, stderr: () => stderr,
    events: () => stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) };
}

async function api(base, route, options = {}) {
  const response = await fetch(base + route, { ...options, headers: { ...hostHeaders, ...options.headers } });
  const body = await response.json();
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
function json(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function copiedNodeProcesses(node) {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // An enumeration failure is a test failure, never an empty process list.
  const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "@((Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id,Path)) | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  const entries = JSON.parse(output.trim());
  return (Array.isArray(entries) ? entries : [entries]).filter(item => item && item.Path && path.resolve(item.Path).toLowerCase() === path.resolve(node).toLowerCase());
}

test("脱仓生产包离线启动、对话、扩展与工具链及关停回收", { timeout: 120000, skip: process.platform !== "win32" ? "Windows-only staging" : !hasStage && "build-staging is not prepared" }, async t => {
  assert.equal(process.platform, "win32", "Windows staging requires Windows");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays packaged smoke "));
  const relative = path.relative(fs.realpathSync(path.resolve(__dirname, "../../../..")), fs.realpathSync(temp));
  assert.ok(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative), "temporary directory must be outside repository");
  const copied = path.join(temp, "staged resources");
  const appRoot = path.join(temp, "application data");
  let child;
  try {
    fs.cpSync(staging, copied, { recursive: true, dereference: true });
    const resources = copied;
    const node = path.join(resources, "node-runtime", "node.exe");
    const entry = path.join(resources, "backend", "dist", "main.js");
    const presets = path.join(resources, "preset-assets");
    for (const file of [node, entry, presets]) assert.ok(fs.existsSync(file), `missing staged asset: ${file}`);
    const start = performance.now();
    child = spawn(node, [entry, "--app-root", appRoot, "--preset-assets-dir", presets, "--port", "0", "--watch-stdin"],
      { cwd: temp, env: { ...cleanEnv(temp), NOWADAYS_HOST_TOKEN: hostToken }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const output = processOutput(child);
    let spawnError;
    child.on("error", error => { spawnError = error; });
    const listening = await waitFor(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}: ${output.stderr()}`);
      return output.events().find(event => event.event === "listening");
    });
    const base = `http://127.0.0.1:${listening.port}`;
    await waitFor(async () => { try { return (await fetch(base + "/v1/health", { headers: hostHeaders })).status === 200; } catch { return false; } });
    t.diagnostic(`spawn to first health 200: ${Math.round(performance.now() - start)} ms`);
    assert.ok(copiedNodeProcesses(node).some(item => item.Id === child.pid), "process enumeration must find the live backend at the copied path");
    const roles = await api(base, "/v1/roles");
    const preset = roles.items.find(role => role.isBuiltin);
    assert.ok(preset, "builtin role is present");
    const detail = await api(base, `/v1/roles/${preset.roleId}`);
    assert.ok(detail.bio && detail.bio.length > 20, "packaged preset biography was imported");
    const outfits = await api(base, `/v1/roles/${preset.roleId}/appearance/outfits`);
    assert.equal(outfits.items.filter(item => item.isPreset).length, 2);
    const home = outfits.items.find(item => item.presetKey === "default").home;
    assert.ok(home);
    const image = await fetch(`${base}/v1/roles/${preset.roleId}/appearance/assets/${home.assetId}`, { headers: hostHeaders });
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type"), /^image\//);
    assert.ok((await image.arrayBuffer()).byteLength > 0);
    // Resolve the client from the copied payload; no test dependencies come from the repository.
    const sdk = path.join(resources, "pi-mcp", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
    const { Client } = await import(pathToFileURL(path.join(sdk, "index.js")));
    const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, "stdio.js")));
    async function connectMcp(script, extraEnv = {}) {
      const client = new Client({ name: "packaged-smoke", version: "1" });
      const transport = new StdioClientTransport({ command: node, args: [script], cwd: temp,
        env: { ...cleanEnv(temp), ...extraEnv }, stderr: "pipe" });
      let errors = ""; transport.stderr.on("data", chunk => { errors += chunk; });
      try { await client.connect(transport); } catch (error) {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        throw Error(`${error}: ${errors}`);
      }
      return client;
    }
    const workspace = path.join(temp, "mcp workspace");
    fs.mkdirSync(workspace);
    const local = await connectMcp(path.join(resources, "backend", "dist", "mcp", "local-server.js"), { NOWADAYS_WORKSPACE: workspace });
    try {
      const write = await local.callTool({ name: "workspace_write", arguments: { path: "proof.txt", content: "packaged MCP proof" } });
      assert.ok(!write.isError, JSON.stringify(write));
      assert.equal(fs.readFileSync(path.join(workspace, "proof.txt"), "utf8"), "packaged MCP proof");
      const read = await local.callTool({ name: "workspace_read", arguments: { path: "proof.txt" } });
      assert.match(JSON.stringify(read), /packaged MCP proof/);
    } finally { await local.close(); }

    let workerNames;
    const model = http.createServer(async (request, response) => {
      if (request.url === "/release") { request.resume(); response.writeHead(204).end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      workerNames = JSON.parse(Buffer.concat(chunks).toString()).tools.map(tool => tool.function.name);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"id":"smoke","model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
    let pi;
    try {
      pi = await connectMcp(path.join(resources, "pi-mcp", "src", "server.mjs"));
      await pi.callTool({ name: "pi_task_start", arguments: { extId: "smoke", prompt: "test" }, _meta: { nowadays: {
        cwd: workspace, baseUrl: `http://127.0.0.1:${model.address().port}`, lease: "synthetic", jobId: "smoke-worker",
        modelName: "test", apiFlavor: "openai-completions", expiresAt: Date.now() + 30000, allowShell: false } } });
      await waitFor(async () => {
        if (workerNames) return true;
        const result = await pi.callTool({ name: "pi_task_result", arguments: { jobId: "smoke-worker" } });
        if (result.structuredContent?.state === "failed") throw Error(JSON.stringify(result));
        return false;
      });
      assert.deepEqual(workerNames.sort(), ["read", "write", "edit", "draft_test"].sort());
      await waitFor(async () => (await pi.callTool({ name: "pi_task_result", arguments: { jobId: "smoke-worker" } })).structuredContent?.state === "completed");
    } finally {
      try { await pi?.close(); }
      finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
    }

    const role = await api(base, "/v1/roles", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Offline smoke", definition: { text: "test" } }) });
    assert.ok(role.roleId && role.defaultWindowId);

    // A loopback-only OpenAI-compatible model publishes an extension and then
    // calls its newly registered tool in the same real conversation.
    const requests = [];
    const conversationModel = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const index = requests.length - 1;
      const calls = [
        ["app_extension_upsert", { extId: "smoke", manifest: { version: "v1", entry: "entry.mjs", ui: [] },
          files: { "entry.mjs": 'export default (_, api) => api.tools.register({name:"hello",description:"smoke",scope:"all_roles",inputSchema:{type:"object"}}, () => "PACKAGED_EXTENSION_OK");' } }],
        ["ext_smoke__hello", {}],
      ];
      const call = calls[index];
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `smoke_${index}`, type: "function",
        function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: "assistant", content: "OFFLINE_CONVERSATION_OK" };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? "tool_calls" : "stop" }])
        response.write(`data: ${JSON.stringify({ id: "smoke", model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise(resolve => conversationModel.listen(0, "127.0.0.1", resolve));
    try {
      for (const item of (await api(base, "/v1/activities")).items)
        await api(base, `/v1/roles/${item.roleId}/activity/stop`, { method: "POST" });
      const resource = await api(base, "/v1/resources", json("POST", { kind: "model", name: "offline smoke",
        config: { protocol: "openai-chat", baseUrl: `http://127.0.0.1:${conversationModel.address().port}/v1` } }));
      await api(base, `/v1/roles/${preset.roleId}/bindings`, json("PUT", { bindings: [{ capability: "chat_model", resourceId: resource.resourceId, modelName: "smoke" }] }));
      await api(base, `/v1/roles/${preset.roleId}/activity/resume`, { method: "POST" });
      const messages = `/v1/roles/${preset.roleId}/windows/${preset.defaultWindowId}/messages`;
      await api(base, messages, json("POST", { content: "请测试扩展", submissionId: require("node:crypto").randomUUID() }));
      await waitFor(async () => JSON.stringify(await api(base, messages)).includes("OFFLINE_CONVERSATION_OK"), 45000);
      assert.ok(requests.length >= 3, "conversation must reach both tool calls and final reply");
      assert.match(JSON.stringify(requests[2].messages), /PACKAGED_EXTENSION_OK/, "model received real extension tool result");
      const extension = await api(base, "/v1/extensions/smoke");
      assert.equal(extension.status, "enabled");
      assert.ok(extension.tools.some(tool => tool.name === "hello"));
      assert.ok(copiedNodeProcesses(node).length >= 2, "enumeration must find the backend and live extension runner");
    } finally { conversationModel.closeAllConnections(); await new Promise(resolve => conversationModel.close(resolve)); }
    const backendPid = child.pid;
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("shutdown timeout")), 15000);
      child.once("close", code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exit, 0, output.stderr());
    assert.ok(output.events().some(event => event.event === "shutdown_complete" && event.source === "stdin"));
    assert.throws(() => process.kill(backendPid, 0), { code: "ESRCH" });
    assert.deepEqual(copiedNodeProcesses(node), [], "copied node processes remain after shutdown");
    child = undefined;
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("close", resolve)); }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
