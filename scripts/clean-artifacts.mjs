#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendTestResultsDir,
  docsDir,
  repoRoot,
  rootTestResultsDir,
  toolsDir,
} from "./repo-paths.mjs";

export const RUN_NAME_RE = /^p5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
const RUN_REFERENCE_RE = /p5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}/g;
const LEGACY_RELATIVE_PATHS = [
  ".cache",
  "node_modules",
  "release",
  ".nowadays-review",
  "prototypes/p0/.runtime",
  "prototypes/p0/node_modules",
  "desktop/renderer",
  "desktop-dist",
  "dist",
  "release-build",
  ".packaging",
  ".packaging-28948",
];
const LEGACY_PATHS = new Set(LEGACY_RELATIVE_PATHS.map((relative) => path.resolve(repoRoot, relative)));
const TEST_RESULTS_ROOTS = [backendTestResultsDir, rootTestResultsDir];
const NODE_RUNTIME_DIR = path.join(toolsDir, "node-v24");
const GIT_DIR = path.join(repoRoot, ".git");

function isWithin(parent, candidate, includeParent = false) {
  const relative = path.relative(parent, candidate);
  if (relative === "") return includeParent;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function repoRelative(target) {
  return path.relative(repoRoot, target).split(path.sep).join("/");
}

function hasTrackedFileWithin(target, trackedFiles) {
  const relative = repoRelative(target);
  if (relative === "" || relative === ".." || relative.startsWith("../")) return true;
  const prefix = `${relative}/`;
  for (const file of trackedFiles) {
    if (file === relative || file.startsWith(prefix)) return true;
  }
  return false;
}

function assertSafeTarget(operation) {
  const target = path.resolve(operation.path);
  const fail = (reason) => {
    throw new Error(`SAFETY_TARGET_REJECTED: ${target}: ${reason}`);
  };
  if (!isWithin(repoRoot, target)) fail("目标必须严格位于仓库内");
  if (isWithin(GIT_DIR, target, true) || isWithin(target, GIT_DIR, true)) fail("禁止触碰 .git");
  if (isWithin(NODE_RUNTIME_DIR, target, true) || isWithin(target, NODE_RUNTIME_DIR, true)) {
    fail("禁止触碰 .tools/node-v24");
  }

  if (operation.action === "legacy") {
    if (!LEGACY_PATHS.has(target)) fail("legacy 目标不在方案 A 清单");
    return;
  }

  if (!TEST_RESULTS_ROOTS.includes(operation.testRoot)) fail("未知 test-results 根目录");
  if (!isWithin(operation.testRoot, target)) fail("不得删除 test-results 根本身或越界目标");
  const segments = path.relative(operation.testRoot, target).split(path.sep);
  if (!RUN_NAME_RE.test(segments[0])) fail("run 名称不符合严格格式");
  if (operation.action === "rotate") {
    if (segments.length !== 1) fail("轮转只能删除完整 run 目录");
    return;
  }
  if (operation.action === "prune") {
    const relative = segments.slice(1).join("/");
    if (relative !== "tmp" && relative !== "process-smoke/app") fail("仅允许清理 run/tmp 或 run/process-smoke/app");
    return;
  }
  fail("未知操作");
}

async function assertNoSymlinkTraversal(target) {
  const relative = path.relative(repoRoot, target);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = repoRoot;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`SAFETY_SYMLINK_TRAVERSAL: 仓库根不是真实目录: ${repoRoot}`);
  }
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`SAFETY_SYMLINK_TRAVERSAL: 删除路径的祖先不得是符号链接或联接点: ${current}`);
    }
  }
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    legacy: false,
    testResults: false,
    keepRuns: 5,
    protectStatusRefs: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.apply = false;
    else if (argument === "--legacy") options.legacy = true;
    else if (argument === "--test-results") options.testResults = true;
    else if (argument === "--protect-status-refs") options.protectStatusRefs = true;
    else if (argument === "--no-protect-status-refs") options.protectStatusRefs = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--keep-runs" || argument.startsWith("--keep-runs=")) {
      const value = argument === "--keep-runs" ? argv[++index] : argument.slice("--keep-runs=".length);
      if (!/^\d+$/.test(value || "")) throw new Error("--keep-runs 需要非负整数 N");
      options.keepRuns = Number(value);
      if (!Number.isSafeInteger(options.keepRuns)) throw new Error("--keep-runs 超出安全整数范围");
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }
  if (!options.legacy && !options.testResults) {
    options.legacy = true;
    options.testResults = true;
  }
  return options;
}

function printHelp() {
  console.log(`用法: node scripts/clean-artifacts.mjs [选项]

默认同时预览 legacy 与 test-results，且不删除任何文件。
  --apply                    实际执行删除（缺省为 dry-run）
  --dry-run                  显式仅预览
  --legacy                   仅选择方案 A 档；与 --test-results 可组合
  --test-results             仅选择测试产物；与 --legacy 可组合
  --keep-runs N              每个 test-results 根保留最新 N 个未保护 run（默认 5）
  --protect-status-refs      保护 devDoc 全树及根 README/AGENTS 引用的 run（默认）
  --no-protect-status-refs   关闭文档引用保护
  --help                     显示帮助`);
}

async function pathStat(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function markdownFiles(directory) {
  const files = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(target);
    }
  }
  if (await pathStat(directory)) await visit(directory);
  return files;
}

export async function collectProtectedRunNames() {
  const files = await markdownFiles(docsDir);
  for (const name of ["README.md", "AGENTS.md"]) {
    const target = path.join(repoRoot, name);
    if ((await pathStat(target))?.isFile()) files.push(target);
  }
  const protectedRuns = new Set();
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    for (const match of content.matchAll(RUN_REFERENCE_RE)) protectedRuns.add(match[0]);
  }
  return { protectedRuns, scannedFiles: files.length };
}

async function listRuns(testRoot) {
  const stat = await pathStat(testRoot);
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`test-results 根必须是真实目录: ${testRoot}`);
  const entries = await fs.readdir(testRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_NAME_RE.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(testRoot, entry.name), testRoot }))
    .sort((left, right) => right.name.localeCompare(left.name));
}

async function addOperation(operations, operation) {
  if (await pathStat(operation.path)) operations.push(operation);
}

async function buildOperations(options, protectedRuns) {
  const operations = [];
  if (options.legacy) {
    for (const relative of LEGACY_RELATIVE_PATHS) {
      await addOperation(operations, { action: "legacy", path: path.resolve(repoRoot, relative) });
    }
  }
  if (options.testResults) {
    for (const testRoot of TEST_RESULTS_ROOTS) {
      const runs = await listRuns(testRoot);
      const unprotected = runs.filter((run) => !protectedRuns.has(run.name));
      const rotate = new Set(unprotected.slice(options.keepRuns).map((run) => run.path));
      for (const run of runs) {
        if (rotate.has(run.path)) {
          operations.push({ action: "rotate", ...run, protected: false });
          continue;
        }
        const isProtected = protectedRuns.has(run.name);
        await addOperation(operations, {
          action: "prune",
          path: path.join(run.path, "tmp"),
          testRoot,
          runName: run.name,
          protected: isProtected,
        });
        await addOperation(operations, {
          action: "prune",
          path: path.join(run.path, "process-smoke", "app"),
          testRoot,
          runName: run.name,
          protected: isProtected,
        });
      }
    }
  }
  return operations;
}

async function measurePath(target) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return stat.size;
  let bytes = 0;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      bytes += (await fs.lstat(child)).size;
    } else if (entry.isDirectory()) {
      bytes += await measurePath(child);
    } else {
      bytes += (await fs.lstat(child)).size;
    }
  }
  return bytes;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function loadTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean).sort();
}

export function runSafetySelfChecks() {
  const validRun = "p5-2026-11-21T13-11-21-968Z-cfbceea9";
  assert(RUN_NAME_RE.test(validRun));
  for (const invalid of ["p5-gap-audit", `${validRun}-extra`, validRun.toUpperCase(), "p5-2026-11-21"]) {
    assert(!RUN_NAME_RE.test(invalid), `不应接受 run 名称: ${invalid}`);
  }
  assert.doesNotThrow(() => assertSafeTarget({ action: "legacy", path: path.join(repoRoot, ".cache") }));
  assert.doesNotThrow(() => assertSafeTarget({
    action: "rotate",
    path: path.join(backendTestResultsDir, validRun),
    testRoot: backendTestResultsDir,
  }));
  for (const target of [repoRoot, GIT_DIR, NODE_RUNTIME_DIR, toolsDir, path.dirname(repoRoot)]) {
    assert.throws(() => assertSafeTarget({ action: "legacy", path: target }), /SAFETY_TARGET_REJECTED/);
  }
  assert.throws(() => assertSafeTarget({
    action: "rotate",
    path: path.join(backendTestResultsDir, "p5-gap-audit"),
    testRoot: backendTestResultsDir,
  }), /SAFETY_TARGET_REJECTED/);
  assert.throws(() => assertSafeTarget({
    action: "prune",
    path: path.join(backendTestResultsDir, validRun, "summary.json"),
    testRoot: backendTestResultsDir,
  }), /SAFETY_TARGET_REJECTED/);
  assert(hasTrackedFileWithin(path.join(repoRoot, "backend"), ["backend/src/main.ts"]));
  assert(!hasTrackedFileWithin(path.join(repoRoot, "release"), ["backend/src/main.ts"]));
}

function describeOperation(operation) {
  const label = operation.action === "legacy" ? "A档" : operation.action === "rotate" ? "轮转整目录" : "仅清临时目录";
  return `[${label}] ${repoRelative(operation.path)} (${formatBytes(operation.bytes)})`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  runSafetySelfChecks();
  const { protectedRuns, scannedFiles } = options.protectStatusRefs
    ? await collectProtectedRunNames()
    : { protectedRuns: new Set(), scannedFiles: 0 };
  const trackedFiles = loadTrackedFiles();
  const candidates = await buildOperations(options, protectedRuns);
  const operations = [];
  const skipped = [];
  for (const operation of candidates) {
    assertSafeTarget(operation);
    await assertNoSymlinkTraversal(operation.path);
    if (hasTrackedFileWithin(operation.path, trackedFiles)) {
      skipped.push(operation);
      continue;
    }
    operation.bytes = await measurePath(operation.path);
    operations.push(operation);
  }

  console.log(`模式: ${options.apply ? "APPLY（将实际删除）" : "DRY-RUN（不会删除文件）"}`);
  console.log(`范围: ${[options.legacy && "legacy", options.testResults && "test-results"].filter(Boolean).join(", ")}`);
  if (options.testResults) {
    console.log(`轮转: 每个测试结果根保留最新 ${options.keepRuns} 个未保护 run`);
    console.log(`文档保护: ${options.protectStatusRefs ? `开启，扫描 ${scannedFiles} 个 Markdown，引用 ${protectedRuns.size} 个 run` : "关闭"}`);
  }
  console.log(`安全自检: 通过；Git 跟踪文件: ${trackedFiles.length} 个（含跟踪文件的目标整体跳过）`);
  console.log("\n删除预览:");
  if (operations.length === 0) console.log("  （无匹配目标）");
  for (const operation of operations) console.log(`  ${describeOperation(operation)}`);
  for (const operation of skipped) console.log(`  [跳过：含 Git 跟踪文件] ${repoRelative(operation.path)}`);
  const estimatedBytes = operations.reduce((total, operation) => total + operation.bytes, 0);
  console.log(`\n合计: ${operations.length} 个目标，跳过 ${skipped.length} 个，预计释放 ${formatBytes(estimatedBytes)}`);

  if (!options.apply) {
    console.log("未执行删除；确认预览后使用 --apply。");
    return;
  }

  let releasedBytes = 0;
  let deleted = 0;
  for (const operation of operations) {
    assertSafeTarget(operation);
    await assertNoSymlinkTraversal(operation.path);
    if (hasTrackedFileWithin(operation.path, trackedFiles)) {
      throw new Error(`SAFETY_TRACKED_FILE: 删除前复核发现跟踪文件: ${operation.path}`);
    }
    const stat = await fs.lstat(operation.path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) await fs.unlink(operation.path);
    else await fs.rm(operation.path, { recursive: true, force: false });
    releasedBytes += operation.bytes;
    deleted += 1;
    console.log(`已删除: ${repoRelative(operation.path)}`);
  }
  console.log(`实际完成: 删除 ${deleted} 个目标，按删除前大小估算释放 ${formatBytes(releasedBytes)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
