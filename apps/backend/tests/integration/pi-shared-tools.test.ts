import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { listen } from "../../src/bootstrap/app.js";
import { McpToolClient, type McpToolInfo } from "../../src/mcp/client.js";
import { addBinding, createFixtureWithModel, deferred, disableResourceDirect, ScriptedChatModel, withStorage,
  type Fixture } from "../fixtures/conversation-fixture.js";

const probe = "SECRET_PROBE_VALUE";
const sample = path.resolve("tests/fixtures/pi-shared-mcp.mjs");
const deniedNames = ["admin-tools", "pi_task_start", "app_extension_publish_work", "extension_install", "ext_sample__edit",
  "command_run", "desktop_click", "computer_use", "private_description"];
function seat() {
  const f = createFixtureWithModel(new ScriptedChatModel([[{ type: "text_delta", text: "等待交办" },
    { type: "completed", stopReason: "stop" }]]), { disablePresetAssistant: false, presetAssetsDir: "tests/fixtures" });
  const roleId = f.app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  return { ...f, roleId, windowId: f.app.services.roles.initializeRole(roleId).defaultWindowId };
}
function task(f: Fixture, autonomous = false) {
  const { roleId, windowId } = f;
  return withStorage(f, ({ business }) => {
    const { executionId } = business.createExecution({ roleId, windowId, triggerType: autonomous ? "autonomous" : "user_message" });
    const { taskId } = business.createTask({ roleId, goal: "验证工程工具", origin: autonomous ? "autonomous" : "user", initiatorExecutionId: executionId });
    business.linkExecutionTask({ roleId, taskId, executionId, relation: "initiates" });
    const jobId = randomUUID();
    return { roleId, windowId, executionId, taskId, jobId, cwd: f.app.services.extensions.work.workspace("sample", jobId), autonomous };
  });
}
function external(f: Fixture, identity: string, args = ["--token", "ARGV_FIXTURE_PROBE"], env: Record<string, string> = {}) {
  const res = f.app.services.resources.create({ kind: "mcp", name: identity, config: { command: process.execPath,
    args: [sample, identity, path.join(f.root, "dispatches"), ...args], env: { ...env, API_KEY: probe } } });
  addBinding(f, "mcp", res.resourceId);
  return res.resourceId;
}
function post(port: number, token: string, route: string, body: object = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/internal/tool-proxy/${route}`, { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
}
function lease(f: Fixture, job: ReturnType<typeof task>, expiresAt = Date.now() + 60000) {
  const shared = f.app.services.toolProxy.forJob(job);
  const binding = { capability: "chat_model" as const, resourceId: "fixture", modelName: "offline",
    config: { protocol: "openai-chat" as const, baseUrl: "http://127.0.0.1:1" } };
  return { shared, token: f.app.services.modelProxy.issue(job.roleId, binding, job.autonomous, expiresAt, shared) };
}
function mapped(resourceId: string, name: string) {
  return "mcp_" + createHash("sha256").update(JSON.stringify([resourceId, name])).digest("hex").slice(0, 24) + "_" + name;
}

test("真实 Pi SDK 动态注册、调用两份同名 MCP 与宿主 Skill，模型和 shell 只收到公开数据", { timeout: 90000 }, async t => {
  const f = seat();
  const doc = path.join(f.root, "private-skill-root with spaces", "SKILL.md");
  fs.mkdirSync(path.join(path.dirname(doc), "refs"), { recursive: true });
  const front = "---\nname: sample-skill\ndescription: sample-brief\n---\n";
  fs.writeFileSync(doc, front + "BODY_VERSION_ONE");
  fs.writeFileSync(path.join(path.dirname(doc), "refs", "sample.txt"), "NESTED_REFERENCE");
  fs.writeFileSync(path.join(path.dirname(doc), "check.mjs"), `import fs from "node:fs";
if (process.env.API_KEY || process.env.NOWADAYS_HOST_PROBE || process.permission.has("fs.write", import.meta.filename) ||
  process.permission.has("child") || !process.permission.has("fs.read", import.meta.filename)) throw Error("permissions");
fs.writeFileSync("output.txt",process.argv[2]);console.log("SCRIPT_OK", import.meta.url);`);
  const calls = t.mock.method(McpToolClient.prototype, "callTool");
  let round = 0;
  const errors: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      const buffers = [];
      for await (const part of req) buffers.push(part);
      const raw = Buffer.concat(buffers).toString();
      assert.ok(!raw.includes(probe) && !raw.includes("ARGV_FIXTURE_PROBE") && !raw.includes("private-skill-root"));
      const body = JSON.parse(raw);
      const meta = calls.mock.calls.find(c => c.arguments[0] === "pi_task_start")!.arguments[2]!.meta!.nowadays as
        { skills: { id: string; name: string; description: string }[] };
      assert.ok(!JSON.stringify(meta).includes(probe) && !JSON.stringify(meta).includes("private-skill-root"));
      const [skill] = meta.skills;
      assert.deepEqual(skill, { id: skill!.id, name: "sample-skill", description: "sample-brief" });
      const tools = body.tools.map((t: { function: McpToolInfo }) => t.function) as McpToolInfo[];
      const echoes = tools.filter(t => t.name.startsWith("mcp_")).sort((a,b) => a.description.localeCompare(b.description));
      assert.equal(echoes.length, 2);
      assert.notEqual(echoes[0]!.name, echoes[1]!.name);
      assert.ok(raw.includes(skill!.id));
      const shell = process.platform === "win32" ? "powershell" : "bash";
      const shellCommand = `node -e "if(Object.values(process.env).some(v=>v.includes(['SECRET','PROBE','VALUE'].join('_'))))process.exit(1);console.log('PI_ENV_CLEAR')"`;
      const plan: [string, object, string][] = [
        ["skill_read", { id: skill!.id }, "BODY_VERSION_ONE"],
        ["skill_read", { id: skill!.id }, "BODY_VERSION_TWO"],
        ["skill_read", { id: skill!.id, path: "refs/sample.txt" }, "NESTED_REFERENCE"],
        ["skill_read", { id: skill!.id, path: "../outside" }, "PI_TOOL_UNAVAILABLE"],
        ["skill_run", { id: skill!.id, path: "check.mjs", args: ["workspace-result"] }, "SCRIPT_OK"],
        [echoes[0]!.name, {}, "provider-one"],
        [echoes[1]!.name, {}, "provider-two"],
        [echoes[0]!.name, { mode: "error" }, "MCP_TOOL_ERROR"],
        [echoes[0]!.name, { mode: "argv" }, "PI_MCP_PRIVATE_OUTPUT"],
        ["write", { path: path.join(f.root, "outside-job.txt"), content: "fixture" }, "PI_WORKSPACE_PATH_DENIED"],
        [shell, { command: shellCommand }, "PI_ENV_CLEAR"],
      ];
      if (round) {
        const last = body.messages.at(-1);
        assert.equal(last.role, "tool");
        assert.match(JSON.stringify(last.content), new RegExp(plan[round-1]![2]));
      }
      if (round === 1) fs.writeFileSync(doc, front + "BODY_VERSION_TWO");
      const step = plan[round++];
      const delta = step ? { tool_calls: [{ index: 0, id: "tool_" + round, type: "function",
        function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { content: "SDK_DONE" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [{ delta: { role: "assistant", ...delta }, finish_reason: null },
        { delta: {}, finish_reason: step ? "tool_calls" : "stop" }])
        res.write("data: " + JSON.stringify({ id: "offline", model: "offline", choices: [{ index: 0, ...choice }] }) + "\n\n");
      res.end("data: [DONE]\n\n");
    } catch (error) { errors.push(String(error)); res.writeHead(400).end(); }
  });
  const previous = process.env.NOWADAYS_HOST_PROBE;
  process.env.NOWADAYS_HOST_PROBE = probe;
  try {
    const target = await listen(upstream, 0, "127.0.0.1");
    await listen(f.app.server, 0, "127.0.0.1");
    const model = f.app.services.resources.create({ kind: "model", name: "fixture", config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:" + target } });
    addBinding(f, "chat_model", model.resourceId);
    f.app.services.activity.resume(f.roleId);
    await f.app.conversation.waitForIdle(f.roleId, 30000);
    const skill = f.app.services.resources.create({ kind: "skill", name: "shared", config: { sourcePath: path.dirname(doc) } });
    addBinding(f, "skill", skill.resourceId);
    external(f, "provider-one");
    external(f, "provider-two");
    const job = task(f, true);
    const tools = await f.app.services.pi.tools(f.roleId);
    const start = tools.find(t => t.name === "pi_task_start")!;
    const budget = f.app.services.autonomy.setBudget(f.roleId, { unlimited: false, dailyLimit: 100 });
    const started = await start.execute({ extId: "sample", prompt: "调用共享资源" }, { ...job, signal: new AbortController().signal });
    const { jobId } = started.adaptedResult as { jobId: string };
    assert.ok(jobId);
    for (let i=0; i<1200 && f.app.services.pi.running().length; i++) await delay(50);
    assert.deepEqual(errors, []);
    assert.equal(round, 12);
    assert.ok(!fs.existsSync(path.join(f.root, "outside-job.txt")));
    assert.equal(f.app.services.pi.running().length, 0);
    assert.equal(fs.readFileSync(path.join(f.app.services.extensions.work.workspace("sample", jobId), "output.txt"), "utf8"), "workspace-result");
    assert.deepEqual(fs.readFileSync(path.join(f.root, "dispatches"), "utf8").trim().split("\n"), ["provider-one", "provider-two", "provider-one", "provider-one"]);
    assert.equal(f.app.services.autonomy.getBudget(f.roleId).usedPoints - budget.usedPoints, 5);
  } finally {
    if (previous === undefined) delete process.env.NOWADAYS_HOST_PROBE;
    else process.env.NOWADAYS_HOST_PROBE = previous;
    await f.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("Skill 续用来自原父任务；新任务、目录穿越和包内 junction 不能取得停用或包外内容", async () => {
  const f = seat();
  try {
    const root = path.join(f.root, "skills");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "SKILL.md"), "第一版");
    fs.writeFileSync(path.join(f.root, "outside.txt"), "包外");
    fs.writeFileSync(path.join(f.root, "fake.mjs"), "console.log(1)");
    fs.symlinkSync(f.root, path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
    const skill = f.app.services.resources.create({ kind: "skill", name: "样本", config: { sourcePath: root } });
    addBinding(f, "skill", skill.resourceId);
    const job = task(f);
    const port = await listen(f.app.server, 0, "127.0.0.1");
    const { token, shared } = lease(f, job);
    const { id } = shared.briefs()[0]!;
    fs.writeFileSync(path.join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1));
    assert.equal((await post(port, token, "skill/read", { id, path: "large.txt" })).status, 404);
    for (const [route, relative] of [["skill/read","../app.sqlite"],["skill/read","outside/outside.txt"],
      ["skill/run","outside/fake.mjs"],["skill/run","SKILL.md"]] as const) {
      const r = await post(port, token, route, { id, path: relative });
      assert.equal(r.status, 404);
      assert.match(await r.text(), /PI_TOOL_UNAVAILABLE/);
    }
    assert.ok(withStorage(f, ({ business }) => business.listResourceContinuations(job.roleId, job.taskId)
      .some(r => r.resourceId === skill.resourceId && !r.endedAt)));
    disableResourceDirect(f, skill.resourceId);
    const fresh = lease(f, task(f));
    assert.deepEqual(fresh.shared.briefs(), []);
    assert.equal((await post(port, fresh.token, "skill/read", { id })).status, 404);
    const resumed = lease(f, { ...job, jobId: randomUUID() });
    assert.equal(resumed.shared.briefs()[0]!.id, id);
    fs.writeFileSync(path.join(root, "SKILL.md"), "修改后的内容");
    assert.deepEqual(await (await post(port, resumed.token, "skill/read", { id })).json(), { content: "修改后的内容" });
  } finally { await f.close(); }
});

test("MCP 目录与回执保留普通配置值，仍过滤环境和参数中的凭据", async () => {
  const f = seat();
  try {
    const publicText = "1 info dev 4096 none production interactive updated-at 12345678 disabled";
    const id = external(f, publicText, ["--max-tokens=4096", "--auth-mode=none", "--auth-mode=interactive",
      "--sort-key", "updated-at", "--token", "12345678", "--api-key=ARGV_FIXTURE_PROBE"],
      { DEBUG: "1", LOG_LEVEL: "info", NODE_ENV: "dev", STAGE: "production", AUTH_ENABLED: "disabled" });
    const port = await listen(f.app.server, 0, "127.0.0.1");
    const { token } = lease(f, task(f));
    const { tools } = await (await post(port, token, "list")).json() as { tools: McpToolInfo[] };
    const name = mapped(id, "echo");
    assert.deepEqual(tools.map(tool => tool.name), [name]);
    assert.ok(tools[0]!.description.includes(publicText));
    const call = async (mode: string) => (await post(port, token, "call", { name, arguments: { mode } })).json();
    assert.deepEqual(await call(""), { status: "success", result: [{ type: "text", text: publicText }] });
    for (const mode of ["private", "argv"])
      assert.deepEqual(await call(mode), { status: "success", result: { code: "PI_MCP_PRIVATE_OUTPUT" } });
    assert.deepEqual(await call("error"), { status: "failed", result: { code: "MCP_TOOL_ERROR" } });
  } finally { await f.close(); }
});

test("MCP 白名单映射、密钥过滤、额度拒绝、断连未知与派发前到期", async t => {
  const f = seat();
  try {
    const ordinary = external(f, "ordinary");
    const blocked = ["admin-tools", "nowadays-pi", "nowadays-local-tools", "nowadays-desktop-takeover"].map(name => external(f, name));
    const port = await listen(f.app.server, 0, "127.0.0.1");
    const job = task(f, true);
    const expiresAt = Date.now() + 60000;
    const { token } = lease(f, job, expiresAt);
    const catalog = await (await post(port, token, "list")).json() as {tools: McpToolInfo[]};
    const name = mapped(ordinary, "echo");
    assert.deepEqual(catalog.tools.map(t => t.name), [name]);
    assert.ok(!JSON.stringify(catalog).includes(probe));
    for (const n of [...deniedNames.map(n => mapped(ordinary,n)), ...blocked.map(id => mapped(id,"echo")), "echo"])
      assert.equal((await post(port, token, "call", { name: n, arguments: {} })).status, 404);
    const call = (mode = "") => post(port, token, "call", { name, arguments: { mode } });
    f.app.services.autonomy.setBudget(f.roleId, { dailyLimit: 2, unlimited: false });
    assert.deepEqual(await (await call("private")).json(), {status:"success", result:{code:"PI_MCP_PRIVATE_OUTPUT"}});
    assert.deepEqual(await (await call("disconnect")).json(), {status:"unknown", result:{code:"MCP_TOOL_OUTCOME_UNKNOWN"}});
    const exhausted = await call();
    assert.equal(exhausted.status, 409);
    assert.match(await exhausted.text(), /AUTONOMY_BUDGET_EXHAUSTED/);
    f.app.services.autonomy.setBudget(f.roleId, { dailyLimit: 3, unlimited: false });
    const connected = deferred<void>(), release = deferred<void>();
    const connect = McpToolClient.connect.bind(McpToolClient);
    t.mock.method(McpToolClient, "connect", async (...args: Parameters<typeof connect>) => {
      const client = await connect(...args);
      connected.resolve();
      await release.promise;
      return client;
    });
    const pending = call();
    try {
      await Promise.race([connected.promise, delay(10000, undefined, { ref:false }).then(() => { throw Error("CONNECT_TIMEOUT"); })]);
      assert.equal(f.app.services.autonomy.getBudget(f.roleId).usedPoints, 3);
      t.mock.method(Date, "now", () => expiresAt + 1);
    } finally { release.resolve(); }
    const revoked = await pending;
    assert.equal(revoked.status, 403);
    assert.match(await revoked.text(), /PI_LEASE_REVOKED/);
    await f.app.services.toolProxy.drain();
    assert.equal(f.app.services.autonomy.getBudget(f.roleId).usedPoints, 2);
    assert.deepEqual(fs.readFileSync(path.join(f.root,"dispatches"), "utf8").trim().split("\n"), ["ordinary","ordinary"]);
    withStorage(f, ({business}) => assert.deepEqual(business.db.prepare(
      "SELECT status FROM tool_calls WHERE task_id=? ORDER BY rowid").all(job.taskId),
      ["success","unknown","failed","failed"].map(status => ({status}))));
  } finally { await f.close(); }
});

test("读体期间吊销拒绝派发；配置变更用于下一次调用，已派发的晚到结果按原任务归档", async () => {
  const f = seat();
  const journal = path.join(f.root, "dispatches");
  try {
    const resourceId = external(f, "before");
    const job = task(f);
    const port = await listen(f.app.server, 0, "127.0.0.1");
    const token = lease(f, job).token;
    const name = mapped(resourceId, "echo");
    const catalog = await (await post(port, token, "list")).json() as {tools:McpToolInfo[]};
    assert.deepEqual(catalog.tools.map(t=>t.name), [name]);

    const reading = deferred<void>();
    f.app.server.once("request", () => reading.resolve());
    const response = deferred<http.IncomingMessage>();
    const slow = http.request({ hostname:"127.0.0.1", port, path:"/v1/internal/tool-proxy/call", method:"POST",
      headers:{authorization:"Bearer " + token, "content-type":"application/json"} }, response.resolve);
    slow.write('{"name":');
    await reading.promise;
    f.app.services.modelProxy.revoke(token);
    // 客户端尚未发送余下的请求体时就应收到拒绝。
    const denied = await Promise.race([response.promise, delay(3000, undefined, { ref:false }).then(() => {
      throw Error("PI_REVOCATION_WAITED_FOR_BODY");
    })]).finally(() => slow.end(JSON.stringify(name) + ',"arguments":{}}'));
    assert.equal(denied.statusCode, 403);
    let body = "";
    for await (const chunk of denied) body += chunk;
    assert.match(body, /PI_LEASE_REVOKED/);
    assert.equal(fs.existsSync(journal), false);

    const current = lease(f, job).token;
    await post(port, current, "list");
    const config = f.app.appStore.getResource(resourceId).config;
    f.app.appStore.updateResource({resourceId, config:{...config, args:[sample,"after",journal]}});
    const pending = post(port, current, "call", { name, arguments:{mode:"wait"} });
    for (let i=0; i<500 && !fs.existsSync(journal); i++) await delay(20);
    assert.equal(fs.readFileSync(journal,"utf8"), "after\n");
    f.app.conversation.finishTask({ ...job, status:"completed", endReason:"工程父任务已结束" });
    const later = await post(port, current, "call", { name, arguments:{} });
    assert.equal(later.status, 403);
    assert.match(await later.text(), /PI_LEASE_REVOKED/);
    f.app.services.modelProxy.revoke(current);
    fs.writeFileSync(journal + ".release", "");
    assert.deepEqual(await (await pending).json(), { status:"success", result:[{type:"text",text:"after"}] });
    withStorage(f, ({business}) => {
      assert.equal(business.getTask(job.roleId, job.taskId).status, "completed");
      assert.ok(business.listResourceContinuations(job.roleId,job.taskId)[0]!.endedAt);
      assert.deepEqual(business.db.prepare("SELECT status FROM tool_calls WHERE task_id=?").all(job.taskId), [{status:"success"}]);
    });
    assert.equal(fs.readFileSync(journal,"utf8"), "after\n");
  } finally { fs.writeFileSync(journal + ".release", ""); await f.close(); }
});
