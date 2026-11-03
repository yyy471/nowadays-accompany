import fs from "node:fs";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  caseDir,
  currentRunId,
  ensureDir,
  p0Root,
  prepareCaseDir,
} from "../config.js";
import type { RunEvent } from "../domain/runtime.js";
import { buildP0Graph } from "../graph/build.js";
import { Barrier } from "../model/barrier.js";
import { createScriptedModel } from "../model/scripts.js";
import {
  McpToolExecutor,
  createNoteWriteReconciler,
} from "../mcp/executor.js";
import { BusinessStore, type RoleSnapshot } from "../storage/business.js";

export interface CasePaths {
  dir: string;
  roleDbPath: string;
  executionDbPath: string;
  workspace: string;
}

export interface SeedResult {
  role: RoleSnapshot;
  userMessageId: string;
  executionId: string;
}

export interface ReportCheck {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export class CheckList {
  readonly items: ReportCheck[] = [];

  async check(
    name: string,
    fn: () => unknown | Promise<unknown>,
  ): Promise<void> {
    try {
      const detail = await fn();
      this.items.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      this.items.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get ok(): boolean {
    return this.items.every((item) => item.ok);
  }
}

export function openCasePaths(caseName: string): CasePaths {
  const dir = ensureDir(caseDir(caseName));
  return {
    dir,
    roleDbPath: path.join(dir, "role.sqlite"),
    executionDbPath: path.join(dir, "execution.sqlite"),
    workspace: ensureDir(path.join(dir, "workspace")),
  };
}

export function prepareCasePaths(caseName: string): CasePaths {
  prepareCaseDir(caseName);
  return openCasePaths(caseName);
}

export function packageVersion(name: string): string {
  const packageJsonPath = path.join(p0Root, "node_modules", name, "package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };
  return parsed.version ?? "unknown";
}

export function versions(): Record<string, string> {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    "@langchain/langgraph": packageVersion("@langchain/langgraph"),
    "@langchain/core": packageVersion("@langchain/core"),
    "@langchain/langgraph-checkpoint-sqlite": packageVersion(
      "@langchain/langgraph-checkpoint-sqlite",
    ),
    "@modelcontextprotocol/sdk": packageVersion("@modelcontextprotocol/sdk"),
    "better-sqlite3": packageVersion("better-sqlite3"),
    zod: packageVersion("zod"),
    typescript: packageVersion("typescript"),
  };
}

export function seedRoleAndInput(
  store: BusinessStore,
  options: {
    settings?: Record<string, unknown>;
    state?: Record<string, unknown>;
    windowId?: string;
    userMessage?: string;
  } = {},
): SeedResult {
  const role = store.createRole({
    name: "P0 Role",
    settings: options.settings ?? { tone: "calm" },
    state: options.state ?? { mood: "neutral", energy: 80 },
  });
  const windowId = options.windowId ?? "main";
  const userMessageId = store.insertUserMessage({
    roleId: role.id,
    windowId,
    content: options.userMessage ?? "请记录一条 P0 笔记。",
  }).id;
  const executionId = store.createExecution({
    roleId: role.id,
    windowId,
    triggerMessageId: userMessageId,
  }).id;
  return { role, userMessageId, executionId };
}

export interface RuntimeOptions {
  caseName: string;
  scriptName: string;
  prepare?: boolean;
  pauseAfterTool?: boolean;
  faultMode?: "commit_fail";
  reconcileMode?: "verify" | "unverifiable";
  timeoutMs?: number;
}

export interface CaseRuntime {
  caseName: string;
  paths: CasePaths;
  store: BusinessStore;
  saver: SqliteSaver;
  executor: McpToolExecutor;
  barrier: Barrier;
  events: RunEvent[];
  graph: ReturnType<typeof buildP0Graph>;
  emit: (event: RunEvent) => void;
  close(): Promise<void>;
}

export async function createRuntime(
  options: RuntimeOptions,
): Promise<CaseRuntime> {
  const paths =
    options.prepare === false
      ? openCasePaths(options.caseName)
      : prepareCasePaths(options.caseName);
  const store = new BusinessStore(paths.roleDbPath);
  const saver = SqliteSaver.fromConnString(paths.executionDbPath);
  const executor = new McpToolExecutor(paths.workspace, options.timeoutMs ?? 5000);
  const barrier = new Barrier();
  const events: RunEvent[] = [];
  const emit = (event: RunEvent): void => {
    events.push(event);
    if (process.env.P0_VERBOSE === "1") {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    }
  };
  const model = createScriptedModel(options.scriptName);
  const graph = buildP0Graph(
    {
      store,
      model,
      executor,
      emit,
      barrier,
      pauseAfterTool: options.pauseAfterTool ?? false,
      ...(options.faultMode ? { faultMode: options.faultMode } : {}),
      ...(options.reconcileMode
        ? { reconcile: createNoteWriteReconciler(options.reconcileMode) }
        : {}),
    },
    saver,
  );

  return {
    caseName: options.caseName,
    paths,
    store,
    saver,
    executor,
    barrier,
    events,
    graph,
    emit,
    async close() {
      await executor.close();
      saver.db.close();
      store.close();
    },
  };
}

export function createGraphFor(
  runtime: Pick<CaseRuntime, "store" | "saver" | "executor" | "barrier">,
  scriptName: string,
  emit: (event: RunEvent) => void,
) {
  return buildP0Graph(
    {
      store: runtime.store,
      model: createScriptedModel(scriptName),
      executor: runtime.executor,
      emit,
      barrier: runtime.barrier,
    },
    runtime.saver,
  );
}

export function readWorkspaceFile(
  workspace: string,
  relativePath: string,
): string | null {
  const target = path.join(workspace, relativePath);
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
}

export function readEffectCounts(workspace: string): Record<string, number> {
  const target = path.join(workspace, ".p0-effect-counts.json");
  if (!fs.existsSync(target)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, number>;
}

export interface ReportRuntime {
  paths: CasePaths;
  store: BusinessStore;
  events: RunEvent[];
}

export interface CaseReportInput {
  caseName: string;
  checks: CheckList;
  runtime: ReportRuntime;
  extra?: Record<string, unknown>;
}

export function writeCaseReport(input: CaseReportInput): Record<string, unknown> {
  const report = {
    case: input.caseName,
    runId: currentRunId(),
    versions: versions(),
    checks: input.checks.items,
    events: input.runtime.events,
    snapshot: input.runtime.store.snapshot(),
    workspaceFiles: {
      "note.md": readWorkspaceFile(input.runtime.paths.workspace, "note.md"),
      "old-note.md": readWorkspaceFile(
        input.runtime.paths.workspace,
        "old-note.md",
      ),
    },
    effectCounts: readEffectCounts(input.runtime.paths.workspace),
    paths: input.runtime.paths,
    ...(input.extra ?? {}),
    ok: input.checks.ok,
  };
  fs.writeFileSync(
    path.join(input.runtime.paths.dir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}
