import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MemoryQueryService } from "../src/application/memory-query-service.js";
import type { RoleAccess } from "../src/application/role-access.js";
import { rebuildTransferMemorySearch } from "../src/application/role-transfer-data.js";
import type { MemoryClaimRecord } from "../src/domain/memory.js";
import { registerMessageEvidence } from "../src/storage/evidence.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { RoleStore } from "../src/storage/role-store.js";

const now = "2026-11-20T12:00:00.000Z";
function setup() {
  const roleId = randomUUID();
  const business = new RoleStore(":memory:");
  const { window } = business.createRoleRecord({
    roleId, displayName: "校对", definitionText: "校对", definitionPayload: {}, initialState: {},
  });
  const raw = "票夹是墨绿色，夹着一片银杏。";
  const { message } = business.submitMessage(roleId, window.windowId, {
    content: raw, submissionId: randomUUID(), sourcePlatform: "nowadays",
  });
  registerMessageEvidence(business.db, { roleId, executionId: null, messageIds: [message.messageId] });
  const store = new MemoryStore(business.db);
  const evidenceId = store.listEvidence(roleId)[0]!.evidenceId;
  const access = { withStore: (_id: string, callback: (s: { business: RoleStore }) => unknown) => callback({ business }) };
  const service = new MemoryQueryService(access as RoleAccess, { now: () => new Date(now) });
  const claim = (kind: MemoryClaimRecord["kind"], text: string): MemoryClaimRecord => ({
    kind, text, evidenceId, sourceKind: "message", sourceSender: "user", sourceAt: now, recordedAt: now, learnedAt: now,
  });
  const create = (claims: MemoryClaimRecord[]) => store.createEvent({
    roleId, title: "午间见面", summary: "正午经过紫色板凳。", subjectiveExperience: "", occurredAtStart: now,
    occurredAtEnd: null, experienceDate: now.slice(0, 10), tags: { topic: ["午饭"] }, currentRound: 0,
    evidenceIds: [evidenceId], now, claims,
  }).eventId;
  return { roleId, business, store, service, claim, create, raw, evidenceId };
}

test("逐项更正经过精炼和迁移重建后仍可检索，其余珍惜线索与历史原文保留", t => {
  const { roleId, business, store, service, claim, create, raw, evidenceId } = setup();
  t.after(() => business.close());
  const eventId = create([claim("cherished_detail", "绯红色票夹"), claim("interest", "银杏标本")]);
  const initial = service.getEvent(roleId, eventId);
  const [color, leaf] = initial.claims;
  const corrected = service.correctEvent(roleId, eventId, {
    expectedVersion: 1, patch: { summary: "更正后的票夹为墨绿色，正午经过紫色板凳。" },
    supersedeClaimIds: [color!.claimId!], claimReplacements: { [color!.claimId!]: "墨绿色票夹" },
  }, "user_correction");
  const visible = service.getEvent(roleId, eventId).claims;
  assert.equal(visible[0]!.claimId, leaf!.claimId);
  assert.equal(visible[1]!.kind, "correction");
  assert.equal(visible[1]!.correctedKind, "cherished_detail");
  assert.equal(visible[1]!.correctionSource, "user_correction");
  assert.equal(visible[1]!.quoteContext, undefined);
  const hits = (query: string) => service.search(roleId, { query, types: ["event"] }).items.map(item => item.id);
  assert.deepEqual(hits("绯红色"), []);
  const refined = store.refineEvent({ roleId, events: [{eventId, expectedVersion: corrected.version}], summary: "午间闲谈。", now });
  const verify = () => {
    assert.deepEqual(hits("墨绿色"), [eventId]);
    assert.deepEqual(hits("银杏"), [eventId]);
    assert.deepEqual(hits("绯红色"), []);
    assert.deepEqual(hits("紫色板凳"), []);
    assert.deepEqual(store.listRecentEvents(roleId, 20, "再聊聊银杏标本？").map(item => item.eventId), [eventId]);
    assert.deepEqual(store.listRecentEvents(roleId, 20, "紫色板凳"), []);
    assert.deepEqual(store.listRecentEvents(roleId, 20, "午饭").map(item => item.eventId), [eventId]);
    assert.equal(store.getSearchDocument(roleId, "daily_summary", refined.summary.summaryId)?.title, "午饭");
  };
  verify();
  business.db.exec("DELETE FROM memory_search_documents");
  rebuildTransferMemorySearch(business.db);
  verify();
  assert.equal(store.getEvidenceDetail(roleId, evidenceId).content, raw);
  const original = business.db.prepare("SELECT content_json FROM memory_revisions WHERE target_id=? AND revision_number=1")
    .get(eventId) as {content_json:string};
  assert.match(original.content_json, /绯红色/);
  assert.throws(() => service.correctEvent(roleId, eventId, {
    expectedVersion: refined.events[0]!.version, patch: {summary:"不应提交"}, supersedeClaimIds: [color!.claimId!],
  }, "user_correction"), { code: "INVALID_MEMORY_CORRECTION" });
  assert.notEqual(service.getEvent(roleId, eventId).summary, "不应提交");
});

test("撤下当前实践版本后，旧做法不重新成为现行建议", t => {
  const { roleId, business, store, service, claim, create } = setup();
  t.after(() => business.close());
  const practice = (text: string) => ({ ...claim("practice",text), practice: { key: "版本判读", scope: "藏书", outcome: text } });
  const eventId = create([practice("先看封皮")]);
  store.updateEvent({ roleId, eventId, expectedVersion: 1, patch:{}, addEvidenceIds:[], currentRound:1, now,
    claims:[practice("先看扉页"), claim("commitment","不划伤书页")] });
  service.correctEvent(roleId, eventId, {
    expectedVersion: 2, patch: {}, supersedeClaimIds: ["v1:0"], claimReplacements: { "v1:0": "旧时先看封底" },
  }, "user_correction");
  assert.match(store.getSearchDocument(roleId, "event", eventId)!.body, /先看扉页/);
  assert.doesNotMatch(store.getSearchDocument(roleId, "event", eventId)!.body, /封底/);
  service.correctEvent(roleId, eventId, { expectedVersion:3, patch:{}, supersedeClaimIds:["v2:0"] }, "user_correction");
  assert.deepEqual(service.getEvent(roleId,eventId).claims.map(c => c.text), ["不划伤书页"]);
  const document = store.getSearchDocument(roleId,"event",eventId)!;
  assert.doesNotMatch(document.body,/先看封皮|先看扉页/);
  assert.equal(store.listRecentEvents(roleId,20,"午饭")[0]?.practiceKeys, undefined);
});
