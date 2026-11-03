import { Command } from "@langchain/langgraph";
import { serializeError } from "../domain/errors.js";
import type { RunEvent } from "../domain/runtime.js";
import { createRuntime } from "./harness.js";

interface RunnerConfig {
  caseName: string;
  scriptName: string;
  executionId: string;
  mode: "pause" | "resume";
  pauseAfterTool: boolean;
  timeoutMs?: number;
  reconcileMode?: "verify" | "unverifiable";
}

function print(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const rawConfig = process.argv[2];
if (!rawConfig) {
  print({ event: "error", error: "MISSING_RUNNER_CONFIG" });
  process.exit(2);
}

const config = JSON.parse(rawConfig) as RunnerConfig;
let runtime: Awaited<ReturnType<typeof createRuntime>> | null = null;

try {
  runtime = await createRuntime({
    caseName: config.caseName,
    scriptName: config.scriptName,
    prepare: false,
    pauseAfterTool: config.pauseAfterTool,
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.reconcileMode ? { reconcileMode: config.reconcileMode } : {}),
  });

  if (config.mode === "pause") {
    const result = (await runtime.graph.invoke(
      { executionId: config.executionId },
      { configurable: { thread_id: config.executionId } },
    )) as { __interrupt__?: unknown };
    if (!result.__interrupt__) {
      throw new Error("PAUSE_EXPECTED_BUT_GRAPH_FINISHED");
    }
    runtime.store.setExecutionStatus(config.executionId, "paused");
    const checkpointCount = (
      runtime.saver.db
        .prepare("SELECT COUNT(*) AS count FROM checkpoints")
        .get() as { count: number }
    ).count;
    print({
      event: "paused",
      executionId: config.executionId,
      interrupt: result.__interrupt__,
      checkpointCount,
      events: runtime.events as RunEvent[],
    });
    setInterval(() => {}, 1000);
  } else {
    runtime.store.setExecutionStatus(config.executionId, "running");
    const result = (await runtime.graph.invoke(
      new Command({ resume: "continue" }),
      { configurable: { thread_id: config.executionId } },
    )) as { finalText?: string };
    print({
      event: "completed",
      executionId: config.executionId,
      finalText: result.finalText ?? "",
      events: runtime.events as RunEvent[],
    });
    await runtime.close();
    runtime = null;
    process.exit(0);
  }
} catch (error) {
  print({
    event: "error",
    executionId: config.executionId,
    error: serializeError(error),
    events: runtime?.events ?? [],
  });
  if (runtime) {
    await runtime.close().catch(() => {});
  }
  process.exit(1);
}
