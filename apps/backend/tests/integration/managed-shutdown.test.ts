import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseBackendConfig } from "../../src/bootstrap/config.js";

const backendRoot = fileURLToPath(new URL("../../", import.meta.url));

test("stdin EOF ownership is opt-in", () => {
  const args = ["--app-root", backendRoot, "--port", "0"];
  assert.equal(parseBackendConfig(args).watchStdin, false);
  assert.equal(parseBackendConfig([...args, "--watch-stdin"]).watchStdin, true);
  assert.throws(() => parseBackendConfig([...args, "--watch-stdin=false"]), /UNKNOWN_ARGUMENT/);
});

for (const duringStartup of [true, false]) {
  test(`managed shutdown via stdin ${duringStartup ? "during listen" : "after listening"}`, { timeout: 15_000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nd-managed-shutdown-"));
    const preload = path.join(root, "delay-listen.cjs");
    fs.writeFileSync(preload, `
      const { Server } = require("node:http");
      const listen = Server.prototype.listen;
      Server.prototype.listen = function (...args) {
        const cb = args.pop();
        return listen.call(this, ...args, () => {
          console.log("TEST_LISTEN_PENDING");
          setTimeout(() => cb(), 350);
        });
      };`);
    const child = spawn(process.execPath, [
      ...(duringStartup ? ["--require", preload] : []),
      "--import", "tsx", "src/main.ts", "--app-root", root, "--port", "0", "--watch-stdin",
    ], { cwd: backendRoot, windowsHide: true, stdio: "pipe", env: isolatedEnv() });
    const closed = once(child, "close");
    const lines: string[] = [];
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line: string) => {
      lines.push(line);
      if (duringStartup ? line === "TEST_LISTEN_PENDING" : line.includes('"event":"listening"')) child.stdin.end();
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    t.after(async () => {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed.catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    });
    assert.deepEqual(await closed, [0, null], stderr);
    assert.equal(lines.filter(line => line.includes('"event":"listening"')).length, duringStartup ? 0 : 1);
    assert.deepEqual(lines.filter(line => line.includes("shutdown_complete")), ['{"event":"shutdown_complete","source":"stdin"}']);
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    // 独立模式生成的会话令牌文件随优雅退出清理。
    assert.equal(fs.existsSync(path.join(root, "runtime", "session.token")), false);
  });
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NOWADAYS_HOST_TOKEN;
  delete env.NOWADAYS_MASTER_KEY;
  delete env.NOWADAYS_ALLOWED_ORIGINS;
  delete env.NOWADAYS_APP_ROOT;
  return env;
}
