#!/usr/bin/env node
/**
 * 递归扫描 apps/backend/tests/{unit,integration}/ 按 LPT（大文件优先）顺序执行全部正式单测，
 * 并校验最少文件数与最低通过用例数，防止分目录后静默漏跑或长尾拖慢并发池。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectBackendTestFiles,
  MIN_BACKEND_TEST_FILES,
  readTestTotals,
} from "./acceptance-lib.mjs";

const self = fileURLToPath(import.meta.url);
const backend = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const localNode24Exe = path.join(repoRoot, ".tools", "node-v24", "node.exe");
const compileCache = path.join(repoRoot, ".tools", "compile-cache");
const MIN_BACKEND_TESTS = 551;

fs.mkdirSync(compileCache, { recursive: true });

if (Number(process.versions.node.split(".")[0]) < 24) {
  if (!fs.existsSync(localNode24Exe)) {
    console.error(`需要 Node 24：当前 ${process.version}，且未找到 ${localNode24Exe}`);
    process.exit(1);
  }
  const result = spawnSync(localNode24Exe, [self, ...process.argv.slice(2)], {
    cwd: backend,
    env: { ...process.env, NODE_COMPILE_CACHE: compileCache, NO_COLOR: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const concurrencyFlag = args.find((arg) => arg.startsWith("--test-concurrency="));
const defaultConcurrency = String(Math.min(16, Math.max(8, Math.floor(os.availableParallelism() / 2))));
const rawConcurrency = concurrencyFlag
  ? concurrencyFlag.slice("--test-concurrency=".length)
  : (process.env.ACCEPT_TEST_CONCURRENCY ?? defaultConcurrency);
const concurrency = Number(rawConcurrency);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  console.error(`非法测试并发度：${rawConcurrency}`);
  process.exit(2);
}
const useFsGuard = args.includes("--fs-guard");
const filters = args.filter(
  (arg) => !arg.startsWith("--test-concurrency=") && arg !== "--fs-guard" && arg !== "--",
);

const allFiles = collectBackendTestFiles(path.join(backend, "tests"), {
  baseDir: backend,
  minFiles: MIN_BACKEND_TEST_FILES,
  order: "lpt",
});
const selected = filters.length
  ? allFiles.filter((file) => filters.some((kw) => file.toLowerCase().includes(kw.toLowerCase())))
  : allFiles;

if (selected.length === 0) {
  console.error(`未匹配到包含 [${filters.join(", ")}] 的后端测试文件`);
  process.exit(2);
}

process.chdir(backend);
process.env.NODE_COMPILE_CACHE = compileCache;
process.env.NO_COLOR = "1";

const execArgv = [
  ...(useFsGuard ? ["--import", pathToFileURL(path.join(backend, "scripts", "verify", "fs-guard.mjs")).href] : []),
  "--import",
  "tsx",
];

let hadFailure = false;
let stdout = "";
const stream = run({
  files: selected.map((file) => path.resolve(backend, file)),
  concurrency,
  isolation: "process",
  execArgv,
});
stream.on("test:fail", () => {
  hadFailure = true;
});

for await (const chunk of stream.compose(tap)) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  stdout += text;
  process.stdout.write(text);
}

if (hadFailure) {
  process.exit(1);
}
if (filters.length === 0) {
  try {
    readTestTotals(stdout, { minTests: MIN_BACKEND_TESTS });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
process.exit(0);
