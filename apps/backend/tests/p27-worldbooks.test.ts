import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { selectAgentContext } from "../src/application/conversation/agent-context.js";
import { listen } from "../src/bootstrap/app.js";
import { matchWorldbooks, type Worldbook } from "../src/domain/worldbook.js";
import { type ModelRequest } from "../src/domain/model.js";
import { serializeModelRequest } from "../src/model/protocols.js";
import { MemoryStore } from "../src/storage/memory/memory-store.js";
import { createFixture, ScriptedChatModel, withStorage } from "./p2-05-fixture.js";
import { captureRoleTransfer, roleTransferTimelineFingerprint, roleTransferWithAncestors,
  writeRoleTransferPackage } from "../src/application/transfer/role-transfer-package.js";

const entry = (id: string, keyword: string, content: string): Worldbook["entries"][number] => ({
  id, title: id, keywords: [keyword], content, enabled: true, visibility: "known",
});
const books: Worldbook[] = [{ id: "port", name: "雾港", enabled: true, entries: [
  entry("boat", "雾港", "摆渡凭青陶牌。"),
  { ...entry("secret", "雾港", "作者的朱砂印。"), visibility: "author_only" },
  { ...entry("closed", "雾港", "已停用的旧船。"), enabled: false },
  entry("recursion", "青陶牌", "条目内容不能递归触发。"),
  entry("gallery", "Art", "英文词边界。"),
] }, { id: "off", name: "停用书", enabled: false, entries: [entry("off", "雾港", "未启用。")] }];

test("中文、全角英文及词边界匹配，整条可知内容受实际序列化容量约束", () => {
  const matches = matchWorldbooks({ revision: 3, books }, [{ id: "m1", text: "雾港 cart" }, { id: "m2", text: "ＡＲＴ" }]);
  assert.deepEqual(matches.map(item => [item.entryId, item.messageIds]), [["gallery", ["m2"]], ["boat", ["m1"]]]);
  const request: ModelRequest = { modelName: "local", system: "必要资料", messages: [], tools: [] };
  const protocol = "openai-chat";
  const baseUrl = "http://offline.invalid";
  const input: Parameters<typeof selectAgentContext>[0] = { request, protocol, baseUrl, prompt: { required: request.system, optional: [], worldbook: matches },
    evidenceQuery: "", resuming: false, maxOutputChars: 100 };
  const size = serializeModelRequest(protocol, baseUrl, request).length;
  const tiny = selectAgentContext({ ...input, maxInputChars: size + 100 });
  assert.equal(tiny.system, request.system);
  assert.deepEqual(tiny.worldbookSelection.map(hit => hit.status), ["budget_omitted", "budget_omitted"]);
  const crowded = selectAgentContext({ ...input, prompt: { ...input.prompt, worldbook:
    Array.from({ length: 9 }, (_, i) => ({ ...matches[0]!, content: "慢".repeat(i === 0 ? 1800 : 500), entryId: String(i) })) } });
  assert.ok(crowded.system.length <= request.system.length + 4000);
  assert.ok(crowded.worldbookSelection.some(hit => hit.status === "budget_omitted"));
  const empty = selectAgentContext({ ...input, prompt: { ...input.prompt, worldbook: [] } });
  assert.equal(empty.system, request.system);
});

test("正式消息接口只登记模型收到的条目；记忆关联按证据，修订、删除与跨角色读取不改历史", async () => {
  const reply = [{ type: "text_delta" as const, text: "带上牌子吧。" }, { type: "completed" as const, stopReason: "stop" }];
  const fixture = createFixture([reply, reply, () => { throw new Error("offline rejected before acceptance"); }]);
  const { app, roleId, windowId } = fixture;
  try {
    const port = await listen(app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}/v1/roles/${roleId}`;
    const write = (path: string, method: string, body?: unknown) => fetch(base + path, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const put = (expectedRevision: number, value: Worldbook[]) => write("/worldbooks", "PUT", { expectedRevision, books: value });
    const submit = async (content: string) => {
      const result = await write(`/windows/${windowId}/messages`, "POST", { content, submissionId: randomUUID() });
      assert.equal(result.status, 201);
      await app.conversation.waitForIdle(roleId);
      return withStorage(fixture, ({ business }) => (business.db.prepare(
        "SELECT execution_id AS id FROM executions WHERE role_id = ? ORDER BY rowid DESC LIMIT 1",
      ).get(roleId) as { id: string }).id);
    };
    assert.deepEqual(await (await fetch(base + "/worldbooks")).json(), { revision: 0, books: [] });
    assert.equal((await put(0, books)).status, 409);
    await write("/activity/stop", "POST");
    const large = Array.from({ length: 4 }, (_, n) => ({ id: "large-" + n, name: "大书", enabled: true,
      entries: Array.from({ length: 64 }, (_, k) => entry("entry-" + k, "大书", "字".repeat(1800))) }));
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);
    const largeResponse = await put(0, large);
    assert.equal(largeResponse.status, 200);
    await largeResponse.arrayBuffer();
    const overflow = Array.from({ length: 7 }, (_, i) => entry("extra-" + i, "雾港", "可知的潮汐。"));
    const book = { ...books[0]!, entries: [...books[0]!.entries, ...overflow] };
    assert.equal((await put(1, [book, book])).status, 400);
    assert.equal((await put(1, [book, books[1]!])).status, 200);
    assert.equal((await put(1, [])).status, 409);
    await write("/activity/resume", "POST");
    const executionId = await submit("去雾港。");
    const model = fixture.model as ScriptedChatModel;
    assert.match(model.requests[0]!.system, /摆渡凭青陶牌/);
    assert.doesNotMatch(model.requests[0]!.system, /朱砂印|旧船|递归触发|英文词边界|未启用/);
    const usage = app.services.roles.getWorldbookUsage(roleId, executionId);
    assert.deepEqual((await (await fetch(base + "/worldbooks/usage?executionId=" + executionId)).json() as { items: unknown }).items, usage);
    assert.equal(usage.filter(row => row.status === "included").length, 6);
    assert.equal(usage.filter(row => row.status === "budget_omitted").length, 2);
    const second = await submit("今晚吃面。");
    assert.equal(app.services.roles.getWorldbookUsage(roleId, second).length, 0);
    assert.doesNotMatch(model.requests[1]!.system, /摆渡凭青陶牌|已知世界设定/);
    const refused = await submit("又去雾港。");
    assert.equal(app.services.roles.getWorldbookUsage(roleId, refused).length, 0);
    const eventId = withStorage(fixture, ({ business }) => {
      const store = new MemoryStore(business.db);
      const evidence = store.listEvidence(roleId).find(row => row.sourceId === usage[0]!.messageIds[0]);
      assert.ok(evidence);
      const event = store.createEvent({ roleId, title: "约了摆渡", summary: "谈了计划", subjectiveExperience: "",
        occurredAtStart: evidence.occurredAt, occurredAtEnd: null, experienceDate: evidence.localDate, tags: {},
        evidenceIds: [evidence.evidenceId], currentRound: 0, now: evidence.occurredAt });
      return event.eventId;
    });
    await write("/activity/stop", "POST");
    assert.equal((await put(2, [])).status, 200);
    const detail = app.services.memory.getEvent(roleId, eventId);
    assert.deepEqual(detail.worldbookEntries.map(row => row.entryId).sort(),
      usage.filter(row => row.status === "included").map(row => row.entryId).sort());
    const other = app.services.roles.createRole({ displayName: "另一个角色", definition: { text: "另一段人生" } });
    assert.deepEqual(app.services.roles.getWorldbooks(other.roleId), { revision: 0, books: [] });
    assert.deepEqual(app.services.roles.getWorldbookUsage(other.roleId, executionId), []);
    const pkg = captureRoleTransfer(app.config, roleId);
    assert.equal(pkg.tables.role_worldbooks[0]!.revision, 3);
    assert.equal(pkg.tables.worldbook_usage.length, 8);
    const corrupt = structuredClone(pkg);
    corrupt.tables.worldbook_usage[0]!.execution_id = second;
    const rejected = roleTransferWithAncestors({ ...corrupt,
      timelineFingerprint: roleTransferTimelineFingerprint(corrupt) }, []);
    assert.throws(() => writeRoleTransferPackage(path.join(fixture.root, "broken.json"), rejected), /RELATION_INVALID/);

    // 用户消息可能先被另一执行领取，后由续行送达模型。记忆以命中的消息 ID 留证。
    withStorage(fixture, ({ business }) => business.db.prepare("UPDATE messages SET execution_id = ? WHERE message_id = ?")
      .run(second, usage[0]!.messageIds[0]));
    assert.deepEqual(app.services.memory.getEvent(roleId, eventId).worldbookEntries, detail.worldbookEntries);
    const old = captureRoleTransfer(app.config, other.roleId);
    Reflect.deleteProperty(old.tables, "role_worldbooks");
    Reflect.deleteProperty(old.tables, "worldbook_usage");
    const legacy = roleTransferWithAncestors(old, []);
    assert.equal(roleTransferTimelineFingerprint(legacy), old.timelineFingerprint);
    writeRoleTransferPackage(path.join(fixture.root, "old-v1.json"), legacy);
  } finally { await fixture.close(); }
});

test("旧角色卡内嵌条目在单独维护后可清空，展示人物卡原文时也不泄露作者区", async () => {
  const reply = [{ type: "text_delta" as const, text: "好。" }, { type: "completed" as const, stopReason: "stop" }];
  const fixture = createFixture([reply, reply]);
  const { app, roleId, windowId } = fixture;
  try {
    app.services.activity.requestStop(roleId);
    const payload = { data: { character_book: { name: "旧卡书", entries: [
      { id: 1, keys: ["雾港"], content: "浅读到的公开设定。", visibility: "known" },
      { id: 2, keys: ["雾港"], content: "作者区的隐藏身份。" },
    ] } } };
    const role = app.services.roles.updateDefinition(roleId, { definition: { text: "海边长大。", payload } });
    const imported = app.services.roles.getWorldbooks(roleId);
    assert.equal(imported.revision, role.definitionRevision);
    assert.deepEqual(imported.books[0]!.entries.map(item => item.visibility), ["known", "author_only"]);
    const submit = async () => {
      app.services.activity.resume(roleId);
      app.conversation.submitMessage(roleId, windowId, { content: "展示人物卡原文，雾港怎么样？", submissionId: randomUUID(), sourcePlatform: "nowadays" });
      await app.conversation.waitForIdle(roleId);
      app.services.activity.requestStop(roleId);
    };
    await submit();
    const requests = (fixture.model as ScriptedChatModel).requests;
    assert.match(requests[0]!.system, /浅读到的公开设定/);
    assert.doesNotMatch(requests[0]!.system, /隐藏身份|character_book/);
    app.services.roles.putWorldbooks(roleId, imported.revision, []);
    await submit();
    assert.doesNotMatch(requests[1]!.system, /浅读到的公开设定|隐藏身份|character_book/);
    assert.deepEqual(app.services.roles.getRole(roleId).definition.payload, payload);
  } finally { await fixture.close(); }
});
