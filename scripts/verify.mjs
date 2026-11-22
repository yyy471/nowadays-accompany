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

function desktopUnitTestFiles() {
  return walkFiles(path.join(desktopDir, "tests", "unit"), ".test.cjs", desktopDir);
}

function rendererUnitTestFiles() {
  return walkFiles(path.join(rendererDir, "tests"), ".test.ts", rendererDir);
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
    file.startsWith("apps/backend/reviews/") ||
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
      for (const test of pick("tests/p2-04-mcp.test.ts", "tests/p2-05-mcp.test.ts", "tests/unit/mcp-local.test.ts", "tests/integration/mcp-execution.test.ts")) targets.add(test);
    } else if (relative.startsWith("skills/")) {
      for (const test of pick("tests/p2-04-skill.test.ts", "tests/p2-05-skill.test.ts", "tests/p5-skill-run.test.ts", "tests/unit/skill-library.test.ts", "tests/integration/skill-execution.test.ts", "tests/integration/skill-run.test.ts")) targets.add(test);
    } else if (relative.startsWith("tts/")) {
      for (const test of pick("tests/p8-voice.test.ts", "tests/p9-tts-engines-emotion.test.ts", "tests/p9-tts-unified.test.ts", "tests/integration/voice-tts.test.ts", "tests/unit/tts-engines-emotion.test.ts", "tests/integration/tts-unified.test.ts")) targets.add(test);
    } else if (relative.startsWith("scene/")) {
      for (const test of pick("tests/p10-auto-scene.test.ts", "tests/p10-scene-image.test.ts", "tests/p11-scene-image-planning.test.ts", "tests/integration/scene-image-auto.test.ts", "tests/integration/scene-image-core.test.ts", "tests/integration/scene-image-planning.test.ts")) targets.add(test);
    } else if (relative.startsWith("model/")) {
      for (const test of pick("tests/model-providers.test.ts", "tests/p2-04-model.test.ts", "tests/p2-04-google-gemini.test.ts", "tests/p2-05-stream.test.ts", "tests/unit/model-providers.test.ts", "tests/unit/model-protocols.test.ts", "tests/unit/google-gemini.test.ts", "tests/integration/model-stream.test.ts")) targets.add(test);
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
    return {
      name: tests.length === allCount ? "backend-tests" : `backend-tests:${tests.length}`,
      cmd: process.execPath,
      args: ["--import", "tsx", "--test", `--test-concurrency=${process.env.ACCEPT_TEST_CONCURRENCY ?? "10"}`, ...tests],
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
  feedIntegration() {
    return {
      name: "feed-integration",
      cmd: process.execPath,
      args: ["--import", "tsx", "--test", "tests/integration/feed-integration.test.ts"],
      cwd: desktopDir,
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
    const desktopMatches = filterByKeywords(desktopUnitTestFiles(), keywords);
    const rendererMatches = filterByKeywords(rendererUnitTestFiles(), keywords);
    const list = [commands.docs(), commands.hygiene(), commands.backendTypecheck(), commands.rendererCheck()];
    if (backendMatches.length > 0) list.push(commands.backendTests(backendMatches));
    if (desktopMatches.length > 0) list.push(commands.desktopTests(desktopMatches));
    if (rendererMatches.length > 0) list.push(commands.rendererTests(rendererMatches));
    if (backendMatches.length === 0 && desktopMatches.length === 0 && rendererMatches.length === 0) {
      console.error(`[verify] 未匹配到包含关键字 [${keywords.join(", ")}] 的单测文件`);
      process.exit(2);
    }
    return list;
  }

  if (files.length === 0) {
    return [commands.docs(), commands.hygiene(), commands.backendTypecheck(), commands.rendererCheck(), commands.desktopTests(), commands.rendererTests()];
  }
  const list = [commands.docs(), commands.hygiene()];
  const rootInfraChanged = files.some((file) => ["package.json", "scripts/repo-paths.mjs", "scripts/ensure-tools.mjs"].includes(file));
  const backendChanged = rootInfraChanged || files.some((file) => file.startsWith("apps/backend/"));
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
  // 轻量与前端构建先并发跑完，再独占资源执行 8 并发后端全量单测，避免 CPU 争抢引起子进程启动超时。
  const quick = await runParallel([
    commands.docs(),
    commands.hygiene(),
    commands.backendTypecheck(),
    commands.rendererCheck(),
    commands.rendererBuild(),
    commands.desktopTests(),
    commands.rendererTests(),
    commands.feedIntegration(),
  ]);
  const backend = await run(commands.backendTests());
  return [...quick, backend];
}

async function gateCommands() {
  const first = [];
  for (const command of [commands.rendererCheck(), commands.rendererBuild()]) {
    const result = await run(command);
    first.push(result);
    if (!result.passed) return first;
  }
  // 离线验收自身已按 Stage A/B/C 并发跑满，其余轻量桌面检查先并发或随同执行，避免过多进程争抢。
  const light = await runParallel([
    commands.docs(),
    commands.hygiene(),
    commands.desktopTests(),
    commands.rendererTests(),
    commands.feedIntegration(),
  ]);
  const acceptance = await run(commands.acceptance());
  const e2e = await run(commands.e2e());
  return [...first, ...light, acceptance, e2e];
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
