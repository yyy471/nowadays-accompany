#!/usr/bin/env node
/**
 * 仓库迁移辅助：把历史文档中的路径与本地链接从旧布局重写到当前布局。
 * 仅处理相对链接与已知路径前缀，不动外部链接与页内锚点。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(root, "docs");

const TARGET_MOVES = [
  ["desktop/desk-preview/tools/", "tools/art-pipeline/"],
  ["desktop/desk-preview/", "apps/desktop/"],
  ["desktop/scripts/", "apps/desktop/scripts/"],
  ["backend/", "apps/backend/"],
  ["devDoc/", "docs/"],
];

function toOldDocPath(file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (rel.startsWith("docs/")) return `devDoc/${rel.slice("docs/".length)}`;
  if (rel.startsWith("apps/backend/")) return `backend/${rel.slice("apps/backend/".length)}`;
  if (rel.startsWith("apps/desktop/")) return `desktop/desk-preview/${rel.slice("apps/desktop/".length)}`;
  return rel;
}

function testTarget(name) {
  if (["electron-executable.cjs", "config-page-controls.cjs", "run-e2e.cjs"].includes(name)) {
    return `apps/desktop/tests/helpers/${name}`;
  }
  if (name === "feed-integration.test.ts") return "apps/desktop/tests/integration/feed-integration.test.ts";
  if (name.endsWith(".test.cjs")) return `apps/desktop/tests/unit/${name}`;
  if (name.endsWith("-check.cjs")) return `apps/desktop/tests/e2e/${name.slice(0, -"-check.cjs".length)}.e2e.cjs`;
  if (name === "relations-review-234.cjs") return "apps/desktop/tests/e2e/relations-review-234.e2e.cjs";
  if (name.endsWith(".mjs") || name.endsWith(".py")) return `apps/desktop/tests/live/${name}`;
  return null;
}

function mapTarget(oldTarget) {
  // 兼容已经做过一次前缀替换、但尚未进入分类子目录的链接。
  for (const prefix of ["desktop/desk-preview/tests/", "apps/desktop/tests/"]) {
    if (oldTarget.startsWith(prefix)) {
      const mapped = testTarget(oldTarget.slice(prefix.length));
      if (mapped) return mapped;
    }
  }
  if (oldTarget.startsWith("apps/desktop/")) {
    const name = oldTarget.slice("apps/desktop/".length);
    if (["main.cjs", "settings-preload.cjs", "backend-paths.cjs"].includes(name)) return `apps/desktop/electron/${name}`;
  }
  if (oldTarget.startsWith("desktop/desk-preview/tests/")) {
    const name = oldTarget.slice("desktop/desk-preview/tests/".length);
    const mapped = testTarget(name);
    if (mapped) return mapped;
  }
  if (["main.cjs", "settings-preload.cjs", "backend-paths.cjs"].includes(oldTarget.slice("desktop/desk-preview/".length))) {
    return `apps/desktop/electron/${oldTarget.slice("desktop/desk-preview/".length)}`;
  }
  if (oldTarget === "desktop/desk-preview/package.json") return "apps/desktop/package.json";
  if (oldTarget === "desktop/desk-preview/ART-GENERATION-GUIDE.md") return "apps/desktop/ART-GENERATION-GUIDE.md";
  for (const [from, to] of TARGET_MOVES) {
    if (oldTarget === from.slice(0, -1)) return to.slice(0, -1);
    if (oldTarget.startsWith(from)) return `${to}${oldTarget.slice(from.length)}`;
  }
  return oldTarget;
}

function rewriteLinks(file, text) {
  const oldDoc = path.join(root, toOldDocPath(file));
  const oldDir = path.dirname(oldDoc);
  const newDir = path.dirname(file);
  return text.replace(/(!?\[[^\]\n]*\]\()([^)\n]+)(\))/g, (whole, open, inner, close) => {
    const trimmed = inner.trim();
    if (!trimmed || /^(?:https?:|mailto:|#|file:)/i.test(trimmed) || trimmed.startsWith("<")) return whole;
    const hashIndex = trimmed.indexOf("#");
    const queryIndex = trimmed.indexOf("?");
    const cut = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? trimmed.length;
    const targetPart = trimmed.slice(0, cut);
    const suffix = trimmed.slice(cut);
    const lineMatch = /:\d+(?:-\d+)?$/.exec(targetPart);
    const lineSuffix = lineMatch ? lineMatch[0] : "";
    const pureTarget = lineMatch ? targetPart.slice(0, -lineSuffix.length) : targetPart;
    if (!pureTarget) return whole;
    const oldResolved = path.resolve(oldDir, pureTarget);
    const oldRelative = path.relative(root, oldResolved).split(path.sep).join("/");
    const mapped = mapTarget(oldRelative);
    if (mapped === oldRelative) return whole;
    const newResolved = path.resolve(root, mapped);
    // 已退役文件不制造“看似存在”的新路径；历史链接保留旧目标，由文档巡检白名单登记。
    if (!fs.existsSync(newResolved)) return whole;
    let relative = path.relative(newDir, newResolved).split(path.sep).join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    return `${open}${relative}${lineSuffix}${suffix}${close}`;
  });
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

const files = [
  ...walk(docsDir),
  path.join(root, "README.md"),
  path.join(root, "AGENTS.md"),
  path.join(root, "apps", "backend", "README.md"),
  path.join(root, "apps", "desktop", "ART-GENERATION-GUIDE.md"),
].filter((file) => fs.existsSync(file));
for (const file of files) {
  let text = fs.readFileSync(file, "utf8");
  const original = text;
  text = rewriteLinks(file, text);
  text = text
    .replace(/(?<![A-Za-z0-9_./-])desktop\/desk-preview\/tools\//g, "tools/art-pipeline/")
    .replace(/(?<![A-Za-z0-9_./-])desktop\/desk-preview\//g, "apps/desktop/")
    .replace(/(?<![A-Za-z0-9_./-])desktop\/scripts\//g, "apps/desktop/scripts/")
    .replace(/(?<![A-Za-z0-9_./-])backend\//g, "apps/backend/")
    .replace(/devDoc\//g, "docs/")
    .replace(/cd backend\b/g, "cd apps/backend")
    .replace(/Set-Location ([^\r\n]*?)\\backend\b/g, "Set-Location $1\\apps\\backend");
  if (text !== original) {
    fs.writeFileSync(file, text);
    console.log(path.relative(root, file));
  }
}
console.log(`已重写 ${files.length} 份 Markdown 的候选链接。`);
