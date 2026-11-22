#!/usr/bin/env node
/**
 * 仓库卫生巡检：拦住已退役目录回流、被误提交的构建产物、新增的 JS/声明配对，
 * 以及代码与现行文档中指向旧结构的硬编码路径。
 * 历史归档（docs/archive/）保留当时路径，不参与旧路径检查。
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

const tracked = gitLsFiles();
for (const file of tracked) {
  if (/(^|\/)(node_modules|dist|test-results|release)\//.test(file)) {
    errors.push(`构建/运行产物被跟踪：${file}`);
  }
  if (/\.(log|tsbuildinfo)$/.test(file) || /\.stackdump$/.test(file)) {
    errors.push(`日志或编译缓存被跟踪：${file}`);
  }
}
for (const target of ["test-results", ".tools", "node_modules"]) {
  if (tracked.some((file) => file === target || file.startsWith(`${target}/`))) {
    errors.push(`忽略目录被跟踪：${target}/`);
  }
}

// 前端保留 24 个既有 JS 模块的声明配对；新增必须直接写 .ts，不再扩大配对数量。
const JS_DTS_BASELINE = new Set([
  "appearance-import",
  "components/appearance/preset-lock",
  "components/config/config-texts",
  "components/config/summary",
  "components/image/image-cache",
  "components/model/binding-merge",
  "components/model/model-cache",
  "components/model/model-picker",
  "components/voice/voice-cache",
  "conversation/advance",
  "conversation/history",
  "conversation/performance",
  "conversation/task-actions",
  "conversation/typing-state",
  "conversation/window-model",
  "entry/role-entry",
  "image-config",
  "outfit-display",
  "relations/dossier",
  "relations/fold-marks",
  "state-version",
  "token-usage",
  "voice-config",
]);

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", "test-results"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rendererSource = path.join(repoRoot, "apps", "desktop", "renderer", "src");
const pairs = new Set();
for (const file of walk(rendererSource)) {
  if (!file.endsWith(".js")) continue;
  const declaration = file.replace(/\.js$/, ".d.ts");
  if (!fs.existsSync(declaration)) continue;
  pairs.add(path.relative(rendererSource, file.slice(0, -3)).split(path.sep).join("/"));
}
for (const pair of pairs) {
  if (!JS_DTS_BASELINE.has(pair)) errors.push(`新增 JS/.d.ts 配对：renderer/src/${pair}.js（请直接写 .ts）`);
}
for (const pair of JS_DTS_BASELINE) {
  if (!pairs.has(pair)) warnings.push(`已合并或移除的配对可从基线删除：renderer/src/${pair}.js`);
}

const LEGACY_REFERENCES = [
  { pattern: /desktop\/desk-preview/g, label: "desktop/desk-preview" },
  { pattern: /(^|[^A-Za-z0-9_\-/])devDoc\//g, label: "devDoc/" },
  { pattern: /(^|[^A-Za-z0-9_\-/])prototypes\//g, label: "prototypes/" },
];
const TEXT_EXTENSIONS = /\.(cjs|mjs|js|ts|tsx|json|md|yml|yaml|py|ps1|sh)$/;
const SCAN_ROOTS = ["apps", "scripts", "docs/specs", "docs/README.md", "docs/STATUS.md", "README.md", "AGENTS.md"];
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
        errors.push(`${path.relative(repoRoot, file)}:${index + 1} 仍引用旧路径 ${rule.label}`);
      }
    }
  }
}

for (const warning of warnings) console.warn(`[WARN] ${warning}`);
for (const error of errors) console.error(`[ERR]  ${error}`);
console.log(`仓库卫生巡检：跟踪文件 ${tracked.length} 个，JS/声明配对 ${pairs.size} 组，错误 ${errors.length}，警告 ${warnings.length}`);
if (errors.length) process.exit(1);
