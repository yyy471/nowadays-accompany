"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { createBackendLog, summarizeBackendFailure } = require("../../electron/backend-log.cjs");

test("完整 UTF-8 行保留监听消息，两个流及末尾无换行均先脱敏再保存", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-log-"));
  const stdout = [];
  const log = createBackendLog({ logDirectory: temp.path, hostToken: "raw-host", onStdoutLine: line => stdout.push(line) });
  assert.equal(log.canOpenLogs, true);
  const output = Buffer.from('启动 raw-host\r\n{"event":"listening","port":12345}\nstdout final');
  for (const byte of output) log.stdout(Buffer.from([byte]));
  log.stderr("Authorization: Digest username=\"hidden-user\", nonce=\"hidden-nonce\"\r\n\"Authorization\":\"Basic hidden-basic\", ready=true\n");
  log.stderr('X-Nowadays-Host-Token: extra-host\nBearer standalone-secret\nAPI_KEY=key-');
  log.stderr('value "token": "token value" password=secret-pass\nAPI Key: another-key\nfinal stderr');
  log.close();
  log.close();
  assert.deepEqual(stdout, ["启动 raw-host", '{"event":"listening","port":12345}', "stdout final"]);
  const saved = fs.readFileSync(path.join(temp.path, "backend-latest.log"), "utf8");
  assert.match(saved, /\[stdout\] 启动 \[REDACTED\]/);
  assert.match(saved, /\[stdout\] stdout final\n\[stderr\] final stderr\n$/);
  assert.match(saved, /"Authorization":\[REDACTED\], ready=true/);
  for (const value of ["raw-host", "hidden-user", "hidden-nonce", "hidden-basic", "extra-host", "standalone-secret", "key-value", "token value", "secret-pass", "another-key"]) {
    assert.equal(saved.includes(value) || log.stderrTail.includes(value), false, value);
  }
});

test("启动时轮转三份，路径不可写时仍保留 16 KiB 已脱敏长末行诊断", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-log-"));
  const dir = path.join(temp.path, "logs");
  for (let attempt = 0; attempt < 4; attempt++) {
    const log = createBackendLog({ logDirectory: dir });
    log.stderr("attempt " + attempt);
    log.close();
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ["backend-latest.log", "backend-latest.log.1", "backend-latest.log.2"]);
  for (const [suffix, attempt] of [["", 3], [".1", 2], [".2", 1]]) {
    assert.match(fs.readFileSync(path.join(dir, "backend-latest.log" + suffix), "utf8"), new RegExp("attempt " + attempt));
  }
  const log = createBackendLog({ logDirectory: path.join(dir, "backend-latest.log") });
  assert.equal(log.canOpenLogs, false);
  log.stderr("过期\n");
  log.stderr("新".repeat(100000) + " password=hidden-tail INSTALLATION_BUSY");
  log.close();
  assert.ok(Buffer.byteLength(log.stderrTail) <= 16 * 1024);
  assert.match(log.stderrTail, /^新+ password=\[REDACTED\] INSTALLATION_BUSY\n$/);
  assert.match(summarizeBackendFailure({ code: 1, stderrTail: log.stderrTail }), /本机数据目录正在使用.*INSTALLATION_BUSY/);
});

test("摘要区分缺模块、ABI、权限、进程创建失败及未知退出", () => {
  for (const [stderrTail, expected] of [
    ["ERR_MODULE_NOT_FOUND", /缺少.*ERR_MODULE_NOT_FOUND/],
    ["ERR_DLOPEN_FAILED NODE_MODULE_VERSION", /运行时版本.*NODE_MODULE_VERSION/],
    ["EACCES: permission denied", /权限.*EACCES/],
    ["EPERM: operation not permitted", /权限.*EPERM/]
  ]) assert.match(summarizeBackendFailure({ stderrTail, code: 1 }), expected);
  assert.match(summarizeBackendFailure({ error: { code: "ENOENT" } }), /无法启动.*ENOENT/);
  assert.match(summarizeBackendFailure({ code: 2, stderrTail: "first\nlast\n" }), /code=2.*最后一行错误：last/);
  assert.match(summarizeBackendFailure({ signal: "SIGTERM" }), /signal=SIGTERM/);
});
