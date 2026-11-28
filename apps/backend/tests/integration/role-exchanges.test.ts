import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createFixtureWithModel, deferred, type Fixture } from "../fixtures/conversation-fixture.js";
import { seedLegacyPresetAssistant } from "../fixtures/legacy-role-fixture.js";
import { RoleAccess } from "../../src/application/role/role-access.js";
import { MemoryStore } from "../../src/storage/memory/memory-store.js";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../../src/domain/model.js";
import type { MemoryFormationInput } from "../../src/domain/memory.js";

async function until(check: () => boolean, message: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  assert.fail(message);
}
function prepareSeat(f: Fixture, memory = false) {
  const {app, roleId} = f;
  seedLegacyPresetAssistant(app.config);
  const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const seat = app.services.roles.initializeRole(id);
  const resourceId = app.services.resources.listBindings(roleId)[0]!.resourceId;
  const bindings = [{resourceId, capability: "chat_model" as const, enabled: true, modelName: "offline"}];
  const complete = memory ? [...bindings, {resourceId, capability: "memory_model" as const, enabled: true, modelName: "offline"}] : bindings;
  app.services.resources.replaceBindings(id, complete);
  if (memory) app.services.resources.replaceBindings(roleId, complete);
  app.services.activity.resume(id);
  return {id, windowId: seat.defaultWindowId};
}
function form(input: MemoryFormationInput) {
  const exchanges = input.evidence.filter(e => e.sourceKind === "role_exchange");
  const e = exchanges[0];
  if (!e) return {operations: []};
  assert.ok(exchanges.every(item => item.sender === null));
  const {turn, perspectiveRoleId} = JSON.parse(e.content);
  assert.equal(input.roleId, perspectiveRoleId);
  const peer = input.roleId === turn.initiatorRoleId ? turn.targetName : turn.initiatorName;
  return {operations: [{op: "create_event", localKey: "exchange", title: "和" + peer + "谈" + turn.topic,
    summary: peer + "和我讨论了" + turn.topic, subjectiveExperience: "我觉得" + peer + "很细心",
    tags: {person: [peer]}, occurredAtStart: e.occurredAt, experienceDate: e.localDate, evidenceIds: exchanges.map(item => item.evidenceId),
    claims: [{kind: "impression", text: "我觉得" + peer + "很细心", evidenceId: e.evidenceId}]}]};
}

test("主角色发布定向书签扩展后自选往来征求反馈，双方存证且接收方仍可使用工具", async () => {
  const opening = "给你做了一个书签工具，可以保存页码。你觉得还可以怎么改？";
  const feedback = "记页码很方便，希望也能记下章节。";
  const toolName = "ext_bookmark__mark";
  let targetRoleId = "";
  const requests: ModelRequest[] = [];
  const model: ModelPort = {async *stream(req) {
    requests.push(req);
    const has = (name: string) => req.tools.some(tool => tool.name === name);
    const last = req.messages.at(-1);
    const call = (name: string, args: object): ModelEvent => ({
      type: "tool_call", callId: randomUUID(), name, arguments: args,
    });
    if (has("role_chat_reply") && last?.role !== "tool") {
      yield call("role_chat_reply", {content: feedback, endConversation: true});
    } else if (has("app_extension_upsert") && last?.role !== "tool") {
      yield call("app_extension_upsert", {
        extId: "bookmark", manifest: {version: "v1", entry: "entry.mjs"},
        files: {"entry.mjs": `export default (_, api) => {
          api.tools.register({name:"mark", description:"保存页码", inputSchema:{type:"object",properties:{page:{type:"integer"}},required:["page"]},
            scope:"selected_roles", roleIds:[${JSON.stringify(targetRoleId)}]},
            async ({page}, ctx) => { await api.kv.set(ctx.roleId, page); return {roleId:ctx.roleId, page}; });
          api.events.on('role_exchange', s => api.notify({message:s.status, data:s.sessionId}));
        }`},
      });
    } else if (has("app_role_chat_start") && last?.role === "tool" && last.toolName === "app_extension_upsert") {
      yield call("app_role_chat_start", {targetRoleId, topic: "书签工具反馈", opening});
    } else if (!has("app_extension_upsert") && has(toolName) && last?.role !== "tool") {
      yield call(toolName, {page: 42});
    } else {
      yield {type: "text_delta", text: "已处理。"};
    }
    yield {type: "completed", stopReason: "stop"};
  }};
  const f = createFixtureWithModel(model);
  const {app, roleId} = f;
  targetRoleId = roleId;
  try {
    const seat = prepareSeat(f);
    const completed: unknown[] = [];
    app.services.extensions.onNotice(n => {
      if (n.extId === "bookmark" && n.message === "completed") completed.push(n.data);
    });
    app.conversation.submitMessage(seat.id, seat.windowId, {content: "给阿澄做个书签工具。",
      submissionId: randomUUID(), sourcePlatform: "nowadays"});
    await app.conversation.waitForIdle(seat.id);
    await until(() => app.conversation.exchanges.list(1, 0)[0]?.status === "completed", "阿澄回复并结束往来");
    await app.conversation.waitForIdle(roleId);
    for (const name of ["app_extension_upsert", "app_extension_publish_work"]) {
      assert.match(requests[0]!.tools.find(t => t.name === name)!.description, /是否调用 app_role_chat_start/);
    }

    const port = await listen(app.server, 0, "127.0.0.1");
    const url = `http://127.0.0.1:${port}/v1/role-exchanges`;
    const list = await fetch(url);
    assert.equal(list.status, 200);
    const {items} = await list.json() as {items: ReturnType<typeof app.conversation.exchanges.list>};
    assert.equal(items.length, 1);
    const session = items[0]!;
    assert.equal(session.status, "completed");
    const detail = await fetch(url + "/" + session.sessionId);
    assert.equal(detail.status, 200);
    const {turns} = await detail.json() as ReturnType<typeof app.conversation.exchanges.detail>;
    assert.deepEqual(turns.map(t => [t.speakerRoleId, t.content]), [[seat.id, opening], [roleId, feedback]]);
    const wake = app.services.autonomy.listWakes(roleId).find(w => w.wakeId === `role-exchange:${session.sessionId}:1`);
    assert.equal(wake?.status, "completed");
    await until(() => completed.includes(session.sessionId), "书签扩展收到同一场往来的结束事件");
    const access = app.roleAccess;
    for (const id of [seat.id, roleId]) {
      const rows = access.withStore(id, s => s.business.db.prepare(`
        SELECT t.* FROM role_exchange_turns t JOIN evidence_records e ON e.source_id=t.exchangeId
        WHERE t.sessionId=? AND e.source_kind='role_exchange' AND e.role_id=? ORDER BY t.turnIndex
      `).all(session.sessionId, id));
      assert.deepEqual(rows, turns);
    }
    app.conversation.submitMessage(roleId, f.windowId, {content: "用书签工具记下第 42 页。",
      submissionId: randomUUID(), sourcePlatform: "nowadays"});
    await app.conversation.waitForIdle(roleId);
    const receipt = requests.flatMap(r => r.messages).find(m => m.role === "tool" && m.toolName === toolName);
    assert.ok(receipt);
    assert.deepEqual(JSON.parse(receipt.content), {status: "success", result: {roleId, page: 42}});
  } finally { await f.close(); }
});

test("记忆仍未整理时，互聊可以参考本角色近期已说过的相关内容", async () => {
  const requests: ModelRequest[] = [];
  const model: ModelPort = {async *stream(req) {
    if (req.tools.some(tool => tool.name === "role_chat_reply")) {
      requests.push(req);
      yield {type: "tool_call", name: "role_chat_reply", callId: randomUUID(),
        arguments: {content: "收到。", endConversation: true}};
    } else {
      const book = req.messages.some(m => m.content.includes("银杏书签"));
      yield {type: "text_delta", text: book ? "银杏书签折桂731放在东窗第二格。" : "乐谱放进红色琴盒。"};
    }
    yield {type: "completed", stopReason: "stop"};
  }};
  const f = createFixtureWithModel(model);
  try {
    const send = async (content: string) => {
      f.app.conversation.submitMessage(f.roleId, f.windowId, {content, submissionId: randomUUID(), sourcePlatform: "nowadays"});
      await f.app.conversation.waitForIdle(f.roleId);
    };
    await send("银杏书签的代号是折桂731，放在东窗第二格。我的私人留言是晚霞。");
    await send("乐谱收好了吗？");
    const seat = prepareSeat(f);
    const session = f.app.conversation.exchanges.start(seat.id, f.roleId, "核对登记", "银杏书签的代号和位置是什么？", 2);
    await until(() => f.app.conversation.exchanges.detail(session.sessionId).status === "completed", "互聊已答复");
    const prompt = requests[0]!.turnContext ?? "";
    assert.match(prompt, /折桂731放在东窗第二格/);
    assert.doesNotMatch(prompt, /私人留言|红色琴盒/);
    const other = f.app.conversation.exchanges.start(seat.id, f.roleId, "秋日摄影", "镜头焦距是多少？", 2);
    await until(() => f.app.conversation.exchanges.detail(other.sessionId).status === "completed", "核对另一话题");
    const lastTurn = requests.at(-1)!.turnContext ?? "";
    assert.doesNotMatch(lastTurn, /折桂731|私人留言|红色琴盒/);
    assert.match(lastTurn, /记不清/);
  } finally { await f.close(); }
});

test("两场互聊的证据分别交给整理器", async () => {
  const f = createFixtureWithModel({async *stream(){ yield {type:"completed",stopReason:"stop"}; }});
  try {
    const seat = prepareSeat(f);
    const exchanges = f.app.conversation.exchanges;
    for (const topic of ["银杏书签","蓝色信封"]) {
      const s = exchanges.start(seat.id, f.roleId, topic, "放在哪里？", 2);
      exchanges.reply(f.roleId, s.sessionId, 1, "东窗。", true);
    }
    const access = f.app.roleAccess;
    access.withStore(f.roleId, storage => {
      const batch = new MemoryStore(storage.business.db).startBatch({roleId:f.roleId,budgetChars:24000,outputReserveChars:4000});
      assert.deepEqual(batch?.evidence.map(x => JSON.parse(x.content).turn.topic), ["银杏书签","银杏书签"]);
    });
  } finally { await f.close(); }
});

test("真实工具链按轮次唤醒，提前结束与硬上限均封口，双边记忆可召回，删除一方保留历史", {timeout: 60000}, async () => {
  let target = "";
  let topic = "旧书店";
  let early = false;
  const requests: ModelRequest[] = [];
  const model: ModelPort = {async *stream(req) {
    requests.push(req);
    const has = (tool: string) => req.tools.some(t => t.name === tool);
    if (has("role_chat_reply")) {
      assert.ok(!has("autonomy_share") && !has("app_role_chat_start"));
      yield {type: "tool_call", name: "role_chat_reply", callId: randomUUID(), arguments: {content: "我记得那本旧书。", endConversation: early}};
    } else if (has("app_role_chat_start") && !req.messages.some(m => m.role === "tool")) {
      yield {type: "tool_call", name: "app_role_chat_start", callId: randomUUID(),
        arguments: {targetRoleId: target, topic, opening: "一起聊聊旧书吧。", maxTurns: early ? 6 : 4}};
    } else {
      yield {type: "text_delta", text: "已发起会话。"};
    }
    yield {type: "completed", stopReason: "stop"};
  }};
  const f = createFixtureWithModel(model, {disableMemoryRuntime: false, memoryModelFactory: () => ({async form(input) {return form(input);}})});
  const {app, roleId} = f;
  target = roleId;
  const access = app.roleAccess;
  const service = app.conversation.exchanges;
  try {
    const seat = prepareSeat(f, true);
    app.conversation.submitMessage(seat.id, seat.windowId, {content: "找阿澄聊一次", submissionId: randomUUID(), sourcePlatform: "nowadays"});
    await until(() => service.list(5,0)[0]?.status === "completed", "模型发起与四轮交替封口");
    const first = service.list(5,0)[0]!;
    const history = service.detail(first.sessionId);
    assert.deepEqual(history.turns.map(t => t.speakerRoleId), [seat.id, roleId, seat.id, roleId]);
    assert.equal(new Set(history.turns.map(t => t.exchangeId)).size, 4);
    assert.equal(history.maxTurns, 4);
    const wakes = (id: string) => app.services.autonomy.listWakes(id).filter(w => w.wakeId.startsWith("role-exchange:"));
    await until(() => [...wakes(seat.id), ...wakes(roleId)].every(w => w.status === "completed"), "自主执行结算");
    assert.equal(wakes(seat.id).length + wakes(roleId).length, 3);
    for (const [id, peerName] of [[seat.id, first.targetName], [roleId, first.initiatorName]] as const) {
      const rows = access.withStore(id, s => s.business.db.prepare(`SELECT t.* FROM role_exchange_turns t JOIN evidence_records e ON e.source_kind='role_exchange'
        AND e.source_id=t.exchangeId WHERE e.role_id=? AND e.window_id IS NULL ORDER BY turnIndex`).all(id));
      assert.deepEqual(rows, history.turns);
      await until(() => app.services.memory.search(id, {query: peerName, types: ["event"]}).items.some(e => e.title.includes(peerName)), "后台独立形成对 "+peerName+" 的记忆");
      assert.equal(access.withStore(id, s => s.business.db.prepare("SELECT 1 FROM observed_dialogue_batches").get()), undefined);
    }
    assert.equal(app.services.messages.list(roleId, f.windowId, null, 10).items.length, 0);
    assert.deepEqual(app.services.messages.list(seat.id, seat.windowId, null, 10).items.map(m => m.content), ["找阿澄聊一次","已发起会话。"]);
    early = true;
    topic = "旧书店重访";
    const second = service.start(seat.id, roleId, topic, "又发现了一本书。");
    assert.notEqual(second.sessionId, first.sessionId);
    // 模拟另一侧已落盘但发起方尚未确认，同一次投递重放仍只有一个待办。
    access.withStore(seat.id, s => s.business.db.prepare("UPDATE role_exchange_sessions SET mirrorPending=1 WHERE sessionId=?").run(second.sessionId));
    service.recover(seat.id);
    await until(() => service.detail(second.sessionId).status === "completed", "主动提前结束");
    assert.equal(service.detail(second.sessionId).turnCount, 2);
    assert.equal(wakes(seat.id).length + wakes(roleId).length, 4);
    assert.throws(() => service.reply(roleId, second.sessionId, 1, "重复", false), /轮次已结束/);
    const lastRequest = requests.filter(req => req.tools.some(t => t.name === "role_chat_reply")).at(-1)!;
    assert.match(JSON.stringify(lastRequest), new RegExp("和" + first.initiatorName + "谈旧书店"));
    const port = await listen(app.server, 0, "127.0.0.1");
    const url = `http://127.0.0.1:${port}/v1/role-exchanges`;
    const get = async (suffix: string) => { const res = await fetch(url + suffix); assert.equal(res.status, 200); return await res.json() as {items: typeof first[]; turns: typeof history.turns}; };
    assert.deepEqual((await get("?limit=1&offset=1")).items.map((s: {sessionId:string}) => s.sessionId), [first.sessionId]);
    assert.equal((await get("?from=2099-01-01")).items.length, 0);
    app.services.activity.requestStop(roleId);
    await until(() => app.services.activity.view(roleId).state === "stopped", "删除前停止");
    await app.services.roleDeletion.remove(roleId, false);
    assert.equal((await get("")).items.length, 2);
    assert.deepEqual((await get("/" + first.sessionId)).turns, history.turns);
    assert.ok(app.services.memory.search(seat.id, {query: first.targetName}).items.length);
  } finally { await f.close(); }
});

test("两侧落盘之间中断后重启补齐，模型未作答时双边失败且不再投递", async () => {
  const model: ModelPort = { async *stream() {
    yield {type: "text_delta", text: "本次不回复。"};
    yield {type: "completed", stopReason: "stop"};
  }};
  const f = createFixtureWithModel(model);
  let app = f.app;
  try {
    const seat = prepareSeat(f);
    let access = app.roleAccess;
    access.withStore(f.roleId, s => s.business.db.exec(`CREATE TRIGGER simulate_interruption
      BEFORE INSERT ON role_exchange_turns BEGIN SELECT RAISE(ABORT,'TEST_INTERRUPTION'); END`));
    assert.throws(() => app.conversation.exchanges.start(seat.id, f.roleId, "重启前", "你听到了吗？"), /TEST_INTERRUPTION/);
    const session = app.conversation.exchanges.list(1,0)[0]!;
    assert.equal(app.services.autonomy.listWakes(f.roleId).length, 0);
    access.withStore(f.roleId, s => s.business.db.exec("DROP TRIGGER simulate_interruption"));
    await app.close();
    app = createBackendApp(app.config, {disablePresetAssistant: true, disableMemoryRuntime: true, modelPortFactory: () => model});
    access = app.roleAccess;
    await until(() => app.conversation.exchanges.detail(session.sessionId).status === "failed", "恢复后接收方完成一次决策");
    for (const id of [seat.id, f.roleId]) {
      const row = access.withStore(id, s => s.business.db.prepare(
        "SELECT status,reason,turnCount,mirrorPending FROM role_exchange_sessions WHERE sessionId=?").get(session.sessionId));
      assert.deepEqual(row, {status: "failed", reason: "ROLE_EXCHANGE_NO_REPLY", turnCount: 1, mirrorPending: 0});
    }
    assert.equal(app.services.autonomy.listWakes(f.roleId).length, 1);
    assert.equal(app.services.autonomy.listWakes(seat.id).length, 0);
  } finally {
    await app.close();
    await f.close();
  }
});

test("停止、在途用户消息与自主额度分别收口或排队，无额外预算恢复唤醒", {timeout: 40000}, async () => {
  const started = deferred<void>(), release = deferred<void>();
  const calls: string[] = [];
  const model: ModelPort = {async *stream(request): AsyncIterable<ModelEvent> {
    if (request.tools.some(t => t.name === "role_chat_reply")) {
      calls.push("exchange");
      yield {type: "tool_call", name: "role_chat_reply", arguments: {content: "等你说完了。", endConversation: true}, callId: "r"};
    } else {
      calls.push("user");
      started.resolve();
      await release.promise;
      yield {type: "text_delta", text: "先回答用户。"};
    }
    yield {type: "completed", stopReason: "stop"};
  }};
  const f = createFixtureWithModel(model);
  const {app, roleId} = f;
  try {
    const seat = prepareSeat(f);
    const exchanges = app.conversation.exchanges;
    const start = () => exchanges.start(seat.id, roleId, "问候", "你好。");
    const wakes = () => app.services.autonomy.listWakes(roleId);
    for (const limit of [1, 13, 2.5]) assert.throws(() => exchanges.start(seat.id, roleId, "问候", "你好", limit), /整数轮数/);
    assert.throws(() => exchanges.start(roleId, seat.id, "问候", "你好"), /仅主角色/);
    app.services.activity.requestStop(roleId);
    assert.equal(start().reason, "ROLE_STOPPED");
    assert.equal(wakes().length, 0);
    app.services.activity.resume(roleId);
    app.services.autonomy.setBudget(roleId, {dailyLimit: 1, unlimited: false});
    app.services.autonomy.consumePoint(roleId);
    assert.equal(start().reason, "AUTONOMY_BUDGET_EXHAUSTED");
    assert.equal(wakes().length, 0);
    app.services.autonomy.setBudget(roleId, {dailyLimit: 3, unlimited: false});
    app.conversation.submitMessage(roleId, f.windowId, {content: "用户在说话", submissionId: randomUUID(), sourcePlatform: "nowadays"});
    await started.promise;
    const session = start();
    assert.equal(wakes()[0]?.status, "pending");
    assert.deepEqual(calls, ["user"]);
    release.resolve();
    await until(() => exchanges.detail(session.sessionId).status === "completed", "用户完成后才回复");
    assert.deepEqual(calls, ["user","exchange"]);
    assert.deepEqual(app.services.messages.list(roleId, f.windowId, null, 10).items.map(m => m.content), ["用户在说话","先回答用户。"]);
    app.services.autonomy.setBudget(roleId, {dailyLimit: 4, unlimited: false});
    const exhausted = start();
    await until(() => exchanges.detail(exhausted.sessionId).reason === "AUTONOMY_BUDGET_EXHAUSTED", "最后一点额度只够模型调用");
    assert.ok(wakes().every(w => w.kind !== "budget_resume"));
    assert.equal(exchanges.detail(exhausted.sessionId).turnCount, 1);
  } finally { release.resolve(); await f.close(); }
});
