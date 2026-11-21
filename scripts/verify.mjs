#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendDir,
  docsDir,
  localNode24Exe,
  rendererDir,
  repoRoot,
  rootTestResultsDir,
  toolsDir,
} from "./repo-paths.mjs";
import { ensureToolsDirectories } from "./ensure-tools.mjs";

const self = fileURLToPath(import.meta.url);
const desktopDir = path.join(repoRoot, "desktop", "desk-preview");
const compileCache = path.join(toolsDir, "compile-cache");
const baseEnv = {
  ...process.env,
  NODE_COMPILE_CACHE: compileCache,
  NO_COLOR: "1",
};

function runNode24OrExit() {
  if (Number(process.versions.node.split(".")[0]) >= 24) return;
  if (!fs.existsSync(localNode24Exe)) {
    console.error(`需要 Node 24：当前 ${process.version}，且未找到 ${localNode24Exe}`);
    process.exit(1);
  }
  const result = spawnSync(localNode24Exe, [self, ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: baseEnv,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
runNode24OrExit();
ensureToolsDirectories();

const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const concurrency = process.env.VERIFY_CONCURRENCY ?? "4";

function execText(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout : "";
}

function changedFiles() {
  const tracked = execText("git", ["diff", "--name-only", "-z", "--diff-filter=ACMRD", "HEAD"]);
  const untracked = execText("git", ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean))]
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
}

function backendTestFiles() {
  return fs.readdirSync(path.join(backendDir, "tests"))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => `tests/${file}`);
}

function targetedBackendTests(files) {
  const all = backendTestFiles();
  const directTests = files.filter((file) => /^backend\/tests\/[^/]+\.test\.ts$/.test(file))
    .map((file) => file.slice("backend/".length));
  const source = files.filter((file) => file.startsWith("backend/src/"));
  if (source.length === 0) {
    if (directTests.length) return directTests;
    // 验收脚本、reviews 或共享配置改动无法由文件名推断覆盖面，回退全量。
    if (files.some((file) => file.startsWith("backend/scripts/") || file.startsWith("backend/reviews/"))) return all;
    return [];
  }
  const pick = (...names) => names.filter((name) => all.includes(name));
  const targets = new Set();
  for (const file of source) {
    const relative = file.slice("backend/src/".length);
    if (relative.startsWith("mcp/")) {
      for (const test of pick("tests/p2-04-mcp.test.ts", "tests/p2-05-mcp.test.ts")) targets.add(test);
    } else if (relative.startsWith("skills/")) {
      for (const test of pick("tests/p2-04-skill.test.ts", "tests/p2-05-skill.test.ts", "tests/p5-skill-run.test.ts")) targets.add(test);
    } else if (relative.startsWith("tts/")) {
      for (const test of pick("tests/p8-voice.test.ts", "tests/p9-tts-engines-emotion.test.ts", "tests/p9-tts-unified.test.ts")) targets.add(test);
    } else if (relative.startsWith("scene/")) {
      for (const test of pick("tests/p10-auto-scene.test.ts", "tests/p10-scene-image.test.ts", "tests/p11-scene-image-planning.test.ts")) targets.add(test);
    } else if (relative.startsWith("model/")) {
      for (const test of pick("tests/model-providers.test.ts", "tests/p2-04-model.test.ts", "tests/p2-04-google-gemini.test.ts", "tests/p2-05-stream.test.ts")) targets.add(test);
    } else {
      // bootstrap/storage/application/http/domain/security 等共享层改动无法可靠局部化，升级全量。
      return all;
    }
  }
  // 改动测试自身与共享源码同时出现时，至少覆盖被改测试。
  for (const test of directTests) targets.add(test);
  return targets.size ? [...targets].sort() : all;
}

const commands = {
  docs() {
    return { name: "docs", cmd: process.execPath, args: [path.join(repoRoot, "scripts", "check-docs.mjs")] };
  },
  backendTypecheck() {
    return {
      name: "backend-typecheck",
      cmd: process.execPath,
      args: [path.join(backendDir, "node_modules", "typescript", "bin", "tsc"), "--noEmit"],
      cwd: backendDir,
    };
  },
  backendTests(tests = backendTestFiles()) {
    return {
      name: tests.length === backendTestFiles().length ? "backend-tests" : `backend-tests:${tests.length}`,
      cmd: process.execPath,
      args: ["--import", "tsx", "--test", `--test-concurrency=${process.env.ACCEPT_TEST_CONCURRENCY ?? "8"}`, ...tests],
      cwd: backendDir,
    };
  },
  rendererCheck() {
    return { name: "renderer-check", cmd: process.execPath, args: [npmCli, "run", "check"], cwd: rendererDir };
  },
  rendererBuild() {
    return { name: "renderer-build", cmd: process.execPath, args: [npmCli, "run", "build"], cwd: rendererDir };
  },
  desktopTests() {
    const tests = fs.readdirSync(path.join(desktopDir, "tests"))
      .filter((file) => file.endsWith(".test.cjs"))
      .sort()
      .map((file) => `tests/${file}`);
    return { name: "desktop-tests", cmd: process.execPath, args: ["--test", ...tests], cwd: desktopDir };
  },
  feedIntegration() {
    return {
      name: "feed-integration",
      cmd: process.execPath,
      args: ["--import", "tsx", "--test", "tests/feed-integration.test.ts"],
      cwd: desktopDir,
    };
  },
  acceptance() {
    return {
      name: "accept-offline",
      cmd: process.execPath,
      args: ["scripts/accept-offline.mjs"],
      cwd: backendDir,
    };
  },
  e2e(args = []) {
    return {
      name: "desktop-e2e",
      cmd: process.execPath,
      args: ["tests/run-e2e.cjs", ...args],
      cwd: desktopDir,
    };
  },
};

function formatCommand(command) {
  return [path.basename(command.cmd), ...command.args].join(" ");
}

function run(command) {
  const started = Date.now();
  console.log(`\n[verify] ${command.name}: ${formatCommand(command)}`);
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, {
      cwd: command.cwd ?? repoRoot,
      env: baseEnv,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      console.error(`[verify] ${command.name} 启动失败: ${error.message}`);
      resolve({ ...command, passed: false, ms: Date.now() - started });
    });
    child.once("close", (code, signal) => {
      const passed = code === 0;
      console.log(`[verify] ${command.name} ${passed ? "PASS" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s${signal ? `, ${signal}` : ""})`);
      resolve({ ...command, passed, ms: Date.now() - started });
    });
  });
}

async function runParallel(commandList) {
  const results = [];
  let next = 0;
  const limit = Math.max(1, Number(concurrency));
  async function worker() {
    while (next < commandList.length) {
      const command = commandList[next];
      next += 1;
      results.push(await run(command));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, commandList.length) }, worker));
  return results.sort((left, right) => commandList.findIndex((item) => item.name === left.name) - commandList.findIndex((item) => item.name === right.name));
}

async function fastCommands(files) {
  if (files.length === 0) return [commands.docs(), commands.backendTypecheck(), commands.rendererCheck(), commands.desktopTests()];
  const list = [commands.docs()];
  const backendChanged = files.some((file) =>
    file.startsWith("backend/") || file === "scripts/repo-paths.mjs" || file === "scripts/ensure-tools.mjs");
  const rendererChanged = files.some((file) => file.startsWith("desktop/desk-preview/renderer/"));
  const desktopChanged = files.some((file) =>
    file.startsWith("desktop/desk-preview/tests/") || [
      "desktop/desk-preview/main.cjs",
      "desktop/desk-preview/backend-paths.cjs",
      "desktop/desk-preview/settings-preload.cjs",
    ].includes(file));
  if (backendChanged) {
    list.push(commands.backendTypecheck());
    const tests = targetedBackendTests(files);
    if (tests.length) list.push(commands.backendTests(tests));
  }
  if (rendererChanged) list.push(commands.rendererCheck());
  if (desktopChanged || rendererChanged) list.push(commands.desktopTests());
  return list;
}

async function unitCommands() {
  return runParallel([
    commands.docs(),
    commands.backendTypecheck(),
    commands.backendTests(),
    commands.rendererCheck(),
    commands.rendererBuild(),
    commands.desktopTests(),
    commands.feedIntegration(),
  ]);
}

async function gateCommands() {
  const first = [];
  for (const command of [commands.rendererCheck(), commands.rendererBuild()]) {
    const result = await run(command);
    first.push(result);
    if (!result.passed) return first;
  }
  const parallel = await runParallel([
    commands.acceptance(),
    commands.desktopTests(),
    commands.feedIntegration(),
    commands.docs(),
  ]);
  const e2e = await run(commands.e2e());
  return [...first, ...parallel, e2e];
}

const args = process.argv.slice(2);
const mode = args[0] ?? "gate";
if (!["fast", "unit", "gate", "e2e", "changed"].includes(mode)) {
  console.error("用法: node scripts/verify.mjs <fast|unit|gate|e2e|changed> [--filter <关键字>]");
  process.exit(2);
}

let results;
if (mode === "changed") {
  const files = changedFiles();
  console.log(files.length ? files.join("\n") : "（无工作区改动）");
  process.exit(0);
} else if (mode === "e2e") {
  results = [await run(commands.rendererBuild()), await run(commands.e2e(args.slice(1)))];
} else if (mode === "fast") {
  results = await runParallel(await fastCommands(changedFiles()));
} else if (mode === "unit") {
  results = await unitCommands();
} else {
  results = await gateCommands();
}

const failed = results.filter((item) => !item.passed);
const total = (results.reduce((sum, item) => sum + item.ms, 0) / 1000).toFixed(1);
console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过，累计 ${total}s`);
if (failed.length) {
  console.error(`[verify] 失败: ${failed.map((item) => item.name).join(", ")}`);
  process.exit(1);
}
