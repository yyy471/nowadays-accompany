"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const TAIL_BYTES = 16 * 1024;
const LOG_NAME = "backend-latest.log";
const AUTHORIZATION = /((?<![\w-])["']?(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^"'].*)/gi;
const SECRET_FIELD = /((?<![\w-])["']?(?:(?:[\w-]*[-_])?api[ _-]?key|[\w-]*token|[\w-]*password|[\w-]*secret)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"'<>;,}\]]+)/gi;

function redact(line, hostToken) {
  const safe = line.replace(AUTHORIZATION, "$1[REDACTED]")
    .replace(SECRET_FIELD, "$1[REDACTED]")
    .replace(/\bBearer[ \t]+[^\s"'<>;,}\]]+/gi, "Bearer [REDACTED]");
  return hostToken ? safe.replaceAll(hostToken, "[REDACTED]") : safe;
}

// 先拼成完整 UTF-8 文本行，再脱敏和识别启动消息。
function consumeLines(emit) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function read(text) {
    const lines = text.split("\n");
    lines[0] = pending + lines[0];
    pending = lines.pop();
    for (const line of lines) emit(line.replace(/\r$/, ""));
  }
  return {
    write: chunk => read(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
    close() {
      read(decoder.end());
      if (pending) emit(pending.replace(/\r$/, ""));
      pending = "";
    }
  };
}

function rotate(latest) {
  for (const [old, next] of [[latest + ".1", latest + ".2"], [latest, latest + ".1"]]) {
    try { fs.renameSync(old, next); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function createBackendLog({ logDirectory, hostToken, onStdoutLine }) {
  let fd;
  let canOpenLogs = false;
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    const latest = path.join(logDirectory, LOG_NAME);
    rotate(latest);
    fd = fs.openSync(latest, "w", 0o600);
    canOpenLogs = true;
  } catch { /* 日志目录不可写时只保留内存诊断。 */ }

  let tail = Buffer.alloc(0);
  let closed = false;
  function closeFile() {
    if (fd === undefined) return;
    try { fs.closeSync(fd); } catch { /* 不影响后端关闭。 */ }
    fd = undefined;
  }
  function record(source, line) {
    const safe = redact(line, hostToken);
    if (source === "stderr") {
      const bytes = Buffer.from(safe + "\n");
      tail = bytes.length >= TAIL_BYTES ? Buffer.from(bytes.subarray(-TAIL_BYTES)) :
        Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - TAIL_BYTES)), bytes]);
    }
    if (fd !== undefined) {
      try { fs.writeFileSync(fd, `[${source}] ${safe}\n`); }
      catch { closeFile(); } // 写失败后仍消费输出，并保留内存摘要。
    }
  }
  const stdout = consumeLines(line => {
    record("stdout", line);
    onStdoutLine?.(line);
  });
  const stderr = consumeLines(line => record("stderr", line));
  return {
    canOpenLogs,
    get stderrTail() {
      let start = 0;
      while ((tail[start] & 0xc0) === 0x80) start++;
      return tail.toString("utf8", start);
    },
    stdout: stdout.write,
    stderr: stderr.write,
    lifecycle: line => record("host", line),
    close() {
      if (closed) return;
      closed = true;
      try {
        stdout.close();
        stderr.close();
      } finally {
        closeFile();
      }
    }
  };
}

function summarizeBackendFailure({ code, signal, error, stderrTail = "" }) {
  const known = [
    [/\bINSTALLATION_BUSY\b/, "本机数据目录正在使用（INSTALLATION_BUSY）。请关闭其他使用该目录的 Nowadays 实例后重试。"],
    [/\b(?:ERR_DLOPEN_FAILED|NODE_MODULE_VERSION)\b|compiled against a different Node\.js version/i,
      "本机服务的原生模块无法加载，可能与 Node.js 运行时版本不匹配（" +
      (stderrTail.includes("NODE_MODULE_VERSION") ? "NODE_MODULE_VERSION" : "ERR_DLOPEN_FAILED") + "）。"],
    [/\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|Cannot find (?:module|package)\b/i,
      "本机服务缺少启动所需的文件或模块（" +
      (stderrTail.includes("ERR_MODULE_NOT_FOUND") ? "ERR_MODULE_NOT_FOUND" : "MODULE_NOT_FOUND") + "）。"],
    [/\b(EACCES|EPERM)\b/, "本机服务缺少访问所需文件或目录的权限。"]
  ];
  if (error) {
    const errorCode = /^[A-Z0-9_]+$/.test(error.code) ? error.code : "SPAWN_ERROR";
    const denied = /^(EACCES|EPERM)$/.test(errorCode) ? "，请检查运行权限" : "";
    return `无法启动本机服务进程（${errorCode}${denied}）。`;
  }
  for (const [pattern, message] of known) {
    const match = stderrTail.match(pattern);
    if (match) return match[1] ? `${message}（${match[1]}）` : message;
  }
  const last = stderrTail.trim().split(/\r?\n/).pop()?.trim().slice(0, 240);
  const status = signal ? `signal=${signal}` : `code=${code ?? "unknown"}`;
  return `本机服务在启动期间退出（${status}）。${last ? "最后一行错误：" + last : ""}`;
}

module.exports = { createBackendLog, summarizeBackendFailure };
