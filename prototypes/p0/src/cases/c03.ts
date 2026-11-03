import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import { p0Root } from "../config.js";
import type { RunEvent } from "../domain/runtime.js";
import { BusinessStore } from "../storage/business.js";
import {
  CheckList,
  prepareCasePaths,
  readEffectCounts,
  readWorkspaceFile,
  seedRoleAndInput,
  writeCaseReport,
} from "./harness.js";

interface RunnerConfig {
  caseName: string;
  scriptName: string;
  executionId: string;
  mode: "pause" | "resume";
  pauseAfterTool: boolean;
}

interface ChildEvent {
  event?: string;
  [key: string]: unknown;
}

interface ChildHandle {
  child: ChildProcess;
  events: ChildEvent[];
  waitForEvent(name: string, timeoutMs?: number): Promise<ChildEvent>;
  waitForExit(): Promise<number | null>;
  killTree(): Promise<void>;
}

function spawnRunner(config: RunnerConfig): ChildHandle {
  const tsxCli = path.join(p0Root, "node_modules", "tsx", "dist", "cli.mjs");
  const runnerPath = path.join(p0Root, "src", "cases", "runner.ts");
  const child = spawn(
    process.execPath,
    [tsxCli, runnerPath, JSON.stringify(config)],
    {
      cwd: p0Root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, P0_VERBOSE: "0" },
    },
  );
  const events: ChildEvent[] = [];
  const emitter = new EventEmitter();
  let stderrText = "";
  let stdoutText = "";

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    throw new Error("RUNNER_STDIO_NOT_AVAILABLE");
  }
  readline.createInterface({ input: stdout }).on("line", (line) => {
    stdoutText += `${line}\n`;
    try {
      const parsed = JSON.parse(line) as ChildEvent;
      events.push(parsed);
      emitter.emit("event", parsed);
      if (parsed.event) {
        emitter.emit(parsed.event, parsed);
      }
    } catch {
      stderrText += `[non-json stdout] ${line}\n`;
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      emitter.emit("exit", code);
      resolve(code);
    });
  });

  return {
    child,
    events,
    waitForEvent(name, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `TIMEOUT_WAITING_FOR:${name}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`,
            ),
          );
        }, timeoutMs);
        const onExit = (code: number | null): void => {
          clearTimeout(timer);
          reject(
            new Error(
              `CHILD_EXITED_BEFORE_${name}:${code}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`,
            ),
          );
        };
        emitter.once("exit", onExit);
        emitter.once(name, (event: ChildEvent) => {
          clearTimeout(timer);
          emitter.off("exit", onExit);
          resolve(event);
        });
      });
    },
    waitForExit() {
      return exitPromise;
    },
    async killTree() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (process.platform === "win32" && child.pid) {
        await new Promise<void>((resolve) => {
          const killer = spawn(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            { stdio: "ignore" },
          );
          killer.on("close", () => resolve());
        });
      } else {
        child.kill("SIGKILL");
      }
      await exitPromise;
    },
  };
}

async function openStoreWithRetry(dbPath: string): Promise<BusinessStore> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return new BusinessStore(dbPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`BUSINESS_DB_UNREADABLE:${dbPath}`);
}

async function countCheckpoints(dbPath: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const db = new Database(dbPath);
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM checkpoints")
        .get() as { count: number };
      db.close();
      return row.count;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`CHECKPOINT_DB_UNREADABLE:${dbPath}`);
}

const checks = new CheckList();
const paths = prepareCasePaths("c03");
const seedStore = new BusinessStore(paths.roleDbPath);
const seed = seedRoleAndInput(seedStore);
seedStore.close();

let pausedStore: BusinessStore | null = null;
let pausedCheckpointCount = 0;
let finalStore: BusinessStore | null = null;
const childEvents: RunEvent[] = [];

try {
  const pauseChild = spawnRunner({
    caseName: "c03",
    scriptName: "c03",
    executionId: seed.executionId,
    mode: "pause",
    pauseAfterTool: true,
  });
  const paused = await pauseChild.waitForEvent("paused");
  await pauseChild.killTree();
  const pauseExit = await pauseChild.waitForExit();
  pausedCheckpointCount = Number(paused.checkpointCount ?? 0);
  childEvents.push(
    ...((paused.events as RunEvent[] | undefined) ?? []),
    {
      type: "child_paused",
      executionId: seed.executionId,
      interrupt: paused.interrupt,
      checkpointCount: pausedCheckpointCount,
      pauseExit,
    },
  );

  pausedStore = await openStoreWithRetry(paths.roleDbPath);
  const pausedSnapshot = pausedStore.snapshot();

  await checks.check("pause child persisted business state and checkpoint", () => {
    const executions = pausedSnapshot.executions as Array<{
      id: string;
      status: string;
    }>;
    const toolCalls = pausedSnapshot.toolCalls as Array<{ status: string }>;
    const toolResults = pausedSnapshot.toolResults as Array<{ status: string }>;
    assert.equal(executions[0]?.id, seed.executionId);
    assert.equal(executions[0]?.status, "paused");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.status, "success");
    assert.equal(toolResults[0]?.status, "success");
    assert.ok(pausedCheckpointCount > 0);
    assert.equal(readEffectCounts(paths.workspace).append_note, 1);
    assert.equal(readWorkspaceFile(paths.workspace, "note.md"), "P0-C03\n");
    return {
      executionStatus: executions[0]?.status,
      checkpointCount: pausedCheckpointCount,
      toolCalls: toolCalls.length,
    };
  });
  pausedStore.close();
  pausedStore = null;

  const resumeChild = spawnRunner({
    caseName: "c03",
    scriptName: "c03",
    executionId: seed.executionId,
    mode: "resume",
    pauseAfterTool: true,
  });
  const completed = await resumeChild.waitForEvent("completed");
  const resumeExit = await resumeChild.waitForExit();
  const resumedCheckpointCount = await countCheckpoints(paths.executionDbPath);
  childEvents.push(
    ...((completed.events as RunEvent[] | undefined) ?? []),
    {
      type: "child_completed",
      executionId: seed.executionId,
      finalText: completed.finalText,
      resumeExit,
    },
  );
  assert.equal(resumeExit, 0);

  finalStore = await openStoreWithRetry(paths.roleDbPath);
  const finalSnapshot = finalStore.snapshot();

  await checks.check("new process resumes the same execution", () => {
    const executions = finalSnapshot.executions as Array<{
      id: string;
      status: string;
    }>;
    const messages = finalSnapshot.messages as Array<{
      sender: string;
      content: string;
      status: string;
    }>;
    const roles = finalSnapshot.roles as Array<{
      state: Record<string, unknown>;
      state_version: number;
    }>;
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.id, seed.executionId);
    assert.equal(executions[0]?.status, "completed");
    const assistant = messages.find((message) => message.sender === "assistant");
    assert.equal(assistant?.status, "completed");
    assert.equal(assistant?.content, "重启恢复后工具状态=success。");
    assert.equal(roles[0]?.state.lastToolStatus, "success");
    assert.equal(roles[0]?.state.lastReply, "c03");
    assert.equal(roles[0]?.state_version, 2);
    return {
      executionId: executions[0]?.id,
      executionStatus: executions[0]?.status,
      finalText: completed.finalText,
      stateVersion: roles[0]?.state_version,
      resumeExit,
    };
  });

  await checks.check("restart did not repeat the saved tool effect", () => {
    assert.equal(readEffectCounts(paths.workspace).append_note, 1);
    assert.equal(readWorkspaceFile(paths.workspace, "note.md"), "P0-C03\n");
    const toolCalls = finalSnapshot.toolCalls as Array<{ status: string }>;
    const toolResults = finalSnapshot.toolResults as Array<{ status: string }>;
    assert.equal(toolCalls.length, 1);
    assert.equal(toolResults.length, 1);
    assert.equal(pausedCheckpointCount > 0, true);
    assert.equal(resumedCheckpointCount > 0, true);
    return {
      toolCalls: toolCalls.length,
      toolResults: toolResults.length,
      pausedCheckpointCount,
      resumedCheckpointCount,
    };
  });

  const report = writeCaseReport({
    caseName: "c03",
    checks,
    runtime: { paths, store: finalStore, events: childEvents },
    extra: {
      seed,
      pausedCheckpointCount,
      resumedCheckpointCount,
      childEvents,
    },
  });
  console.log(
    JSON.stringify({ case: "c03", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  pausedStore?.close();
  finalStore?.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
