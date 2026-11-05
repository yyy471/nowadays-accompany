import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCases, readTestTotals } from "./acceptance-lib.mjs";

const backend = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/accept-offline.mjs\n离线固定全量验收；报告自动保存于 backend/test-results/p5-<时间>-<编号>/，不覆盖旧记录。");
    process.exit(0);
  }
  throw new Error("UNKNOWN_ACCEPTANCE_ARGUMENT");
}
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("NODE_24_REQUIRED");
const run = path.join(backend, "test-results", `p5-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
const temp = path.join(run, "tmp");
fs.mkdirSync(temp, { recursive: true });
const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, P1_REVIEW_TMP_ROOT: temp, NODE_OPTIONS: "", NO_COLOR: "1" };
delete env.NOWADAYS_REVIEW_CASE;
delete env.NOWADAYS_REVIEW_OUTPUT;
delete env.NOWADAYS_APP_ROOT;
const guard = pathToFileURL(path.join(backend, "scripts/fs-guard.mjs")).href;
const imports = ["--import", guard, "--import", "tsx"];
const matrices = [
  ["p2-original", "20261104-p2-05-review.ts", "report.json", 10, "contractPassed"],
  ["p2-extended", "20261104-p2-05-fix-recheck.ts", "extended-report.json", 5, "contractPassed"],
  ["p2-continuation", "20261104-p2-05-model-continuation.ts", "model-continuation-report.json", 1, "contractPassed"],
  ["p2-combined", "20261104-p2-06-acceptance.ts", "acceptance-report.json", 4, "passed"],
  ["p3-original", "20261104-p3-review.ts", "p3-review-report.json", 7, "contractPassed"],
  ["p3-extended", "20261104-p3-fix-recheck.ts", "p3-extended-report.json", 2, "contractPassed"],
  ["p3-reservation", "20261104-p3-reservation-boundary-review.ts", "reservation-boundary-report.json", 2, "contractPassed"],
  ["p4-original", "20261104-p4-acceptance.ts", "p4-report.json", 8, "contractPassed"],
  ["p4-continuation", "20261104-p4-recovery-recheck.ts", "p4-recovery-recheck-report.json", 6, "contractPassed"],
  ["p4-boundaries", "20261105-p4-remaining-acceptance.ts", "p4-remaining-report.json", 14, "contractPassed"],
];
function manifest() {
  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(backend, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push(next);
    }
  }
  for (const directory of ["src", "tests", "reviews", "scripts", "examples"]) walk(directory);
  files.push("package.json", "package-lock.json", "tsconfig.json");
  return files.sort().map((file) => ({ file: file.replaceAll(path.sep, "/"), sha256: createHash("sha256").update(fs.readFileSync(path.join(backend, file))).digest("hex") }));
}
const before = manifest();
fs.writeFileSync(path.join(run, "source-manifest.json"), JSON.stringify(before, null, 2));
function git(args) {
  const result = spawnSync("git", args, { cwd: backend, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}
const summary = {
  kind: "implementation_self_validation", startedAt: new Date().toISOString(),
  node: process.version, platform: `${os.platform()}-${os.arch()}`, nodeExecutable: process.execPath,
  gitHead: git(["rev-parse", "HEAD"]), gitStatus: git(["status", "--short"]),
  realServiceCalls: 0, passed: false, steps: [], runDirectory: run,
};
const save = () => fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify(summary, null, 2));
save();
console.log(JSON.stringify({ event: "acceptance_started", runDirectory: run }));
async function step(id, argv, inspect = () => ({})) {
  const log = path.join(run, `${id}.log`);
  const output = path.join(run, id);
  fs.mkdirSync(output);
  const fd = fs.openSync(log, "w");
  const startedAt = new Date().toISOString();
  const row = { id, startedAt, log: path.basename(log), passed: false };
  summary.steps.push(row);
  save();
  let child;
  let timedOut = false;
  try {
    const exit = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, argv, { cwd: backend, env: { ...env, NOWADAYS_REVIEW_OUTPUT: output }, stdio: ["ignore", fd, fd], windowsHide: true });
      const timer = setTimeout(() => {
        timedOut = true;
        // 超时只终止本步骤创建的进程树，避免遗留工具子进程。
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else child.kill("SIGKILL");
      }, 240_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    row.exitCode = exit.code;
    row.signal = exit.signal;
    if (timedOut || exit.code !== 0) throw new Error(timedOut ? "STEP_TIMEOUT" : "STEP_EXIT_FAILED");
    Object.assign(row, inspect(log, output));
    row.passed = true;
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  } finally {
    fs.closeSync(fd);
    row.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ event: "step_finished", id, passed: row.passed, error: row.error }));
  }
}
try {
  await step("typecheck", ["node_modules/typescript/bin/tsc", "--noEmit"]);
  await step("review-typecheck", ["node_modules/typescript/bin/tsc", "--noEmit", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--esModuleInterop", "--skipLibCheck", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--types", "node", "scripts/process-smoke.ts", ...matrices.map((m) => `reviews/${m[1]}`)]);
  await step("delivery-tests", ["--import", guard, "--test", "--test-reporter=tap", "scripts/acceptance.test.mjs"], (log) => ({ totals: readTestTotals(fs.readFileSync(log, "utf8")) }));
  const tests = fs.readdirSync(path.join(backend, "tests")).filter((file) => file.endsWith(".test.ts")).sort().map((file) => `tests/${file}`);
  await step("tests", [...imports, "--test", "--test-reporter=tap", ...tests], (log) => ({ totals: readTestTotals(fs.readFileSync(log, "utf8")) }));
  await step("process-smoke", [...imports, "scripts/process-smoke.ts"], (_log, output) => ({ caseIds: readCases(path.join(output, "smoke-report.json"), 1, "passed") }));
  for (const [id, script, report, expected, field] of matrices) {
    await step(id, [...imports, `reviews/${script}`], (_log, output) => ({ report: `${id}/${report}`, caseIds: readCases(path.join(output, report), expected, field, id === "p2-continuation" ? "model-continuation" : undefined) }));
  }
  summary.sourceUnchanged = JSON.stringify(before) === JSON.stringify(manifest());
  summary.passed = summary.sourceUnchanged && summary.steps.every((row) => row.passed);
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  summary.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ event: "acceptance_finished", passed: summary.passed, report: path.join(run, "summary.json") }));
  if (!summary.passed) process.exitCode = 1;
}
