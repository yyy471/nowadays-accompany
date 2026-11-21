#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendDir,
  localNode24Exe,
  repoRoot,
  rendererDir,
  rootTestResultsDir,
  toolsDir,
} from "./repo-paths.mjs";

export function ensureToolsDirectories() {
  for (const directory of [
    path.join(toolsDir, "compile-cache"),
    path.join(toolsDir, "tsbuildinfo"),
    path.join(rootTestResultsDir, "desktop-e2e"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  ensureToolsDirectories();
  if (!fs.existsSync(localNode24Exe) && !process.env.NOWADAYS_NODE_PATH) {
    console.warn(`未找到项目 Node 24：${localNode24Exe}；将使用 PATH 中的 node。`);
  }
  console.log(`工具目录就绪：${path.relative(repoRoot, toolsDir)}`);
}
