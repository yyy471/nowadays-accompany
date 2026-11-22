#!/usr/bin/env node
/**
 * 仓库卫生巡检：落地 6 条防反弹护栏并拦住退役目录与跟踪产物回流：
 * 1. hygiene/root-allowlist：根目录已跟踪顶层目录仅允许 apps、docs、scripts、tools；
 * 2. hygiene/no-js-dts-pairs：apps/desktop/renderer/src/ 禁止 .js + .d.ts 配对；
 * 3. hygiene/test-naming：apps/backend/tests/ 禁止 p\d+- 或 202\d{5}- 前缀命名；
 * 4. hygiene/no-legacy-refs：代码、脚本与现行文档禁止残留旧路径硬编码（docs/archive/ 保留历史）；
 * 5. hygiene/no-large-tracked-blobs：禁止跟踪非资产白名单目录的 > 2 MB 文件；
 * 6. hygiene/file-size-budget：超过 100 KB 的源码单文件温和告警。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./repo-paths.mjs";

const errors = [];
const warnings = [];

const RETIRED_ROOTS = ["backend", "desktop", "devDoc", "prototypes"];
for (const name of RETIRED_ROOTS) {
  if (fs.existsSync(path.join(repoRoot, name))) {
    errors.push(`退役目录回流：${name}/（应位于 apps/ 或 docs/ 下）`);
  }
}

for (const name of fs.readdirSync(repoRoot)) {
  if (/^\.packaging/.test(name)) warnings.push(`本地打包临时目录：${name}/（已被忽略，可手动清理）`);
}

function gitLsFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`GIT_LS_FILES_FAILED:${result.stderr ?? ""}`);
  return result.stdout.split("\0").filter(Boolean);
}

const ROOT_DIR_ALLOWLIST = new Set(["apps", "docs", "scripts", "tools"]);
const LARGE_BLOB_LIMIT = 2 * 1024 * 1024;
const LARGE_BLOB_ALLOWLIST = [
  "apps/backend/assets/",
  "apps/desktop/renderer/src/assets/",
  "apps/desktop/assets/",
  "tools/art-pipeline/source/",
];
const SOURCE_SIZE_BUDGET = 100 * 1024;
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/;

const tracked = gitLsFiles();
for (const file of tracked) {
  if (file.includes("/")) {
    const topDir = file.split("/")[0];
    if (!ROOT_DIR_ALLOWLIST.has(topDir)) {
      errors.push(`[hygiene/root-allowlist] 根目录不允许出现非白名单已跟踪目录：${topDir}/ (${file})`);
    }
  }
  if (/(^|\/)(node_modules|dist|test-results|release)\//.test(file)) {
    errors.push(`构建/运行产物被跟踪：${file}`);
  }
  if (/\.(log|tsbuildinfo)$/.test(file) || /\.stackdump$/.test(file)) {
    errors.push(`日志或编译缓存被跟踪：${file}`);
  }
  const fullPath = path.join(repoRoot, file);
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      if (stat.size > LARGE_BLOB_LIMIT && !LARGE_BLOB_ALLOWLIST.some((prefix) => file.startsWith(prefix))) {
        errors.push(`[hygiene/no-large-tracked-blobs] 非资产白名单大文件被跟踪：${file} (${(stat.size / 1048576).toFixed(2)} MB)`);
      }
      if (SOURCE_EXTENSIONS.test(file) && stat.size > SOURCE_SIZE_BUDGET) {
        warnings.push(`[hygiene/file-size-budget] 超大源码单文件：${file} (${(stat.size / 1024).toFixed(1)} KB > 100 KB)`);
      }
    }
  }
}
for (const target of ["test-results", ".tools", "node_modules"]) {
  if (tracked.some((file) => file === target || file.startsWith(`${target}/`))) {
    errors.push(`忽略目录被跟踪：${target}/`);
  }
}

function walk(directory, out = []) {
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", "test-results"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// 规则 2：apps/desktop/renderer/src/ 禁止任何 .js + .d.ts 配对。
const JS_DTS_BASELINE = new Set([]);
const rendererSource = path.join(repoRoot, "apps", "desktop", "renderer", "src");
const pairs = new Set();
for (const file of walk(rendererSource)) {
  if (!file.endsWith(".js")) continue;
  const declaration = file.replace(/\.js$/, ".d.ts");
  if (!fs.existsSync(declaration)) continue;
  pairs.add(path.relative(rendererSource, file.slice(0, -3)).split(path.sep).join("/"));
}
for (const pair of pairs) {
  if (!JS_DTS_BASELINE.has(pair)) {
    errors.push(`[hygiene/no-js-dts-pairs] 存在 JS/.d.ts 配对：renderer/src/${pair}.js（请直接写 .ts）`);
  }
}
for (const pair of JS_DTS_BASELINE) {
  if (!pairs.has(pair)) warnings.push(`已合并或移除的配对可从基线删除：renderer/src/${pair}.js`);
}

// 规则 3：apps/backend/tests/ 禁止再出现 p\d+- 或 202\d{5}- 前缀命名。
const BAD_TEST_PREFIX_RE = /^(p\d+-|202\d{5}-)/;
const backendTestsDir = path.join(repoRoot, "apps", "backend", "tests");
const backendTestNamesChecked = new Set();
for (const file of walk(backendTestsDir)) {
  const rel = path.relative(repoRoot, file).split(path.sep).join("/");
  backendTestNamesChecked.add(rel);
  if (BAD_TEST_PREFIX_RE.test(path.basename(file))) {
    errors.push(`[hygiene/test-naming] 后端测试禁止流水号/日期前缀：${rel}`);
  }
}
for (const file of tracked) {
  if (!file.startsWith("apps/backend/tests/") || backendTestNamesChecked.has(file)) continue;
  if (BAD_TEST_PREFIX_RE.test(path.posix.basename(file))) {
    errors.push(`[hygiene/test-naming] 后端测试禁止流水号/日期前缀：${file}`);
  }
}

// 规则 4：代码、脚本与现行文档禁止残留旧路径硬编码。
const LEGACY_REFERENCES = [
  { pattern: /prototypes\/p0\/\.runtime/g, label: "prototypes/p0/.runtime" },
  {
    pattern: /desktop[\/\\]desk-preview|\[desk-preview\]|['"`]desk-preview['"`]|(^|[^A-Za-z0-9_\-])desk-preview\//g,
    label: "desk-preview",
  },
  { pattern: /(^|[^A-Za-z0-9_\-/])devDoc\//g, label: "devDoc/" },
  { pattern: /(^|[^A-Za-z0-9_\-/])prototypes\//g, label: "prototypes/" },
];
const TEXT_EXTENSIONS = /\.(cjs|mjs|js|ts|tsx|json|md|yml|yaml|py|ps1|sh)$/;
const SCAN_ROOTS = [
  "apps",
  "scripts",
  "tools",
  "docs/specs",
  "docs/design/character-studio/tokens.json",
  "docs/README.md",
  "docs/STATUS.md",
  "README.md",
  "AGENTS.md",
  "package.json",
];
const SCAN_FILES = SCAN_ROOTS.map((entry) => path.join(repoRoot, entry)).filter((entry) => fs.existsSync(entry));
// 迁移与清理工具本身必须写下旧路径才能工作，不参与旧路径扫描。
const SKIP_SCAN = new Set([
  "scripts/check-repo-hygiene.mjs",
  "scripts/clean-artifacts.mjs",
  "scripts/rewrite-doc-links.mjs",
  "scripts/check-docs.mjs",
]);

function textFiles(entry) {
  const stat = fs.statSync(entry);
  if (stat.isFile()) return TEXT_EXTENSIONS.test(entry) ? [entry] : [];
  return walk(entry).filter((file) => TEXT_EXTENSIONS.test(file));
}

for (const file of SCAN_FILES.flatMap(textFiles)) {
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  if (SKIP_SCAN.has(relative)) continue;
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of LEGACY_REFERENCES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        errors.push(`[hygiene/no-legacy-refs] ${relative}:${index + 1} 仍引用旧路径 ${rule.label}`);
      }
    }
  }
}

for (const warning of warnings) console.warn(`[WARN] ${warning}`);
for (const error of errors) console.error(`[ERR]  ${error}`);
console.log(`仓库卫生巡检：跟踪文件 ${tracked.length} 个，JS/声明配对 ${pairs.size} 组，错误 ${errors.length}，警告 ${warnings.length}`);
if (errors.length) process.exit(1);
