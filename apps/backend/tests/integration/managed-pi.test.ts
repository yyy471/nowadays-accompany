import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { seedEngineeringPool } from "../fixtures/engineering-pool.js";
import type { ExtensionHost } from "../../src/application/extensions/extension-host.js";
import { setTimeout as delay } from "node:timers/promises";
import { McpToolClient, type PiReceipt } from "../../src/mcp/client.js";
import { ConversationStore } from "../../src/storage/conversation/conversation-store.js";
import { EngineeringJobs, engineeringWait } from "../../src/storage/conversation/engineering-jobs.js";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import type { ModelEvent, ModelRequest } from "../../src/domain/model.js";
import { createFixtureWithModel, deferred, ScriptedChatModel, withStorage } from "../fixtures/conversation-fixture.js";

const event = (name: string, args: object): ModelEvent[] => [
  { type: "tool_call", callId: randomUUID(), name, arguments: args }, { type: "completed", stopReason: "stop" },
];
const say = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const result = (r: ModelRequest) => r.messages.filter(m => m.role === "tool").at(-1)?.content ?? "";
test("草稿与发布目录隔离，拒绝穿越与 Windows junction 并保留已启用版本", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host: ExtensionHost = f.app.services.extensions;
  try {
    assert.throws(() => host.work.workspace("../outside"));
    const dir = host.work.workspace("project");
    assert.equal(dir, fs.realpathSync.native(path.join(f.app.config.appRoot, "extensions-work/project")));
    const files = { "manifest.json": JSON.stringify({ version: "v1", entry: "entry.mjs" }), "entry.mjs": "export default () => {}" };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    await host.publishWork("project");
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: "v2", entry: "entry.mjs" }));
    fs.mkdirSync(path.join(f.root, "outside"));
    fs.symlinkSync(path.join(f.root, "outside"), path.join(dir, "ui"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => host.publishWork("project"), { code: "EXTENSION_PATH_INVALID" });
    assert.equal(host.get("project").version, "v1");
    assert.equal(host.get("project").status, "enabled");
    fs.symlinkSync(dir, path.join(f.root, "extensions-work", "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => host.work.workspace("linked"), { code: "EXTENSION_PATH_INVALID" });
  } finally { await f.close(); }
});

const shell = process.platform === "win32" ? "powershell" : "bash";

test("单条用户消息触发 Pi SDK 首测失败、修复、自动回原窗热发布和试用", async t => {
  const listeners: Array<(receipt: PiReceipt) => void> = [];
  const connect = McpToolClient.connect.bind(McpToolClient);
  t.mock.method(McpToolClient, "connect", (...args: Parameters<typeof connect>) => {
    if (args[1]?.onPiTerminal) listeners.push(args[1].onPiTerminal);
    return connect(...args);
  });
  const gate = deferred<void>();
  const reached = deferred<void>();
  const finished = deferred<void>();
  const mockKey = "offline-probe-key-" + randomUUID();
  const manifest = { version: "v1", entry: "entry.mjs", ui: [] };
  const entry = 'export const label = "wrong";\nexport default (_ctx, api) => api.tools.register({name:"label",description:"标签",scope:"all_roles",inputSchema:{type:"object"}}, () => label);';
  // 第三个文件既验证工具业务逻辑，也检查在 Pi 内实际可见的进程环境与独立配置目录。
  const check = `import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";import { label } from "./entry.mjs";
assert.equal(process.env.NOWADAYS_PI_TEST_CREDENTIAL, undefined);assert.ok(Object.values(process.env).every(v=>!v.includes("offline-probe-key-")));
for(const f of fs.readdirSync(process.env.PI_CODING_AGENT_DIR,{recursive:true})) {
const p=path.join(process.env.PI_CODING_AGENT_DIR,f); if(fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).includes("offline-probe-key")); }
assert.equal(label,"verified-label","FIRST_TEST_FAILED");console.log("MOD_TEST_PASSED");`;
  const requestBodies: string[] = [];
  const toolOutputs: string[] = [];
  const attempts: string[] = [];
  const errors: string[] = [];
  const plan = [
    ["write", { path: "manifest.json", content: JSON.stringify(manifest) }],
    ["write", { path: "entry.mjs", content: entry }],
    ["write", { path: "test.mjs", content: check }],
    [shell, { command: "node test.mjs" }],
    ["read", { path: "entry.mjs" }],
    ["edit", { path: "entry.mjs", edits: [{ oldText: '"wrong"', newText: '"verified-label"' }] }],
    [shell, { command: "node test.mjs" }],
  ] as const;
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      attempts.push(req.url!);
      assert.equal(req.headers.authorization, "Bearer " + mockKey);
      assert.equal(body.model, "offline-pi");
      toolOutputs.push(JSON.stringify(body.messages.at(-1)));
      const i = requestBodies.push(JSON.stringify(body)) - 1;
      if (!i) { reached.resolve(); await gate.promise; }
      const call = plan[i];
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + i, type: "function",
        function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: "assistant", content: "工程复测完成" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? "tool_calls" : "stop" }]) {
        res.write("data: " + JSON.stringify({ id: "offline", model: body.model, choices: [{ index: 0, ...choice }],
          usage: { prompt_tokens: 13, completion_tokens: 7 } }) + "\n\n");
      }
      res.end("data: [DONE]\n\n");
      if (!call) finished.resolve();
    } catch (error) { errors.push(String(error)); res.writeHead(500).end(); }
  });
  process.env.NOWADAYS_PI_TEST_CREDENTIAL = mockKey;
  const upstreamPort = await listen(upstream, 0, "127.0.0.1");
  let jobId = "";
  let inspected = "";
  let phase: "result" | "inspect" | "published" | "tested" | "ordinary" | "done" = "result";
  function finish(request: ModelRequest): ModelEvent[] {
    switch (phase) {
      case "result":
        assert.ok(request.system.includes(jobId) && request.system.includes("工程复测完成"));
        phase = "inspect"; return event("pi_task_result", { jobId });
      case "inspect": {
        inspected = result(request);
        if (inspected.includes('"state":"running"')) { phase = "result"; return say("工程还在收尾"); }
        phase = "published";
        return event("app_extension_publish_work", { extId: "sample", jobId });
      }
      case "published": phase = "tested"; return event("ext_sample__label", {});
      case "tested": phase = "ordinary"; return say("已发布");
      case "ordinary": phase = "done"; return event("ext_sample__label", {});
      case "done": return say("已收到");
    }
  }
  const scripts: ConstructorParameters<typeof ScriptedChatModel>[0] = [
    say("先等待用户。"),
    event("pi_task_start", { extId: "sample", prompt: "制作标签扩展并运行测试。" }),
    r => { inspected = result(r); jobId = inspected.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] ?? ""; return say("工程已接单"); },

    ...Array.from({ length: 60 }, () => finish),
  ];
  const model = new ScriptedChatModel(scripts);
  const f = createFixtureWithModel(model, { disablePresetAssistant: false, presetAssetsDir: "tests/fixtures" });
  const { app } = f;
  async function send(role: string, window: string, content: string) {
    app.conversation.submitMessage(role, window, { content, sourcePlatform: "nowadays", submissionId: randomUUID() });
    await app.conversation.waitForIdle(role, 30000);
  }
  try {
    await listen(app.server, 0, "127.0.0.1");
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const window = app.services.roles.initializeRole(id).defaultWindowId;
    const resource = app.services.resources.create({ kind: "model", name: "离线 Pi", secret: mockKey,
      config: { baseUrl: "http://127.0.0.1:" + upstreamPort + "/v1", protocol: "openai-chat" } });
    const [piBinding] = app.services.resources.listBindings(id);
    seedEngineeringPool(app, resource.resourceId, "offline-pi");
    app.services.engineeringPool.update({ allowShell: true });
    assert.equal(piBinding?.enabled, true);
    assert.equal(app.services.resources.getView(piBinding.resourceId).adminSeatOnly, true);
    app.services.resources.replaceBindings(id, [
      { resourceId: resource.resourceId, capability: "chat_model", enabled: true, modelName: "offline-pi" },
      { resourceId: piBinding.resourceId, capability: "mcp", enabled: piBinding.enabled },
    ]);
    app.services.activity.resume(id);
    await app.conversation.waitForIdle(id, 30000);
    assert.equal(app.services.autonomy.listWakes(id)[0]?.status, "completed");
    const previousConnection = listeners.at(-1);
    assert.ok(previousConnection);
    app.services.activity.requestStop(id);
    app.services.activity.resume(id);
    await send(id, window, "开发并测试标签工具");
    assert.deepEqual(model.requests[0]!.tools.map(t => t.name).filter(name => name.startsWith("pi_task_")).sort(),
      ["pi_task_cancel", "pi_task_result", "pi_task_start", "pi_task_status"]);
    assert.ok(jobId && inspected.includes("running"), inspected);
    const timeout = (ms: number) => delay(ms, false, { ref: false });
    assert.ok(await Promise.race([reached.promise.then(() => true), timeout(25000)]), "Pi 未到达模拟模型：" + errors.join());
    const parent = app.conversation.listTasks(id).find(t => t.waitReason === "AWAITING_ENGINEERING_JOB");
    assert.ok(parent);
    assert.notEqual(listeners.at(-1), previousConnection);
    previousConnection({jobId,state:"failed",summary:"旧连接伪造的回执"});
    listeners.at(-1)!({jobId:randomUUID(),state:"completed",summary:"非本连接持有的工程"});
    assert.equal(app.services.pi.running()[0]?.jobId, jobId);
    gate.resolve();
    assert.ok(await Promise.race([finished.promise.then(() => true), timeout(30000)]), "Pi 调试未结束，轮数 " + requestBodies.length);
    assert.match(requestBodies[0]!, /Nowadays Mod 工程规范/);
    assert.match(toolOutputs[4]!, /FIRST_TEST_FAILED/);
    assert.match(toolOutputs[7]!, /MOD_TEST_PASSED/);
    assert.deepEqual(fs.readdirSync(app.services.extensions.work.workspace("sample", jobId)).sort(), ["entry.mjs", "manifest.json", "test.mjs"]);
    for (let i = 0; i < 400 && !app.services.messages.list(id, window, null, 20).items.some(m => m.content === "已发布"); i++)
      await delay(50);
    assert.ok(app.services.messages.list(id, window, null, 20).items.some(m => m.content === "已发布"), JSON.stringify(model.requests.at(-1)?.messages.slice(-1)));
    assert.equal(app.conversation.listTasks(id).find(t => t.taskId === parent.taskId)?.status, "completed");
    withStorage({ ...f, roleId: id }, ({business}) => {
      assert.deepEqual(business.db.prepare(`SELECT DISTINCT m.purpose FROM engineering_wakes w
        JOIN model_calls m USING(execution_id) WHERE w.job_id=?`).all(jobId), [{purpose:"user_chat"}]);
    });
    assert.match(inspected, /completed/);
    assert.ok(model.requests.at(-2)!.tools.some(t => t.name === "ext_sample__label"));
    assert.match(result(model.requests.at(-1)!), /verified-label/);
    app.services.activity.requestStop(id);
    withStorage(f, storage => storage.business.ensureMcpBinding(f.roleId, piBinding.resourceId));
    await send(f.roleId, f.windowId, "使用公开标签");
    assert.ok(!model.requests.at(-2)!.tools.some(t => t.name === "app_extension_publish_work"));
    assert.ok(!model.requests.at(-2)!.tools.some(t => t.name.includes("pi_task_")));
    assert.match(result(model.requests.at(-1)!), /verified-label/);
    const rows = app.appStore.db.prepare("SELECT * FROM token_usage_records WHERE source_call_id LIKE 'pi:%'").all() as
      { status: string; input_tokens: number; output_tokens: number; role_id: string }[];
    assert.equal(attempts.length, 8);
    assert.equal(rows.length, attempts.length);
    assert.equal(rows.filter(r => r.status === "succeeded").length, 8);
    assert.equal(rows.filter(r => r.status === "failed").length, 0);
    assert.ok(rows.filter(r => r.status === "succeeded").every(r => Number(r.input_tokens) === 13 && Number(r.output_tokens) === 7 && r.role_id === id));
    assert.deepEqual(errors, []);
  } finally { delete process.env.NOWADAYS_PI_TEST_CREDENTIAL; gate.resolve(); await f.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("同名工程分别发布自己的内容；重复终态与归属不匹配不能改写结果", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const ids = [randomUUID(), randomUUID()];
  try {
    for (const [index, jobId] of ids.entries()) {
      const version = "v" + index;
      const dir = host.work.workspace("sample", jobId);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({version, entry:"entry.mjs"}));
      fs.writeFileSync(path.join(dir, "entry.mjs"), "export default () => {}; // " + version);
      withStorage(f, ({business}) => {
        const task = business.createTask({roleId:f.roleId,goal:"制作样例"});
        const jobs = new EngineeringJobs(business.db);
        jobs.register({jobId, extId:"sample", roleId:f.roleId, windowId:f.windowId, taskId:task.taskId, modelResourceId:null, modelName:null,
          workDir:dir, origin:"user", title:"样例", startedAt:new Date().toISOString()});
        business.db.exec("CREATE TEMP TRIGGER reject_wake BEFORE INSERT ON engineering_wakes BEGIN SELECT RAISE(ABORT, 'TEST_WAKE_FAILURE'); END");
        assert.throws(() => jobs.settle(jobId,"completed",version,new Date().toISOString()), /TEST_WAKE_FAILURE/);
        assert.equal(jobs.find(jobId)?.status,"running");
        business.db.exec("DROP TRIGGER reject_wake");
        assert.ok(jobs.settle(jobId,"completed",version,new Date().toISOString()));
        assert.ok(!jobs.settle(jobId,"failed","晚到错误",new Date().toISOString()));
        assert.equal(jobs.find(jobId)?.summary,version);
        assert.deepEqual(business.db.prepare("SELECT wake_id FROM engineering_wakes WHERE job_id=?").all(jobId),[{wake_id:"pi:"+jobId}]);
      });
    }
    for (const [index, jobId] of [...ids.entries()].reverse()) {
      assert.throws(() => f.app.services.pi.publishTarget(f.roleId, jobId,"other"),{code:"PI_JOB_TARGET_INVALID"});
      await host.publishWork(f.app.services.pi.publishTarget(f.roleId, jobId), jobId);
      assert.equal(host.get("sample").version,"v"+index);
      assert.match(JSON.stringify(host.source({extId:"sample",file:"entry.mjs"})),new RegExp("// v"+index));
    }
    const dir = host.work.workspace("sample", ids[0]);
    fs.renameSync(dir, dir + "-moved");
    fs.symlinkSync(dir + "-moved", dir, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => host.publishWork("sample",ids[0]),{code:"EXTENSION_PATH_INVALID"});
  } finally { await f.close(); }
});

test("重启收敛遗留 running，停机保留 wake，恢复时用户新消息先于工程续行", async () => {
  const model = new ScriptedChatModel([say("等待用户"),say("先处理新的消息"),say("旧工程结果待核查")]);
  const f = createFixtureWithModel(model, {disablePresetAssistant:false,presetAssetsDir:"tests/fixtures"});
  const {app} = f;
  const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const windowId = app.services.roles.initializeRole(id).defaultWindowId;
  const main = {...f,roleId:id,windowId};
  let restarted: ReturnType<typeof createBackendApp> | undefined;
  try {
    const resource = app.services.resources.create({kind:"model",name:"离线模型",config:{protocol:"openai-chat",baseUrl:"http://127.0.0.1:1"}});
    app.services.resources.replaceBindings(id,[{resourceId:resource.resourceId,capability:"chat_model",enabled:true,modelName:"offline"}]);
    app.services.activity.resume(id);
    await app.conversation.waitForIdle(id);
    app.services.activity.requestStop(id);
    const jobId = randomUUID();
    const original = app.conversation.submitMessage(id,windowId,{content:"检查已有工程",sourcePlatform:"nowadays",submissionId:randomUUID()});
    const taskId = withStorage(main,({business}) => {
      // 模拟 Pi 已接单、前台尚未提交首条回复时进程消失的持久状态。
      const store = new ConversationStore(business.db,id);
      const {execution} = store.beginExecution({windowId})!;
      const {taskId} = business.createTask({roleId:id,goal:"检查已有工程",initiatorExecutionId:execution.executionId});
      business.linkExecutionTask({roleId:id,taskId,executionId:execution.executionId,relation:"initiates"});
      new EngineeringJobs(business.db).register({jobId,roleId:id,taskId,windowId,origin:"user",extId:"probe",modelResourceId:null,modelName:null,
        title:"速查",workDir:app.services.extensions.work.workspace("probe",jobId),startedAt:new Date().toISOString()});
      return taskId;
    });
    await app.close();
    restarted = createBackendApp(app.config,{modelPortFactory:()=>model,disableMemoryRuntime:true});
    assert.equal(model.requests.length,1);
    withStorage(main,({business}) => {
      const job = new EngineeringJobs(business.db).find(jobId);
      assert.equal(job?.status,"interrupted_unknown");
      assert.ok(job.finishedAt);
      assert.equal(business.getTask(id,taskId).waitReason,engineeringWait);
    });
    restarted.conversation.submitMessage(id,windowId,{content:"聊点别的",sourcePlatform:"nowadays",submissionId:randomUUID()});
    restarted.services.activity.resume(id);
    await restarted.conversation.waitForIdle(id,20000);
    assert.equal(model.requests.length,3);
    assert.ok(!model.requests[1]!.system.includes(jobId));
    assert.ok(model.requests[2]!.system.includes(jobId));
    const messages = restarted.services.messages.list(id,windowId,null,20).items;
    const first = messages.find(m=>m.content==="先处理新的消息");
    const second = messages.find(m=>m.content==="旧工程结果待核查");
    assert.ok(first && second && first.sequence < second.sequence);
    withStorage(main,({business}) => {
      assert.equal(business.getTask(id,taskId).status,"completed");
      assert.deepEqual(business.db.prepare("SELECT COUNT(*) n FROM engineering_jobs").get(),{n:1});
      const originalDelivery = business.db.prepare(`SELECT w.execution_id FROM engineering_wakes w JOIN messages m
        ON w.execution_id=m.processed_by_execution_id WHERE w.job_id=? AND m.message_id=?`).get(jobId,original.message.messageId);
      assert.ok(originalDelivery, "原交办仅由工程回执执行结算");
    });
  } finally { await restarted?.close(); await f.close(); }
});

test("自主工程在前台提交前结束，只在自主窗口领取一次并沿用自主预算", async () => {
  const allowReply = deferred<void>();
  const reached = deferred<void>();
  const model = new ScriptedChatModel([event("pi_task_start",{extId:"journal",prompt:"检查日记扩展"}),
    say("已分派工程"),say("已收下工程结果")]);
  const f = createFixtureWithModel({async *stream(request) {
    if (model.requests.length === 1) { reached.resolve(); await allowReply.promise; }
    yield* model.stream(request);
  }}, {disablePresetAssistant:false,presetAssetsDir:"tests/fixtures"});
  const upstream = http.createServer((req,res) => {
    req.resume();
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.end("data: "+JSON.stringify({id:"offline",model:"offline",choices:[{index:0,delta:{role:"assistant",content:"核查完成"},finish_reason:"stop"}]})+"\n\ndata: [DONE]\n\n");
  });
  try {
    const {app} = f;
    const port = await listen(upstream,0,"127.0.0.1");
    await listen(app.server,0,"127.0.0.1");
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const windowId = app.services.roles.initializeRole(id).defaultWindowId;
    const main = {...f,roleId:id,windowId};
    const resource = app.services.resources.create({kind:"model",name:"离线模型",config:{protocol:"openai-chat",baseUrl:"http://127.0.0.1:"+port}});
    const [pi] = app.services.resources.listBindings(id);
    seedEngineeringPool(app, resource.resourceId);
    app.services.resources.replaceBindings(id,[{resourceId:resource.resourceId,capability:"chat_model",enabled:true,modelName:"offline"},
      {resourceId:pi!.resourceId,capability:"mcp",enabled:true}]);
    app.services.activity.resume(id);
    assert.ok(await Promise.race([reached.promise.then(()=>true),delay(15000,false,{ref:false})]));
    for (let i=0;i<300 && app.services.pi.running().length;i++) await delay(40);
    const job = withStorage(main,({business}) => business.db.prepare(
      "SELECT origin,status,job_id,task_id,window_id FROM engineering_jobs").get()) as Record<string,string>;
    assert.equal(job.status,"completed");
    assert.equal(job.origin,"autonomous");
    assert.notEqual(job.window_id,windowId);
    assert.equal(model.requests.length,1);
    allowReply.resolve();
    await app.conversation.waitForIdle(id,30000);
    assert.equal(model.requests.length,3);
    assert.ok(model.requests[2]!.system.includes(job.job_id!));
    assert.ok(model.requests[2]!.tools.some(t=>t.name==="autonomy_share"));
    const [activity] = app.services.autonomy.listActivities(id);
    assert.equal(activity?.summary,"已收下工程结果");
    assert.equal(activity.sharedMessageId,null);
    assert.ok(app.services.messages.list(id,job.window_id!,null,20).items.some(m=>m.content===activity.summary));
    assert.ok(!app.services.messages.list(id,windowId,null,20).items.some(m=>m.content===activity.summary));
    withStorage(main,({business}) => assert.deepEqual(business.db.prepare(`SELECT DISTINCT m.purpose
      FROM engineering_wakes w JOIN model_calls m USING(execution_id) WHERE w.job_id=?`).all(job.job_id),[{purpose:"autonomous"}]));
  } finally { allowReply.resolve(); await f.close(); upstream.closeAllConnections(); await new Promise<void>(r=>upstream.close(()=>r())); }
});

for (const reason of ["AWAITING_USER_INPUT", "CIRCUIT_BREAKER"]) {
  test("工程回执等候明确恢复：" + reason, async () => {
    const pause = reason === "AWAITING_USER_INPUT" ? event("task_pause", { reason: "等待确认" })
      : [...Array.from({ length: 3 }, () => event("pi_task_status", { jobId: randomUUID() })[0]!), { type: "completed" as const, stopReason: "stop" as const }];
    const model = new ScriptedChatModel([say("就绪"), event("pi_task_start", { extId: "sample", prompt: "准备工程" }),
      pause, say("等你确认"), say("工程回执已收到")]);
    const f = createFixtureWithModel(model, { disablePresetAssistant: false, presetAssetsDir: "tests/fixtures" });
    const upstream = http.createServer(req => req.resume());
    try {
      const port = await listen(upstream, 0, "127.0.0.1");
      const { app } = f;
      await listen(app.server, 0, "127.0.0.1");
      const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
      const windowId = app.services.roles.initializeRole(roleId).defaultWindowId;
      const main = { ...f, roleId, windowId };
      const resource = app.services.resources.create({ kind: "model", name: "离线", config: {
        protocol: "openai-chat", baseUrl: "http://127.0.0.1:" + port } });
      const [pi] = app.services.resources.listBindings(roleId);
      seedEngineeringPool(app, resource.resourceId);
      app.services.resources.replaceBindings(roleId, [{ resourceId: pi!.resourceId, capability: "mcp" },
        { resourceId: resource.resourceId, capability: "chat_model", modelName: "offline" }]);
      app.services.activity.resume(roleId);
      await app.conversation.waitForIdle(roleId, 30000);
      const send = (content: string) => app.conversation.submitMessage(roleId, windowId,
        { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
      send("委派后等我决定");
      await app.conversation.waitForIdle(roleId, 30000);
      const [job] = app.services.pi.running();
      assert.ok(job);
      const parent = app.conversation.listTasks(roleId).find(t => t.waitReason === reason);
      assert.ok(parent);
      const count = model.requests.length;
      await app.services.pi.cancel(job.jobId);
      for (let i = 0; i < 150 && app.services.pi.running().length; i++) await delay(20);
      await app.conversation.waitForIdle(roleId, 30000);
      assert.equal(app.conversation.getTask(roleId, parent.taskId).waitReason, reason);
      assert.equal(model.requests.length, count);
      withStorage(main, ({ business }) => assert.deepEqual(business.db.prepare(
        "SELECT execution_id FROM engineering_wakes WHERE job_id=?").get(job.jobId), { execution_id: null }));
      send("可以继续");
      await app.conversation.waitForIdle(roleId, 30000);
      assert.ok(model.requests.at(-1)!.system.includes(job.jobId));
      assert.equal(app.conversation.getTask(roleId, parent.taskId).status, "completed");
    } finally {
      await f.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
}

test("工程登记失败回收本次草稿，保留已有工程目录", async t => {
  const model = new ScriptedChatModel([say("就绪")]);
  const f = createFixtureWithModel(model, { disablePresetAssistant: false, presetAssetsDir: "tests/fixtures" });
  const { app } = f;
  try {
    await listen(app.server, 0, "127.0.0.1");
    const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const windowId = app.services.roles.initializeRole(roleId).defaultWindowId;
    const resource = app.services.resources.create({ kind: "model", name: "模型", config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1" } });
    const [pi] = app.services.resources.listBindings(roleId);
    app.services.resources.replaceBindings(roleId, [{ resourceId: resource.resourceId, capability: "chat_model", modelName: "offline" },
      { resourceId: pi!.resourceId, capability: "mcp" }]);
    seedEngineeringPool(app, resource.resourceId);
    app.services.activity.resume(roleId);
    await app.conversation.waitForIdle(roleId, 30000);
    const task = withStorage({ ...f, roleId }, ({ business }) => business.createTask({ roleId, goal: "启动检查" }));
    const retained = randomUUID();
    const existing = app.services.extensions.work.workspace("other", retained);
    const root = path.dirname(path.dirname(existing));
    t.mock.method(EngineeringJobs.prototype, "register", () => { throw Error("TEST_REGISTER_FAILED"); });
    const start = (await app.services.pi.tools(roleId)).find(tool => tool.name === "pi_task_start")!;
    await assert.rejects(start.execute({ extId: "sample", prompt: "检查" }, { roleId, windowId,
      taskId: task.taskId, executionId: randomUUID(), signal: new AbortController().signal }), /TEST_REGISTER_FAILED/);
    assert.deepEqual(fs.readdirSync(root), [retained]);
  } finally { await f.close(); }
});

test("单个通知监听者异常不影响其他监听者与工程收尾调度", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const pi = f.app.services.pi;
    const roleId = f.roleId;
    const jobId = randomUUID();
    const taskId = withStorage({ ...f, roleId }, ({ business }) => {
      const task = business.createTask({ roleId, goal: "通知隔离" });
      new EngineeringJobs(business.db).register({
        jobId, roleId, taskId: task.taskId, windowId: f.windowId, origin: "user", extId: "probe",
        title: "通知隔离", workDir: f.app.services.extensions.work.workspace("probe", jobId),
        startedAt: new Date().toISOString(), modelResourceId: null, modelName: null,
      });
      return task.taskId;
    });
    const internals = pi as unknown as {
      jobs: Map<string, {
        roleId: string; taskId: string; owner: unknown; connection: Promise<unknown>;
        token: string; timer: NodeJS.Timeout;
      }>;
      schedule: (roleId: string) => void;
      finish: (id: string, status: string, summary: string) => void;
    };
    const scheduled: string[] = [];
    internals.schedule = id => scheduled.push(id);
    internals.jobs.set(jobId, {
      roleId, taskId, owner: undefined, connection: Promise.resolve(),
      token: "unused", timer: setTimeout(() => undefined, 60_000).unref(),
    });
    const seen: string[] = [];
    const stopThrowing = pi.subscribe(() => {
      seen.push("throwing");
      throw new Error("SSE_SUBSCRIBER_FAILED");
    });
    const stopCounting = pi.subscribe(() => { seen.push("counting"); });
    try {
      internals.finish(jobId, "completed", "完成");
    } finally {
      stopThrowing();
      stopCounting();
    }
    assert.deepEqual(seen, ["throwing", "counting"]);
    assert.deepEqual(scheduled, [roleId]);
    withStorage({ ...f, roleId }, ({ business }) => {
      assert.equal(new EngineeringJobs(business.db).find(jobId)?.status, "completed");
    });
  } finally { await f.close(); }
});

test("New jobs read the current shell setting for the same parent task", async t => {
  const f = createFixtureWithModel(new ScriptedChatModel([say("done")]), { disablePresetAssistant: false, presetAssetsDir: "tests/fixtures" });
  const { app } = f;
  try {
    await listen(app.server, 0, "127.0.0.1");
    const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const windowId = app.services.roles.initializeRole(roleId).defaultWindowId;
    const resource = app.services.resources.create({ kind: "model", name: "offline", config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1" } });
    seedEngineeringPool(app, resource.resourceId);
    app.services.activity.resume(roleId);
    await app.conversation.waitForIdle(roleId, 30000);
    const task = withStorage({ ...f, roleId }, ({ business }) => business.createTask({ roleId, goal: "snapshot" }));
    const start = (await app.services.pi.tools(roleId)).find(tool => tool.name === "pi_task_start")!;
    app.services.engineeringPool.update({ allowShell: true });
    const entered = deferred<void>(), release = deferred<void>();
    const original = McpToolClient.prototype.callTool;
    let starts = 0;
    const call = t.mock.method(McpToolClient.prototype, "callTool", async function(this: McpToolClient, ...args: Parameters<typeof original>) {
      if (args[0] === "pi_task_start" && ++starts === 1) { entered.resolve(); await release.promise; }
      return original.apply(this, args);
    });
    const context = { roleId, windowId, taskId: task.taskId, executionId: randomUUID(), signal: new AbortController().signal };
    const first = start.execute({ extId: "sample", prompt: "first" }, context);
    await entered.promise;
    app.services.engineeringPool.update({ allowShell: false });
    try { await start.execute({ extId: "sample", prompt: "second" }, context); }
    finally { release.resolve(); }
    await first;
    const snapshots = call.mock.calls.filter(c => c.arguments[0] === "pi_task_start").map(c => c.arguments[2]!.meta!.nowadays as { allowShell: boolean });
    assert.deepEqual(snapshots.map(m => m.allowShell), [true, false]);
  } finally { await f.close(); }
});
