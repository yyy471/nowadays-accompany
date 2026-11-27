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
import { CoplayBatches } from "../../src/application/extensions/coplay-batches.js";
import { ExtensionHost, type Notice } from "../../src/application/extensions/extension-host.js";
import type { ModelEvent } from "../../src/domain/model.js";
import { createFixtureWithModel, GatedChatModel, ScriptedChatModel } from "../fixtures/conversation-fixture.js";
import { seedLegacyPresetAssistant } from "../fixtures/legacy-role-fixture.js";
import { createAdminTools } from "../../src/application/role/admin-tools.js";

function demoPlugin(extraTools = "") { return `
import version from "./helper.mjs";
export default async (ctx, api) => {
  ${extraTools}
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
};`; }
function source(extId: string, version: string, body = demoPlugin()) {
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

test("定向工具按调用者身份发现和派发，换版立即撤权，动态注销刷新快照", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const b = { roleId:f.roleId, adminSeat:false };
  const c = { roleId:"role-c", adminSeat:false };
  const seat = { roleId:"main-seat", adminSeat:true };
  const names = (caller: typeof b) => host.tools(caller).map(({ spec }) => spec.name);
  const call = (caller: typeof b, name: string) => host.call("targeted", name, caller, {}, {});
  const publish = (version: string, roleIds: unknown) => host.upsert(source("targeted", version, `
    export default (_, api) => {
      const register = (name, access) => api.tools.register(
        { name, description:name, inputSchema:{type:"object"}, ...access }, (_, ctx) => ctx.roleId);
      register("shared", {scope:"all_roles"});
      register("private", {scope:"admin_only"});
      const off = register("stamp", {scope:"selected_roles", roleIds:${JSON.stringify(roleIds)}});
      api.ui.onAction("remove", () => { off(); return null; });
    }`));
  let snapshot: unknown;
  const stop = host.subscribeUi((event, data) => { if (event === "snapshot") snapshot = data; });
  try {
    const port = await listen(f.app.server, 0, "127.0.0.1");
    await publish("v1", [b.roleId, "removed-role", b.roleId]);
    const expected = [
      { name:"shared", scope:"all_roles" }, { name:"private", scope:"admin_only" },
      { name:"stamp", scope:"selected_roles", roleIds:[b.roleId, "removed-role"] },
    ];
    const response = await fetch(`http://127.0.0.1:${port}/v1/extensions`);
    assert.equal(response.status, 200);
    const listing = await response.json() as { items: { tools: unknown[] }[] };
    assert.deepEqual(listing.items[0]?.tools, expected);
    const ui = source("targeted", "v1").manifest.ui;
    const item = { extId:"targeted", version:"v1", status:"enabled", ui, lastError:null };
    assert.deepEqual(snapshot, [{ ...item, tools:expected }]);
    assert.deepEqual(names(b), ["shared", "stamp"]);
    assert.deepEqual(names(c), ["shared"]);
    assert.deepEqual(names(seat), ["shared", "private", "stamp"]);
    assert.equal(await call(b, "stamp"), b.roleId);
    assert.equal(await call(seat, "stamp"), seat.roleId);
    assert.throws(() => call(c, "stamp"), { code:"EXTENSION_UNAVAILABLE" });
    assert.throws(() => call(b, "private"), { code:"EXTENSION_UNAVAILABLE" });
    assert.equal(await call(c, "shared"), c.roleId);
    assert.equal(await call(seat, "private"), seat.roleId);

    for (const invalid of [undefined, "role-b", [1], ["  "]])
      await assert.rejects(publish("invalid", invalid), { code:"EXTENSION_IPC_INVALID" });
    assert.equal(await call(b, "stamp"), b.roleId);
    await publish("v2", []);
    assert.deepEqual(names(b), ["shared"]);
    assert.throws(() => call(b, "stamp"), { code:"EXTENSION_UNAVAILABLE" });
    assert.equal(await call(seat, "stamp"), seat.roleId);
    assert.deepEqual(snapshot, [{ ...item, version:"v2", tools:[...expected.slice(0, 2),
      { name:"stamp", scope:"selected_roles", roleIds:[] }] }]);
    await host.uiAction("targeted", "v2", "remove", null);
    assert.deepEqual(snapshot, [{ ...item, version:"v2", tools:expected.slice(0, 2) }]);
  } finally { stop(); await f.close(); }
});

test("同进程收紧同名工具名单时，已通过旧授权的调用不能执行新处理器", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const caller = { roleId: f.roleId, adminSeat: false };
  try {
    await host.upsert(source("race", "v1", `export default (_, api) => {
      const spec = { name: "stamp", scope: "selected_roles", roleIds: [${JSON.stringify(f.roleId)}],
        description: "印章", inputSchema: { type: "object" } };
      const off = api.tools.register(spec, () => "旧");
      let count = 0;
      api.ui.onAction("restrict", () => { off(); api.tools.register({...spec, roleIds: []}, () => ++count); });
    }`));
    let changed: Promise<unknown> | undefined;
    const stale = host.call("race", "stamp", caller, {}, {}, () => {
      changed = host.uiAction("race", "v1", "restrict", null);
    });
    await assert.rejects(stale, { code: "EXTENSION_UNAVAILABLE" });
    await changed;
    assert.throws(() => host.call("race", "stamp", caller, {}, {}), { code: "EXTENSION_UNAVAILABLE" });
    assert.equal(await host.call("race", "stamp", { ...caller, adminSeat: true }, {}, {}), 1);
  } finally { await f.close(); }
});

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

test("共玩固定窗从首击计满五秒；无摘要、停机和撤版的迟到回执不能重建待发项", t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let active = true;
  const due: string[] = [];
  const batches = new CoplayBatches(() => active, roleId => { due.push(roleId); });
  const begin = () => batches.begin("dice", "b", "掷骰");
  const first = begin();
  t.mock.timers.tick(1250);
  first?.("1");
  t.mock.timers.tick(3749);
  begin()?.("6");
  assert.deepEqual(due, []);
  t.mock.timers.tick(1);
  assert.deepEqual(due, ["b"]);
  const batch = batches.due("b")!;
  assert.match(batch.intent, /共玩 2 次。最后一次掷骰：6/);
  batch.claimed();
  assert.equal(batches.due("b"), undefined);
  begin()?.();
  const late = begin();
  active = false;
  batches.budgetChanged("b");
  const stopped = begin();
  active = true;
  late?.("旧骰点"); stopped?.("停机时派发");
  const retired = begin();
  batches.discard(item => item.extId === "dice");
  retired?.("旧版");
  t.mock.timers.tick(5000);
  assert.deepEqual(due, ["b"]);
});

function dice(version = "v1") {
  const ui = [{ slot: "page", file: "ui/index.html", coplay: [
    { action: "roll", label: "掷骰" }, { action: "silent", label: "静默动作" },
  ] }];
  return { extId: "dice", manifest: { version, entry: "entry.mjs", ui },
    files: { "ui/index.html": "<output></output>", "entry.mjs": `export default (_, api) => {
      let value = 0;
      const roll = () => ({data: ++value, summary: '点数 ' + value});
      api.ui.onAction('roll', roll);
      api.ui.onAction('ordinary', roll);
      api.ui.onAction('silent', () => ({data: ++value}));
    }` } };
}
const hostButton = (roleId: string) => ({ coplay: true, roleId, slot: "page", file: "ui/index.html" });

test("静态 asset 仍可发布，asset 与未知槽位均拒绝声明共玩", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const project = dice();
    for (const slot of ["asset", "unknown"]) {
      project.manifest.ui[0]!.slot = slot;
      assert.throws(() => f.app.services.extensions.upsert(project), { code: "EXTENSION_ARGUMENTS_INVALID" });
    }
    const asset = { slot: "asset", file: "ui/index.html" };
    const installed = await f.app.services.extensions.upsert({ ...project, manifest: { ...project.manifest, ui: [asset] } });
    assert.deepEqual(installed.ui, [asset]);
    assert.equal(f.app.services.extensions.uiAsset("dice", asset.file, "v1").toString(), "<output></output>");
  } finally { await f.close(); }
});

test("共玩只投单个点名角色，普通动作、错误槽位和无摘要动作零唤醒", async () => {
  const share = (content: string) => event("autonomy_share", {content});
  const model = new ScriptedChatModel([share("看到了最后的骰点。"), reply, share("这次轮到我了。"), reply, share("旧骰点")]);
  const f = createFixtureWithModel(model, { coplayWindowMs: 180 });
  const { services, appStore } = f.app;
  try {
    seedLegacyPresetAssistant(f.app.config);
    const id = appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const seat = services.roles.initializeRole(id);
    services.resources.replaceBindings(id, [{resourceId:services.resources.listBindings(f.roleId)[0]!.resourceId,
      capability:"chat_model",enabled:true,modelName:"offline"}]);
    services.activity.resume(id);
    const port = await listen(f.app.server, 0, "127.0.0.1");
    const url = `http://127.0.0.1:${port}/v1/extensions/dice`;
    const post = async (action: string, extra = {}) => {
      const res = await fetch(url + "/ui-action", { method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({ version: "v1", payload: null, action, ...extra }) });
      assert.equal(res.status, 200);
      return (await res.json() as {data:unknown}).data;
    };
    await services.extensions.upsert(dice());
    assert.deepEqual((await (await fetch(url)).json() as {ui:unknown}).ui, dice().manifest.ui);
    let snapshot;
    services.extensions.subscribeUi((_, data) => { snapshot = data; })();
    assert.deepEqual((snapshot as unknown as {ui:unknown}[])[0]?.ui, dice().manifest.ui);
    const wakes = (roleId: string) => services.autonomy.listWakes(roleId);
    assert.deepEqual(await post("roll"), {data:1, summary:"点数 1"});
    await post("ordinary", hostButton(id));
    await post("roll", {...hostButton(id), slot:"widget"});
    await post("roll", {...hostButton(id), file:"ui/other.html"});
    assert.equal(await post("silent", hostButton(id)), 5);
    await sleep(240);
    assert.deepEqual([wakes(id).length, wakes(f.roleId).length, model.requests.length], [0,0,0]);
    let count = 5;
    const eventUrl = `http://127.0.0.1:${port}/v1/extension-events`;
    async function readUntil(event: string, lastEventId?: string) {
      const response = await fetch(eventUrl, { headers: lastEventId ? { "Last-Event-ID": lastEventId } : {},
        signal: AbortSignal.timeout(5000) });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let body = "";
      try {
        while (!body.split("\n\n").slice(0, -1).some(frame => frame.includes("event: " + event + "\n"))) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          body += chunk.value;
        }
      } finally { await reader.cancel(); }
      return body;
    }
    const initial = await readUntil("snapshot");
    const cursor = /^id: (.+)$/m.exec(initial)![1]!;
    for (const [target, win, text] of [[id, seat.defaultWindowId, "看到了最后的骰点。"], [f.roleId, f.windowId, "这次轮到我了。"]] as const) {
      for (let i = 0; i < 3; i++) assert.equal(await post("roll", hostButton(target)), ++count);
      await until(() => wakes(target)[0]?.status === "completed", "共玩自主执行完成");
      assert.equal(wakes(target).length, 1);
      assert.ok(model.requests.at(-2)?.system.includes("共玩 3 次。最后一次掷骰：点数 " + count));
      assert.equal(services.messages.list(target, win, null, 10).items.at(-1)?.content, text);
    }
    assert.deepEqual([wakes(id).length, wakes(f.roleId).length], [1,1]);
    const resumed = await readUntil("coplay-share", cursor);
    const shares = [...resumed.matchAll(/id: (.+)\nevent: coplay-share\ndata: (.+)\n/g)];
    assert.equal(shares.length, 1);
    const notice = JSON.parse(shares[0]![2]!);
    assert.equal(notice.roleId, f.roleId);
    assert.equal(notice.messageId, services.messages.list(f.roleId, f.windowId, null, 10).items[0]!.messageId);
    assert.ok(JSON.parse(shares[0]![1]!)[f.roleId] > JSON.parse(cursor)[f.roleId]);
    // 领取时还剩一点，模型判断后已耗尽。共玩任务在此结束，次日不再领取预算续行。
    const used = services.autonomy.getBudget(f.roleId).usedPoints;
    services.autonomy.setBudget(f.roleId, { dailyLimit:used + 1, unlimited:false });
    assert.equal(await post("roll", hostButton(f.roleId)), ++count);
    await until(() => wakes(f.roleId).some(w => w.lastErrorCode === "AUTONOMY_BUDGET_EXHAUSTED"), "领取后耗尽额度");
    assert.ok(!wakes(f.roleId).some(w => w.kind === "budget_resume"));
    assert.equal(services.messages.list(f.roleId, f.windowId, null, 10).items.length, 1);
  } finally { await f.close(); }
});

test("忙时跨固定窗仍合并直到领取，停机、额度耗尽、换版与禁用清除待发共玩", async () => {
  let now = new Date("2026-11-26T05:00:00Z");
  const model = new GatedChatModel();
  const f = createFixtureWithModel(model, { coplayWindowMs: 40, now: () => now });
  const { extensions, activity, autonomy } = f.app.services;
  const role = f.roleId;
  const wakes = () => autonomy.listWakes(role).filter(w => w.wakeId.startsWith("coplay/"));
  try {
    const port = await listen(f.app.server, 0, "127.0.0.1");
    const post = async (version = "v1", status = 200) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/extensions/dice/ui-action`, {
        method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({version, action:"roll", ...hostButton(role)}) });
      assert.equal(res.status, status);
      return (await res.json() as {data:number}).data;
    };
    await extensions.upsert(dice());
    f.app.conversation.submitMessage(role, f.windowId, {content:"稍等一下",sourcePlatform:"nowadays",submissionId:randomUUID()});
    await model.started.promise;
    await post();
    await sleep(80);
    await post();
    assert.equal(wakes().length, 0);
    model.release.resolve();
    await until(() => wakes()[0]?.status === "completed", "忙碌解除后领取");
    assert.match(wakes()[0]!.intent, /共玩 2 次。最后一次掷骰：点数 2/);
    await f.app.conversation.waitForIdle(role);

    await post();
    activity.requestStop(role);
    assert.equal(await post(), 4);
    activity.resume(role);
    await post();
    const used = autonomy.getBudget(role).usedPoints;
    assert.ok(used > 0);
    autonomy.setBudget(role, {unlimited:false, dailyLimit:used});
    assert.equal(await post(), 6);
    now = new Date("2026-11-27T05:00:00Z");
    assert.equal(autonomy.getBudget(role).usedPoints, 0);
    await sleep(85);
    assert.equal(wakes().length, 1);

    // 固定窗已到、但角色无模型时仍保留一批；换版或停用后不能在恢复模型时领取。
    const binding = f.app.services.resources.listBindings(role)[0]!;
    f.app.appStore.updateResource({resourceId:binding.resourceId, enabled:false});
    await post();
    await sleep(80);
    await extensions.upsert(dice("v2"));
    await post("v1", 409);
    f.app.appStore.updateResource({resourceId:binding.resourceId, enabled:true});
    f.app.conversation.wakePendingWork(role);
    assert.equal(wakes().length, 1);
    await post("v2");
    await extensions.toggle("dice","disable");
    await post("v2", 409);
    await extensions.toggle("dice","enable");
    f.app.conversation.wakePendingWork(role);
    await sleep(85);
    assert.equal(wakes().length, 1);
  } finally { model.release.resolve(); await f.close(); }
});

test("Pi 的工具分发与双向槽位契约与两项主角色发布工具逐字一致", async () => {
  const {default: install, uiActionContract, toolScopeContract} = await import(new URL("../../../pi-mcp/src/extensions/nowadays-mod.mjs", import.meta.url).href);
  let prompt = "";
  install({on: (name: string, hook: (e: {systemPrompt: string}) => {systemPrompt: string}) => {
    assert.equal(name, "before_agent_start");
    prompt = hook({systemPrompt: "base"}).systemPrompt;
  }});
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const tools = createAdminTools({...f.app.services, now: () => new Date()});
    for (const contract of [uiActionContract, toolScopeContract]) {
      assert.ok(prompt.includes(contract));
      for (const name of ["app_extension_upsert", "app_extension_publish_work"])
        assert.ok(tools.find(t => t.name === name)?.description.includes(contract), name);
    }
  } finally { await f.close(); }
});

test("主角色在对话中创建并验收定向工具，名单内角色调用后触发批次与往来事件", async () => {
  const project = source("demo", "v1");
  const model = new ScriptedChatModel([
    event("app_extension_upsert", project), event("ext_demo__stamp",{}), reply,
    event("ext_demo__stamp",{}), reply, event("ext_demo__hello",{}), reply, reply, reply,
  ]);
  const f = createFixtureWithModel(model, {batchDelayMs:60});
  const {app, roleId, windowId} = f;
  try {
    project.files["entry.mjs"] = demoPlugin(`
      api.tools.register({name:"stamp", description:"验收", inputSchema:{type:"object"},
        scope:"selected_roles", roleIds:[${JSON.stringify(roleId)}]}, (_, ctx) => ({version, roleId:ctx.roleId}));`);
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
    assert.ok(model.requests[1]!.tools.some(t=>t.name === "ext_demo__stamp"));
    const acceptance = model.requests[2]!.messages.filter(m=>m.role === "tool").at(-1);
    assert.match(JSON.stringify(acceptance), new RegExp(id));
    // 停用席位活动以保留批次唤醒，避免该唤醒消费普通角色的离线脚本。
    app.services.activity.requestStop(id);
    await send(roleId,windowId,"试用工具");
    const names = model.requests[3]!.tools.map(t=>t.name);
    assert.ok(names.includes("ext_demo__hello"));
    assert.ok(names.includes("ext_demo__stamp"));
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
    await app.services.extensions.flushKv("receipt");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,"extensions","receipt","kv.json"),"utf8")).count,1);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(f.root,"extensions","receipt","manifest.json"),"utf8")),"kv"),false);
  } finally { await f.close(); }
});

test("仓库外版本目录原子升级、失败回滚、KV 隔离、在途排空、HTTP 启停删除与关闭回收", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const notices: Notice[] = [];
  host.onNotice(n=>notices.push(n));
  const call = (name: string, id = "demo") => host.call(id,name,{ adminSeat:false, roleId:f.roleId },{},{});
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
    const caller = { adminSeat:false, roleId:f.roleId };
    const timeout = assert.rejects(host.call("hung","hang",caller,{},{}),{code:"EXTENSION_CALL_TIMEOUT"});
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status,200);
    await timeout;
    assert.equal(host.get("hung").status,"failed");
    await host.call("crash","crash",caller,{},{});
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
    assert.equal((await app.services.extensions.call("active","private",{ adminSeat:true, roleId:"seat" },{},{})),"v1");
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

test("SEC-03 KV 独立落盘并在重启后恢复，manifest.json 不再携带 KV", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const body = `export default (_, api) => {
    api.tools.register({name:"bump",scope:"all_roles",description:"bump",inputSchema:{type:"object"}}, async () => {
      const count = (await api.kv.get("count") ?? 0) + 1;
      await api.kv.set("count", count);
      return count;
    });
    api.tools.register({name:"peek",scope:"all_roles",description:"peek",inputSchema:{type:"object"}}, () => api.kv.get("count"));
  }`;
  const caller = { adminSeat:false, roleId:f.roleId };
  const dir = path.join(f.root, "extensions", "kv");
  try {
    await host.upsert(source("kv", "v1", body));
    assert.equal(await host.call("kv","bump",caller,{},{}), 1);
    assert.equal(await host.call("kv","bump",caller,{},{}), 2);
    await host.flushKv("kv");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,"kv.json"),"utf8")), { count:2 });
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8")),"kv"),false);
    await f.app.close();
    const app = createBackendApp(f.app.config, { disablePresetAssistant:true, disableMemoryRuntime:true });
    await app.services.extensions.ready;
    try {
      assert.equal(await app.services.extensions.call("kv","peek",caller,{},{}), 2);
      assert.equal(await app.services.extensions.call("kv","bump",caller,{},{}), 3);
      await app.services.extensions.flushKv("kv");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,"kv.json"),"utf8")), { count:3 });
    } finally { await app.close(); }
  } finally { await f.close(); }
});

test("SEC-03 旧 manifest.json 的 KV 自动迁移到 kv.json 并清理清单", async () => {
  const root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "nd-kv-migrate-"));
  const dir = path.join(root.path, "extensions", "legacy");
  fs.mkdirSync(path.join(dir, "versions", "v1"), { recursive:true });
  fs.writeFileSync(path.join(dir, "versions", "v1", "entry.mjs"), "export default () => {};\n");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    version:"v1", entry:"entry.mjs", ui:[], status:"disabled", tools:[], lastError:null, kv:{ count:7 },
  }));
  const host = new ExtensionHost(root.path);
  try {
    host.restore();
    await host.ready;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,"kv.json"),"utf8")), { count:7 });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));
    assert.equal(Object.hasOwn(manifest,"kv"),false);
    assert.equal(manifest.status,"disabled");
  } finally { await host.close(); root.remove(); }
});

test("SEC-03 原型键、空键、超长键与超限单值被拒绝且不污染原型", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host = f.app.services.extensions;
  const body = `export default (_, api) => {
    api.tools.register({name:"try",scope:"all_roles",description:"try",inputSchema:{type:"object"}}, async args => {
      try { await api.kv.set(args.key, args.value); return "ok"; }
      catch (error) { return String(error?.message ?? error); }
    });
    api.tools.register({name:"read",scope:"all_roles",description:"read",inputSchema:{type:"object"}}, args => api.kv.get(args.key));
  }`;
  const caller = { adminSeat:false, roleId:f.roleId };
  const attempt = (key: string, value: unknown) => host.call("guard","try",caller,{key,value},{}) as Promise<string>;
  try {
    await host.upsert(source("guard", "v1", body));
    for (const key of ["__proto__","constructor","prototype","","   ","x".repeat(129)])
      assert.match(await attempt(key, "p"), /EXTENSION_KV_KEY_INVALID/);
    assert.match(await attempt("big", "x".repeat(65_537)), /EXTENSION_KV_VALUE_TOO_LARGE/);
    assert.equal(await attempt("ok", { sec03Polluted:true }), "ok");
    assert.equal(({} as Record<string, unknown>).sec03Polluted, undefined);
    assert.equal((Object.prototype as Record<string, unknown>).sec03Polluted, undefined);
    assert.equal(await host.call("guard","read",caller,{key:"big"},{}), null);
    await host.flushKv("guard");
    const kv = JSON.parse(fs.readFileSync(path.join(f.root,"extensions","guard","kv.json"),"utf8"));
    assert.deepEqual(Object.keys(kv), ["ok"]);
    assert.deepEqual(kv.ok, { sec03Polluted:true });
  } finally { await f.close(); }
});

test("SEC-03 小配额下键数、总容量与写频限制生效且子进程不崩溃", async () => {
  const caller = { adminSeat:false, roleId:"r" };
  const body = `export default (_, api) => {
    api.tools.register({name:"burst",scope:"all_roles",description:"burst",inputSchema:{type:"object"}}, async args => {
      const results = [];
      for (const [key, value] of args.items) {
        try { await api.kv.set(key, value); results.push("ok"); }
        catch (error) { results.push(String(error?.message ?? error)); }
      }
      return results;
    });
    api.tools.register({name:"ping",scope:"all_roles",description:"ping",inputSchema:{type:"object"}}, () => "pong");
  }`;
  const run = async (limits: ConstructorParameters<typeof ExtensionHost>[3],
    verify: (host: ExtensionHost) => Promise<void>) => {
    const root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "nd-kv-small-"));
    const host = new ExtensionHost(root.path, undefined, undefined, limits);
    try {
      await host.upsert(source("small", "v1", body));
      await verify(host);
      // 被拒绝的写入只回到扩展错误，不打断子进程。
      assert.equal(await host.call("small","ping",caller,{},{}), "pong");
      assert.equal(host.get("small").status, "enabled");
    } finally { await host.close(); root.remove(); }
  };
  await run({ maxKeys:3, maxKeyLength:8, maxValueBytes:24, maxTotalBytes:40, flushDebounceMs:5, maxWritesPerSecond:100 },
    async host => {
      const results = await host.call("small","burst",caller,{items:[
        ["k0","x".repeat(20)], ["k1","x".repeat(20)], ["k2","v"], ["k3","v"], ["k4","v"], ["k5","v"],
      ]},{}) as string[];
      assert.deepEqual(results, [
        "ok",
        "EXTENSION_KV_QUOTA_EXCEEDED: 扩展 KV 总容量已达上限",
        "ok", "ok",
        "EXTENSION_KV_QUOTA_EXCEEDED: 扩展 KV 键数已达上限",
        "EXTENSION_KV_QUOTA_EXCEEDED: 扩展 KV 键数已达上限",
      ]);
    });
  await run({ maxKeys:100, maxKeyLength:8, maxValueBytes:16, maxTotalBytes:100_000, flushDebounceMs:5, maxWritesPerSecond:2 },
    async host => {
      const results = await host.call("small","burst",caller,{items:[["w0","v"],["w1","v"],["w2","v"],["w3","v"]]},{}) as string[];
      assert.deepEqual(results, [
        "ok", "ok",
        "EXTENSION_KV_RATE_LIMITED: 扩展 KV 写入过于频繁",
        "EXTENSION_KV_RATE_LIMITED: 扩展 KV 写入过于频繁",
      ]);
    });
});
