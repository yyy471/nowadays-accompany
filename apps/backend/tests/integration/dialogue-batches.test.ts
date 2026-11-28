import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { rolePaths } from "../../src/bootstrap/config.js";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import type { ModelEvent } from "../../src/domain/model.js";
import { ConversationStore } from "../../src/storage/conversation/conversation-store.js";
import { RoleAccess } from "../../src/application/role/role-access.js";
import { createAdminTools } from "../../src/application/role/admin-tools.js";
import { createFixtureWithModel, ScriptedChatModel } from "../fixtures/conversation-fixture.js";
import { seedLegacyPresetAssistant } from "../fixtures/legacy-role-fixture.js";

const reply = (text: string): ModelEvent[] => [
  { type: "text_delta", text }, { type: "completed", stopReason: "stop" },
];
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(25);
  }
  assert.fail("批次调度超时");
}

test("普通来信合批，跨重启幂等投递；主角色先回复用户，再按 A 批查阅，B 批受预算守卫", async () => {
  let clock = Date.now();
  let anchor: Record<string, unknown> = {};
  const model = new ScriptedChatModel([
    reply("甲答一"), reply("甲答二"), reply("乙答"), reply("先回答你"),
    () => [{type: "tool_call", callId: "read-a", name: "app_role_records_query",
      arguments: {...anchor, kind: "messages"}}, {type: "completed", stopReason: "tool_use"}],
    reply("已看过这段记录。"),
  ]);
  const options = {batchDelayMs: 50, now: () => new Date(clock), disableMemoryRuntime: true,
    disablePresetAssistant: true, modelPortFactory: () => model};
  const fixture = createFixtureWithModel(model, options);
  let app = fixture.app;
  const {roleId, windowId} = fixture;
  const db = () => app.roleAccess;
  const send = async (content: string) => {
    app.conversation.submitMessage(roleId, windowId, {content, submissionId: randomUUID(), sourcePlatform: "nowadays"});
    await app.conversation.waitForIdle(roleId);
  };
  const restart = async () => {
    await app.close();
    app = createBackendApp(fixture.app.config, options);
  };
  try {
    seedLegacyPresetAssistant(app.config);
    const seatId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const seat = app.services.roles.initializeRole(seatId);
    const resourceId = app.services.resources.listBindings(roleId)[0]!.resourceId;
    app.services.resources.replaceBindings(seatId, [{resourceId, capability: "chat_model", enabled: true, modelName: "offline-chat"}]);
    const wakes = () => app.services.autonomy.listWakes(seatId).filter(w => w.wakeId.startsWith("dialogue-"));
    await send("原文甲一");
    await send("原文甲二");
    assert.equal(wakes().length, 0);
    const expected = app.services.messages.list(roleId, windowId, null, 10).items;
    assert.equal(expected.length, 4);
    clock += 60;
    await restart();
    await until(() => wakes().length === 1);
    const a = wakes()[0]!;
    assert.doesNotMatch(a.intent, /原文|甲答/);
    assert.equal(a.status, "pending");
    anchor = {roleId, windowId, batchId: a.wakeId, afterSeq: 0, upToSeq: expected.at(-1)!.sequence};
    assert.match(a.intent, /"messageCount":4/);
    // 模拟收端已提交、源端确认尚未写入时掉电。
    db().withStore(roleId, s => s.business.db.prepare("UPDATE observed_dialogue_batches SET delivered_at=NULL").run());
    await restart();
    await until(() => db().withStore(roleId, s => !!s.business.db.prepare("SELECT 1 FROM observed_dialogue_batches WHERE delivered_at IS NOT NULL").get()));
    assert.equal(wakes().length, 1);
    await send("原文乙");
    clock += 60;
    await until(() => wakes().length === 2);
    assert.equal(app.services.autonomy.getBudget(seatId).usedPoints, 0);
    assert.equal(app.services.activity.view(seatId).state, "stopped");

    app.services.autonomy.setBudget(seatId, {dailyLimit: 3, unlimited: false});
    app.services.messages.submit(seatId, seat.defaultWindowId, {content: "先处理这封来信", submissionId: randomUUID(), sourcePlatform: "nowadays"});
    app.services.activity.resume(seatId);
    await until(() => wakes().every(w => w.status === "completed"));
    await app.conversation.waitForIdle(seatId);
    assert.match(JSON.stringify(model.requests[3]?.messages), /先处理这封来信/);
    assert.match(model.requests[4]!.turnContext ?? "", new RegExp(a.wakeId));
    assert.doesNotMatch(model.requests[4]!.turnContext ?? "", /原文甲|原文乙/);
    const receipt = db().withStore(seatId, s => s.business.db.prepare(
      `SELECT adapted_result_json FROM tool_results JOIN tool_calls USING(tool_call_id)
       JOIN evidence_records ON source_kind = 'tool_result' AND source_id = tool_call_id WHERE tool_name='app_role_records_query'`,
    ).get()) as {adapted_result_json: string};
    const result = JSON.parse(receipt.adapted_result_json);
    assert.equal(result.provenance, "查阅其他角色窗口的引述记录");
    assert.equal(result.roleId, roleId);
    assert.equal(result.windowId, windowId);
    assert.equal(result.consultedAt, new Date(clock).toISOString());
    assert.deepEqual(result.items.map((m: {messageId: string; createdAt: string; content: string}) => [m.messageId, m.createdAt, m.content]),
      expected.map(m => [m.messageId, m.createdAt, m.content]));
    assert.equal(wakes().find(w => w.wakeId !== a.wakeId)?.lastErrorCode, "AUTONOMY_BUDGET_EXHAUSTED");
    assert.equal(app.services.autonomy.getBudget(seatId).usedPoints, 3);
    assert.equal(db().withStore(seatId, s => s.business.db.prepare("SELECT 1 FROM observed_dialogue_batches").get()), undefined);
    await restart();
    assert.equal(wakes().length, 2);
    assert.equal(app.services.autonomy.getBudget(seatId).usedPoints, 3);
    assert.equal(model.requests.length, 6);
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("输入态、流式增量、自主执行与纯工具续行都不产批，按范围和按批次分别分页", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]), {disablePresetAssistant: false});
  try {
    const {app, roleId, windowId} = f;
    const seatId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const access = app.roleAccess;
    app.conversation.updateInputState({roleId, windowId, typing: true, clientId: "draft"});
    const anchor = access.withStore(roleId, ({business}) => {
      const store = new ConversationStore(business.db, roleId);
      const count = () => business.db.prepare("SELECT batch_id FROM observed_dialogue_batches").all().length;
      for (const triggerType of ["autonomous", "tool_result"] as const) {
        const {executionId} = business.createExecution({roleId, windowId, triggerType});
        store.commitConversation({executionId, content: "单独执行", statePatch: {}, countsAsConversationRound: triggerType !== "autonomous"});
      }
      assert.equal(count(), 0);
      business.submitMessage(roleId, windowId, {content: "用户来信", sourcePlatform: "nowadays", submissionId: randomUUID()});
      const {executionId} = store.beginExecution({windowId})!.execution;
      // 来信与回复之间夹着其他来源的消息，批次成员不包含它。
      store.appendProactiveMessage({executionId, windowId, content: "独立通知"});
      store.appendMessageDelta({executionId, windowId, text: "半句"});
      assert.equal(count(), 0);
      const commit = {executionId, content: "完成回复", statePatch: {}};
      store.commitConversation(commit);
      store.commitConversation(commit);
      return business.db.prepare("SELECT batch_id AS id, message_count AS n, up_to_seq AS last FROM observed_dialogue_batches").get() as {id:string; n:number; last:number};
    });
    assert.equal(anchor.n, 2);
    const query = createAdminTools({...app.services, builtinRoleId: seatId, now: () => new Date()}).find(t => t.name === "app_role_records_query")!;
    const read = async (args: Record<string, unknown>) => {
      const response = await query.execute({roleId, windowId, kind: "messages", ...args}, {
        roleId: seatId, windowId: app.services.roles.getRole(seatId).defaultWindowId,
        executionId: randomUUID(), taskId: null, signal: new AbortController().signal,
      });
      assert.equal(response.status, "success");
      return response.adaptedResult as {items: Array<{content: string}>; nextAfter: number | null};
    };
    const first = await read({batchId: anchor.id, limit: 1});
    assert.deepEqual(first.items.map(m => m.content), ["用户来信"]);
    const second = await read({batchId: anchor.id, afterSeq: first.nextAfter, limit: 1});
    assert.deepEqual(second.items.map(m => m.content), ["完成回复"]);
    assert.equal(second.nextAfter, null);
    const bounded = await read({afterSeq: anchor.last - 3, upToSeq: anchor.last - 1});
    assert.deepEqual(bounded.items.map(m => m.content), ["用户来信", "独立通知"]);
  } finally { await f.close(); }
});

test("收端登记后源端确认前强制退出子进程，重启复用同一个 wake", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([reply("本轮结束")]), {disablePresetAssistant: false, batchDelayMs: 60_000});
  const seatId = f.app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const config = f.app.config;
  let recovered;
  let child;
  try {
    f.app.conversation.submitMessage(f.roleId, f.windowId, {content: "一封来信", submissionId: randomUUID(), sourcePlatform: "nowadays"});
    await f.app.conversation.waitForIdle(f.roleId);
    await f.app.close();
    const source = new Database(rolePaths(config.dataRoot, f.roleId).businessDatabasePath);
    try {
      source.exec(`UPDATE observed_dialogue_batches SET due_at = completed_at;
        CREATE TRIGGER fail_ack BEFORE UPDATE OF delivered_at ON observed_dialogue_batches
        BEGIN SELECT RAISE(ABORT, 'TEST_CRASH_BEFORE_ACK'); END`);
    } finally { source.close(); }
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import {createBackendApp, listen} from "./src/bootstrap/app.ts";
      import {parseBackendConfig} from "./src/bootstrap/config.ts";
      const app = createBackendApp(parseBackendConfig(["--app-root", process.argv[1], "--port", "0"]), {disableMemoryRuntime:true});
      await listen(app.server, 0, "127.0.0.1");
    `, f.root], {stdio: "ignore", windowsHide: true});
    const exited = once(child, "exit");
    const receiver = new Database(rolePaths(config.dataRoot, seatId).businessDatabasePath, {readonly: true});
    let batchId: string;
    try {
      const wake = receiver.prepare("SELECT wake_id FROM autonomy_wakes WHERE wake_id LIKE 'dialogue-%'");
      await until(() => !!wake.get());
      batchId = (wake.get() as {wake_id: string}).wake_id;
    } finally {
      receiver.close();
      child.kill("SIGKILL");
      await exited;
    }
    const pending = new Database(rolePaths(config.dataRoot, f.roleId).businessDatabasePath);
    try {
      assert.ok(pending.prepare("SELECT 1 FROM observed_dialogue_batches WHERE batch_id=? AND delivered_at IS NULL").get(batchId));
      pending.exec("DROP TRIGGER fail_ack");
    } finally { pending.close(); }
    recovered = createBackendApp(config, {disableMemoryRuntime: true});
    const access = recovered.roleAccess;
    await until(() => access.withStore(f.roleId, s => !!s.business.db.prepare(
      "SELECT 1 FROM observed_dialogue_batches WHERE batch_id=? AND delivered_at IS NOT NULL").get(batchId)));
    assert.deepEqual(recovered.services.autonomy.listWakes(seatId).map(w => w.wakeId), [batchId]);
    assert.equal(recovered.services.autonomy.getBudget(seatId).usedPoints, 0);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await recovered?.close();
    await f.close();
  }
});

test("正式分享提交后可独立订阅和重放，只发送分享且保留句段标注入口", async t => {
  const f = createFixtureWithModel(new ScriptedChatModel([]), {disablePresetAssistant: false, typingMs: 30_000});
  const app = f.app;
  const abort = new AbortController();
  try {
    const seat = app.services.roles.getRole(app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId);
    const roleId = seat.roleId, windowId = seat.defaultWindowId;
    const access = app.roleAccess;
    const executionId = access.withStore(roleId, s => s.business.createExecution({roleId, windowId, triggerType: "autonomous"}).executionId);
    const annotation = t.mock.method(app.conversation, "queueSegmentAnnotation");
    access.withStore(roleId, s => new ConversationStore(s.business.db, roleId).appendProactiveMessage({
      source: "task_circuit_breaker", executionId, windowId, content: "系统熔断样例",
    }));
    const share = app.services.autonomy.shareMessage(roleId, {executionId, content: "正式分享样例"});
    assert.equal(annotation.mock.calls.length, 1);
    assert.equal(annotation.mock.calls[0]?.arguments[0].messageId, share.messageId);
    assert.ok(app.services.messages.get(roleId, windowId, share.messageId).segments.length);
    const port = await listen(app.server, 0, "127.0.0.1");
    app.conversation.updateInputState({roleId, windowId, typing: true, clientId: "editor"});
    const url = `http://127.0.0.1:${port}/v1/roles/${roleId}/share-events?after=0&clientId=editor`;
    const subscription = t.mock.method(app.conversation, "streamEvents");
    const response = await fetch(url, {signal: abort.signal});
    assert.equal(response.status, 200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let body = "";
    while (!body.includes("event: share")) body += (await reader.read()).value;
    const notice = JSON.parse(body.split("event: share\ndata: ")[1]!.split("\n")[0]!);
    assert.deepEqual([notice.source, notice.roleId, notice.windowId, notice.messageId, notice.summary],
      ["autonomy_share", roleId, windowId, share.messageId, "正式分享样例"]);
    assert.doesNotMatch(body, /系统熔断样例|message_segments/);
    await reader.cancel();
    await subscription.mock.calls[0]!.result;
    assert.equal(app.conversation.inputStates.isTyping(roleId, windowId), true);
    assert.equal((await fetch(url.replace(roleId, f.roleId))).status, 404);
  } finally {
    abort.abort();
    await f.close();
  }
});
