import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { addBinding, createFixture, createFixtureWithModel, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p2-06-acceptance-20261104");
fs.mkdirSync(output, { recursive: true });
const results: Array<{ id: string; passed: boolean; observed?: unknown; error?: string }> = [];
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("ACCEPTANCE_TIMEOUT"); process.exit(2); }, 60_000);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("ACCEPTANCE_WAIT_TIMEOUT");
    await delay(20);
  }
}
async function probe(id: string, action: () => Promise<unknown>): Promise<void> {
  try { results.push({ id, passed: true, observed: await action() }); }
  catch (error) { results.push({ id, passed: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }); }
  fs.writeFileSync(path.join(output, "acceptance-report.json"), JSON.stringify(results, null, 2));
}
function send(fixture: Fixture, content: string, windowId = fixture.windowId): void {
  fixture.app.conversation.submitMessage(fixture.roleId, windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
}
function bindLocal(fixture: Fixture): string {
  const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
  const resource = fixture.app.services.resources.create({ kind: "mcp", name: "acceptance-local", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace },
  } });
  addBinding(fixture, "mcp", resource.resourceId);
  return workspace;
}
function tool(callId: string, name: string, args: unknown): ModelEvent[] {
  return [{ type: "tool_call", callId, name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];
}

await probe("A01-skill-mcp-memory-cross-window-diary", async () => {
  let phase: "write" | "recall" = "write";
  let round = 0;
  let eventId = "";
  let memoryCreated = false;
  let memoryCalls = 0;
  const modelErrors: string[] = [];
  const toolHistory: unknown[] = [];
  const model: ModelPort = { async *stream(request) {
    round += 1;
    const replies = request.messages.filter((item) => item.role === "tool");
    if (phase === "recall") toolHistory.push({ round, reply: replies.at(-1) });
    let events: ModelEvent[];
    if (phase === "write") {
      if (round === 1) {
        assert.match(request.system, /acceptance-note/);
        assert.doesNotMatch(request.system, /正文标记只按需读取/);
        events = tool("skill", "skill_read", { skill: "acceptance-note" });
      } else if (round === 2) {
        assert.match(replies.at(-1)?.content ?? "", /正文标记只按需读取/);
        events = tool("reference", "skill_read", { skill: "acceptance-note", path: "reference.md" });
      } else if (round === 3) {
        assert.match(replies.at(-1)?.content ?? "", /验收专题：星河计划/);
        const write = request.tools.find((item) => item.name.includes("workspace_write"));
        assert.ok(write);
        events = tool("save-note", write.name, { path: "notes/星河计划.md", content: "# 星河计划\n下周三讨论望远镜观测，预算 1200 元。" });
      } else {
        assert.ok(replies.at(-1)?.content);
        events = [{ type: "text_delta", text: "星河计划笔记已实际保存。" }, { type: "completed", stopReason: "stop" }];
      }
    } else {
      if (round === 1) events = tool("search", "memory_search", { query: "星河计划", types: ["event"] });
      else if (round === 2) {
        const found = JSON.parse(replies.at(-1)?.content ?? "{}").result;
        assert.ok(found.items.some((item: { id: string }) => item.id === eventId));
        events = tool("event", "memory_event", { eventId });
      } else if (round === 3) {
        const detail = JSON.parse(replies.at(-1)?.content ?? "{}").result;
        assert.ok(detail.sources?.[0]?.evidenceId);
        events = tool("evidence", "memory_evidence", { evidenceId: detail.sources[0].evidenceId });
      } else if (round === 4) {
        assert.match(replies.at(-1)?.content ?? "", /星河计划/);
        events = [
          { type: "tool_call", callId: "diary", name: "diary_write", arguments: { content: "我很期待星河计划的观测讨论。", eventIds: [eventId] } },
          { type: "tool_call", callId: "state", name: "state_update", arguments: { patch: { mood: "期待" } } },
          { type: "completed", stopReason: "tool_calls" },
        ];
      } else events = [{ type: "text_delta", text: "记得星河计划，下周三讨论观测，预算 1200 元。" }, { type: "completed", stopReason: "stop" }];
    }
    yield* events;
  } };
  const fixture = createFixtureWithModel(model, { modelPortFactory: () => ({ async *stream(request) {
    try { yield* model.stream(request); } catch (error) { modelErrors.push(String(error)); throw error; }
  } }), disableMemoryRuntime: false, memoryModelFactory: () => ({ async form(input) {
    memoryCalls += 1;
    if (memoryCreated) return { operations: [] };
    const evidence = input.evidence.find((item) => item.sourceKind === "tool_result");
    assert.ok(evidence);
    memoryCreated = true;
    return { operations: [{ op: "create_event", localKey: "stargazing", title: "星河计划笔记", summary: "按 Skill 模板保存星河计划，下周三讨论观测，预算 1200 元。", subjectiveExperience: "对共同观测感到期待。", occurredAtStart: evidence.occurredAt, experienceDate: evidence.localDate, tags: { topic: ["星河计划"], emotion: ["期待"] }, evidenceIds: input.evidence.map((item) => item.evidenceId) }] };
  } }) });
  try {
    const workspace = bindLocal(fixture);
    const skills = path.join(fixture.root, "skills");
    fs.mkdirSync(path.join(skills, "acceptance-note"), { recursive: true });
    fs.writeFileSync(path.join(skills, "acceptance-note", "SKILL.md"), "---\nname: acceptance-note\ndescription: 整理观测笔记\n---\n正文标记只按需读取。先读 reference.md，再经 MCP 保存 Markdown。\n");
    fs.writeFileSync(path.join(skills, "acceptance-note", "reference.md"), "验收专题：星河计划。记录讨论日期及预算。");
    const skill = fixture.app.services.resources.create({ kind: "skill", name: "acceptance", config: { sourcePath: skills } });
    addBinding(fixture, "skill", skill.resourceId);
    send(fixture, "用 Skill 保存星河计划：下周三讨论望远镜观测，预算1200元。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.match(fs.readFileSync(path.join(workspace, "notes/星河计划.md"), "utf8"), /1200/);
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    const events = withStorage(fixture, (storage) => new MemoryStore(storage.business.db).listEvents(fixture.roleId));
    assert.equal(events.length, 1, "one event must be formed from the saved tool result");
    eventId = events[0]!.eventId;
    const otherWindow = fixture.app.services.roles.createWindow(fixture.roleId, { kind: "custom", source: "nowadays" });
    phase = "recall"; round = 0;
    send(fixture, "你记得星河计划的预算吗？若想记录心情可以写日记。", otherWindow.windowId);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const diaries = fixture.app.services.memory.listDiaries(fixture.roleId);
    assert.equal(diaries.length, 1, `the Agent must save its diary in the second window: ${JSON.stringify({ modelErrors, toolHistory })}`);
    const diary = fixture.app.services.memory.getDiary(fixture.roleId, diaries[0]!.diaryId);
    assert.deepEqual(diary.eventIds, [eventId]);
    assert.match(fs.readFileSync(path.join(workspace, diary.relativePath), "utf8"), /期待星河计划/);
    assert.equal(fixture.app.services.roles.getState(fixture.roleId).state.mood, "期待");
    const calls = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT status, tool_name FROM tool_calls ORDER BY rowid").all());
    assert.equal(calls.length, 1);
    const otherRole = fixture.app.services.roles.createRole({ displayName: "其他角色", definition: { text: "独立角色" } });
    const isolated = fixture.app.services.memory.search(otherRole.roleId, { query: "星河计划" });
    assert.equal(isolated.items.length, 0);
    return { eventId, memoryCalls, externalCalls: calls, diary: { relativePath: diary.relativePath, eventIds: diary.eventIds }, separateWindows: fixture.app.services.roles.listWindows(fixture.roleId).length, roleIsolation: true };
  } finally { await fixture.close(); }
});

await probe("A02-rebinding-keeps-original-model-until-task-end", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed: Array<{ resourceId: string; baseUrl: string }> = [];
  let aCalls = 0;
  const firstModel: ModelPort = { async *stream(request) {
    aCalls += 1;
    if (aCalls === 1) {
      const read = request.tools.find((item) => item.name.includes("workspace_read")); assert.ok(read);
      yield* tool("read-a", read.name, { path: "input.md" });
    } else if (aCalls === 2) {
      await gate;
      yield { type: "text_delta", text: "旧回复" }; yield { type: "completed", stopReason: "stop" };
    } else if (aCalls === 3) {
      const write = request.tools.find((item) => item.name.includes("workspace_write")); assert.ok(write);
      yield* tool("write-a", write.name, { path: "original.md", content: "原模型完成原任务" });
    } else { yield { type: "text_delta", text: "原任务完成" }; yield { type: "completed", stopReason: "stop" }; }
  } };
  let firstId = "";
  let bCalls = 0;
  const fixture = createFixtureWithModel(firstModel, { modelPortFactory(binding) {
    observed.push({ resourceId: binding.resourceId, baseUrl: binding.config.baseUrl });
    if (binding.resourceId === firstId) return firstModel;
    return { async *stream() { bCalls += 1; yield { type: "text_delta", text: "新模型回复" }; yield { type: "completed", stopReason: "stop" }; } };
  } });
  try {
    firstId = fixture.app.services.resources.listBindings(fixture.roleId).find((item) => item.capability === "chat_model")!.resourceId;
    const workspace = bindLocal(fixture); fs.writeFileSync(path.join(workspace, "input.md"), "原任务资料");
    send(fixture, "读取并保存原任务资料"); await until(() => aCalls === 2);
    const replacement = fixture.app.services.resources.create({ kind: "model", name: "new", config: { protocol: "openai-chat", baseUrl: "http://b.invalid/v1" } });
    const bindings = fixture.app.services.resources.listBindings(fixture.roleId);
    fixture.app.services.resources.replaceBindings(fixture.roleId, bindings.map((item) => ({ capability: item.capability, resourceId: item.capability === "chat_model" ? replacement.resourceId : item.resourceId, ...(item.modelName === null ? {} : { modelName: item.modelName }), enabled: true })));
    fixture.app.services.resources.update(firstId, { enabled: false, config: { protocol: "openai-chat", baseUrl: "http://a-updated.invalid/v1" } });
    send(fixture, "先回答新消息"); await until(() => bCalls === 1);
    release(); await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(fs.readFileSync(path.join(workspace, "original.md"), "utf8"), "原模型完成原任务");
    assert.equal(aCalls, 4);
    assert.deepEqual(observed.slice(3).map((item) => item.resourceId), [firstId, firstId]);
    assert.ok(observed.slice(3).every((item) => item.baseUrl === "http://a-updated.invalid/v1"));
    send(fixture, "下一次使用新绑定"); await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(bCalls, 2); assert.equal(observed.at(-1)?.resourceId, replacement.resourceId);
    return { originalCalls: aCalls, replacementCalls: bCalls, bindingsUsed: observed, sameTask: fixture.app.conversation.listTasks(fixture.roleId).length === 1 };
  } finally { release(); await fixture.close(); }
});

await probe("A03-commit-conflict-preserves-partial-reply-and-new-state", async () => {
  let calls = 0;
  let fixture: Fixture;
  fixture = createFixtureWithModel({ async *stream() {
    calls += 1;
    if (calls === 1) yield* tool("state", "state_update", { patch: { mood: "旧模型状态" } });
    else {
      yield { type: "text_delta", text: "这段文字必须保留" };
      fixture.app.services.roles.setState(fixture.roleId, { state: { mood: "用户最新修改" } });
      yield { type: "completed", stopReason: "stop" };
    }
  } });
  try {
    send(fixture, "检查提交冲突"); await fixture.app.conversation.waitForIdle(fixture.roleId);
    const state = fixture.app.services.roles.getState(fixture.roleId);
    const messages = fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 20).items;
    const execution = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT status, decision_round FROM executions ORDER BY rowid DESC LIMIT 1").get()) as { status: string; decision_round: number | null };
    const failure = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT payload_json FROM execution_stream_events WHERE event_type='execution_failed' ORDER BY stream_event_id DESC LIMIT 1").get()) as { payload_json: string };
    assert.equal(execution.status, "failed"); assert.equal(JSON.parse(failure.payload_json).errorCode, "STATE_VERSION_CONFLICT"); assert.equal(execution.decision_round, null);
    assert.equal(state.state.mood, "用户最新修改");
    assert.ok(messages.some((item) => item.content.includes("这段文字必须保留") && item.status !== "completed"));
    assert.equal(calls, 2);
    return { execution, state: state.state, messages: messages.map((item) => ({ sender: item.sender, status: item.status, content: item.content })) };
  } finally { await fixture.close(); }
});

await probe("A04-background-memory-does-not-block-chat", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false; let finished = false;
  const fixture = createFixture([
    [{ type: "text_delta", text: "第一轮聊天" }, { type: "completed", stopReason: "stop" }],
    [{ type: "text_delta", text: "整理期间也能回复" }, { type: "completed", stopReason: "stop" }],
  ], { disableMemoryRuntime: false, memoryModelFactory: () => ({ async form() { started = true; await gate; finished = true; return { operations: [] }; } }) });
  try {
    send(fixture, "第一轮"); await fixture.app.conversation.waitForIdle(fixture.roleId);
    const maintenance = fixture.app.conversation.runMemoryPending(fixture.roleId);
    await until(() => started);
    send(fixture, "现在仍然需要回复"); await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(finished, false);
    assert.ok(fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 20).items.some((item) => item.content === "整理期间也能回复" && item.status === "completed"));
    release(); await maintenance;
    return { repliedBeforeMemoryFinished: true, memoryFinished: finished };
  } finally { release(); await fixture.close(); }
});

clearInterval(alive); clearTimeout(watchdog);
console.log(JSON.stringify(results, null, 2));
if (results.some((item) => !item.passed)) process.exitCode = 1;
