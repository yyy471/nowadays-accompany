#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendDir,
  docsDir,
  localNode24Exe,
  piMcpDir,
  rendererDir,
  repoRoot,
  toolsDir,
} from "./repo-paths.mjs";
import { ensureToolsDirectories } from "./ensure-tools.mjs";

const self = fileURLToPath(import.meta.url);
const desktopDir = path.join(repoRoot, "apps", "desktop");
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

function walkFiles(directory, suffix, base = directory) {
  if (!fs.existsSync(directory)) return [];
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "fixtures", "acceptance"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, suffix, base));
    else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(path.relative(base, full).replaceAll("\\", "/"));
    }
  }
  return out.sort();
}

function backendTestFiles() {
  return walkFiles(path.join(backendDir, "tests"), ".test.ts", backendDir);
}

function backendEvalTestFiles() {
  return walkFiles(path.join(backendDir, "scripts", "eval"), ".test.mjs", backendDir);
}

function desktopUnitTestFiles() {
  return walkFiles(path.join(desktopDir, "tests", "unit"), ".test.cjs", desktopDir);
}

function rendererUnitTestFiles() {
  return walkFiles(path.join(rendererDir, "tests"), ".test.ts", rendererDir);
}

function piTestFiles() {
  return walkFiles(path.join(piMcpDir, "test"), ".test.mjs", piMcpDir);
}

function targetedBackendTests(files) {
  const all = backendTestFiles();
  if (files.includes("package.json")) return all;
  const directTests = files
    .filter((file) => file.startsWith("apps/backend/tests/") && file.endsWith(".test.ts") && !file.startsWith("apps/backend/tests/acceptance/"))
    .map((file) => file.slice("apps/backend/".length));
  const nonTestBackendInfra = files.some((file) =>
    file === "apps/backend/package.json" ||
    file === "apps/backend/tsconfig.json" ||
    file === "scripts/repo-paths.mjs" ||
    file === "scripts/ensure-tools.mjs" ||
    file.startsWith("apps/backend/examples/") ||
    file.startsWith("apps/backend/scripts/") ||
    file.startsWith("apps/backend/tests/acceptance/") ||
    (file.startsWith("apps/backend/tests/") && !file.endsWith(".test.ts")),
  );
  if (nonTestBackendInfra) return all;

  const source = files.filter((file) => file.startsWith("apps/backend/src/"));
  if (source.length === 0) return directTests;

  const pick = (...names) => names.filter((name) => all.includes(name));
  const targets = new Set();
  for (const file of source) {
    const relative = file.slice("apps/backend/src/".length);
    if (relative.startsWith("mcp/")) {
      for (const test of pick("tests/unit/mcp-local.test.ts", "tests/integration/mcp-execution.test.ts")) targets.add(test);
    } else if (relative.startsWith("skills/")) {
      for (const test of pick("tests/unit/skill-library.test.ts", "tests/integration/skill-execution.test.ts", "tests/integration/skill-run.test.ts")) targets.add(test);
    } else if (relative.startsWith("tts/")) {
      for (const test of pick("tests/integration/voice-tts.test.ts", "tests/unit/tts-engines-emotion.test.ts", "tests/integration/tts-unified.test.ts")) targets.add(test);
    } else if (relative.startsWith("scene/")) {
      for (const test of pick("tests/integration/scene-image-auto.test.ts", "tests/integration/scene-image-core.test.ts", "tests/integration/scene-image-planning.test.ts")) targets.add(test);
    } else if (relative.startsWith("model/")) {
      for (const test of pick("tests/unit/model-providers.test.ts", "tests/unit/model-protocols.test.ts", "tests/unit/google-gemini.test.ts", "tests/integration/model-stream.test.ts")) targets.add(test);
    } else {
      // bootstrap/storage/application/http/domain/security 等共享层改动无法可靠局部化，升级全量。
      return all;
    }
  }
  for (const test of directTests) targets.add(test);
  return targets.size ? [...targets].sort() : all;
}

const commands = {
  docs() {
    return { name: "docs", cmd: process.execPath, args: [path.join(repoRoot, "scripts", "check-docs.mjs")] };
  },
  hygiene() {
    return { name: "hygiene", cmd: process.execPath, args: [path.join(repoRoot, "scripts", "check-repo-hygiene.mjs")] };
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
    const allCount = backendTestFiles().length;
    const defaultConcurrency = String(Math.min(16, Math.max(8, Math.floor(os.availableParallelism() / 2))));
    const concurrencyArg = `--test-concurrency=${process.env.ACCEPT_TEST_CONCURRENCY ?? defaultConcurrency}`;
    if (tests.length === allCount) {
      return {
        name: "backend-tests",
        cmd: process.execPath,
        args: [path.join(backendDir, "scripts", "verify", "run-tests.mjs"), concurrencyArg],
        cwd: backendDir,
      };
    }
    return {
      name: `backend-tests:${tests.length}`,
      cmd: process.execPath,
      args: ["--import", "tsx", "--test", concurrencyArg, ...tests],
      cwd: backendDir,
    };
  },
  rendererCheck() {
    return { name: "renderer-check", cmd: process.execPath, args: [npmCli, "run", "check"], cwd: rendererDir };
  },
  rendererBuild() {
    return { name: "renderer-build", cmd: process.execPath, args: [npmCli, "run", "build"], cwd: rendererDir };
  },
  desktopTests(tests = desktopUnitTestFiles()) {
    const allCount = desktopUnitTestFiles().length;
    return {
      name: tests.length === allCount ? "desktop-tests" : `desktop-tests:${tests.length}`,
      cmd: process.execPath,
      args: ["--test", ...tests],
      cwd: desktopDir,
    };
  },
  rendererTests(tests = rendererUnitTestFiles()) {
    const allCount = rendererUnitTestFiles().length;
    return {
      name: tests.length === allCount ? "renderer-tests" : `renderer-tests:${tests.length}`,
      cmd: process.execPath,
      args: ["--import", "../node_modules/tsx/dist/loader.mjs", "--test", ...tests],
      cwd: rendererDir,
    };
  },
  piTests(tests = piTestFiles()) {
    const allCount = piTestFiles().length;
    // Pi 子包生命周期与进程树清理用例必须串行运行，避免并发子进程互相干扰残留检查。
    return {
      name: tests.length === allCount ? "pi-tests" : `pi-tests:${tests.length}`,
      cmd: process.execPath,
      args: ["--test", "--test-concurrency=1", ...tests],
      cwd: piMcpDir,
    };
  },
  feedIntegration() {
    return {
      name: "feed-integration",
      cmd: process.execPath,
      args: ["--import", "tsx", "--test", "tests/integration/feed-integration.test.ts"],
      cwd: desktopDir,
    };
  },
  backendEvalTests(tests = backendEvalTestFiles()) {
    const allCount = backendEvalTestFiles().length;
    return {
      name: tests.length === allCount ? "backend-eval-tests" : `backend-eval-tests:${tests.length}`,
      cmd: process.execPath,
      args: ["--import", "tsx", "--test", ...tests],
      cwd: backendDir,
    };
  },
  acceptance() {
    const script = fs.existsSync(path.join(backendDir, "scripts", "verify", "accept-offline.mjs"))
      ? "scripts/verify/accept-offline.mjs"
      : "scripts/accept-offline.mjs";
    return {
      name: "accept-offline",
      cmd: process.execPath,
      args: [script],
      cwd: backendDir,
    };
  },
  e2e(args = []) {
    return {
      name: "desktop-e2e",
      cmd: process.execPath,
      args: ["tests/helpers/run-e2e.cjs", ...args],
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

function filterByKeywords(candidates, keywords) {
  const lower = keywords.map((k) => k.toLowerCase());
  return candidates.filter((file) => lower.some((k) => file.toLowerCase().includes(k)));
}

async function fastCommands(files, keywords = []) {
  if (keywords.length > 0) {
    const backendMatches = filterByKeywords(backendTestFiles(), keywords);
    const evalMatches = filterByKeywords(backendEvalTestFiles(), keywords);
    const piMatches = filterByKeywords(piTestFiles(), keywords);
    const desktopMatches = filterByKeywords(desktopUnitTestFiles(), keywords);
    const rendererMatches = filterByKeywords(rendererUnitTestFiles(), keywords);
    const list = [commands.docs(), commands.hygiene(), commands.backendTypecheck(), commands.rendererCheck()];
    if (backendMatches.length > 0) list.push(commands.backendTests(backendMatches));
    if (evalMatches.length > 0) list.push(commands.backendEvalTests(evalMatches));
    if (piMatches.length > 0) list.push(commands.piTests(piMatches));
    if (desktopMatches.length > 0) list.push(commands.desktopTests(desktopMatches));
    if (rendererMatches.length > 0) list.push(commands.rendererTests(rendererMatches));
    if (backendMatches.length === 0 && evalMatches.length === 0 && piMatches.length === 0 && desktopMatches.length === 0 && rendererMatches.length === 0) {
      console.error(`[verify] 未匹配到包含关键字 [${keywords.join(", ")}] 的单测文件`);
      process.exit(2);
    }
    return list;
  }

  if (files.length === 0) {
    return [commands.docs(), commands.hygiene(), commands.backendTypecheck(), commands.backendEvalTests(), commands.piTests(), commands.rendererCheck(), commands.desktopTests(), commands.rendererTests()];
  }
  const list = [commands.docs(), commands.hygiene()];
  const rootInfraChanged = files.some((file) => ["package.json", "scripts/repo-paths.mjs", "scripts/ensure-tools.mjs"].includes(file));
  const backendChanged = rootInfraChanged || files.some((file) => file.startsWith("apps/backend/"));
  const piChanged = rootInfraChanged || files.some((file) => file.startsWith("apps/pi-mcp/"));
  const rendererChanged = rootInfraChanged || files.some((file) =>
    file.startsWith("apps/desktop/renderer/") ||
    file.startsWith("apps/desktop/scripts/") ||
    file === "docs/design/character-studio/tokens.json",
  );
  const desktopChanged = rootInfraChanged || files.some((file) =>
    file === "apps/desktop/package.json" ||
    file.startsWith("apps/desktop/scripts/") ||
    file.startsWith("apps/desktop/tests/") ||
    file.startsWith("apps/desktop/electron/") ||
    file === "docs/design/character-studio/tokens.json",
  );
  if (backendChanged) {
    list.push(commands.backendTypecheck());
    const tests = targetedBackendTests(files);
    if (tests.length) list.push(commands.backendTests(tests));
    if (rootInfraChanged || files.some((file) => file.startsWith("apps/backend/scripts/eval/"))) {
      list.push(commands.backendEvalTests());
    }
  }
  if (piChanged) {
    list.push(commands.piTests());
  }
  if (rendererChanged) {
    list.push(commands.rendererCheck());
    list.push(commands.rendererTests());
  }
  if (desktopChanged) list.push(commands.desktopTests());
  if (files.some((file) => file.startsWith("apps/desktop/tests/integration/") || file.startsWith("apps/desktop/renderer/src/feed/"))) {
    list.push(commands.feedIntegration());
  }
  return list;
}

async function unitCommands() {
  // 轻量与前端构建先并发跑完，再独占资源依次执行高并发后端单测与串行 Pi 子包测试，避免 CPU 争抢引起子进程超时。
  const quick = await runParallel([
    commands.docs(),
    commands.hygiene(),
    commands.backendTypecheck(),
    commands.backendEvalTests(),
    commands.rendererCheck(),
    commands.rendererBuild(),
    commands.desktopTests(),
    commands.rendererTests(),
    commands.feedIntegration(),
  ]);
  const backend = await run(commands.backendTests());
  const pi = await run(commands.piTests());
  return [...quick, backend, pi];
}

async function gateCommands() {
  // 前端校验/轻量检查/构建 与 后端离线验收 互不写同一目录，并行执行以缩短总墙钟；
  // Pi 子包串行测试与桌面 Electron E2E 在两者落定后独占 CPU 顺序执行，避免动画与进程树残留检查争时序。
  const frontendAndLight = (async () => {
    const preflight = await runParallel([
      commands.rendererCheck(),
      commands.docs(),
      commands.hygiene(),
      commands.backendEvalTests(),
      commands.desktopTests(),
      commands.rendererTests(),
      commands.feedIntegration(),
    ]);
    const checkPassed = preflight.find((result) => result.name === "renderer-check")?.passed === true;
    const build = checkPassed ? await run(commands.rendererBuild()) : null;
    return { preflight, build };
  })();
  const [{ preflight, build }, acceptance] = await Promise.all([
    frontendAndLight,
    run(commands.acceptance()),
  ]);
  const pi = await run(commands.piTests());
  const results = [...preflight, ...(build ? [build] : []), acceptance, pi];
  if (!build?.passed) return results;
  const e2e = await run(commands.e2e());
  return [...results, e2e];
}

const rawArgs = process.argv.slice(2);
const dashDash = rawArgs.indexOf("--");
const headArgs = dashDash >= 0 ? rawArgs.slice(0, dashDash) : rawArgs;
const tailKeywords = dashDash >= 0 ? rawArgs.slice(dashDash + 1).filter(Boolean) : [];
const mode = headArgs[0] ?? "gate";
if (!["fast", "unit", "gate", "e2e", "changed"].includes(mode)) {
  console.error("用法: node scripts/verify.mjs <fast|unit|gate|e2e|changed> [--filter <关键字> | -- <关键字...>]");
  process.exit(2);
}

const wallStarted = Date.now();
let results;
if (mode === "changed") {
  const files = changedFiles();
  console.log(files.length ? files.join("\n") : "（无工作区改动）");
  process.exit(0);
} else if (mode === "e2e") {
  results = [await run(commands.rendererBuild()), await run(commands.e2e(headArgs.slice(1)))];
} else if (mode === "fast") {
  const keywords = tailKeywords.length ? tailKeywords : headArgs.slice(1).filter((a) => a !== "--");
  results = await runParallel(await fastCommands(changedFiles(), keywords));
} else if (mode === "unit") {
  results = await unitCommands();
} else {
  results = await gateCommands();
}

const failed = results.filter((item) => !item.passed);
const wall = ((Date.now() - wallStarted) / 1000).toFixed(1);
const total = (results.reduce((sum, item) => sum + item.ms, 0) / 1000).toFixed(1);
console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过，墙钟 ${wall}s（子项累计 ${total}s）`);
if (failed.length) {
  console.error(`[verify] 失败: ${failed.map((item) => item.name).join(", ")}`);
  process.exit(1);
}
