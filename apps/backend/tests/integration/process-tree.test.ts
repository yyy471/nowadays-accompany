import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runSkillScriptProcess } from "../../src/application/conversation/agent-tools.js";
import { McpToolClient } from "../../src/mcp/client.js";

const windowsOnly = { skip: process.platform !== "win32", timeout: 20_000 };

for (const mode of ["inherit", "ignore"] as const) {
  test(`command_run reaps Windows descendants with ${mode} stdio`, windowsOnly, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-process-tree-"));
    const target = path.join(root, "target.mjs");
    const grandchild = path.join(root, "grandchild.mjs");
    const pidFile = path.join(root, "grandchild.pid");
    let pid: number | undefined;
    try {
      fs.writeFileSync(grandchild, `
        import fs from "node:fs";
        console.log("grandchild inherited stdout");
        fs.writeFileSync(process.argv[2], String(process.pid));
        setTimeout(() => {}, 12_000);
      `);
      fs.writeFileSync(target, `
        import fs from "node:fs";
        import { spawn } from "node:child_process";
        import { setTimeout as delay } from "node:timers/promises";
        const [mode, script, pidFile] = process.argv.slice(2);
        const child = spawn(process.execPath, [script, pidFile], {
          detached: mode === "ignore", stdio: mode, windowsHide: true,
        });
        child.unref();
        while (!fs.existsSync(pidFile) || fs.statSync(pidFile).size === 0) await delay(10);
        console.log("target completed");
        if (mode === "ignore") {
          process.stdout.write("x".repeat(900_000) + "stdout-tail");
          process.stderr.write("y".repeat(1_000_100));
        } else {
          await delay(12_000);
        }
      `);
      const result = await run(target, root, [mode, grandchild, pidFile], 4_000);
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "grandchild started and recorded its PID");
      assert.match(result.stdout, /target completed\r?\n/);
      if (mode === "inherit") {
        assert.match(result.stdout, /grandchild inherited stdout/);
        assert.equal(result.timedOut, true);
        assert.equal(result.exitCode, null);
        assert.equal(result.status, "failed");
      } else {
        assert.equal(result.timedOut, false);
        assert.equal(result.exitCode, 0);
        assert.equal(result.status, "success");
        assert.ok(result.stdout.endsWith("x".repeat(900_000) + "stdout-tail"));
        assert.equal(result.stderr.length, 1_000_000);
        assert.ok(!/[^y]/.test(result.stderr));
        assert.equal(result.truncated, true);
      }
      for (let tries = 0; tries < 50 && alive(pid); tries += 1) await delay(20);
      assert.equal(alive(pid), false, `Windows descendant ${pid} survived tool settlement`);
    } finally {
      if (pid === undefined && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Windows job setup failure prevents the target from starting", windowsOnly, async (t) => {
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const load = t.mock.method(koffi, "load", () => { throw new Error("TEST_JOB_SETUP_FAILED"); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-job-setup-"));
  const script = path.join(root, "target.mjs");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-job-workspace-"));
  const sentinel = path.join(workspace, "started");
  try {
    fs.writeFileSync(script, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "started");');
    const result = await runSkillScriptProcess(script, root, workspace, [sentinel], 4_000, root);
    assert.equal(load.mock.callCount(), 1);
    assert.equal(result.diagnosticCode, "SKILL_SCRIPT_SPAWN_FAILED");
    assert.match(JSON.stringify(result.error), /TEST_JOB_SETUP_FAILED/);
    assert.equal(fs.existsSync(sentinel), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

interface ProcessResult {
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

async function run(
  script: string,
  root: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcessResult & { status: string }> {
  const client = await McpToolClient.connect({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/local-server.ts", "--mode", "command"],
    env: { NOWADAYS_WORKSPACE: root },
  });
  try {
    const result = await client.callTool("command_run", {
      command: process.execPath, args: [script, ...args], timeoutMs,
    });
    assert.ok(!result.isError, JSON.stringify(result.content).slice(0, 200));
    const payload = (result.content as Array<{ text: string }>)[0];
    assert.ok(payload);
    const output = JSON.parse(payload.text) as ProcessResult & { ok: boolean };
    return { ...output, status: output.ok ? "success" : "failed" };
  } finally {
    await client.close();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("skill process rejects child creation and enforces its own timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-process-"));
  const skill = path.join(root, "skill");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(skill); fs.mkdirSync(workspace);
  const script = path.join(skill, "run.mjs");
  try {
    fs.writeFileSync(script, `import { spawnSync } from 'node:child_process';
try { spawnSync(process.execPath, ['-e', '0']); throw Error('unexpected access'); }
catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; }`);
    const denied = await runSkillScriptProcess(script, skill, workspace, [], 5000, skill);
    assert.equal(denied.status, "success", JSON.stringify(denied));
    fs.writeFileSync(script, 'setInterval(() => {}, 1000)');
    const timeout = await runSkillScriptProcess(script, skill, workspace, [], 200, skill);
    assert.equal(timeout.diagnosticCode, "SKILL_SCRIPT_TIMEOUT");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
