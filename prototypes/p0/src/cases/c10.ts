import assert from "node:assert/strict";
import { buildP0Graph } from "../graph/build.js";
import { createScriptedModel } from "../model/scripts.js";
import {
  CheckList,
  createRuntime,
  readEffectCounts,
  seedRoleAndInput,
  writeCaseReport,
  type CaseRuntime,
} from "./harness.js";

const checks = new CheckList();
const firstRuntime = await createRuntime({
  caseName: "c10",
  scriptName: "c01",
});
let currentRuntime: CaseRuntime | null = firstRuntime;

try {
  const seed = seedRoleAndInput(firstRuntime.store);
  const config = { configurable: { thread_id: seed.executionId } };
  let injected = false;

  const faultingGraph = buildP0Graph(
    {
      store: firstRuntime.store,
      model: createScriptedModel("c01"),
      executor: firstRuntime.executor,
      emit(event) {
        firstRuntime.emit(event);
        if (event.type === "tool_registered" && !injected) {
          injected = true;
          throw new Error("REVIEW_FAULT_AFTER_TOOL_REGISTERED");
        }
      },
    },
    firstRuntime.saver,
  );

  await checks.check(
    "registration re-entry reuses the same logical tool call",
    async () => {
      let initialError: unknown = null;
      try {
        await faultingGraph.invoke({ executionId: seed.executionId }, config);
      } catch (error) {
        initialError = error;
      }
      assert.match(String(initialError), /REVIEW_FAULT_AFTER_TOOL_REGISTERED/);

      const before = firstRuntime.store.snapshot();
      const beforeCalls = before.toolCalls as Array<{
        id: string;
        status: string;
        step_key: string;
      }>;
      assert.equal(beforeCalls.length, 1);
      assert.equal(beforeCalls[0]?.status, "pending");
      const originalCallId = beforeCalls[0]?.id;
      assert.ok(originalCallId);
      await firstRuntime.close();
      currentRuntime = null;

      const resumedRuntime = await createRuntime({
        caseName: "c10",
        scriptName: "c01",
        prepare: false,
      });
      currentRuntime = resumedRuntime;
      await resumedRuntime.graph.invoke(null, config);

      const snapshot = resumedRuntime.store.snapshot();
      const executions = snapshot.executions as Array<{ status: string }>;
      const calls = snapshot.toolCalls as Array<{
        id: string;
        status: string;
        step_key: string;
      }>;
      const results = snapshot.toolResults as Array<{ status: string }>;
      const messages = snapshot.messages as Array<{
        sender: string;
        content: string;
        status: string;
      }>;
      assert.equal(executions[0]?.status, "completed");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.id, originalCallId);
      assert.equal(calls[0]?.status, "success");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.status, "success");
      assert.equal(
        readEffectCounts(resumedRuntime.paths.workspace).append_note,
        1,
      );
      const reply = messages.find((message) => message.sender === "assistant");
      assert.equal(reply?.status, "completed");
      assert.equal(reply?.content, "工具状态=success。");
      const reusedEvent = resumedRuntime.events.find(
        (event) => event.type === "tool_registration_reused",
      );
      assert.ok(reusedEvent);
      return {
        originalCallId,
        executionStatus: executions[0]?.status,
        toolCallId: calls[0]?.id,
        toolStatus: calls[0]?.status,
        stepKey: calls[0]?.step_key,
        finalText: reply?.content,
      };
    },
  );

  const activeRuntime = currentRuntime as CaseRuntime;
  const report = writeCaseReport({
    caseName: "c10",
    checks,
    runtime: activeRuntime,
    extra: { seed },
  });
  console.log(
    JSON.stringify({ case: "c10", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  await currentRuntime?.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
