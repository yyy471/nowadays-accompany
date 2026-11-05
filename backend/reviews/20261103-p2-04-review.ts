import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelProtocol, ModelRequest } from "../src/domain/model.js";
import { McpToolClient } from "../src/mcp/client.js";
import { HttpModelAdapter } from "../src/model/protocols.js";
import { SkillLibrary } from "../src/skills/skill-library.js";
import { registerMessageEvidence } from "../src/storage/evidence.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { RoleStore } from "../src/storage/role-store.js";

// 独立复核探针：仅本地模拟响应和专用目录，不修改业务源码或访问真实模型。
const outputRoot = path.resolve("test-results/p2-04-independent-20261103");
const runRoot = path.join(outputRoot, `probe-${randomUUID()}`);
fs.mkdirSync(runRoot, { recursive: true });
const reports: Array<{ id: string; contractPassed: boolean; observed: unknown }> = [];
const protocols: ModelProtocol[] = ["openai-chat", "openai-responses", "anthropic-messages"];
const request: ModelRequest = {
  modelName: "offline-review",
  system: "offline test",
  messages: [{ role: "user", content: "read a note" }],
  tools: [],
};
const originalFetch = globalThis.fetch;
function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
function ending(protocol: ModelProtocol): string {
  if (protocol === "openai-chat") return sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
  if (protocol === "openai-responses") return sse({ type: "response.completed", response: { status: "completed" } });
  return sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + sse({ type: "message_stop" });
}
function delta(protocol: ModelProtocol): string {
  if (protocol === "openai-chat") return sse({ choices: [{ delta: { content: "partial" } }] });
  if (protocol === "openai-responses") return sse({ type: "response.output_text.delta", delta: "partial" });
  return sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
}
async function collect(protocol: ModelProtocol, body: string, value = request): Promise<{ events: ModelEvent[]; error: string | null }> {
  globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
  const events: ModelEvent[] = [];
  try {
    const adapter = new HttpModelAdapter({ protocol, baseUrl: "http://offline.invalid/v1" }, undefined);
    for await (const event of adapter.stream(value)) events.push(event);
    return { events, error: null };
  } catch (error) {
    return { events, error: (error as { code?: string }).code ?? String(error) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const protocol of protocols) {
  const control = await collect(protocol, delta(protocol) + ending(protocol));
  reports.push({ id: `control-complete-${protocol}`, contractPassed: control.error === null && control.events.some((e) => e.type === "completed"), observed: control });
  const partial = await collect(protocol, delta(protocol));
  reports.push({ id: `R02-truncated-${protocol}`, contractPassed: partial.error !== null && !partial.events.some((e) => e.type === "completed"), observed: partial });
  const empty = await collect(protocol, "");
  reports.push({ id: `R02-empty-${protocol}`, contractPassed: empty.error !== null && !empty.events.some((e) => e.type === "completed"), observed: empty });

  let wire: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(ending(protocol), { headers: { "content-type": "text/event-stream" } });
  };
  const adapter = new HttpModelAdapter({ protocol, baseUrl: "http://offline.invalid/v1" }, undefined);
  try {
    // 当前正式类型只能表达文字和 tool 结果，不能表达助手发起的调用。
    for await (const _ of adapter.stream({
      ...request,
      messages: [
        { role: "user", content: "read a note" },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "call_1", toolName: "workspace_read", content: "note contents" },
      ],
    })) { /* capture only */ }
    const serialized = JSON.stringify(wire);
    const hasInvocation = protocol === "openai-chat" ? serialized.includes('"tool_calls"') : protocol === "openai-responses" ? serialized.includes('"type":"function_call"') : serialized.includes('"type":"tool_use"');
    reports.push({ id: `R01-tool-continuation-${protocol}`, contractPassed: hasInvocation, observed: wire });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const appRoot = path.join(runRoot, "app");
fs.mkdirSync(appRoot);
const app = createBackendApp(parseBackendConfig(["--app-root", appRoot, "--port", "0"]));
try {
  globalThis.fetch = async () => new Response("", { headers: { "content-type": "text/event-stream" } });
  const tested = await app.services.modelServices.test({ protocol: "openai-chat", baseUrl: "http://offline.invalid/v1", model: "offline-review" });
  const saved = app.appStore.db.prepare("SELECT status FROM model_test_calls").get();
  reports.push({ id: "R02-empty-connection-test", contractPassed: !tested.ok, observed: { tested, saved } });
  globalThis.fetch = originalFetch;

  // 使用纯虚构标记，检查 HTTP 错误是否未经处理回显上游正文中的凭据。
  const dummyCredential = "REVIEW_PUBLIC_DUMMY_CREDENTIAL";
  fs.writeFileSync(path.join(appRoot, "dummy-key.txt"), dummyCredential);
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("http://offline.invalid/")) {
      return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${dummyCredential}` } }), { status: 401 });
    }
    return originalFetch(input, init);
  };
  const port = await listen(app.server, 0, "127.0.0.1");
  const response = await originalFetch(`http://127.0.0.1:${port}/v1/model-services/models`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "openai-chat", baseUrl: "http://offline.invalid/v1", credentialRef: "file:dummy-key.txt" }),
  });
  const exposed = await response.text();
  reports.push({ id: "R06-upstream-error-body", contractPassed: !exposed.includes(dummyCredential), observed: { status: response.status, dummyCredentialExposed: exposed.includes(dummyCredential) } });
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
}

const skillsRoot = path.join(runRoot, "skills");
fs.mkdirSync(path.join(skillsRoot, "quoted"), { recursive: true });
fs.writeFileSync(path.join(skillsRoot, "quoted", "SKILL.md"), '---\nname: "quoted"\ndescription: "Read notes"\n---\n# Instructions\nRead a note.\n');
fs.mkdirSync(path.join(skillsRoot, "folded"));
fs.writeFileSync(path.join(skillsRoot, "folded", "SKILL.md"), '---\nname: folded\ndescription: >-\n  Read and summarize notes.\n  Use when asked about a note.\n---\n# Instructions\nRead a note.\n');
const library = new SkillLibrary(skillsRoot);
const metadata = library.list();
const quoted = metadata.find((item) => item.directory === "quoted");
const folded = metadata.find((item) => item.directory === "folded");
let loadByExposedName = false;
try { if (quoted) loadByExposedName = library.read(quoted.name).directory === "quoted"; } catch { /* observed below */ }
reports.push({ id: "R04-yaml-metadata", contractPassed: quoted?.name === "quoted" && quoted.description === "Read notes" && folded?.description === "Read and summarize notes. Use when asked about a note." && loadByExposedName, observed: { metadata, loadByExposedName } });

const workspace = path.join(runRoot, "workspace");
const outside = path.join(runRoot, "outside-workspace");
fs.mkdirSync(workspace);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(workspace, "linked"), "junction");
const mcp = await McpToolClient.connect({ command: process.execPath, args: ["--import", "tsx", "src/mcp/local-server.ts"], env: { NOWADAYS_WORKSPACE: workspace } });
try {
  const control = await mcp.callTool("workspace_write", { path: "linked/direct.txt", content: "control" });
  reports.push({ id: "control-existing-junction-parent", contractPassed: control.isError && !fs.existsSync(path.join(outside, "direct.txt")), observed: control });
  const result = await mcp.callTool("workspace_write", { path: "linked/new-directory/note.txt", content: "independent probe" });
  const wroteOutside = fs.existsSync(path.join(outside, "new-directory", "note.txt"));
  reports.push({ id: "R03-nonexistent-parent-junction", contractPassed: result.isError && !wroteOutside, observed: { result, wroteOutside } });
} finally {
  await mcp.close();
}

const store = new RoleStore(path.join(runRoot, "memory.sqlite"));
try {
  const created = store.createRoleRecord({ roleId: randomUUID(), displayName: "复核", definitionText: "review", definitionPayload: {}, initialState: {} });
  const roleId = created.role.roleId;
  const memory = new MemoryStore(store.db);
  const summaryIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const message = store.submitMessage(roleId, created.window.windowId, { content: `同日同主题日常 ${index}`, submissionId: randomUUID(), sourcePlatform: "nowadays" });
    registerMessageEvidence(store.db, { roleId, messageIds: [message.message.messageId], executionId: null });
    const evidence = memory.listEvidence(roleId).find((item) => item.sourceId === message.message.messageId)!;
    const event = memory.createEvent({ roleId, title: `日常 ${index}`, summary: "较长的日常事件描述。".repeat(100), subjectiveExperience: "", occurredAtStart: "2026-11-03T01:00:00.000Z", occurredAtEnd: null, experienceDate: "2026-11-03", tags: { topic: ["午餐"] }, evidenceIds: [evidence.evidenceId], currentRound: 0, now: "2026-11-03T02:00:00.000Z" });
    const refined = store.db.transaction(() => memory.refineEvent({ roleId, eventId: event.eventId, expectedVersion: event.version, now: "2026-11-03T03:00:00.000Z" }))();
    summaryIds.push(refined.summary.summaryId);
  }
  const summaries = store.db.prepare("SELECT summary_id, length(summary) AS length FROM daily_summaries").all();
  reports.push({ id: "R05-summary-aggregation", contractPassed: new Set(summaryIds).size === 1, observed: { summaries, oneSummaryPerEvent: new Set(summaryIds).size === 2 } });
} finally {
  store.close();
}

const report = { runRoot, findings: reports.filter((item) => !item.contractPassed).length, probes: reports };
fs.writeFileSync(path.join(outputRoot, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ runRoot, probes: reports.map(({ id, contractPassed }) => ({ id, contractPassed })) }, null, 2));
