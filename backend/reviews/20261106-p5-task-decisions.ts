import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
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
import { RoleStorage } from "../src/storage/role-storage.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p5-task-decisions");
const onlyCase = process.env.NOWADAYS_REVIEW_CASE ?? null;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const done = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const callTool = (name: string, callId: string, args: Record<string, unknown> = {}): ModelEvent[] =>
  [{ type: "tool_call", callId, name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];

async function waitFor(check: () => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("P5_TASK_WAIT_TIMEOUT");
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
    executions: s.business.db.prepare("SELECT status, trigger_type FROM executions WHERE role_id = ? ORDER BY rowid").all(fixture.roleId) as Array<{ status: string; trigger_type: string }>,
    tasks: s.business.db.prepare("SELECT task_id, status, end_reason, origin FROM tasks ORDER BY rowid").all() as Array<{ task_id: string; status: string; end_reason: string | null; origin: string }>,
    links: s.business.db.prepare("SELECT execution_id, task_id, relation FROM execution_tasks ORDER BY created_at, rowid").all() as Array<{ execution_id: string; task_id: string; relation: string }>,
    notes: s.business.db.prepare("SELECT task_id, note FROM task_notes ORDER BY rowid").all() as Array<{ task_id: string; note: string }>,
    continuations: s.business.db.prepare("SELECT task_id, resource_id, ended_at FROM task_resource_continuations ORDER BY rowid").all() as Array<{ task_id: string; resource_id: string; ended_at: string | null }>,
    calls: s.business.db.prepare("SELECT tool_call_id, tool_name, status FROM tool_calls ORDER BY rowid").all() as Array<{ tool_call_id: string; tool_name: string; status: string }>,
    wakes: fixture.app.services.autonomy.listWakes(fixture.roleId),
  }));
}

function addWorkspaceMcp(fixture: Fixture): string {
  const workspace = withStorage(fixture, (s) => s.paths.workspaceDir);
  fs.mkdirSync(workspace, { recursive: true });
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name: "workspace",
    config: {
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`,
      ],
      env: { NOWADAYS_WORKSPACE: workspace },
    },
  });
  addBinding(fixture, "mcp", resource.resourceId);
  return workspace;
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
  fs.writeFileSync(path.join(output, "p5-tasks-report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ id: result.id, passed: result.contractPassed, error: result.probeError }));
}

fs.mkdirSync(output, { recursive: true });
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P5_TASKS_TIMEOUT"); process.exit(2); }, 240_000);

/** 两段阅读：round1 读 → round2 携任务编号安排唤醒 → round3 task_pause → round4 先回复；唤醒接回后 task_finish。 */
function twoPhaseModel(): ModelPort & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(request);
      const round = requests.length;
      if (round === 1) {
        const read = request.tools.find((t) => t.name.includes("workspace_read"));
        if (!read) throw new Error("P5_READ_TOOL_MISSING");
        yield* callTool(read.name, "wire-read-first", { path: "material.md" });
        return;
      }
      if (round === 2) {
        const match = /taskId=([0-9a-f-]{36})/.exec(request.system);
        if (!match) throw new Error("P5_TASK_BRIEF_MISSING");
        const schedule = request.tools.find((t) => t.name === "autonomy_schedule");
        if (!schedule) throw new Error("P5_SCHEDULE_TOOL_MISSING");
        yield* callTool(schedule.name, "wire-schedule", {
          wakeAt: new Date(Date.now() + 1500).toISOString(),
          intent: "继续阅读剩余部分",
          taskId: match[1],
        });
        return;
      }
      if (round === 3) {
        const pauseTool = request.tools.find((t) => t.name === "task_pause");
        if (!pauseTool) throw new Error("P5_PAUSE_TOOL_MISSING");
        yield* callTool(pauseTool.name, "wire-pause", {
          reason: "分两次阅读",
          note: "已读完前半部分",
        });
        return;
      }
      if (round === 4) {
        yield* done("先读到这里，稍后继续。");
        return;
      }
      const replayed = request.messages.some(
        (message) => message.role === "tool" && String(message.content).includes("前半部分内容"),
      );
      if (!replayed) throw new Error("P5_REPLAY_MISSING");
      if (!/已读完前半部分/.test(request.system)) throw new Error("P5_NOTE_REPLAY_MISSING");
      const finish = request.tools.find((t) => t.name === "task_finish");
      if (!finish) throw new Error("P5_FINISH_TOOL_MISSING");
      if (round === 5) {
        yield* callTool(finish.name, "wire-finish", {
          status: "completed",
          endReason: "阅读完成",
          note: "已读完后半部分",
        });
        return;
      }
      yield* done("全部读完了。");
    },
  };
}

async function caseTwoPhaseReading(): Promise<CaseResult> {
  const model = twoPhaseModel();
  const fixture = createFixtureWithModel(model);
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(path.join(workspace, "material.md"), "前半部分内容\n后半部分内容", "utf8");
    submit(fixture, "分两次读完这份资料，先读前半");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const paused = snapshot(fixture);
    const taskId = paused.tasks[0]?.task_id ?? "";
    const pausedOk =
      paused.tasks.length === 1 &&
      paused.tasks[0]?.status === "paused" &&
      paused.tasks[0]?.end_reason === "分两次阅读" &&
      paused.notes.some((row) => row.note === "已读完前半部分") &&
      paused.continuations.some((row) => row.task_id === taskId && row.ended_at === null) &&
      paused.executions.every((row) => row.status === "completed") &&
      paused.wakes.some((wake) => wake.taskId === taskId && wake.status === "pending");
    if (!pausedOk) {
      return { id: "two-phase-reading", contractPassed: false, observed: { paused } };
    }

    try {
      await waitFor(() => fixture.app.conversation.getTask(fixture.roleId, taskId).status === "completed");
    } catch (error) {
      return {
        id: "two-phase-reading",
        contractPassed: false,
        probeError: error instanceof Error ? error.message : String(error),
        observed: { paused, after: snapshot(fixture) },
      };
    }
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const snap = snapshot(fixture);
    return {
      id: "two-phase-reading",
      contractPassed:
        snap.tasks.length === 1 &&
        snap.tasks[0]?.status === "completed" &&
        snap.tasks[0]?.end_reason === "阅读完成" &&
        snap.links.map((row) => row.relation).join(",") === "initiates,continues" &&
        snap.executions.filter((row) => row.status === "completed").length === 2 &&
        snap.continuations.every((row) => row.ended_at !== null) &&
        snap.wakes.every((wake) => wake.taskId === taskId || wake.taskId === null),
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

/** 暂停后重启：close 旧应用并以同根重启，唤醒接回原暂停任务。 */
async function caseRestartContinuesPausedTask(): Promise<CaseResult> {
  const model = twoPhaseModel();
  const fixture = createFixtureWithModel(model);
  let root = "";
  let roleId = "";
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(path.join(workspace, "material.md"), "前半部分内容\n后半部分内容", "utf8");
    submit(fixture, "分两次读完，先读前半");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const paused = snapshot(fixture);
    const taskId = paused.tasks[0]?.task_id ?? "";
    if (paused.tasks[0]?.status !== "paused") {
      return { id: "restart-continues-paused-task", contractPassed: false, observed: { paused } };
    }
    root = fixture.root;
    roleId = fixture.roleId;
    // 只关闭应用，保留目录用于重启模拟。
    await fixture.app.close();

    // 重启：唤醒在暂停期间保持 pending，启动恢复后接回原任务。
    let restartedFinished = false;
    const restartedModel: ModelPort & { requests: ModelRequest[] } = {
      requests: [],
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        const replayed = request.messages.some(
          (message) => message.role === "tool" && String(message.content).includes("前半部分内容"),
        );
        if (!replayed) {
          yield* done("重启后先看情况");
          return;
        }
        const finish = request.tools.find((t) => t.name === "task_finish");
        if (!finish) throw new Error("P5_FINISH_TOOL_MISSING");
        if (!restartedFinished) {
          restartedFinished = true;
          yield* callTool(finish.name, "wire-finish-restart", {
            status: "completed",
            endReason: "重启后完成",
          });
          return;
        }
        yield* done("重启后读完。");
      },
    };
    const app = createBackendApp(parseBackendConfig(["--app-root", root, "--port", "0"]), {
      timeZone: "Asia/Shanghai",
      typingMs: 1000,
      disableMemoryRuntime: true,
      modelPortFactory: () => restartedModel,
    });
    try {
      await waitFor(() => app.conversation.getTask(roleId, taskId).status === "completed", 20_000);
      await app.conversation.waitForIdle(roleId);
      const storage = RoleStorage.openExisting(
        rolePaths(app.config.dataRoot, roleId),
      );
      try {
        const snap = {
          tasks: storage.business.db.prepare("SELECT task_id, status, end_reason FROM tasks ORDER BY rowid").all() as Array<{ task_id: string; status: string; end_reason: string | null }>,
          links: storage.business.db.prepare("SELECT relation FROM execution_tasks ORDER BY created_at, rowid").all() as Array<{ relation: string }>,
          executions: storage.business.db.prepare("SELECT status FROM executions ORDER BY rowid").all() as Array<{ status: string }>,
        };
        return {
          id: "restart-continues-paused-task",
          contractPassed:
            snap.tasks.length === 1 &&
            snap.tasks[0]?.task_id === taskId &&
            snap.tasks[0]?.status === "completed" &&
            snap.tasks[0]?.end_reason === "重启后完成" &&
            snap.links.map((row) => row.relation).join(",").includes("continues"),
          observed: snap,
        };
      } finally {
        storage.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    if (root === "") {
      await fixture.close();
    } else {
      await fixture.app.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
}

/** 任务结束后另起目标：不带 taskId 的唤醒创建新任务，且按当前资源开关授权。 */
async function caseNewGoalNewChain(): Promise<CaseResult> {
  const requests: ModelRequest[] = [];
  let phase: "finish-old" | "new-goal" = "finish-old";
  const fixture = createFixtureWithModel({
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(request);
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        const read = request.tools.find((t) => t.name.includes("workspace_read"));
        if (!read) throw new Error("P5_READ_TOOL_MISSING");
        yield* callTool(read.name, `wire-read-${requests.length}`, { path: "material.md" });
        return;
      }
      if (phase === "finish-old") {
        const finish = request.tools.find((t) => t.name === "task_finish");
        if (!finish) throw new Error("P5_FINISH_TOOL_MISSING");
        yield* callTool(finish.name, "wire-finish-old", {
          status: "completed",
          endReason: "资料阅读结束",
        });
        phase = "new-goal";
        return;
      }
      yield* done("新目标已启动。");
    },
  });
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(path.join(workspace, "material.md"), "第一份资料", "utf8");
    submit(fixture, "读完这份资料");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const oldTasks = snapshot(fixture).tasks;
    if (oldTasks[0]?.status !== "completed") {
      return { id: "new-goal-new-chain", contractPassed: false, observed: snapshot(fixture) };
    }

    // 关闭 MCP 资源后另起目标：新链不延续被关闭的资源。
    for (const binding of fixture.app.services.resources.listBindings(fixture.roleId)) {
      if (binding.capability === "mcp") {
        fixture.app.services.resources.update(binding.resourceId, { enabled: false });
      }
    }
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: new Date(Date.now() + 400).toISOString(),
      intent: "另起目标：整理书桌",
    });
    await waitFor(
      () => fixture.app.conversation.listTasks(fixture.roleId).length === 2 &&
        fixture.app.conversation.listTasks(fixture.roleId)[1]?.status === "completed",
      20_000,
    );
    const snap = snapshot(fixture);
    const newTask = snap.tasks[1];
    return {
      id: "new-goal-new-chain",
      contractPassed:
        snap.tasks.length === 2 &&
        newTask?.task_id !== snap.tasks[0]?.task_id &&
        newTask?.status === "completed" &&
        newTask?.end_reason === "回复完成" &&
        snap.continuations.filter((row) => row.task_id === newTask?.task_id && row.ended_at === null).length === 0 &&
        snap.continuations.filter((row) => row.task_id === snap.tasks[0]?.task_id).every((row) => row.ended_at !== null),
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

/** 回归锁定：普通轮次无任务决策时仍按「回复完成」结束。 */
async function caseDefaultCompletionRegression(): Promise<CaseResult> {
  const fixture = createFixture([
    (request) => {
      const read = request.tools.find((t) => t.name.includes("workspace_read"));
      if (!read) throw new Error("P5_READ_TOOL_MISSING");
      return callTool(read.name, "wire-read-default", { path: "material.md" });
    },
    done("读完了。"),
  ]);
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(path.join(workspace, "material.md"), "全文内容", "utf8");
    submit(fixture, "读完这份资料");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const snap = snapshot(fixture);
    return {
      id: "default-completion-regression",
      contractPassed:
        snap.tasks.length === 1 &&
        snap.tasks[0]?.status === "completed" &&
        snap.tasks[0]?.end_reason === "回复完成" &&
        snap.executions.every((row) => row.status === "completed"),
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

const cases: Array<() => Promise<CaseResult>> = [
  caseTwoPhaseReading,
  caseRestartContinuesPausedTask,
  caseNewGoalNewChain,
  caseDefaultCompletionRegression,
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
