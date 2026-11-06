import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import {
  addBinding,
  createFixture,
  withStorage,
  type Fixture,
} from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p5-skill-run");
const onlyCase = process.env.NOWADAYS_REVIEW_CASE ?? null;
const done = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const callTool = (name: string, callId: string, args: Record<string, unknown> = {}): ModelEvent[] =>
  [{ type: "tool_call", callId, name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
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
  fs.writeFileSync(path.join(output, "p5-skill-run-report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ id: result.id, passed: result.contractPassed, error: result.probeError }));
}

fs.mkdirSync(output, { recursive: true });
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P5_SKILL_TIMEOUT"); process.exit(2); }, 150_000);

function createSkillPack(fixture: Fixture, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p5-skill-review-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  const resource = fixture.app.services.resources.create({
    kind: "skill",
    name: "评审随包脚本",
    config: { sourcePath: root },
  });
  addBinding(fixture, "skill", resource.resourceId);
  return resource.resourceId;
}

function callsOf(fixture: Fixture) {
  return withStorage(fixture, (s) => ({
    calls: s.business.db.prepare("SELECT tool_call_id, task_id, tool_name, status FROM tool_calls ORDER BY rowid").all() as Array<{ tool_call_id: string; task_id: string; tool_name: string; status: string }>,
    results: s.business.db.prepare("SELECT tool_call_id, status, diagnostic_code, adapted_result_json FROM tool_results ORDER BY rowid").all() as Array<{ tool_call_id: string; status: string; diagnostic_code: string | null; adapted_result_json: string | null }>,
    tasks: s.business.db.prepare("SELECT status, end_reason FROM tasks ORDER BY rowid").all() as Array<{ status: string; end_reason: string | null }>,
  }));
}

async function caseScriptRunsWithBundledResources(): Promise<CaseResult> {
  const fixture = createFixture([
    (request) => {
      const runTool = request.tools.find((t) => t.name === "skill_run");
      if (!runTool) throw new Error("P5_SKILL_RUN_MISSING");
      return callTool(runTool.name, "wire-skill-run", { skill: "demo", script: "run.mjs" });
    },
    done("脚本已运行。"),
  ]);
  try {
    const workspace = withStorage(fixture, (s) => s.paths.workspaceDir);
    fs.mkdirSync(workspace, { recursive: true });
    createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 随包脚本评审\n---\n正文",
      "demo/run.mjs": [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const data = fs.readFileSync('data.txt', 'utf8');",
        "fs.writeFileSync(path.join(process.env.NOWADAYS_WORKSPACE, 'skill-output.txt'), data, 'utf8');",
        "console.log('bundled:', data.trim());",
      ].join("\n"),
      "demo/data.txt": "随包资源内容\n",
    });
    submit(fixture, "运行 demo 的脚本");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const snap = callsOf(fixture);
    return {
      id: "script-runs-with-bundled-resources",
      contractPassed:
        snap.calls.length === 1 &&
        snap.calls[0]?.tool_name === "skill_run" &&
        snap.calls[0]?.status === "success" &&
        snap.results[0]?.status === "success" &&
        /bundled: 随包资源内容/.test(snap.results[0]?.adapted_result_json ?? "") &&
        fs.readFileSync(path.join(workspace, "skill-output.txt"), "utf8") === "随包资源内容\n" &&
        snap.tasks.length === 1 &&
        snap.tasks[0]?.status === "completed" &&
        snap.tasks[0]?.end_reason === "回复完成",
      observed: { snap },
    };
  } finally {
    await fixture.close();
  }
}

async function caseFailureRecorded(): Promise<CaseResult> {
  const fixture = createFixture([
    (request: ModelRequest) => {
      const runTool = request.tools.find((t) => t.name === "skill_run");
      if (!runTool) throw new Error("P5_SKILL_RUN_MISSING");
      return callTool(runTool.name, "wire-fail", {
        skill: "demo",
        script: "fail.mjs",
        timeoutMs: 1000,
      });
    },
    (request: ModelRequest) => {
      const runTool = request.tools.find((t) => t.name === "skill_run");
      if (!runTool) throw new Error("P5_SKILL_RUN_MISSING");
      return callTool(runTool.name, "wire-slow", {
        skill: "demo",
        script: "slow.mjs",
        timeoutMs: 1000,
      });
    },
    done("失败已记录。"),
  ]);
  try {
    createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 失败评审\n---\n正文",
      "demo/fail.mjs": "console.error('爆炸原因');\nprocess.exit(3);",
      "demo/slow.mjs": "await new Promise((r) => setTimeout(r, 15000));",
    });
    submit(fixture, "运行失败脚本");
    await fixture.app.conversation.waitForIdle(fixture.roleId, 30_000);
    const snap = callsOf(fixture);
    const exitResult = snap.results.find((row) => row.diagnostic_code === "SKILL_SCRIPT_EXIT");
    const timeoutResult = snap.results.find((row) => row.diagnostic_code === "SKILL_SCRIPT_TIMEOUT");
    return {
      id: "failure-states-recorded",
      contractPassed:
        snap.calls.length === 2 &&
        exitResult?.status === "failed" &&
        (JSON.parse(exitResult?.adapted_result_json ?? "{}") as { exitCode?: number }).exitCode === 3 &&
        timeoutResult?.status === "failed" &&
        (JSON.parse(timeoutResult?.adapted_result_json ?? "{}") as { timedOut?: boolean }).timedOut === true,
      observed: snap,
    };
  } finally {
    await fixture.close();
  }
}

async function caseReadOnlyAndDisabled(): Promise<CaseResult> {
  const fixture = createFixture([
    (request) => {
      const read = request.tools.find((t) => t.name === "skill_read");
      if (!read) throw new Error("P5_SKILL_READ_MISSING");
      if (request.tools.some((t) => t.name === "skill_run") === false) {
        throw new Error("P5_SKILL_RUN_MISSING");
      }
      return callTool(read.name, "wire-read-only", { skill: "demo", path: "helper.mjs" });
    },
    done("只读完成。"),
    (request) => {
      if (request.tools.some((t) => t.name === "skill_run" || t.name === "skill_read")) {
        throw new Error("P5_DISABLED_SKILL_STILL_VISIBLE");
      }
      return done("禁用后无 Skill 工具。");
    },
  ]);
  try {
    const resourceId = createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 只读评审\n---\n正文",
      "demo/helper.mjs": "console.log('不应被执行');",
    });
    submit(fixture, "读取脚本正文");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const snap = callsOf(fixture);
    const readOnlyOk = snap.calls.length === 0;
    fixture.app.services.resources.update(resourceId, { enabled: false });
    submit(fixture, "禁用后再试一次");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    return {
      id: "read-only-and-disabled",
      contractPassed: readOnlyOk && callsOf(fixture).calls.length === 0,
      observed: { snap },
    };
  } finally {
    await fixture.close();
  }
}

const cases: Array<() => Promise<CaseResult>> = [
  caseScriptRunsWithBundledResources,
  caseFailureRecorded,
  caseReadOnlyAndDisabled,
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
