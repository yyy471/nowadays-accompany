import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import {
  addBinding,
  createFixture,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "../tests/p2-05-fixture.js";
import { createBackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p5-reconcile-unknown");
const onlyCase = process.env.NOWADAYS_REVIEW_CASE ?? null;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const done = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const callTool = (name: string, callId: string, args: Record<string, unknown> = {}): ModelEvent[] =>
  [{ type: "tool_call", callId, name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];

async function waitFor(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("P5_RECONCILE_WAIT_TIMEOUT");
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
    calls: s.business.db.prepare("SELECT tool_call_id, status FROM tool_calls ORDER BY rowid").all() as Array<{ tool_call_id: string; status: string }>,
    results: s.business.db.prepare("SELECT tool_call_id, status, previous_status, diagnostic_code, adapted_result_json, reconciled_at, reconciled_by_call_id FROM tool_results ORDER BY rowid").all() as Array<{
      tool_call_id: string;
      status: string;
      previous_status: string | null;
      diagnostic_code: string | null;
      adapted_result_json: string | null;
      reconciled_at: string | null;
      reconciled_by_call_id: string | null;
    }>,
    tasks: s.business.db.prepare("SELECT status FROM tasks ORDER BY rowid").all() as Array<{ status: string }>,
    executions: s.business.db.prepare("SELECT status FROM executions ORDER BY rowid").all() as Array<{ status: string }>,
  }));
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
  fs.writeFileSync(path.join(output, "p5-reconcile-report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ id: result.id, passed: result.contractPassed, error: result.probeError }));
}

fs.mkdirSync(output, { recursive: true });
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P5_RECONCILE_TIMEOUT"); process.exit(2); }, 200_000);

function buildWriteServer(directory: string, workspace: string): string {
  const mcp = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdio = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  return `import fs from 'node:fs'; import {McpServer} from ${JSON.stringify(mcp)}; import {StdioServerTransport} from ${JSON.stringify(stdio)};
    const server=new McpServer({name:'p5-write',version:'1'}); process.stdin.on('end',()=>process.exit(0));
    server.registerTool('write_then_wait',{inputSchema:{}},async()=>{fs.writeFileSync(${JSON.stringify(path.join(workspace, "evidence.txt"))},'崩溃前已写入');fs.appendFileSync(${JSON.stringify(path.join(directory, "writes.log"))},'write\\n');fs.writeFileSync(${JSON.stringify(path.join(directory, "tool-pid.txt"))},String(process.pid));return await new Promise(()=>{});});
    server.registerTool('read_evidence',{inputSchema:{}},async()=>{const text=fs.existsSync(${JSON.stringify(path.join(workspace, "evidence.txt"))})?fs.readFileSync(${JSON.stringify(path.join(workspace, "evidence.txt"))},'utf8'):'missing';return {content:[{type:'text',text}]};});
    await server.connect(new StdioServerTransport());`;
}

async function worker(directory: string): Promise<void> {
  fs.mkdirSync(directory, { recursive: true });
  let calls = 0;
  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      calls += 1;
      const name = request.tools.find((t) => t.name.includes("write_then_wait"))?.name;
      if (!name) throw new Error("P5_WRITE_TOOL_MISSING");
      yield* callTool(name, `wire-write-${calls}`);
    },
  };
  const fixture = createFixtureWithModel(model);
  const workspace = withStorage(fixture, (s) => s.paths.workspaceDir);
  fs.mkdirSync(workspace, { recursive: true });
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name: "P5 写入样例",
    config: { command: process.execPath, args: ["--input-type=module", "-e", buildWriteServer(directory, workspace)], env: {} },
  });
  addBinding(fixture, "mcp", resource.resourceId);
  submit(fixture, "把结论写进 evidence.txt");
  await waitFor(() => fs.existsSync(path.join(directory, "tool-pid.txt")));
  // 改变角色状态版本，使恢复走「中断补录 + 新执行重放」路径，
  // 避免图节点从检查点续跑时重复派发同一次工具调用。
  withStorage(fixture, (s) => {
    s.business.db
      .prepare("UPDATE roles SET state_version = state_version + 1 WHERE role_id = ?")
      .run(fixture.roleId);
  });
  fs.writeFileSync(
    path.join(directory, "fixture.json"),
    JSON.stringify({ root: fixture.root, roleId: fixture.roleId, windowId: fixture.windowId }),
  );
  fs.writeFileSync(path.join(directory, "boundary.json"), JSON.stringify({ calls }));
  setInterval(() => {}, 1000);
}

async function caseCrashThenReconcile(): Promise<CaseResult> {
  const directory = path.join(output, `crash-then-reconcile-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  const log = fs.openSync(path.join(directory, "worker.log"), "w");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL(import.meta.url)), "--worker", directory],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", log, log], windowsHide: true },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let app: Awaited<ReturnType<typeof createBackendApp>> | undefined;
  let toolStopped = false;
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`P5_WORKER_EARLY_EXIT:${child.exitCode}`);
      return fs.existsSync(path.join(directory, "boundary.json"));
    });
    child.kill("SIGKILL");
    await exited;
    const pid = Number(fs.readFileSync(path.join(directory, "tool-pid.txt"), "utf8"));
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 工具进程可能已随 stdio 退出。
    }
    toolStopped = true;

    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json"), "utf8")) as {
      root: string;
      roleId: string;
      windowId: string;
    };
    const paths = rolePaths(path.join(metadata.root, "data"), metadata.roleId);
    const workspace = paths.workspaceDir;
    // 重启后的恢复模型：先核查文件状态，再按原调用编号补录。
    const requests: ModelRequest[] = [];
    let originalFromDb = "";
    const model: ModelPort = {
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        requests.push(request);
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        const unknown = toolMessages.find((message) => String(message.content).includes('"status":"unknown"'));
        const originalCallId = unknown?.toolCallId || originalFromDb;
        if (!originalCallId) throw new Error("P5_ORIGINAL_CALL_MISSING");
        const checked = toolMessages.find((message) => message.toolName?.includes("read_evidence"));
        if (checked === undefined) {
          const readTool = request.tools.find((t) => t.name.includes("read_evidence"))?.name;
          if (!readTool) throw new Error("P5_CHECK_TOOL_MISSING");
          yield* callTool(readTool, "wire-check-file");
          return;
        }
        if (checked.content.includes("missing")) throw new Error("P5_EVIDENCE_MISSING");
        const reconcile = request.tools.find((t) => t.name === "tool_reconcile");
        if (!reconcile) throw new Error("P5_RECONCILE_TOOL_MISSING");
        if (!toolMessages.some((message) => message.toolName === "tool_reconcile")) {
          yield* callTool(reconcile.name, "wire-reconcile", {
            toolCallId: originalCallId,
            status: "success",
            observation: "重启后确认文件已存在",
            verifiedByToolCallId: checked.toolCallId,
          });
          return;
        }
        yield* done("核查完成，已按原调用补录。");
      },
    };
    app = createBackendApp(parseBackendConfig(["--app-root", metadata.root, "--port", "0"]), {
      timeZone: "Asia/Shanghai",
      typingMs: 1000,
      disableMemoryRuntime: true,
      modelPortFactory: () => model,
      toolForegroundWaitMs: 60_000,
    });
    const fixture = { ...metadata, app } as unknown as Fixture;
    const known = snapshot(fixture);
    originalFromDb = known.calls[0]?.tool_call_id ?? "";
    await app.conversation.waitForIdle(metadata.roleId, 30_000);
    await pause(200);
    const snap = snapshot(fixture);
    const original = snap.results.find((row) => row.tool_call_id === originalFromDb);
    const writes =
      fs.existsSync(path.join(directory, "writes.log")) &&
      fs.readFileSync(path.join(directory, "writes.log"), "utf8") === "write\n";
    const passed =
      known.results[0]?.status === "unknown" &&
      original?.status === "success" &&
      original?.previous_status === "unknown" &&
      original?.reconciled_at !== null &&
      original?.reconciled_by_call_id !== null &&
      (JSON.parse(original?.adapted_result_json ?? "{}") as { observation?: string }).observation ===
        "重启后确认文件已存在" &&
      writes &&
      fs.readFileSync(path.join(workspace, "evidence.txt"), "utf8") === "崩溃前已写入";
    return {
      id: "crash-then-reconcile",
      contractPassed: passed,
      observed: { known, snap, originalFromDb, writes, requests: requests.length },
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    if (!toolStopped && fs.existsSync(path.join(directory, "tool-pid.txt"))) {
      try {
        process.kill(Number(fs.readFileSync(path.join(directory, "tool-pid.txt"), "utf8")), "SIGKILL");
      } catch {
        // 仅清理本次样例进程。
      }
    }
    await app?.close();
    fs.closeSync(log);
  }
}

function seedUnknown(fixture: Fixture): { toolCallId: string; taskId: string } {
  return withStorage(fixture, (storage) => {
    const execution = storage.business.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
    });
    const task = storage.business.createTask({
      roleId: fixture.roleId,
      goal: "评审种子任务",
      origin: "user",
      initiatorExecutionId: execution.executionId,
    });
    storage.business.linkExecutionTask({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    const begun = storage.business.beginToolCall({
      roleId: fixture.roleId,
      taskId: task.taskId,
      executionId: execution.executionId,
      stepKey: `seed:${randomUUID()}`,
      toolName: "workspace_write",
      args: { path: "seed.txt", content: "x" },
    });
    storage.business.markToolCallRunning(fixture.roleId, begun.toolCall.toolCallId);
    storage.business.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: begun.toolCall.toolCallId,
      status: "unknown",
      adaptedResult: { error: { code: "PROCESS_INTERRUPTED", message: "进程中断" } },
      diagnosticCode: "PROCESS_INTERRUPTED",
      error: { code: "PROCESS_INTERRUPTED", message: "进程中断" },
    });
    storage.business.db
      .prepare("UPDATE executions SET status = 'completed', state_version_committed = 1 WHERE execution_id = ?")
      .run(execution.executionId);
    return { toolCallId: begun.toolCall.toolCallId, taskId: task.taskId };
  });
}

async function caseDuplicateConflictEnded(): Promise<CaseResult> {
  const fixture = createFixture([]);
  try {
    const seeded = seedUnknown(fixture);
    // 已结束任务仍可补录。
    withStorage(fixture, (storage) => {
      storage.business.finishTask({
        roleId: fixture.roleId,
        taskId: seeded.taskId,
        status: "completed",
        endReason: "评审提前结束",
      });
    });
    const outcome = withStorage(fixture, (storage) => {
      const first = storage.business.saveToolResult({
        roleId: fixture.roleId,
        toolCallId: seeded.toolCallId,
        status: "success",
        adaptedResult: { observation: "第一次核查" },
        reconciledByCallId: null,
      });
      const duplicate = storage.business.saveToolResult({
        roleId: fixture.roleId,
        toolCallId: seeded.toolCallId,
        status: "success",
        adaptedResult: { observation: "第二次核查" },
        reconciledByCallId: null,
      });
      let conflictRejected = false;
      try {
        storage.business.saveToolResult({
          roleId: fixture.roleId,
          toolCallId: seeded.toolCallId,
          status: "failed",
          adaptedResult: { observation: "冲突证据" },
        });
      } catch (error) {
        conflictRejected =
          error instanceof Error &&
          "code" in error &&
          ((error as { code: string }).code === "TOOL_CALL_STATUS_CONFLICT" ||
            (error as { code: string }).code === "TOOL_RESULT_CONFLICT");
      }
      return { first, duplicate, conflictRejected };
    });
    const snap = snapshot(fixture);
    const original = snap.results.find((row) => row.tool_call_id === seeded.toolCallId);
    return {
      id: "duplicate-conflict-ended",
      contractPassed:
        original?.status === "success" &&
        original?.previous_status === "unknown" &&
        original?.reconciled_at !== null &&
        (JSON.parse(original?.adapted_result_json ?? "{}") as { observation?: string }).observation ===
          "第一次核查" &&
        outcome.duplicate.duplicate === true &&
        outcome.conflictRejected === true &&
        snap.tasks[0]?.status === "completed",
      observed: { snap, outcome },
    };
  } finally {
    await fixture.close();
  }
}

async function caseEvidenceInsufficientStaysUnknown(): Promise<CaseResult> {
  const fixture = createFixture([
    done("先不做核查，保持未知。"),
  ]);
  try {
    const seeded = seedUnknown(fixture);
    submit(fixture, "先不做核查");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const snap = snapshot(fixture);
    const original = snap.results.find((row) => row.tool_call_id === seeded.toolCallId);
    return {
      id: "evidence-insufficient-stays-unknown",
      contractPassed: original?.status === "unknown" && original?.reconciled_at === null,
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

const cases: Array<() => Promise<CaseResult>> = [
  caseCrashThenReconcile,
  caseDuplicateConflictEnded,
  caseEvidenceInsufficientStaysUnknown,
];

if (process.argv[2] === "--worker") {
  await worker(process.argv[3]!);
} else {
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
}
