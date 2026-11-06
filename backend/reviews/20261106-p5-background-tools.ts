import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { addBinding, createFixture, createFixtureWithModel, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p5-background-tools");
const onlyCase = process.env.NOWADAYS_REVIEW_CASE ?? null;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const done = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const toolCall = (name: string, callId: string, args: Record<string, unknown> = {}): ModelEvent[] =>
  [{ type: "tool_call", callId, name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];

async function waitFor(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("P5_BACKGROUND_WAIT_TIMEOUT");
    await pause(20);
  }
}

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

function snapshot(fixture: Fixture) {
  return withStorage(fixture, (s) => ({
    executions: s.business.db.prepare("SELECT status FROM executions WHERE role_id = ? ORDER BY rowid").all(fixture.roleId) as Array<{ status: string }>,
    calls: s.business.db.prepare("SELECT tool_call_id, status, tool_name FROM tool_calls ORDER BY rowid").all() as Array<{ tool_call_id: string; status: string; tool_name: string }>,
    results: s.business.db.prepare("SELECT tool_call_id, status FROM tool_results ORDER BY rowid").all() as Array<{ tool_call_id: string; status: string }>,
    metering: s.business.db.prepare("SELECT call_id, COUNT(*) AS count FROM call_metering WHERE call_kind = 'tool' GROUP BY call_id").all() as Array<{ call_id: string; count: number }>,
    tasks: s.business.db.prepare("SELECT status, end_reason FROM tasks ORDER BY rowid").all() as Array<{ status: string; end_reason: string | null }>,
    modeEvents: s.business.db.prepare("SELECT tool_call_id, mode FROM tool_call_mode_events ORDER BY rowid").all() as Array<{ tool_call_id: string; mode: string }>,
    streamEvents: s.business.db.prepare("SELECT event_type, payload_json FROM execution_stream_events ORDER BY stream_event_id").all() as Array<{ event_type: string; payload_json: string }>,
    messages: s.business.db.prepare("SELECT sender, status, content FROM messages ORDER BY sequence").all() as Array<{ sender: string; status: string; content: string }>,
  }));
}

function addSlowOpMcp(fixture: Fixture, dir: string, delayMsScript: string): void {
  const mcp = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdio = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  const source = `import fs from 'node:fs'; import {McpServer} from ${JSON.stringify(mcp)}; import {StdioServerTransport} from ${JSON.stringify(stdio)};
    const server=new McpServer({name:'p5-slow-op',version:'1'}); process.stdin.on('end',()=>process.exit(0));
    server.registerTool('slow_op',{inputSchema:{}},async(args)=>{fs.writeFileSync(${JSON.stringify(path.join(dir, "bg-started"))},'');const deadline=Date.now()+30000;while(!fs.existsSync(${JSON.stringify(path.join(dir, "bg-release"))})&&Date.now()<deadline){await new Promise(r=>setTimeout(r,10));}return {content:[{type:'text',text:'slow-result'}]};});
    server.registerTool('delayed_op',{inputSchema:{}},async(args)=>{${delayMsScript}return {content:[{type:'text',text:'delayed-result'}]};});
    await server.connect(new StdioServerTransport());`;
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name: "P5 慢工具样例",
    config: { command: process.execPath, args: ["--input-type=module", "-e", source], env: {} },
  });
  addBinding(fixture, "mcp", resource.resourceId);
}

function slowOpModel(): ModelPort & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let rounds = 0;
  return {
    requests,
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(request);
      rounds += 1;
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        if (String(last.content) === "先回答这条消息") {
          yield* done("先回应新消息");
          return;
        }
        const name = request.tools.find((t) => t.name.includes("slow_op"))?.name;
        if (!name) throw new Error("P5_SLOW_TOOL_MISSING");
        yield { type: "text_delta", text: "正在执行慢操作" };
        yield* toolCall(name, `wire-slow-${rounds}`);
        return;
      }
      yield* done("后台结果已收到");
    },
  };
}

interface CaseResult {
  id: string;
  contractPassed: boolean;
  observed?: unknown;
  probeError?: string;
}

const results: CaseResult[] = [];
function record(result: CaseResult): void {
  results.push(result);
  fs.writeFileSync(path.join(output, "p5-background-report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ id: result.id, passed: result.contractPassed, error: result.probeError }));
}

fs.mkdirSync(output, { recursive: true });
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P5_BACKGROUND_TIMEOUT"); process.exit(2); }, 220_000);

// 前台窗口包含 MCP 连接建立（本机样例约 0.3～0.7 秒），取足够余量保证快工具稳定落前台。
const WAIT_MS = 2_500;

async function caseFastForeground(): Promise<CaseResult> {
  const fixture = createFixture([
    (request) => {
      const name = request.tools.find((t) => t.name.includes("delayed_op"))?.name;
      if (!name) throw new Error("P5_DELAYED_TOOL_MISSING");
      return toolCall(name, "wire-fast");
    },
    done("快工具已完成"),
  ], { toolForegroundWaitMs: WAIT_MS });
  try {
    const dir = withStorage(fixture, (s) => s.paths.workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    addSlowOpMcp(fixture, dir, "await new Promise(r=>setTimeout(r,50));");
    submit(fixture, "执行快工具");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const snap = snapshot(fixture);
    const toolCallId = snap.calls[0]?.tool_call_id ?? "";
    const record_ = withStorage(fixture, (s) => s.business.getToolCall(fixture.roleId, toolCallId));
    return {
      id: "fast-stays-foreground",
      contractPassed:
        snap.executions.every((row) => row.status === "completed") &&
        snap.calls.length === 1 && snap.calls[0]?.status === "success" &&
        record_.mode === "foreground" &&
        !snap.modeEvents.some((event) => event.mode === "background") &&
        !snap.streamEvents.some((event) => event.event_type === "tool_backgrounded") &&
        snap.tasks[0]?.status === "completed" && snap.tasks[0]?.end_reason === "回复完成",
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

async function caseSlowBackgroundThenInterject(): Promise<CaseResult> {
  const model = slowOpModel();
  const fixture = createFixtureWithModel(model, { toolForegroundWaitMs: WAIT_MS });
  try {
    const dir = withStorage(fixture, (s) => s.paths.workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    addSlowOpMcp(fixture, dir, "");
    submit(fixture, "请执行慢操作");
    await waitFor(() => fs.existsSync(path.join(dir, "bg-started")));
    await waitFor(() => {
      const snap = snapshot(fixture);
      return snap.executions[0]?.status === "superseded";
    });
    const afterBackground = snapshot(fixture);
    const toolCallId = afterBackground.calls[0]?.tool_call_id ?? "";
    const backgroundedEvent = afterBackground.streamEvents.find((event) => event.event_type === "tool_backgrounded");
    const modeRecord = withStorage(fixture, (s) => s.business.getToolCall(fixture.roleId, toolCallId));

    // 决策位置释放：插话先得到回复。
    submit(fixture, "先回答这条消息");
    await waitFor(() =>
      fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 20)
        .items.some((message) => message.sender === "assistant" && message.status === "completed" && message.content === "先回应新消息"),
    );

    fs.writeFileSync(path.join(dir, "bg-release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const snap = snapshot(fixture);
    const continuationRequest = model.requests.at(-1);
    return {
      id: "slow-background-then-interject",
      contractPassed:
        afterBackground.executions[0]?.status === "superseded" &&
        Boolean(backgroundedEvent) &&
        (JSON.parse(backgroundedEvent?.payload_json ?? "{}") as { toolCallId?: string }).toolCallId === toolCallId &&
        modeRecord.mode === "background" &&
        snap.calls.length === 1 && snap.results[0]?.status === "success" &&
        snap.metering.every((row) => row.count === 1) && snap.metering.length === 1 &&
        snap.messages.some((message) => message.status === "completed" && message.content === "先回应新消息") &&
        snap.messages.some((message) => message.status === "completed" && message.content === "后台结果已收到") &&
        snap.executions.filter((row) => row.status === "completed").length === 2 &&
        snap.tasks.length === 1 && snap.tasks[0]?.status === "completed" && snap.tasks[0]?.end_reason === "回复完成" &&
        Boolean(continuationRequest?.messages.some((message) => message.role === "tool" && String(message.content).includes("slow-result"))),
      observed: { afterBackground, snap },
    };
  } finally {
    try {
      fs.writeFileSync(
        path.join(withStorage(fixture, (s) => s.paths.workspaceDir), "bg-release"),
        "",
      );
    } catch {
      // 角色存储已关闭时无需释放。
    }
    await fixture.close();
  }
}

async function caseBoundaryInvariants(): Promise<CaseResult> {
  // 边界迭代：工具完成时间交替压在窗口两侧，断言每轮全局不变量
  // （恰好一次保存、一次计量，前台或后台二居其一）。
  const observedRounds: Array<{
    delayMs: number;
    backgrounded: boolean;
    savedOnce: boolean;
    meteredOnce: boolean;
    exclusive: boolean;
    executionSettled: boolean;
  }> = [];
  // 前台窗口从工具派发开始计算，包含 MCP 握手；两侧取足够余量避免进程启动抖动。
  const delays = [WAIT_MS + 2_000, 100, WAIT_MS + 2_000, 100];
  for (const [index, delayMs] of delays.entries()) {
    const fixture = createFixture([
      (request: ModelRequest) => {
        const name = request.tools.find((t) => t.name.includes("delayed_op"))?.name;
        if (!name) throw new Error("P5_DELAYED_TOOL_MISSING");
        return toolCall(name, `wire-round-${index}`);
      },
      done(`边界第 ${index} 轮完成`),
    ], { toolForegroundWaitMs: WAIT_MS });
    try {
      const dir = withStorage(fixture, (s) => s.paths.workspaceDir);
      fs.mkdirSync(dir, { recursive: true });
      addSlowOpMcp(fixture, dir, `await new Promise(r=>setTimeout(r,${delayMs}));`);
      submit(fixture, `边界第 ${index} 轮`);
      await fixture.app.conversation.waitForIdle(fixture.roleId, 20_000);
      const snap = snapshot(fixture);
      const toolCallId = snap.calls[0]?.tool_call_id ?? "";
      const backgrounded =
        snap.streamEvents.some((event) => event.event_type === "tool_backgrounded") &&
        snap.modeEvents.some((event) => event.mode === "background");
      const foreground =
        !backgrounded &&
        snap.executions.every((row) => row.status === "completed");
      observedRounds.push({
        delayMs,
        backgrounded,
        savedOnce: snap.calls.length === 1 && snap.results.length === 1,
        meteredOnce: snap.metering.length === 1 && snap.metering[0]?.count === 1,
        exclusive: backgrounded !== foreground,
        executionSettled: snap.executions.every((row) => row.status !== "running"),
      });
    } finally {
      await fixture.close();
    }
  }
  return {
    id: "boundary-invariants",
    contractPassed: observedRounds.every(
      (round) => round.savedOnce && round.meteredOnce && round.exclusive && round.executionSettled,
    ) && observedRounds.some((round) => round.backgrounded) && observedRounds.some((round) => !round.backgrounded),
    observed: observedRounds,
  };
}

async function caseEndedTaskLateResult(): Promise<CaseResult> {
  const fixture = createFixtureWithModel(slowOpModel(), { toolForegroundWaitMs: WAIT_MS });
  try {
    const dir = withStorage(fixture, (s) => s.paths.workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    addSlowOpMcp(fixture, dir, "");
    submit(fixture, "请执行慢操作");
    await waitFor(() => fs.existsSync(path.join(dir, "bg-started")));
    await waitFor(() => snapshot(fixture).executions[0]?.status === "superseded");
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "用户提前结束",
    });
    fs.writeFileSync(path.join(dir, "bg-release"), "");
    await waitFor(() => snapshot(fixture).results[0]?.status === "success");
    await pause(300);
    const snap = snapshot(fixture);
    return {
      id: "ended-task-late-result",
      contractPassed:
        snap.executions.every((row) => row.status !== "running") &&
        snap.executions.every((row) => row.status !== "completed" || snap.executions.length === 1) &&
        snap.results[0]?.status === "success" &&
        snap.tasks.length === 1 && snap.tasks[0]?.status === "completed" && snap.tasks[0]?.end_reason === "用户提前结束" &&
        snap.executions.filter((row) => row.status === "completed").length === 0,
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

async function caseDisabledResourceLateResult(): Promise<CaseResult> {
  const fixture = createFixtureWithModel(slowOpModel(), { toolForegroundWaitMs: WAIT_MS });
  try {
    const dir = withStorage(fixture, (s) => s.paths.workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    const { resourceId } = (() => {
      addSlowOpMcp(fixture, dir, "");
      const binding = fixture.app.services.resources.listBindings(fixture.roleId).find((item) => item.capability === "mcp");
      return { resourceId: binding?.resourceId ?? "" };
    })();
    submit(fixture, "请执行慢操作");
    await waitFor(() => fs.existsSync(path.join(dir, "bg-started")));
    await waitFor(() => snapshot(fixture).executions[0]?.status === "superseded");
    // 资源关闭 + 任务结束：晚到结果只落库，不复活、不续行。
    for (const binding of fixture.app.services.resources.listBindings(fixture.roleId)) {
      fixture.app.services.resources.update(binding.resourceId, { enabled: false });
    }
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "资源关闭前结束",
    });
    void resourceId;
    fs.writeFileSync(path.join(dir, "bg-release"), "");
    await waitFor(() => snapshot(fixture).results[0]?.status === "success");
    await pause(300);
    const snap = snapshot(fixture);
    return {
      id: "disabled-resource-late-result",
      contractPassed:
        snap.results[0]?.status === "success" &&
        snap.tasks[0]?.status === "completed" &&
        snap.executions.filter((row) => row.status === "completed").length === 0,
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

const cases: Array<() => Promise<CaseResult>> = [
  caseFastForeground,
  caseSlowBackgroundThenInterject,
  caseBoundaryInvariants,
  caseEndedTaskLateResult,
  caseDisabledResourceLateResult,
];

try {
  for (const run of cases) {
    if (onlyCase !== null && !run.name.toLowerCase().includes(onlyCase.toLowerCase())) {
      continue;
    }
    try {
      record(await run());
    } catch (error) {
      record({ id: run.name, contractPassed: false, probeError: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  }
} finally {
  clearTimeout(watchdog);
  clearInterval(alive);
}
process.exitCode = results.some((r) => r.probeError) ? 2 : results.some((r) => !r.contractPassed) ? 1 : 0;
