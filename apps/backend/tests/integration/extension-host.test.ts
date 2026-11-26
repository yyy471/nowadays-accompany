import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import { ExtensionHost, type Notice } from "../../src/application/extensions/extension-host.js";
import type { ModelEvent } from "../../src/domain/model.js";
import { createFixtureWithModel, ScriptedChatModel } from "../fixtures/conversation-fixture.js";
import { seedLegacyPresetAssistant } from "../fixtures/legacy-role-fixture.js";
import { createAdminTools } from "../../src/application/role/admin-tools.js";

const plugin = `
import version from "./helper.mjs";
export default async (ctx, api) => {
  const register = (name, scope, fn) => api.tools.register({name, scope, description:name, inputSchema:{type:"object"}}, fn);
  register("hello","all_roles",async (args, context) => {
    const count = (await api.kv.get("count") ?? 0) + 1;
    await api.kv.set("count", count);
    if (context.autonomous) await api.notify({message:"autonomous_call", data:context.roleId});
    return {version, count, roleId:context.roleId};
  });
  register("private","admin_only",()=>version);
  register("slow","all_roles",async () => {
    await api.notify({message:"started"});
    await new Promise(resolve => setTimeout(resolve, 450));
    return version;
  });
  register("hang","all_roles",()=>{while(true){}});
  register("crash","all_roles",()=>{setTimeout(()=>Promise.reject(Error("offline crash")),10);return true});
  for (const name of ["dialogue_batch","role_exchange"]) {
    api.events.on(name, data => api.notify({message:name, data}));
  }
  api.onDispose(async ()=>{
    await new Promise(resolve=>setTimeout(resolve,10));
    await api.notify({message:"disposed",data:version});
  });
};`;
function source(extId: string, version: string, body = plugin) {
  return { extId, manifest: {version, entry:"entry.mjs", ui:[{slot:"page",file:"ui/index.html"}]},
    files: {"entry.mjs":body,"helper.mjs":"export default " + JSON.stringify(version),"ui/index.html":"<p>extension</p>"} };
}
async function until(check: () => boolean, message: string) {
  const end = Date.now() + 10_000;
  while (!check() && Date.now() < end) await sleep(15);
  assert.ok(check(), message);
}
function gone(pid: number | null) {
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), {code:"ESRCH"});
}
function external(root: string) {
  const repo = path.resolve(import.meta.dirname, "../../../..");
  assert.ok(path.relative(repo, fs.realpathSync(root)).startsWith("..") || path.parse(repo).root !== path.parse(root).root);
  assert.throws(() => createRequire(path.join(root, "entry.mjs")).resolve("cordis"), {code:"MODULE_NOT_FOUND"});
}
const event = (name: string, args: object): ModelEvent[] => [
  {type:"tool_call",callId:randomUUID(),name,arguments:args}, {type:"completed",stopReason:"stop"},
];
const reply: ModelEvent[] = [{type:"text_delta",text:"离线回执已收到。"}, {type:"completed",stopReason:"stop"}];

test("沙箱动作只调用精确登记的处理器，校验版本、JSON 字节数并按原进程排空", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const notices: string[] = [];
  host.onNotice(n => notices.push(n.message));
  const body = `
    import version from './helper.mjs';
    export default (ctx, api) => {
      api.tools.register({name:'private',scope:'admin_only',description:'private',inputSchema:{type:'object'}}, () => 99);
      api.events.on('dialogue_batch', () => api.notify({message:'unexpected'}));
      const off = api.ui.onAction('removed', () => true);
      off();
      api.ui.onAction('write', async p => { await api.kv.set('value', p); return version; });
      api.ui.onAction('read', () => api.kv.get('value'));
      api.ui.onAction('fail', () => { throw Error('action failed'); });
      api.ui.onAction('drain', async () => {
        await api.notify({message:'started-' + version});
        if (version === 'v1') {
          while (await api.kv.get('value') !== 'release') await new Promise(r => setTimeout(r, 10));
        } else await new Promise(r => setTimeout(r, 250));
        await api.notify({message:'finished-' + version});
        return version;
      });
      ctx.effect(() => () => api.notify({message:'disposed-' + version}));
    }`;
  try {
    const port = await listen(f.app.server, 0, "127.0.0.1");
    const post = async (version: string, action: string, payload: unknown = null) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/extensions/counter/ui-action`, {
        method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({version, action, payload})
      });
      const value = await res.json() as {data?: unknown; error?: {code: string}};
      return [res.status, value.error?.code ?? value.data];
    };
    const first = await host.upsert(source("counter", "v1", body));
    for (const name of ["private", "dialogue_batch", "removed", "Write", "constructor"])
      assert.deepEqual(await post("v1", name), [404, "EXTENSION_UI_ACTION_NOT_FOUND"]);
    assert.deepEqual(await post("v1", "fail"), [422, "EXTENSION_UI_ACTION_FAILED"]);
    assert.deepEqual(await post("v1", "/v1/roles"), [400, "INVALID_REQUEST"]);
    assert.deepEqual(await post("", "write"), [400, "INVALID_REQUEST"]);
    assert.deepEqual(await post("v1", "write", "界".repeat(5461)), [413, "PAYLOAD_TOO_LARGE"]);
    const value = {label:"界", count:1};
    assert.deepEqual(await post("v1", "write", value), [200, "v1"]);
    assert.deepEqual(await post("v1", "read"), [200, value]);
    const oldCall = post("v1", "drain");
    await until(() => notices.includes("started-v1"), "旧版动作已派发");
    const upgrade = host.upsert(source("counter", "v2", body));
    await until(() => host.get("counter").version === "v2", "新版已接手");
    assert.deepEqual(await post("v1", "write", "stale"), [409, "EXTENSION_VERSION_MISMATCH"]);
    assert.deepEqual(await post("v2", "read"), [200, value]);
    assert.deepEqual(await post("v2", "write", "release"), [200, "v2"]);
    assert.deepEqual(await oldCall, [409, "EXTENSION_VERSION_MISMATCH"]);
    const second = await upgrade;
    gone(first.pid);
    const inflight = post("v2", "drain");
    await until(() => notices.includes("started-v2"), "停用前动作已派发");
    const disable = host.toggle("counter", "disable");
    await until(() => host.get("counter").status === "disabled", "槽位已撤销");
    assert.deepEqual(await post("v2", "write"), [409, "EXTENSION_UNAVAILABLE"]);
    assert.deepEqual(await inflight, [409, "EXTENSION_VERSION_MISMATCH"]);
    await disable;
    gone(second.pid);
    assert.deepEqual(notices, ["started-v1","finished-v1","disposed-v1","started-v2","finished-v2","disposed-v2"]);
  } finally { await f.close(); }
});

test("Pi 的双向槽位契约与两项主角色发布工具逐字一致", async () => {
  const {default: install, uiActionContract} = await import(new URL("../../../pi-mcp/src/extensions/nowadays-mod.mjs", import.meta.url).href);
  let prompt = "";
  install({on: (name: string, hook: (e: {systemPrompt: string}) => {systemPrompt: string}) => {
    assert.equal(name, "before_agent_start");
    prompt = hook({systemPrompt: "base"}).systemPrompt;
  }});
  assert.ok(prompt.includes(uiActionContract));
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const tools = createAdminTools({...f.app.services, now: () => new Date()});
    for (const name of ["app_extension_upsert", "app_extension_publish_work"])
      assert.ok(tools.find(t => t.name === name)?.description.includes(uiActionContract), name);
  } finally { await f.close(); }
});

test("主角色在真实对话图中创建扩展，同一任务调用新工具，普通角色仅有公开工具并触发真实批次与往来事件", async () => {
  const model = new ScriptedChatModel([
    event("app_extension_upsert", source("demo","v1")), event("ext_demo__hello",{}), reply,
    event("ext_demo__hello",{}), reply, event("ext_demo__hello",{}), reply, reply, reply,
  ]);
  const f = createFixtureWithModel(model, {batchDelayMs:60});
  const {app, roleId, windowId} = f;
  try {
    external(f.root);
    seedLegacyPresetAssistant(app.config);
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const seat = app.services.roles.initializeRole(id);
    app.services.resources.replaceBindings(id, [{resourceId:app.services.resources.listBindings(roleId)[0]!.resourceId,
      capability:"chat_model",enabled:true,modelName:"offline"}]);
    app.services.activity.resume(id);
    const send = async (who: string, win: string, content: string) => {
      app.conversation.submitMessage(who, win, {content,sourcePlatform:"nowadays",submissionId:randomUUID()});
      await app.conversation.waitForIdle(who);
    };
    const notices: Notice[] = [];
    app.services.extensions.onNotice(n => notices.push(n));
    await send(id,seat.defaultWindowId,"创建工具并试用");
    assert.ok(model.requests[0]!.tools.some(t=>t.name === "app_extension_upsert"));
    assert.ok(model.requests[0]!.tools.some(t=>t.name === "app_extension_source"));
    assert.ok(model.requests[1]!.tools.some(t=>t.name === "ext_demo__private"));
    assert.match(JSON.stringify(model.requests[2]!.messages), /v1/);
    // 停用席位活动以保留批次唤醒，避免该唤醒消费普通角色的离线脚本。
    app.services.activity.requestStop(id);
    await send(roleId,windowId,"试用工具");
    const names = model.requests[3]!.tools.map(t=>t.name);
    assert.ok(names.includes("ext_demo__hello"));
    assert.ok(!names.some(name=>name.startsWith("app_extension") || name === "ext_demo__private"));
    const received = model.requests[4]!.messages.filter(m=>m.role === "tool").at(-1);
    assert.ok(received);
    assert.match(JSON.stringify(received), /v1/);
    assert.match(JSON.stringify(received), new RegExp(roleId));
    await until(()=>notices.some(n=>n.message==="dialogue_batch"), "普通角色批次到达扩展");
    app.services.activity.resume(id);
    await until(()=>notices.some(n=>n.message==="autonomous_call" && n.data===id), "主角色收到批次唤醒并自主调用扩展工具");
    await app.conversation.waitForIdle(id);
    const session = app.conversation.exchanges.start(id,roleId,"扩展验收","来聊一聊",2);
    await until(()=>notices.some(n=>n.message==="role_exchange" && JSON.stringify(n.data).includes(session.sessionId)), "往来事件到达扩展");
  } finally { await f.close(); }
});

test("扩展已写入并调用后回复失败，原消息补答显示回执且不重派模型再次提出的工具", async () => {
  const model = new ScriptedChatModel([
    event("app_extension_upsert", source("receipt","v1")), event("ext_receipt__hello",{}),
    event("task_finish",{status:"completed",endReason:"验证完成"}),
    () => { throw Error("model connection closed"); },
    request => {
      assert.deepEqual(request.tools, []);
      const evidence = JSON.stringify(request.messages);
      assert.match(evidence, /ext_receipt__hello/);
      assert.match(evidence, /v1/);
      return [{type:"text_delta",text:"扩展已启用，工具已验证。"}, ...event("ext_receipt__hello",{})];
    },
  ]);
  const f = createFixtureWithModel(model);
  try {
    const {app} = f;
    seedLegacyPresetAssistant(app.config);
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const win = app.services.roles.initializeRole(id).defaultWindowId;
    app.services.resources.replaceBindings(id, [{resourceId:app.services.resources.listBindings(f.roleId)[0]!.resourceId,
      capability:"chat_model",enabled:true,modelName:"offline"}]);
    app.services.activity.resume(id);
    const list = () => app.services.messages.list(id,win,null,30);
    app.conversation.submitMessage(id,win,{content:"创建扩展并验证一次",sourcePlatform:"nowadays",submissionId:randomUUID()});
    await app.conversation.waitForIdle(id);
    const page = list();
    assert.equal(page.failedReply,null);
    assert.deepEqual(page.items.map(m=>[m.sender,m.content]),[["user","创建扩展并验证一次"],["assistant","扩展已启用，工具已验证。"]]);
    assert.equal(model.requests.length,5);
    assert.ok(app.conversation.listTasks(id).some(task=>task.status==="completed" && task.endReason==="验证完成"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,"extensions","receipt","manifest.json"),"utf8")).kv.count,1);
  } finally { await f.close(); }
});

test("仓库外版本目录原子升级、失败回滚、KV 隔离、在途排空、HTTP 启停删除与关闭回收", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const notices: Notice[] = [];
  host.onNotice(n=>notices.push(n));
  const call = (name: string, id = "demo") => host.call(id,name,false,{},{roleId:f.roleId});
  try {
    external(f.root);
    const port = await listen(f.app.server,0,"127.0.0.1");
    const api = async <T = ReturnType<typeof host.get>>(method: string, sub: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/extensions`+sub,{method});
      assert.equal(res.status,200); return await res.json() as T;
    };
    const v1 = await host.upsert(source("demo","v1"));
    assert.throws(() => host.upsert({...source("demo","bad-file"),files:{index_mjs:""}}), /ui\/index\.html/);
    await assert.rejects(host.upsert(source("demo","bad-effect",
      "export default (ctx,api)=>{const off=api.tools.register({name:'stamp',scope:'all_roles',description:'stamp',inputSchema:{type:'object'}},()=>1); ctx.effect(()=>{off()})}")),
      /EXTENSION_EFFECT_INVALID.*onDispose/u);
    assert.equal(host.get("demo").version, "v1");
    assert.deepEqual(await call("hello"),{version:"v1",count:1,roleId:f.roleId});
    const slow = call("slow");
    await until(()=>notices.some(n=>n.message==="started"),"旧调用已进入");
    const upgrade = host.upsert(source("demo","v2"));
    await until(()=>host.get("demo").version==="v2","新版本握手并发布");
    assert.deepEqual(await call("hello"),{version:"v2",count:2,roleId:f.roleId});
    assert.equal(await slow,"v1");
    const v2 = await upgrade;
    gone(v1.pid);
    assert.ok(notices.some(n=>n.message==="disposed" && n.data==="v1"));
    const admin = createAdminTools({ ...f.app.services, now: () => new Date() }).find(t => t.name === "app_extension_upsert")!;
    const context = {roleId:"seat",windowId:"test-window",executionId:"update",taskId:null,signal:new AbortController().signal};
    for (const bad of ["export !","export default async(ctx,api)=>{await api.kv.set('count',999);throw Error('init failure')}"]) {
      const receipt = await admin.execute(source("demo","broken",bad),context);
      assert.equal(receipt.diagnosticCode,"EXTENSION_LOAD_FAILED");
      assert.match(JSON.stringify(receipt.adaptedResult),/broken/);
      assert.equal(host.get("demo").pid,v2.pid);
      assert.equal(host.get("demo").lastError?.code,"EXTENSION_LOAD_FAILED");
    }
    assert.deepEqual(await call("hello"),{version:"v2",count:3,roleId:f.roleId});
    const second = await host.upsert(source("another","v1"));
    assert.deepEqual(await call("hello","another"),{version:"v1",count:1,roleId:f.roleId});
    const listing = await api<{items: ReturnType<typeof host.list>}>("GET","");
    assert.deepEqual(listing.items.map(e=>e.extId),["another","demo"]);
    assert.equal((await api("GET","/demo")).ui[0]?.file,"ui/index.html");
    notices.length=0;
    const inflight = call("slow");
    await until(()=>notices.some(n=>n.message==="started"),"停用前调用已派发");
    const disabled = api("POST","/demo/disable");
    await until(()=>host.get("demo").status==="disabled","撤销工具注册");
    assert.throws(()=>call("hello"),{code:"EXTENSION_UNAVAILABLE"});
    assert.equal(await inflight,"v2");
    await disabled;
    gone(v2.pid);
    assert.ok(notices.some(n=>n.message==="disposed" && n.data==="v2"));
    const enabled = await api("POST","/demo/enable");
    const reloaded = await api("POST","/demo/reload");
    gone(enabled.pid);
    notices.length=0;
    await api("DELETE","/demo");
    gone(reloaded.pid);
    assert.ok(notices.some(n=>n.message==="disposed"));
    assert.throws(()=>call("hello"),{code:"EXTENSION_UNAVAILABLE"});
    assert.equal(fs.existsSync(path.join(f.root,"extensions","demo")),false);
    await f.app.close();
    gone(second.pid);
  } finally { await f.close(); }
});

test("初始化超时、同步阻塞和未处理拒绝隔离，健康检查与普通会话继续，重启只恢复启用项", async () => {
  const model = new ScriptedChatModel([reply]);
  const f = createFixtureWithModel(model, {extensionTimeouts:{initMs:2500,callMs:300}});
  let app = f.app;
  try {
    external(f.root);
    const host = app.services.extensions;
    const active = await host.upsert(source("active","v1"));
    const hung = await host.upsert(source("hung","v1"));
    const crash = await host.upsert(source("crash","v1"));
    const stopped = await host.upsert(source("off","v1"));
    await host.toggle("off","disable");
    gone(stopped.pid);
    await assert.rejects(host.upsert(source("bad-init","v1","export default ()=>{while(true){}}")),{code:"EXTENSION_INIT_TIMEOUT"});
    const port = await listen(app.server,0,"127.0.0.1");
    const timeout = assert.rejects(host.call("hung","hang",false,{},{}),{code:"EXTENSION_CALL_TIMEOUT"});
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status,200);
    await timeout;
    assert.equal(host.get("hung").status,"failed");
    await host.call("crash","crash",false,{},{});
    await until(()=>host.get("crash").status==="failed","运行中崩溃已收敛");
    assert.match(host.get("crash").lastError!.message,/offline crash/);
    app.conversation.submitMessage(f.roleId,f.windowId,{content:"还能收到信吗",sourcePlatform:"nowadays",submissionId:randomUUID()});
    await app.conversation.waitForIdle(f.roleId);
    assert.equal(app.services.messages.list(f.roleId,f.windowId,null,10).items.at(-1)?.content,"离线回执已收到。");
    await app.close();
    for (const pid of [active.pid,hung.pid,crash.pid]) gone(pid);
    app = createBackendApp(f.app.config,{disablePresetAssistant:true,disableMemoryRuntime:true});
    await app.services.extensions.ready;
    assert.deepEqual(app.services.extensions.list().map(e=>[e.extId,e.status]),
      [["active","enabled"],["bad-init","failed"],["crash","failed"],["hung","failed"],["off","disabled"]]);
    const restored = app.services.extensions.get("active");
    assert.notEqual(restored.pid,active.pid);
    assert.equal((await app.services.extensions.call("active","private",true,{},{})),"v1");
    await app.close();
    gone(restored.pid);
  } finally { await app.close(); await f.close(); }
});

test("UI 资产只读取已启用版本的声明文件，每次请求重新核实目录", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const port = await listen(f.app.server,0,"127.0.0.1");
  const base = `http://127.0.0.1:${port}/v1/extensions/ui-test/ui/`;
  const item = (version: string) => {
    const input = source("ui-test", version, "export default () => {}");
    return { ...input, manifest: { ...input.manifest, ui: [...input.manifest.ui,
      {slot:"asset",file:"ui/style.css"}, {slot:"asset",file:"ui/private.mjs"}] },
      files: { ...input.files, "ui/index.html": version, "ui/style.css":"body{}",
        "ui/private.mjs":"export default 42", "ui/hidden.html":"private" } };
  };
  try {
    await host.upsert(item("v1"));
    assert.equal(await (await fetch(base+"index.html?v=v1")).text(),"v1");
    assert.match((await fetch(base+"style.css")).headers.get("content-type") ?? "", /text\/css/);
    for (const tail of ["hidden.html","private.mjs","%2e%2e%2fentry.mjs","..%5cmanifest.json","index.html?v=v0"])
      assert.equal((await fetch(base+tail)).status,404,tail);
    const traversed = await new Promise<number | undefined>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/v1/extensions/ui-test/ui/../../../roles" }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    assert.equal(traversed,404);
    await host.upsert(item("v2"));
    assert.equal((await fetch(base+"index.html?v=v1")).status,404);
    assert.equal(await (await fetch(base+"index.html?v=v2")).text(),"v2");
    const ui = path.join(f.root,"extensions","ui-test","versions","v2","ui");
    const privateDir = path.join(f.root,"private");
    fs.mkdirSync(privateDir);
    fs.writeFileSync(path.join(privateDir,"index.html"),"private");
    fs.renameSync(ui,ui+"-original");
    fs.symlinkSync(privateDir,ui,"junction");
    try {
      assert.equal((await fetch(base+"index.html")).status,404);
      assert.throws(()=>host.source({extId:"ui-test",file:"ui/index.html"}), {code:"EXTENSION_PATH_INVALID"});
      assert.throws(()=>host.source({extId:"ui-test"}), {code:"EXTENSION_PATH_INVALID"});
    }
    finally { fs.unlinkSync(ui); fs.renameSync(ui+"-original",ui); }
    await host.toggle("ui-test","disable");
    assert.equal((await fetch(base+"index.html")).status,404);
    await host.delete("ui-test");
    assert.equal((await fetch(base+"style.css")).status,404);
  } finally { await f.close(); }
});

test("受管路径逐级检查，拒绝越界文件与 Windows junction，保留外部文件", async () => {
  const root = fs.mkdtempDisposableSync(path.join(os.tmpdir(),"nd-extension-path-"));
  const outside = fs.mkdtempDisposableSync(path.join(os.tmpdir(),"nd-extension-other-"));
  const host = new ExtensionHost(root.path);
  const link = path.join(root.path,"extensions","linked");
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(outside.path,link,"junction");
  try {
    external(root.path);
    const input = source("linked","v1");
    await assert.rejects(host.upsert(input),{code:"EXTENSION_PATH_INVALID"});
    assert.throws(()=>host.upsert({...input,files:{"../other.mjs":"x"}}),{code:"EXTENSION_ARGUMENTS_INVALID"});
    assert.deepEqual(fs.readdirSync(outside.path),[]);
  } finally { await host.close(); fs.unlinkSync(link); root.remove(); outside.remove(); }
});

test("按需读取当前扩展的目录与源码，续页保留 Unicode，换版后拒绝旧游标", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  try {
    const project = source("readable", "v1");
    const content = "x".repeat(5999) + "🎭道具";
    await host.upsert({ ...project, files: { ...project.files, "lib/cards.mjs": "//" + content, "ui/notes.txt": content } });
    const query = {extId:"readable", version:"v1"};
    const directory = host.source(query);
    assert.deepEqual(directory.files, ["entry.mjs", "helper.mjs", "lib/cards.mjs", "ui/index.html", "ui/notes.txt"]);
    assert.equal(directory.content, undefined);
    assert.equal(directory.nextOffset, null);
    const file = {...query, file:"ui/notes.txt"};
    const first = host.source(file);
    assert.equal(first.nextOffset, 5999);
    const second = host.source({...file, offset:first.nextOffset});
    assert.equal(first.content! + second.content!, content);
    assert.equal(second.nextOffset, null);
    assert.throws(()=>host.source({...file,offset:6000}), {code:"EXTENSION_SOURCE_OFFSET_INVALID"});
    assert.throws(()=>host.source({...query,file:"not-found.mjs"}), {code:"EXTENSION_FILE_MISSING"});
    assert.throws(()=>host.source({...query,file:"../manifest.json"}), {code:"EXTENSION_ARGUMENTS_INVALID"});
    await host.toggle("readable","disable");
    assert.equal(host.source({...query,file:"helper.mjs"}).content,project.files["helper.mjs"]);
    const next = source("readable","v2");
    const extras = Object.fromEntries(Array.from({length:51}, (_,i)=>[`ui/n${i}.txt`,""]));
    await host.upsert({...next,files:{...next.files,...extras}});
    assert.throws(()=>host.source(file), {code:"EXTENSION_VERSION_CHANGED"});
    assert.equal(host.source({extId:"readable",file:"helper.mjs"}).content, 'export default "v2"');
    const page = host.source({extId:"readable"});
    assert.equal(page.nextOffset,50);
    const tail = host.source({extId:"readable",version:page.version,offset:page.nextOffset});
    assert.equal(tail.nextOffset,null);
    assert.deepEqual([...(page.files ?? []), ...(tail.files ?? [])],Object.keys({...next.files,...extras}).sort());
  } finally { await f.close(); }
});
