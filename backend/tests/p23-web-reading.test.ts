import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { extractMcpWebFragments, pageWebFragments, renderWebReadingPrefix, webReadingCandidates } from "../src/domain/web-reading.js";
import { listWebReadingPositions, readWebToolProjection } from "../src/storage/web-reading.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { backfillEvidence } from "../src/storage/evidence.js";

const url = "https://fixture.invalid/reading/topic";
const markers = (value: unknown): number[] =>
  [...new Set(Array.from((JSON.stringify(value) ?? "").matchAll(/END_ARTICLE_(\d+)!/g), (match) => Number(match[1])))].sort((a, b) => a - b);

type WireRequest = {
  model: string;
  messages: Array<{ role: string; content?: string; name?: string }>;
  tools?: Array<{ function: { name: string } }>;
};

async function awaitState(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "等待网页阅读流水线达到预期状态");
    await setTimeout(20);
  }
}

async function readingInstallation(
  t: TestContext,
  choose: (body: WireRequest, res: http.ServerResponse) => void,
) {
  const captures: WireRequest[] = [];
  const model = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as WireRequest;
    captures.push(body);
    choose(body, res);
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  assert.ok(address && typeof address !== "string");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-web-reading-"));
  const cfg = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(cfg, { disablePresetAssistant: true, disableMemoryRuntime: true, toolForegroundWaitMs: 5_000 });
  const serverPort = await listen(app.server, 0, "127.0.0.1");
  const databases: Database.Database[] = [];
  t.after(async () => {
    model.closeAllConnections();
    await app.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    for (const db of databases) db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const api = async (route: string) => {
    const response = await fetch(`http://127.0.0.1:${serverPort}${route}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const install = async (options: { slow?: boolean; maxInputChars?: number } = {}) => {
    const role = app.services.roles.createRole({ displayName: "雨泊", definition: { text: "阅读时先核对原文。" } });
    const provider = app.services.resources.create({
      kind: "model", name: `网页测试模型-${role.roleId}`,
      config: {
        protocol: "openai-chat", baseUrl: `http://127.0.0.1:${address.port}/v1`,
        ...(options.maxInputChars === undefined ? {} : { maxInputChars: options.maxInputChars, maxOutputChars: 1_024 }),
      },
    });
    const fixture = path.join(import.meta.dirname, "fixtures", "web-reading-source.mjs");
    const mcp = app.services.resources.create({
      kind: "mcp", name: `网页测试-${role.roleId}`,
      config: { command: process.execPath, args: [fixture, "--serve", ...(options.slow ? ["--slow"] : [])], env: {} },
    });
    app.services.resources.replaceBindings(role.roleId, [
      { capability: "chat_model", resourceId: provider.resourceId, modelName: role.roleId, enabled: true },
      { capability: "mcp", resourceId: mcp.resourceId, enabled: true },
    ]);
    app.services.activity.resume(role.roleId);
    await app.conversation.waitForIdle(role.roleId, 15_000);
    const db = new Database(rolePaths(cfg.dataRoot, role.roleId).businessDatabasePath, { readonly: true });
    databases.push(db);
    return {
      roleId: role.roleId,
      db,
      route: `/v1/roles/${role.roleId}`,
      submit(content: string) {
        return app.conversation.submitMessage(role.roleId, role.defaultWindowId, { content, sourcePlatform: "desktop", submissionId: randomUUID() });
      },
      idle: () => app.conversation.waitForIdle(role.roleId, 15_000),
    };
  };
  return { captures, api, install };
}

function complete(res: http.ServerResponse, call?: { name: string; arguments: Record<string, unknown> }) {
  const delta = call ? {
    tool_calls: [{ index: 0, type: "function", id: `wire-${randomUUID()}`, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
  } : { content: "核对完毕。" };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

function readerCall(body: WireRequest, args: Record<string, unknown> = {}) {
  const reader = body.tools?.find((tool) => tool.function.name.includes("read_article"))?.function.name;
  assert.ok(reader);
  return { name: reader, arguments: args };
}

const findings = (db: Database.Database) =>
  db.prepare("SELECT tool_call_id, model_call_id, execution_id, start_offset, end_offset, original_text FROM web_reading_deliveries ORDER BY start_offset")
    .all() as Array<{ tool_call_id: string; model_call_id: string; execution_id: string; start_offset: number; end_offset: number; original_text: string }>;

test("stdio MCP 预取十段；HTTP 只送达已阅读分段，跳读、重读与跨角色回查保留独立事实", async (t) => {
  let stage = 0;
  let toolCallId = "";
  let processFirstDelivery: () => void;
  const env = await readingInstallation(t, (body, res) => {
    const last = body.messages.at(-1);
    if (last?.role === "user" && /(?:审阅|重新打开)夹具文章/.test(last.content ?? "")) {
      return complete(res, readerCall(body));
    }
    if (last?.role === "user" && last.content?.includes("打开新版文章")) {
      return complete(res, readerCall(body, { revision: true }));
    }
    if (last?.role !== "tool" || typeof last.content !== "string") return complete(res);
    const reading = webReadingCandidates(last.content);
    if (!reading) return complete(res);
    const first = reading.fragments[0];
    if (stage++ === 0) {
      assert.ok(first && reading.sourceToolCallId);
      toolCallId = reading.sourceToolCallId;
      return complete(res, { name: "web_reading", arguments: {
        mode: "read", toolCallId, url: first.url, pageVersion: first.pageVersion, offset: first.endOffset * 7, maxChars: 2_500,
      } });
    }
    if (stage === 2) {
      processFirstDelivery();
      return complete(res, { name: "web_reading", arguments: { mode: "read", toolCallId, offset: 0, maxChars: 2_500 } });
    }
    if (stage === 3) return complete(res, { name: "history_lookup", arguments: { kind: "tool", query: "END_ARTICLE_5!" } });
    return complete(res);
  });
  const role = await env.install();
  processFirstDelivery = () => {
    const db = new Database(role.db.name);
    try {
      const memory = new MemoryStore(db);
      assert.deepEqual(markers(findings(db)), [1, 2, 3]);
      const formationMarkers = new Set<number>();
      for (;;) {
        const batch = memory.startBatch({ roleId: role.roleId, budgetChars: 24_000, outputReserveChars: 1_000 });
        if (batch === null) break;
        const batchId = batch.batch.batchId;
        const now = new Date().toISOString();
        for (const item of batch.evidence) {
          for (const mark of markers(item.content)) formationMarkers.add(mark);
          for (const segment of item.segments) memory.markSegmentProcessed(item.evidence.evidenceId, segment.segmentIndex, now);
          memory.markEvidenceProcessed(role.roleId, batchId, item.evidence.evidenceId, now);
        }
        memory.finishBatch({ roleId: role.roleId, batchId, status: "completed" });
      }
      assert.deepEqual([...formationMarkers], [1, 2, 3]);
    } finally {
      db.close();
    }
  };
  role.submit("审阅夹具文章。");
  await role.idle();
  assert.ok(toolCallId);
  const wires = env.captures.flatMap(({ messages }) => messages.filter(({ role }) => role === "tool"));
  assert.deepEqual(markers(wires[0]), [1, 2, 3]);
  assert.deepEqual(markers(wires[1]), [8]);
  assert.deepEqual(markers(wires[2]), [1]);
  assert.deepEqual(JSON.parse(wires[3]!.content!).result.entries, []);

  const stored = findings(role.db);
  assert.deepEqual(markers(stored), [1, 2, 3, 8]);
  assert.equal(new Set(stored.map((item) => item.model_call_id)).size, 2);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]?.end_offset, stored[0]?.original_text.length);
  assert.ok(stored[1]!.start_offset > stored[0]!.end_offset);
  const positions = listWebReadingPositions(role.db, { roleId: role.roleId, url, offset: 0, limit: 1 });
  assert.equal(positions.pages[0]?.ranges.length, 2);
  assert.equal(positions.pages[0]?.resumeOffset, stored[1]?.end_offset);
  assert.equal(positions.pages[0]?.toolCallId, toolCallId);
  const projection = readWebToolProjection(role.db, role.roleId, toolCallId);
  assert.deepEqual(markers(projection), [1, 2, 3, 8]);
  assert.equal(readWebToolProjection(role.db, randomUUID(), toolCallId), undefined);

  const raw = role.db.prepare("SELECT raw_response_json, adapted_result_json FROM tool_results WHERE tool_call_id = ?")
    .get(toolCallId) as { raw_response_json: string; adapted_result_json: string };
  assert.deepEqual(markers(raw.raw_response_json), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(markers(raw.adapted_result_json), []);
  const evidence = new MemoryStore(role.db).listEvidence(role.roleId).filter((row) => row.sourceKind === "tool_result");
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((row) => row.processingStatus), ["processed", "pending"]);
  const details = await Promise.all(evidence.map(({ evidenceId }) => env.api(`${role.route}/memory/evidence/${evidenceId}`)));
  assert.deepEqual(details.map(markers), [[1, 2, 3], [8]]);
  const execution = await env.api(`${role.route}/executions/${stored[0]!.execution_id}`);
  assert.deepEqual(markers(execution), [1, 2, 3, 8]);

  // 另一次工具调用重读相同稳定网页范围，保留工具调用归属，经历证据不重复形成。
  role.submit("重新打开夹具文章。");
  await role.idle();
  const repeated = findings(role.db);
  assert.equal(new Set(repeated.map((item) => item.tool_call_id)).size, 2);
  assert.equal(repeated.length, 3);
  assert.equal(new MemoryStore(role.db).listEvidence(role.roleId).filter((row) => row.sourceKind === "tool_result").length, 2);

  role.submit("打开新版文章。");
  await role.idle();
  const versions = listWebReadingPositions(role.db, { roleId: role.roleId, url, offset: 0, limit: 1 });
  assert.equal(versions.nextOffset, 1);
  const older = listWebReadingPositions(role.db, { roleId: role.roleId, url, offset: versions.nextOffset, limit: 1 });
  assert.notEqual(versions.pages[0]?.pageVersion, older.pages[0]?.pageVersion);
  assert.equal(older.nextOffset, null);
  assert.equal(new MemoryStore(role.db).listEvidence(role.roleId).filter((row) => row.sourceKind === "tool_result").length, 3);
});

for (const condition of ["取消早于发送", "拒绝", "取消早于确认", "确认后取消"] as const) {
  test(`网页送达边界：${condition}`, async (t) => {
    let toolReceived = false;
    const env = await readingInstallation(t, (body, res) => {
      const last = body.messages.at(-1);
      if (last?.role === "user" && last.content?.includes("审阅夹具文章")) {
        return complete(res, readerCall(body));
      }
      if (last?.role !== "tool") return complete(res);
      toolReceived = true;
      if (condition === "拒绝") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":{"message":"fixture rejected"}}');
      } else if (condition === "确认后取消") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
      }
    });
    const role = await env.install({ slow: condition === "取消早于发送" });
    role.submit("审阅夹具文章。");
    if (condition === "取消早于发送") {
      await awaitState(() => Boolean(role.db.prepare("SELECT 1 FROM tool_calls WHERE status = 'running'").get()));
      role.submit("替代任务。");
    } else if (condition === "取消早于确认") {
      await awaitState(() => toolReceived);
      role.submit("替代任务。");
    } else if (condition === "确认后取消") {
      await awaitState(() => findings(role.db).length > 0);
      role.submit("替代任务。");
    }
    await role.idle();
    assert.equal(toolReceived, condition !== "取消早于发送");
    const stored = findings(role.db);
    assert.deepEqual(markers(stored), condition === "确认后取消" ? [1, 2, 3] : []);
    const evidence = new MemoryStore(role.db).listEvidence(role.roleId).filter((row) => row.sourceId.startsWith("web-reading:"));
    assert.equal(evidence.length, condition === "确认后取消" ? 1 : 0);
  });
}

test("受限容量按实发入参裁选网页片段，未装入的正文仍可续读", async (t) => {
  const env = await readingInstallation(t, (body, res) => {
    const last = body.messages.at(-1);
    if (last?.role === "user" && last.content?.includes("审阅夹具文章")) return complete(res, readerCall(body));
    complete(res);
  });
  const generous = await env.install();
  generous.submit("审阅夹具文章。");
  await generous.idle();
  const hydrated = env.captures.find((body) => body.messages.at(-1)?.role === "tool");
  assert.ok(hydrated);
  const last = hydrated.messages.at(-1)!;
  assert.deepEqual(markers(last), [1, 2, 3]);
  const prefix = renderWebReadingPrefix(last.content!, 1);
  assert.ok(prefix);
  const maxInputChars = JSON.stringify({
    ...hydrated, messages: [...hydrated.messages.slice(0, -1), { ...last, content: prefix }],
  }).length + 1_024 + 500;

  const tight = await env.install({ maxInputChars });
  tight.submit("审阅夹具文章。");
  await tight.idle();
  const actual = env.captures.filter((body) => body.model === tight.roleId && body.messages.at(-1)?.role === "tool");
  assert.equal(actual.length, 1);
  assert.ok(JSON.stringify(actual[0]).length + 1_024 <= maxInputChars);
  assert.deepEqual(markers(actual[0]!.messages.at(-1)), [1]);
  const cut = webReadingCandidates(actual[0]!.messages.at(-1)!.content!);
  assert.equal(cut?.next?.offset, cut?.fragments[0]?.endOffset);
  assert.deepEqual(markers(findings(tight.db)), [1]);
});

test("普通 MCP 文字链接和非 MCP 工具回执保持原来的工具证据语义", async (t) => {
  const env = await readingInstallation(t, (body, res) => {
    const last = body.messages.at(-1);
    if (last?.role === "user" && last.content?.includes("检查普通链接")) {
      const name = body.tools?.find((tool) => tool.function.name.includes("plain_reference"))?.function.name;
      assert.ok(name);
      return complete(res, { name, arguments: {} });
    }
    if (last?.role === "user" && last.content?.includes("审阅夹具文章")) return complete(res, readerCall(body));
    if (last?.role === "tool" && last.content && webReadingCandidates(last.content)) {
      res.writeHead(401).end();
      return;
    }
    complete(res);
  });
  const role = await env.install();
  role.submit("检查普通链接。");
  await role.idle();
  role.submit("审阅夹具文章。");
  await role.idle();
  const facts = role.db.prepare("SELECT tool_call_id, tool_name FROM tool_calls ORDER BY created_at, rowid")
    .all() as Array<{ tool_call_id: string; tool_name: string }>;
  assert.equal(facts.length, 2);
  const plain = facts.find((fact) => fact.tool_name.includes("plain_reference"))!;
  const embedded = facts.find((fact) => fact.tool_name.includes("read_article"))!;
  assert.equal(readWebToolProjection(role.db, role.roleId, plain.tool_call_id), undefined);
  assert.deepEqual(markers(readWebToolProjection(role.db, role.roleId, embedded.tool_call_id)), []);
  const db = new Database(role.db.name);
  try {
    db.transaction(() => {
      backfillEvidence(db);
      assert.equal(new MemoryStore(db).listEvidence(role.roleId).filter((row) => row.sourceKind === "tool_result").length, 1);
      // 仅改业务记录的工具身份，保留完整的同形原始结果，模拟旧本地工具回执。
      db.prepare("UPDATE tool_calls SET tool_name = 'skill_run' WHERE tool_call_id = ?").run(embedded.tool_call_id);
      assert.equal(readWebToolProjection(db, role.roleId, embedded.tool_call_id), undefined);
      backfillEvidence(db);
      const memory = new MemoryStore(db);
      const evidence = memory.listEvidence(role.roleId).filter((row) => row.sourceKind === "tool_result");
      assert.equal(evidence.length, 2);
      const original = evidence.find((row) => row.sourceId === plain.tool_call_id)!;
      assert.match(memory.getEvidenceDetail(role.roleId, original.evidenceId).content, /普通回执/);
      const local = evidence.find((row) => row.sourceId === embedded.tool_call_id)!;
      assert.deepEqual(markers(memory.getEvidenceDetail(role.roleId, local.evidenceId)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    })();
  } finally {
    db.close();
  }
});

test("结构化网页按偏移合并，资源镜像去重，新版另记，普通 URL 和二进制保持工具事实", () => {
  const embedded = (text: string) => ({ type: "resource", resource: { uri: url, text } });
  const mixed = extractMcpWebFragments({
    content: [embedded("原文。"), { type: "resource_link", uri: url }, { type: "resource", resource: { uri: url, blob: "YWJj" } }],
    structuredContent: { webReading: [
      { url, version: "v1", text: "原文。" },
      { url, version: "v1", fragments: [{ startOffset: 2, text: "。正文" }, { startOffset: 20, text: "跳读" }] },
      { url, version: "v2", text: "新版。" },
    ] },
  });
  assert.deepEqual(mixed.map(({ pageVersion, startOffset, text }) => [pageVersion, startOffset, text]),
    [["v1", 0, "原文。正文"], ["v1", 20, "跳读"], ["v2", 0, "新版。"]]);
  assert.deepEqual(pageWebFragments(mixed, 19, 2).fragments.map(({ startOffset, text }) => [startOffset, text]), [[20, "跳读"]]);
  assert.deepEqual(extractMcpWebFragments({ content: [{ type: "text", text: `详情见 ${url}` }] }), []);
  assert.deepEqual(extractMcpWebFragments({ isError: true, content: [embedded("页面错误")] }), []);
  assert.deepEqual(extractMcpWebFragments({
    content: [embedded("完整正文")],
    structuredContent: { webReading: { url, version: "partial", fragments: [{ startOffset: 2, text: "正文" }] } },
  }).map(({ pageVersion, text }) => [pageVersion, text]), [["partial", "完整正文"]]);
});
