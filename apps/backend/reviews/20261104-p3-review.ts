import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rolePaths } from "../src/bootstrap/config.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import { ScriptedChatModel, addBinding, createFixtureWithModel, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p3-independent-20261104");
fs.mkdirSync(output, { recursive: true });
const results: Array<{ id: string; contractPassed: boolean; observed?: unknown; probeError?: string }> = [];
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P3_REVIEW_TIMEOUT"); process.exit(2); }, 60_000);
const done = (text = "完成"): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const requestTool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", callId: "probe-call", name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];
function setup(scripts: ConstructorParameters<typeof ScriptedChatModel>[0]) {
  const clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel(scripts);
  const fixture = createFixtureWithModel(model, { now: () => clock.value, timeZone: "Asia/Shanghai" });
  return { fixture, clock, model };
}
async function start(fixture: Fixture, clock: { value: Date }) {
  const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "自主完成原安排" });
  clock.value = new Date(wake.scheduledAt);
  fixture.app.conversation.runDueAutonomy(fixture.roleId);
  await fixture.app.conversation.waitForIdle(fixture.roleId);
  return wake;
}
async function probe(id: string, action: () => Promise<{ contractPassed: boolean; observed: unknown }>) {
  try { results.push({ id, ...await action() }); }
  catch (error) { results.push({ id, contractPassed: false, probeError: error instanceof Error ? (error.stack ?? error.message) : String(error) }); }
  fs.writeFileSync(path.join(output, "p3-review-report.json"), JSON.stringify(results, null, 2));
}
function addLocal(fixture: Fixture) {
  const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
  const resource = fixture.app.services.resources.create({ kind: "mcp", name: "review", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace },
  } });
  addBinding(fixture, "mcp", resource.resourceId);
  return { resourceId: resource.resourceId, workspace };
}

await probe("R01-diary-and-sharing-after-last-model-point", async () => {
  const { fixture, clock, model } = setup([[
    { type: "tool_call", callId: "diary", name: "diary_write", arguments: { content: "自主活动额度已经耗尽，但仍然写出了这篇日记。" } },
    { type: "tool_call", callId: "share", name: "autonomy_share", arguments: { content: "额度耗尽后仍向主窗口分享。" } },
    { type: "completed", stopReason: "tool_calls" },
  ]]);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 1, unlimited: false });
    await start(fixture, clock);
    const diaries = fixture.app.services.memory.listDiaries(fixture.roleId);
    const shared = fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 20).items;
    const metering = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT call_kind, purpose, counted FROM call_metering").all());
    return { contractPassed: diaries.length === 0 && shared.length === 0, observed: { modelRequests: model.requests.length, diaries, shared, metering, status: fixture.app.services.autonomy.getStatus(fixture.roleId) } };
  } finally { await fixture.close(); }
});

await probe("R02-ISO-offset-wake-at-actual-due-time", async () => {
  const { fixture, clock, model } = setup([done()]);
  try {
    const when = "2026-11-04T11:00:01+08:00";
    const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: when, intent: "带时区的合法 ISO 安排" });
    clock.value = new Date("2026-11-04T03:00:02.000Z");
    const started = fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    return { contractPassed: started && model.requests.length === 1, observed: { stored: wake.scheduledAt, actualDueUtc: new Date(when).toISOString(), now: clock.value.toISOString(), started, calls: model.requests.length, wakes: fixture.app.services.autonomy.listWakes(fixture.roleId) } };
  } finally { await fixture.close(); }
});

for (const resourceType of ["model", "mcp"] as const) {
  await probe(`R03-budget-resume-with-disabled-${resourceType}`, async () => {
    let toolOfferedAfterResume = false;
    const scripts: ConstructorParameters<typeof ScriptedChatModel>[0] = [
      (request: ModelRequest) => {
        const write = request.tools.find((item) => item.name.includes("workspace_write"));
        if (!write) throw new Error("INITIAL_MCP_MISSING");
        return requestTool(write.name, { path: "resume.md", content: "原任务最终成果" });
      },
      (request: ModelRequest) => {
        const write = request.tools.find((item) => item.name.includes("workspace_write"));
        toolOfferedAfterResume = write !== undefined;
        return write ? requestTool(write.name, { path: "resume.md", content: "原任务最终成果" }) : done("原资源已丢失");
      },
      done("原任务完成"),
    ];
    const { fixture, clock, model } = setup(scripts);
    try {
      const mcp = addLocal(fixture);
      fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 1, unlimited: false });
      await start(fixture, clock);
      const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
      const resourceId = resourceType === "mcp" ? mcp.resourceId : fixture.app.services.resources.listBindings(fixture.roleId).find((item) => item.capability === "chat_model")!.resourceId;
      // 236 §8：角色开启时全局关闭会被 API 拒绝，这里模拟资源被外部关闭。
      fixture.app.appStore.updateResource({ resourceId, enabled: false });
      fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: false });
      clock.value = new Date("2026-11-05T00:00:01.000Z");
      const resumed = fixture.app.conversation.runDueAutonomy(fixture.roleId);
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      const saved = fs.existsSync(path.join(mcp.workspace, "resume.md"));
      return { contractPassed: resumed && saved && toolOfferedAfterResume, observed: { resumed, saved, toolOfferedAfterResume, calls: model.requests.length, originalTask: fixture.app.conversation.getTask(fixture.roleId, task.taskId), status: fixture.app.services.autonomy.getStatus(fixture.roleId) } };
    } finally { await fixture.close(); }
  });
}

await probe("R04-ended-task-budget-wake-must-not-create-replacement-task", async () => {
  const { fixture, clock, model } = setup([
    requestTool("memory_search", { query: "原任务目标" }),
    requestTool("diary_write", { content: "原任务已被用户结束，预算恢复却重新启动并写了日记。" }),
    done("重新执行了已结束任务"),
  ]);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 1, unlimited: false });
    await start(fixture, clock);
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: task.taskId, status: "completed", endReason: "用户明确结束原任务" });
    const callsBefore = model.requests.length;
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: false });
    clock.value = new Date("2026-11-05T00:00:01.000Z");
    const started = fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    const diaries = fixture.app.services.memory.listDiaries(fixture.roleId);
    return { contractPassed: tasks.length === 1 && model.requests.length === callsBefore && diaries.length === 0, observed: { started, callsBefore, callsAfter: model.requests.length, tasks, diaries, wakes: fixture.app.services.autonomy.listWakes(fixture.roleId) } };
  } finally { await fixture.close(); }
});

await probe("R05-autonomous-completion-must-not-age-conversation-memory", async () => {
  const { fixture, clock } = setup([done("这只是自主活动，没有收到用户消息。")]);
  try {
    const before = withStorage(fixture, (storage) => new MemoryStore(storage.business.db).getCurrentRound(fixture.roleId));
    await start(fixture, clock);
    const after = withStorage(fixture, (storage) => new MemoryStore(storage.business.db).getCurrentRound(fixture.roleId));
    const executions = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT trigger_type, status, decision_round FROM executions").all());
    const userMessages = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender='user'").get());
    return { contractPassed: after === before, observed: { before, after, executions, userMessages } };
  } finally { await fixture.close(); }
});

await probe("R06-status-must-clear-pause-after-resumed-task-completes", async () => {
  const { fixture, clock } = setup([requestTool("memory_search", { query: "待续目标" }), done("恢复后任务完成")]);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 1, unlimited: false });
    await start(fixture, clock);
    clock.value = new Date("2026-11-05T00:00:01.000Z");
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    return { contractPassed: tasks.every((task) => task.status === "completed") && !status.paused, observed: { tasks, status } };
  } finally { await fixture.close(); }
});

clearInterval(alive); clearTimeout(watchdog);
console.log(JSON.stringify(results.map((item) => ({ id: item.id, contractPassed: item.contractPassed, ...(item.probeError ? { probeError: item.probeError } : {}) })), null, 2));
if (results.some((item) => !item.contractPassed)) process.exitCode = 1;
