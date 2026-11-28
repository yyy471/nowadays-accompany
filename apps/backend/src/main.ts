import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listen, createBackendApp, type BackendApp } from "./bootstrap/app.js";
import { parseBackendConfig } from "./bootstrap/config.js";

function sessionTokenPath(appRoot: string): string {
  return path.join(appRoot, "runtime", "session.token");
}

/** 原子写入独立模式的会话令牌；令牌只供本机 CLI 读取，不打印到 stdout。 */
function writeSessionToken(appRoot: string, token: string): string {
  const runtimeDir = path.join(appRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const target = sessionTokenPath(appRoot);
  const temporary = path.join(
    runtimeDir,
    `.session.token.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, token, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* 临时文件可能未创建 */ }
    throw error;
  }
  return target;
}

/** 仅删除本次实例写入且内容未变的令牌，避免误删新实例的会话文件。 */
function removeSessionToken(filePath: string, token: string): void {
  try {
    if (fs.readFileSync(filePath, "utf8").trim() !== token) {
      return;
    }
    fs.unlinkSync(filePath);
  } catch {
    // 文件已被替换或删除时保持现状。
  }
}

async function main(): Promise<void> {
  const bootStartedAt = performance.now();
  const config = parseBackendConfig(process.argv.slice(2));
  // 会话令牌与主密钥只交给当前进程，子进程无需继承。
  delete process.env.NOWADAYS_HOST_TOKEN;
  delete process.env.NOWADAYS_MASTER_KEY;
  if (!config.masterKey && process.platform === "win32") {
    config.warnFallbackMasterKey = true;
  }

  let generatedToken: string | undefined;
  let tokenPath: string | undefined;
  if (!config.hostToken && !config.allowUnauthenticated) {
    generatedToken = randomBytes(32).toString("hex");
    config.hostToken = generatedToken;
    tokenPath = writeSessionToken(config.appRoot, generatedToken);
  }

  let app: BackendApp | undefined;
  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolve => { requestShutdown = resolve; });
  let shutdownSource: "stdin" | "SIGINT" | "SIGTERM" | undefined;
  const shutdown = (source: NonNullable<typeof shutdownSource>): void => {
    if (shutdownSource) return;
    shutdownSource = source;
    requestShutdown();
  };
  const stdinClosed = () => shutdown("stdin");
  const interrupt = () => shutdown("SIGINT");
  const terminate = () => shutdown("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  if (config.watchStdin) {
    process.stdin.once("end", stdinClosed);
    process.stdin.once("close", stdinClosed);
    if (process.stdin.readableEnded || process.stdin.destroyed) stdinClosed();
    else process.stdin.resume();
  }

  try {
    const started = createBackendApp(config);
    app = started;
    if (!shutdownSource) {
      const port = await listen(started.server, config.port, config.host);
      // 先让启动期间积压的 EOF／信号回调处理完，再决定是否公布端口。
      if (config.watchStdin) await new Promise<void>(resolve => setImmediate(resolve));
      if (!shutdownSource) {
        console.log(JSON.stringify({
          event: "listening",
          host: config.host,
          port,
          appRoot: config.appRoot,
          bootMs: Math.round(performance.now() - bootStartedAt),
          ...(tokenPath === undefined ? {} : { sessionTokenPath: tokenPath }),
        }));
        await shutdownRequested;
      }
    }
  } finally {
    try {
      await app?.close();
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      if (config.watchStdin) {
        process.stdin.off("end", stdinClosed);
        process.stdin.off("close", stdinClosed);
        process.stdin.pause();
      }
      if (generatedToken !== undefined && tokenPath !== undefined) {
        removeSessionToken(tokenPath, generatedToken);
      }
    }
  }
  console.log(JSON.stringify({ event: "shutdown_complete", source: shutdownSource }));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
