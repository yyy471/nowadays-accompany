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
export const E2E_RUN_NAME_RE = /^e2e-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
const RUN_REFERENCE_RE = /p5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}/g;
const DIR_REFERENCE_RE = /test-results\/([A-Za-z0-9_.\-]+)/g;
const LEGACY_RELATIVE_PATHS = [
  ".cache",
  "node_modules",
  "release",
  ".nowadays-review",
  ".archify",
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

const RUNTIME_BLOAT_DIR_RE = /^(?:app|app-root|data|source|target|chrome|chrome-.*|profile|profile-.*|chrome-profile|role-data-.*|node_modules|backend|desktop|renderer|dist|browser|acceptance-snapshot|snapshot|build-verification|nvda-portable|nvda-review-profile|tmp|test-results|\.nowadays.*)$/i;
const KEEP_EVIDENCE_FILE_RE = /\.(?:json|log|md|txt|ts|cjs|mjs|py)$/i;
const KEEP_SCREENSHOT_DIRS = new Set(["theme-transition", "desktop-appearance-fixes", "400-v6-verify-20261119"]);
const KEEP_400_V6_SCREENSHOT_SUBDIRS = new Set([
  "release-14",
  "baseline",
  "p2-candidate",
  "p2-external-create",
  "p2-reduced-first",
  "p3b-before",
  "p3b-shell-night",
  "p4-theme-motion",
  "p4-theme-reduced",
]);

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
  if (operation.action === "rotate") {
    if (!RUN_NAME_RE.test(segments[0])) fail("run 名称不符合严格格式");
    if (segments.length !== 1) fail("轮转只能删除完整 run 目录");
    return;
  }
  if (operation.action === "prune") {
    if (!RUN_NAME_RE.test(segments[0])) fail("run 名称不符合严格格式");
    const relative = segments.slice(1).join("/");
    if (relative !== "tmp" && relative !== "process-smoke/app") fail("仅允许清理 run/tmp 或 run/process-smoke/app");
    return;
  }
  if (operation.action === "rotate-e2e") {
    if (segments[0] !== "desktop-e2e" || segments.length !== 2 || !E2E_RUN_NAME_RE.test(segments[1])) {
      fail("E2E 轮转目录不符合严格格式");
    }
    return;
  }
  if (operation.action === "prune-e2e-tmp") {
    if (
      segments[0] !== "desktop-e2e" ||
      segments.length !== 3 ||
      !E2E_RUN_NAME_RE.test(segments[1]) ||
      !segments[2].endsWith(".e2e")
    ) {
      fail("仅允许清理已通过 E2E run 内的用例临时目录");
    }
    return;
  }
  if (operation.action === "prune-review") {
    if (
      segments.length < 1 ||
      RUN_NAME_RE.test(segments[0]) ||
      segments[0] === "desktop-e2e" ||
      segments[0] === "backend-acceptance"
    ) {
      fail("review-bloat 清理禁止直接删 p5/desktop-e2e/backend-acceptance");
    }
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
    pruneReviewBloat: true,
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
    else if (argument === "--prune-review-bloat") options.pruneReviewBloat = true;
    else if (argument === "--no-prune-review-bloat") options.pruneReviewBloat = false;
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
  --protect-status-refs      保护 docs 全树及根 README/AGENTS 引用的 run 与证据（默认）
  --no-protect-status-refs   关闭文档引用保护
  --prune-review-bloat       清理历史审查目录下的运行库/浏览器缓存与未引用冗余产物（默认随 --test-results 开启）
  --no-prune-review-bloat    仅轮转 p5/e2e，不瘦身历史审查目录
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
  const protectedEntries = new Set();
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    for (const match of content.matchAll(RUN_REFERENCE_RE)) protectedRuns.add(match[0]);
    for (const match of content.matchAll(DIR_REFERENCE_RE)) protectedEntries.add(match[1]);
  }
  return { protectedRuns, protectedEntries, scannedFiles: files.length };
}

async function listRuns(testRoot, pattern = RUN_NAME_RE) {
  const stat = await pathStat(testRoot);
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`test-results 根必须是真实目录: ${testRoot}`);
  const entries = await fs.readdir(testRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && pattern.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(testRoot, entry.name), testRoot }))
    .sort((left, right) => right.name.localeCompare(left.name));
}

async function addOperation(operations, operation) {
  if (await pathStat(operation.path)) operations.push(operation);
}

function shouldKeepReviewFile(parts) {
  const topDir = parts[0];
  const fileName = parts[parts.length - 1];
  if (KEEP_EVIDENCE_FILE_RE.test(fileName)) return true;
  if (KEEP_SCREENSHOT_DIRS.has(topDir) && /\.(?:png|jpg|jpeg|webp|svg|html)$/i.test(fileName)) return true;
  if (
    topDir === "400-v6-main-review" &&
    parts.length >= 2 &&
    KEEP_400_V6_SCREENSHOT_SUBDIRS.has(parts[1]) &&
    /\.(?:png|jpg|jpeg|webp|svg|html)$/i.test(fileName)
  ) {
    return true;
  }
  if (topDir === "desktop-media" && /^(?:background|full_scene)\.png$/i.test(fileName)) return true;
  return false;
}

async function collectReviewBloat(testRoot, protectedEntries, options, operations) {
  const stat = await pathStat(testRoot);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
  const topEntries = (await fs.readdir(testRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) continue;
    if (RUN_NAME_RE.test(entry.name) || entry.name === "desktop-e2e" || entry.name === "backend-acceptance") continue;
    const full = path.join(testRoot, entry.name);
    if (!entry.isDirectory()) continue;
    if (options.protectStatusRefs && !protectedEntries.has(entry.name)) {
      operations.push({ action: "prune-review", path: full, testRoot });
      continue;
    }
    if (!options.protectStatusRefs) {
      operations.push({ action: "prune-review", path: full, testRoot });
      continue;
    }

    async function visitCitedDir(current, parts) {
      const children = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const childPath = path.join(current, child.name);
        const childParts = [...parts, child.name];
        if (child.isDirectory()) {
          if (RUNTIME_BLOAT_DIR_RE.test(child.name)) {
            operations.push({ action: "prune-review", path: childPath, testRoot });
            continue;
          }
          await visitCitedDir(childPath, childParts);
        } else if (child.isFile()) {
          if (!shouldKeepReviewFile(childParts)) {
            operations.push({ action: "prune-review", path: childPath, testRoot });
          }
        }
      }
    }
    await visitCitedDir(full, [entry.name]);
  }
}

async function buildOperations(options, protectedRuns, protectedEntries) {
  const operations = [];
  if (options.legacy) {
    for (const relative of LEGACY_RELATIVE_PATHS) {
      await addOperation(operations, { action: "legacy", path: path.resolve(repoRoot, relative) });
    }
  }
  if (options.testResults) {
    for (const testRoot of TEST_RESULTS_ROOTS) {
      const runs = await listRuns(testRoot, RUN_NAME_RE);
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

      if (options.pruneReviewBloat) {
        await collectReviewBloat(testRoot, protectedEntries, options, operations);
      }
    }

    const e2eRoot = path.join(rootTestResultsDir, "desktop-e2e");
    if ((await pathStat(e2eRoot))?.isDirectory()) {
      const e2eRuns = await listRuns(e2eRoot, E2E_RUN_NAME_RE);
      for (const run of e2eRuns.slice(options.keepRuns)) {
        operations.push({ action: "rotate-e2e", path: run.path, testRoot: rootTestResultsDir });
      }
      if (options.pruneReviewBloat) {
        for (const run of e2eRuns.slice(0, options.keepRuns)) {
          const entries = await fs.readdir(run.path, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".e2e")) {
              operations.push({
                action: "prune-e2e-tmp",
                path: path.join(run.path, entry.name),
                testRoot: rootTestResultsDir,
              });
            }
          }
        }
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
  const validE2eRun = "e2e-2026-11-22T03-45-09-908Z-4dde2193";
  assert(RUN_NAME_RE.test(validRun));
  assert(E2E_RUN_NAME_RE.test(validE2eRun));
  for (const invalid of ["p5-gap-audit", `${validRun}-extra`, validRun.toUpperCase(), "p5-2026-11-21"]) {
    assert(!RUN_NAME_RE.test(invalid), `不应接受 run 名称: ${invalid}`);
  }
  assert.doesNotThrow(() => assertSafeTarget({ action: "legacy", path: path.join(repoRoot, ".cache") }));
  assert.doesNotThrow(() => assertSafeTarget({
    action: "rotate",
    path: path.join(backendTestResultsDir, validRun),
    testRoot: backendTestResultsDir,
  }));
  assert.doesNotThrow(() => assertSafeTarget({
    action: "rotate-e2e",
    path: path.join(rootTestResultsDir, "desktop-e2e", validE2eRun),
    testRoot: rootTestResultsDir,
  }));
  assert.doesNotThrow(() => assertSafeTarget({
    action: "prune-review",
    path: path.join(rootTestResultsDir, "400-v6-main-review", "nvda-portable"),
    testRoot: rootTestResultsDir,
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
  assert.throws(() => assertSafeTarget({
    action: "prune-review",
    path: path.join(rootTestResultsDir, "desktop-e2e"),
    testRoot: rootTestResultsDir,
  }), /SAFETY_TARGET_REJECTED/);
  assert(hasTrackedFileWithin(path.join(repoRoot, "apps", "backend"), ["apps/backend/src/main.ts"]));
  assert(!hasTrackedFileWithin(path.join(repoRoot, "release"), ["apps/backend/src/main.ts"]));
}

function describeOperation(operation) {
  const labels = {
    legacy: "A档",
    rotate: "轮转整目录",
    prune: "仅清临时目录",
    "rotate-e2e": "轮转E2E",
    "prune-e2e-tmp": "清E2E临时目录",
    "prune-review": "瘦身审查冗余",
  };
  return `[${labels[operation.action] ?? operation.action}] ${repoRelative(operation.path)} (${formatBytes(operation.bytes)})`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  runSafetySelfChecks();
  const { protectedRuns, protectedEntries, scannedFiles } = options.protectStatusRefs
    ? await collectProtectedRunNames()
    : { protectedRuns: new Set(), protectedEntries: new Set(), scannedFiles: 0 };
  const trackedFiles = loadTrackedFiles();
  const candidates = await buildOperations(options, protectedRuns, protectedEntries);
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
    console.log(`审查目录瘦身: ${options.pruneReviewBloat ? "开启" : "关闭"}`);
    console.log(`文档保护: ${options.protectStatusRefs ? `开启，扫描 ${scannedFiles} 个 Markdown，引用 ${protectedRuns.size} 个 run、${protectedEntries.size} 个目录名` : "关闭"}`);
  }
  console.log(`安全自检: 通过；Git 跟踪文件: ${trackedFiles.length} 个（含跟踪文件的目标整体跳过）`);
  console.log("\n删除预览:");
  if (operations.length === 0) console.log("  （无匹配目标）");
  const previewLimit = 60;
  for (const operation of operations.slice(0, previewLimit)) console.log(`  ${describeOperation(operation)}`);
  if (operations.length > previewLimit) {
    console.log(`  ...（其余 ${operations.length - previewLimit} 项省略预览）`);
  }
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
    try {
      if (stat.isSymbolicLink() || !stat.isDirectory()) await fs.unlink(operation.path);
      else await fs.rm(operation.path, { recursive: true, force: false });
      releasedBytes += operation.bytes;
      deleted += 1;
    } catch (error) {
      if (operation.action === "legacy" && /^\.packaging/.test(path.basename(operation.path)) && ["EBUSY", "EPERM"].includes(error?.code)) {
        console.warn(`[跳过：被系统进程占用] ${repoRelative(operation.path)}`);
        continue;
      }
      throw error;
    }
  }
  console.log(`实际完成: 删除 ${deleted} 个目标，按删除前大小估算释放 ${formatBytes(releasedBytes)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
