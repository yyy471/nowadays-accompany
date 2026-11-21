#!/usr/bin/env node
"use strict";

// 桌面 Electron 离线 E2E 调度器：显式清单、独立临时目录、进程树超时清理。
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const desktop = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktop, "..", "..");
const outputRoot = path.join(repoRoot, "test-results", "desktop-e2e");
const distDir = path.join(desktop, "renderer", "dist");
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? "180000");
const poolSize = Math.max(1, Number(process.env.E2E_CONCURRENCY ?? "2"));
const keepRuns = Math.max(0, Number(process.env.E2E_KEEP_RUNS ?? "5"));
const expectedSuiteSize = 15;

const SUITE = [
  "pack3-entry-check.cjs",
  "dialogue-layout-check.cjs",
  "relations-desktop-check.cjs",
  "theme-transition-check.cjs",
  "startup-flow-fixes-check.cjs",
  "settings-binding-recovery-check.cjs",
  "settings-auto-reload-check.cjs",
  "settings-real-backend-check.cjs",
  "settings-review-fixes-check.cjs",
  "settings-workspace-check.cjs",
  "settings-sheet-focus-check.cjs",
  "settings-media-sheet-check.cjs",
  "settings-v6-behavior-check.cjs",
  "token-usage-check.cjs",
  "workflow-real-backend-chain-check.cjs",
];

// 共享 Electron 会话、精确动画或长等待的用例单独成链，避免与并发池抢时序。
const SERIAL_CHAINS = [
  ["workflow-real-backend-chain-check.cjs"],
  [
    "theme-transition-check.cjs",
    "settings-media-sheet-check.cjs",
    "settings-sheet-focus-check.cjs",
  ],
];
const serialNames = new Set(SERIAL_CHAINS.flat());
// v6 断言精确过渡时长，任何同机 Electron 并发都可能拉长动画；它最后独占运行。
const EXCLUSIVE_STEPS = ["settings-v6-behavior-check.cjs"];

function parseArgs(argv) {
  const options = { filter: null, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") options.list = true;
    else if (argument === "--filter" || argument.startsWith("--filter=")) {
      options.filter = argument === "--filter" ? argv[++index] : argument.slice("--filter=".length);
      if (!options.filter) throw new Error("E2E_FILTER_REQUIRED");
    } else {
      throw new Error(`E2E_UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  return options;
}

function hashDist() {
  if (!fs.existsSync(distDir)) throw new Error("E2E_RENDERER_DIST_MISSING");
  const hash = crypto.createHash("sha256");
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && (entry.name === "index.html" || entry.name.endsWith(".js"))) {
        hash.update(path.relative(distDir, target).replaceAll(path.sep, "/"));
        hash.update(fs.readFileSync(target));
      }
    }
  }
  visit(distDir);
  return hash.digest("hex");
}

function uniqueRunDirectory() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(outputRoot, `e2e-${stamp}-${crypto.randomBytes(4).toString("hex")}`);
}

function rotateRuns(current) {
  if (keepRuns === 0 || !fs.existsSync(outputRoot)) return [];
  const pattern = /^e2e-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
  const runs = fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  const removed = [];
  for (const name of runs.slice(keepRuns)) {
    if (path.join(outputRoot, name) === current) continue;
    fs.rmSync(path.join(outputRoot, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    removed.push(name);
  }
  return removed;
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

function runOne(name, runDir) {
  const caseDir = path.join(runDir, name.replace(/\.cjs$/, ""));
  fs.mkdirSync(caseDir, { recursive: true });
  const log = path.join(runDir, `${name.replace(/\.cjs$/, "")}.log`);
  const fd = fs.openSync(log, "w");
  const env = {
    ...process.env,
    TEMP: path.join(caseDir, "tmp"),
    TMP: path.join(caseDir, "tmp"),
    TMPDIR: path.join(caseDir, "tmp"),
    NOWADAYS_E2E_CASE: name,
  };
  fs.mkdirSync(env.TEMP, { recursive: true });
  delete env.NOWADAYS_REVIEW_OUTPUT;
  delete env.NOWADAYS_APP_ROOT;
  delete env.ELECTRON_RUN_AS_NODE;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let child;
    try {
      child = spawn(process.execPath, [path.join(__dirname, name)], {
        cwd: desktop,
        env,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      fs.closeSync(fd);
      resolve({ name, passed: false, error: error.message, startedAt, finishedAt: new Date().toISOString(), ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ name, passed: false, error: error.message, timedOut, startedAt, finishedAt: new Date().toISOString(), ms: Date.now() - started });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
      resolve({
        name,
        passed: code === 0 && !timedOut,
        exitCode: code,
        signal,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        ms: Date.now() - started,
      });
      console.log(JSON.stringify({ event: "e2e_finished", name, passed: code === 0 && !timedOut, ms: Date.now() - started }));
    });
  });
}

async function runPool(names, runDir, limit) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next];
      next += 1;
      results.push(await runOne(name, runDir));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, worker));
  return results;
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("NODE_24_REQUIRED");
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const name of SUITE) console.log(`${name}${serialNames.has(name) ? " (serial)" : ""}`);
    return;
  }
  for (const name of SUITE) {
    if (!fs.existsSync(path.join(__dirname, name))) throw new Error(`E2E_SUITE_FILE_MISSING:${name}`);
  }
  if (SUITE.length !== expectedSuiteSize) throw new Error(`E2E_SUITE_SIZE_MISMATCH:${SUITE.length}`);

  const selected = options.filter ? SUITE.filter((name) => name.includes(options.filter)) : [...SUITE];
  if (selected.length === 0) throw new Error("E2E_FILTER_EMPTY");
  fs.mkdirSync(outputRoot, { recursive: true });
  const runDir = uniqueRunDirectory();
  fs.mkdirSync(runDir, { recursive: true });
  const beforeHash = hashDist();
  const summary = {
    kind: "desktop_e2e",
    startedAt: new Date().toISOString(),
    node: process.version,
    partial: Boolean(options.filter),
    filter: options.filter,
    expectedSuiteSize,
    selected: selected.length,
    entryHash: beforeHash,
    concurrency: poolSize,
    results: [],
    passed: false,
  };
  const summaryFile = path.join(runDir, "gates.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: "e2e_started", runDirectory: runDir, selected: selected.length }));

  const selectedSerialChains = SERIAL_CHAINS
    .map((chain) => chain.filter((name) => selected.includes(name)))
    .filter((chain) => chain.length);
  const serialSelected = new Set(selectedSerialChains.flat());
  const exclusive = selected.filter((name) => EXCLUSIVE_STEPS.includes(name));
  const pool = selected.filter((name) => !serialSelected.has(name) && !exclusive.includes(name));

  const [chains, pooled] = await Promise.all([
    Promise.all(selectedSerialChains.map((chain) => runPool(chain, runDir, 1))),
    runPool(pool, runDir, poolSize),
  ]);
  const exclusiveResults = await runPool(exclusive, runDir, 1);
  summary.results = [...chains.flat(), ...pooled, ...exclusiveResults];
  const afterHash = hashDist();
  summary.entryStable = beforeHash === afterHash;
  summary.complete = !summary.partial && summary.results.length === expectedSuiteSize;
  summary.finishedAt = new Date().toISOString();
  summary.passed = summary.results.length === selected.length &&
    summary.results.every((result) => result.passed) && summary.entryStable;
  summary.rotatedRuns = rotateRuns(runDir);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    event: "e2e_completed",
    passed: summary.passed,
    complete: summary.complete,
    passedCount: summary.results.filter((result) => result.passed).length,
    total: summary.results.length,
    report: summaryFile,
  }));
  if (!summary.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
