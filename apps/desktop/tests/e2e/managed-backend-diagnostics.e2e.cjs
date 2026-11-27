"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { repoRoot } = require("../helpers/paths.cjs");
const { resolveElectronExecutable } = require("../helpers/electron-executable.cjs");

const backend = path.join(repoRoot, "apps", "backend");
const Database = require(path.join(backend, "node_modules", "better-sqlite3"));

async function session(temp, mode, extraEnv, releaseLock = () => {}) {
  const profile = path.join(temp, mode);
  const env = {
    ...process.env,
    ...extraEnv,
    NOWADAYS_NODE_PATH: path.join(repoRoot, ".tools", "node-v24", "node.exe"),
    NOWADAYS_APP_ROOT: path.join(temp, mode + "-data"),
    NOWADAYS_SKIP_ROLE_PICKER: "1",
    DIAGNOSTIC_MODE: mode
  };
  delete env.NOWADAYS_BACKEND_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronExecutable({ repoRoot }), ["--no-sandbox", "--user-data-dir=" + profile,
    path.join(__dirname, "../helpers/managed-backend-diagnostics-session.cjs")], {
    env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stderr.on("data", chunk => { output += chunk; });
  child.stdout.on("data", chunk => {
    output += chunk;
    if (output.includes("DIAGNOSTIC_LOCK_OBSERVED")) releaseLock();
  });
  const timer = setTimeout(() => {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  }, 55000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /DIAGNOSTIC_VERIFIED/);
    console.log(mode, "DIAGNOSTIC_VERIFIED");
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-diagnostics-"));
  const data = path.join(temp.path, "lock-data", "data");
  fs.mkdirSync(data, { recursive: true });
  const db = new Database(path.join(data, ".installation-lock.sqlite"));
  db.exec("BEGIN EXCLUSIVE");
  const release = () => {
    if (!db.open) return;
    db.close();
    fs.writeFileSync(path.join(data, "..", "released"), "");
  };
  try {
    await session(temp.path, "lock", { NOWADAYS_BACKEND_ROOT: backend }, release);
  } finally { release(); }
  // 真实 Node/tsx 从隔离后的后端目录启动，但该目录故意没有入口。
  const broken = path.join(temp.path, "missing-backend");
  fs.mkdirSync(broken);
  fs.symlinkSync(path.join(backend, "node_modules"), path.join(broken, "node_modules"),
    process.platform === "win32" ? "junction" : "dir");
  await session(temp.path, "missing", { NOWADAYS_BACKEND_ROOT: broken });
  // 入口已公布监听端口，结束由真实健康请求触发，复现 HTTP 响应与子进程 close 竞态。
  fs.mkdirSync(path.join(broken, "src"));
  fs.writeFileSync(path.join(broken, "src", "main.ts"), `
    const { createServer } = require("node:http");
    const { writeSync } = require("node:fs");
    const server = createServer((req, res) => {
      if (req.url !== "/v1/health") { res.writeHead(404); res.end(); return; }
      writeSync(2, "DIAGNOSTIC_CRASH_DURING_HEALTH");
      process.exit(43);
    });
    server.listen(0, "127.0.0.1", () => {
      console.log(JSON.stringify({ event: "listening", host: "127.0.0.1", port: server.address().port }));
    });
  `);
  await session(temp.path, "health-crash", { NOWADAYS_BACKEND_ROOT: broken });
}

run().catch(error => { console.error(error); process.exitCode = 1; });
