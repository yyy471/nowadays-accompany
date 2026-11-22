import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectBackendTestFiles,
  MIN_BACKEND_TEST_FILES,
  readCases,
  readTestTotals,
  selectRunsToRotate,
} from "./acceptance-lib.mjs";

const backend = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const docsRoot = path.join(repoRoot, "docs");
const toolsRoot = path.join(repoRoot, ".tools");
const acceptanceResultsDir = path.join(repoRoot, "test-results", "backend-acceptance");
const MIN_BACKEND_TESTS = 551;
const MIN_DELIVERY_TESTS = 5;
const STEP_TIMEOUT_MS = 240_000;

const matrices = [
  ["p2-original", "conversation-review.acceptance.ts", "report.json", 10, "contractPassed"],
  ["p2-extended", "conversation-fixes.acceptance.ts", "extended-report.json", 5, "contractPassed"],
  ["p2-continuation", "model-continuation.acceptance.ts", "model-continuation-report.json", 1, "contractPassed"],
  ["p2-combined", "delivery-pipeline.acceptance.ts", "acceptance-report.json", 4, "passed"],
  ["p3-original", "autonomy-review.acceptance.ts", "p3-review-report.json", 7, "contractPassed"],
  ["p3-extended", "autonomy-fixes.acceptance.ts", "p3-extended-report.json", 2, "contractPassed"],
  ["p3-reservation", "autonomy-reservation-boundary.acceptance.ts", "reservation-boundary-report.json", 2, "contractPassed"],
  ["p4-original", "recovery-acceptance.acceptance.ts", "p4-report.json", 8, "contractPassed"],
  ["p4-continuation", "recovery-recheck.acceptance.ts", "p4-recovery-recheck-report.json", 6, "contractPassed"],
  ["p4-boundaries", "recovery-remaining.acceptance.ts", "p4-remaining-report.json", 14, "contractPassed"],
  ["p5-background", "background-tools.acceptance.ts", "p5-background-report.json", 5, "contractPassed"],
  ["p5-tasks", "task-decisions.acceptance.ts", "p5-tasks-report.json", 4, "contractPassed"],
  ["p5-reconcile", "reconcile-unknown.acceptance.ts", "p5-reconcile-report.json", 3, "contractPassed"],
  ["p5-capacity", "memory-capacity.acceptance.ts", "p5-capacity-report.json", 3, "contractPassed"],
  ["p5-skill-run", "skill-run.acceptance.ts", "p5-skill-run-report.json", 3, "contractPassed"],
  ["p5-diary", "diary-read.acceptance.ts", "p5-diary-report.json", 3, "contractPassed"],
];

const STAGE_A = ["typecheck", "review-typecheck", "delivery-tests"];
const STAGE_B = ["tests"];
const STAGE_C = ["process-smoke", ...matrices.map(([id]) => id)];
// p4-boundaries 内部还会再拉起两个并发写进程并包含取消/崩溃边界；与其余 acceptance
// 同池会放大 SQLite 锁竞争，因此单独成道，其余步骤才进入有界并发池。
const ISOLATED_STEPS = ["p4-boundaries"];
// 非隔离 acceptance 按历史实测耗时降序入池，避免 20s 级重脚本排在队尾拉长墙钟。
const STAGE_C_ORDER = [
  "p5-background",
  "p4-continuation",
  "p4-original",
  "p2-original",
  "p5-tasks",
  "p2-combined",
  "p3-original",
  "process-smoke",
  "p2-extended",
  "p5-reconcile",
  "p5-skill-run",
  "p2-continuation",
  "p3-reservation",
  "p3-extended",
  "p5-capacity",
  "p5-diary",
];
const ALL_STEPS = [...STAGE_A, ...STAGE_B, ...STAGE_C];

function printHelp() {
  console.log(`node scripts/verify/accept-offline.mjs [选项]

离线固定全量验收；报告保存于根目录 test-results/backend-acceptance/p5-<时间>-<编号>/。
  --only <id,id>       只运行指定步骤；结果标记 partial，不可作为全量门禁
  --keep-tmp           保留本次 run/tmp（失败时总是保留）
  --keep-runs <N>      保留最新 N 个未被文档引用的历史 run（默认读 ACCEPT_KEEP_RUNS 或 5）
  --list               列出全部步骤
  --help               显示帮助`);
}

function parseArgs(argv) {
  const options = {
    keepTmp: false,
    only: null,
    keepRuns: process.env.ACCEPT_KEEP_RUNS ?? "5",
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep-tmp") options.keepTmp = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--only" || argument.startsWith("--only=")) {
      const value = argument === "--only" ? argv[++index] : argument.slice("--only=".length);
      options.only = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    } else if (argument === "--keep-runs" || argument.startsWith("--keep-runs=")) {
      options.keepRuns = argument === "--keep-runs" ? argv[++index] : argument.slice("--keep-runs=".length);
    } else {
      throw new Error(`UNKNOWN_ACCEPTANCE_ARGUMENT:${argument}`);
    }
  }
  if (options.help || options.list) return options;
  if (options.only) {
    if (options.only.length === 0) throw new Error("ACCEPTANCE_ONLY_REQUIRED");
    const unknown = options.only.filter((id) => !ALL_STEPS.includes(id));
    if (unknown.length) throw new Error(`ACCEPTANCE_ONLY_UNKNOWN:${unknown.join(",")}`);
    if (new Set(options.only).size !== options.only.length) throw new Error("ACCEPTANCE_ONLY_DUPLICATE");
  }
  if (options.keepRuns === "all") options.keepRuns = "0";
  if (!/^\d+$/.test(String(options.keepRuns))) throw new Error("ACCEPTANCE_KEEP_RUNS_INVALID");
  options.keepRuns = Number(options.keepRuns);
  if (!Number.isSafeInteger(options.keepRuns)) throw new Error("ACCEPTANCE_KEEP_RUNS_INVALID");
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.list) {
  console.log(ALL_STEPS.join("\n"));
  process.exit(0);
}
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("NODE_24_REQUIRED");

const selected = args.only ? ALL_STEPS.filter((id) => args.only.includes(id)) : [...ALL_STEPS];
const partial = selected.length !== ALL_STEPS.length;
const run = path.join(acceptanceResultsDir, `p5-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
const temp = path.join(run, "tmp");
fs.mkdirSync(temp, { recursive: true });
const compileCache = path.join(toolsRoot, "compile-cache");
fs.mkdirSync(compileCache, { recursive: true });
const env = {
  ...process.env,
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  P1_REVIEW_TMP_ROOT: temp,
  NODE_OPTIONS: "",
  NO_COLOR: "1",
  NODE_COMPILE_CACHE: compileCache,
};
delete env.NOWADAYS_REVIEW_CASE;
delete env.NOWADAYS_REVIEW_OUTPUT;
delete env.NOWADAYS_APP_ROOT;
const guard = pathToFileURL(path.join(backend, "scripts/verify/fs-guard.mjs")).href;
const imports = ["--import", guard, "--import", "tsx"];
const defaultTestConcurrency = String(Math.min(16, Math.max(8, Math.floor(os.availableParallelism() / 2))));
const testConcurrency = process.env.ACCEPT_TEST_CONCURRENCY ?? defaultTestConcurrency;
const reviewConcurrency = Number(process.env.ACCEPT_REVIEW_CONCURRENCY ?? "6");
if (!Number.isSafeInteger(reviewConcurrency) || reviewConcurrency < 1) {
  throw new Error("ACCEPT_REVIEW_CONCURRENCY_INVALID");
}

function manifest() {
  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(backend, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push(next);
    }
  }
  for (const directory of ["src", "tests", "scripts", "examples"]) walk(directory);
  files.push("package.json", "package-lock.json", "tsconfig.json");
  return files.sort().map((file) => ({
    file: file.replaceAll(path.sep, "/"),
    sha256: createHash("sha256").update(fs.readFileSync(path.join(backend, file))).digest("hex"),
  }));
}

const before = manifest();
fs.writeFileSync(path.join(run, "source-manifest.json"), JSON.stringify(before, null, 2));
function git(args) {
  const result = spawnSync("git", args, { cwd: backend, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}
const rows = selected.map((id) => ({
  id,
  status: "pending",
  startedAt: null,
  finishedAt: null,
  passed: false,
}));
const summary = {
  kind: "implementation_self_validation",
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()}-${os.arch()}`,
  nodeExecutable: process.execPath,
  gitHead: git(["rev-parse", "HEAD"]),
  gitStatus: git(["status", "--short"]),
  realServiceCalls: 0,
  passed: false,
  complete: !partial,
  partial,
  selectedSteps: selected,
  steps: rows,
  runDirectory: run,
};
const summaryFile = path.join(run, "summary.json");
function save() {
  const pending = path.join(run, ".summary.json.tmp");
  fs.writeFileSync(pending, JSON.stringify(summary, null, 2));
  try {
    fs.renameSync(pending, summaryFile);
  } catch {
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    fs.rmSync(pending, { force: true });
  }
}
save();
console.log(JSON.stringify({ event: "acceptance_started", runDirectory: run, partial, selectedSteps: selected }));

async function runStep(id, argv, inspect = () => ({})) {
  const row = summary.steps.find((item) => item.id === id);
  if (!row) throw new Error(`ACCEPTANCE_STEP_NOT_SELECTED:${id}`);
  const log = path.join(run, `${id}.log`);
  const output = path.join(run, id);
  fs.mkdirSync(output);
  const fd = fs.openSync(log, "w");
  row.status = "running";
  row.startedAt = new Date().toISOString();
  save();
  let child;
  let timedOut = false;
  let cleanupError;
  try {
    const exit = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, argv, {
        cwd: backend,
        env: { ...env, NOWADAYS_REVIEW_OUTPUT: output },
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        // 超时只终止本步骤创建的进程树，并等待 close 后再释放后续资源。
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else child.kill("SIGKILL");
      }, STEP_TIMEOUT_MS);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    row.exitCode = exit.code;
    row.signal = exit.signal;
    if (timedOut || exit.code !== 0) throw new Error(timedOut ? "STEP_TIMEOUT" : "STEP_EXIT_FAILED");
    Object.assign(row, inspect(log, output));
    row.passed = true;
    row.status = "passed";
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    row.status = "failed";
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    row.finishedAt = new Date().toISOString();
    if (cleanupError) row.logCleanupError = cleanupError;
    save();
    console.log(JSON.stringify({ event: "step_finished", id, passed: row.passed, error: row.error }));
  }
}

async function runPool(ids, concurrency) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      await runStepById(id);
    }
  });
  await Promise.all(workers);
}

async function runStepById(id) {
  if (id === "typecheck") {
    await runStep(id, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  } else if (id === "review-typecheck") {
    await runStep(id, [
      "node_modules/typescript/bin/tsc", "--noEmit", "--target", "ES2022", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--esModuleInterop", "--skipLibCheck", "--strict",
      "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--types", "node",
      "scripts/verify/process-smoke.ts", ...matrices.map((matrix) => `tests/acceptance/${matrix[1]}`),
    ]);
  } else if (id === "delivery-tests") {
    await runStep(id, ["--import", guard, "--test", "--test-reporter=tap", "scripts/verify/acceptance.test.mjs"], (log) => ({
      totals: readTestTotals(fs.readFileSync(log, "utf8"), { minTests: MIN_DELIVERY_TESTS }),
    }));
  } else if (id === "tests") {
    const tests = collectBackendTestFiles(path.join(backend, "tests"), {
      baseDir: backend,
      minFiles: MIN_BACKEND_TEST_FILES,
    });
    await runStep(id, [
      "--import", guard, "scripts/verify/run-tests.mjs", "--fs-guard", `--test-concurrency=${testConcurrency}`,
    ], (log) => ({
      totals: readTestTotals(fs.readFileSync(log, "utf8"), { minTests: MIN_BACKEND_TESTS }),
      testFiles: tests.length,
    }));
  } else if (id === "process-smoke") {
    await runStep(id, [...imports, "scripts/verify/process-smoke.ts"], (_log, output) => ({
      caseIds: readCases(path.join(output, "smoke-report.json"), 1, "passed"),
    }));
  } else {
    const matrix = matrices.find(([stepId]) => stepId === id);
    if (!matrix) throw new Error(`ACCEPTANCE_STEP_UNKNOWN:${id}`);
    const [stepId, script, report, expected, field] = matrix;
    await runStep(id, [...imports, `tests/acceptance/${script}`], (_log, output) => ({
      report: `${stepId}/${report}`,
      caseIds: readCases(
        path.join(output, report),
        expected,
        field,
        stepId === "p2-continuation" ? "model-continuation" : undefined,
      ),
    }));
  }
}

function markdownFiles(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(target));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(target);
  }
  return files;
}

function referencedRuns() {
  const files = markdownFiles(docsRoot);
  for (const name of ["README.md", "AGENTS.md"]) {
    const file = path.join(repoRoot, name);
    if (fs.existsSync(file)) files.push(file);
  }
  const names = new Set();
  const pattern = /p5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}/g;
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(pattern)) names.add(match[0]);
  }
  return names;
}

function rotateRuns() {
  const testResults = acceptanceResultsDir;
  if (!fs.existsSync(testResults)) return [];
  const names = fs.readdirSync(testResults, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
  const protectedNames = referencedRuns();
  protectedNames.add(path.basename(run));
  const rotate = selectRunsToRotate(names, { keep: args.keepRuns, protectedNames });
  for (const name of rotate) {
    fs.rmSync(path.join(testResults, name), {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
  return rotate;
}

let sourceUnchanged = false;
try {
  await runPool(STAGE_A.filter((id) => selected.includes(id)), STAGE_A.length);
  await runPool(STAGE_B.filter((id) => selected.includes(id)), 1);
  const stageC = STAGE_C.filter((id) => selected.includes(id));
  const poolSteps = stageC
    .filter((id) => !ISOLATED_STEPS.includes(id))
    .sort((left, right) => STAGE_C_ORDER.indexOf(left) - STAGE_C_ORDER.indexOf(right));
  await runPool(poolSteps, reviewConcurrency);
  await runPool(stageC.filter((id) => ISOLATED_STEPS.includes(id)), 1);
  sourceUnchanged = JSON.stringify(before) === JSON.stringify(manifest());
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  const allSelectedPassed = summary.steps.every((row) => row.passed);
  summary.sourceUnchanged = sourceUnchanged;
  summary.selectedPassed = allSelectedPassed && sourceUnchanged;
  summary.finishedAt = new Date().toISOString();
  save();

  const shouldCleanTmp = summary.selectedPassed && !args.keepTmp;
  if (shouldCleanTmp) {
    try {
      fs.rmSync(temp, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
      summary.tmpRemoved = true;
    } catch (error) {
      summary.tmpCleanupError = error instanceof Error ? error.message : String(error);
      summary.tmpRemoved = false;
    }
  } else {
    summary.tmpRemoved = false;
  }

  if (!partial && summary.selectedPassed && args.keepRuns > 0) {
    try {
      summary.rotatedRuns = rotateRuns();
    } catch (error) {
      summary.rotationError = error instanceof Error ? error.message : String(error);
      summary.rotatedRuns = [];
    }
  }

  summary.passed = !partial && summary.selectedPassed && !summary.tmpCleanupError && !summary.error;
  save();
  console.log(JSON.stringify({
    event: "acceptance_finished",
    passed: summary.passed,
    partial,
    selectedPassed: summary.selectedPassed,
    report: summaryFile,
  }));
  if (partial ? !summary.selectedPassed : !summary.passed) process.exitCode = 1;
}
