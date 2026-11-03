import assert from "node:assert/strict";
import { Command } from "@langchain/langgraph";
import {
  CheckList,
  createRuntime,
  readEffectCounts,
  seedRoleAndInput,
  writeCaseReport,
} from "./harness.js";

const checks = new CheckList();
const runtime = await createRuntime({
  caseName: "c05",
  scriptName: "c05",
  pauseAfterTool: true,
});

try {
  const seed = seedRoleAndInput(runtime.store);

  await checks.check("pauses after the tool result is saved", async () => {
    const first = (await runtime.graph.invoke(
      { executionId: seed.executionId },
      { configurable: { thread_id: seed.executionId } },
    )) as { __interrupt__?: unknown };
    assert.ok(first.__interrupt__);
    runtime.store.setExecutionStatus(seed.executionId, "paused");
    return { interrupt: first.__interrupt__ };
  });

  await checks.check("role settings and state can change while paused", () => {
    const updated = runtime.store.patchRole({
      roleId: seed.role.id,
      settingsPatch: { tone: "calm-v2" },
      statePatch: { mood: "calm", energy: 40 },
    });
    assert.equal(updated.settings.tone, "calm-v2");
    assert.equal(updated.state.mood, "calm");
    assert.equal(updated.state.energy, 40);
    assert.equal(updated.stateVersion, 2);
    return {
      settings: updated.settings,
      state: updated.state,
      stateVersion: updated.stateVersion,
    };
  });

  await checks.check("resume reads the latest role data", async () => {
    runtime.store.setExecutionStatus(seed.executionId, "running");
    const resumed = (await runtime.graph.invoke(
      new Command({ resume: "continue" }),
      { configurable: { thread_id: seed.executionId } },
    )) as { finalText?: string };
    assert.equal(
      resumed.finalText,
      "最新设定 tone=calm-v2，最新状态 mood=calm，工具=success。",
    );
    return { finalText: resumed.finalText };
  });

  const snapshot = runtime.store.snapshot();
  const roles = snapshot.roles as Array<{
    settings: Record<string, unknown>;
    state: Record<string, unknown>;
    state_version: number;
  }>;
  const executions = snapshot.executions as Array<{
    status: string;
    state_version_loaded: number | null;
    state_version_committed: number | null;
  }>;
  const decisions = (
    snapshot.decisions as Array<{
      turn: number;
      context_json: string;
      decision_json: string;
    }>
  ).map((row) => ({
    turn: row.turn,
    context: JSON.parse(row.context_json) as {
      settings: Record<string, unknown>;
      state: Record<string, unknown>;
      stateVersion: number;
    },
    decision: JSON.parse(row.decision_json) as {
      type: string;
      text?: string;
    },
  }));

  await checks.check("old checkpoint did not roll back the latest state", () => {
    assert.ok(roles[0]);
    assert.equal(roles[0].state.mood, "calm");
    assert.equal(roles[0].state.energy, 40);
    assert.equal(roles[0].state.lastSeenMood, "calm");
    assert.equal(roles[0].state.lastSeenTone, "calm-v2");
    assert.equal(roles[0].state.lastToolStatus, "success");
    assert.equal(roles[0].settings.tone, "calm-v2");
    assert.equal(roles[0].state_version, 3);
    assert.equal(executions[0]?.status, "completed");
    assert.equal(executions[0]?.state_version_loaded, 2);
    assert.equal(executions[0]?.state_version_committed, 3);
    return {
      state: roles[0].state,
      settings: roles[0].settings,
      stateVersion: roles[0].state_version,
      stateVersionLoaded: executions[0]?.state_version_loaded,
      stateVersionCommitted: executions[0]?.state_version_committed,
    };
  });

  await checks.check("decision snapshots prove the refresh", () => {
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0]?.turn, 0);
    assert.equal(decisions[0]?.context.settings.tone, "calm");
    assert.equal(decisions[0]?.context.state.mood, "neutral");
    assert.equal(decisions[0]?.context.stateVersion, 1);
    assert.equal(decisions[1]?.turn, 1);
    assert.equal(decisions[1]?.context.settings.tone, "calm-v2");
    assert.equal(decisions[1]?.context.state.mood, "calm");
    assert.equal(decisions[1]?.context.stateVersion, 2);
    assert.equal(decisions[1]?.decision.type, "final");
    return decisions.map((decision) => ({
      turn: decision.turn,
      tone: decision.context.settings.tone,
      mood: decision.context.state.mood,
      stateVersion: decision.context.stateVersion,
    }));
  });

  await checks.check("saved tool result remains real and single", () => {
    assert.equal(readEffectCounts(runtime.paths.workspace).append_note, 1);
    const toolCalls = snapshot.toolCalls as Array<{ status: string }>;
    const toolResults = snapshot.toolResults as Array<{ status: string }>;
    assert.equal(toolCalls.length, 1);
    assert.equal(toolResults.length, 1);
    assert.equal(toolCalls[0]?.status, "success");
    assert.equal(toolResults[0]?.status, "success");
    return { toolCalls: toolCalls.length, toolResults: toolResults.length };
  });

  const report = writeCaseReport({
    caseName: "c05",
    checks,
    runtime,
    extra: { seed },
  });
  console.log(
    JSON.stringify({ case: "c05", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  await runtime.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
