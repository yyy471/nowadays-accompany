import { listen, createBackendApp } from "./bootstrap/app.js";
import { parseBackendConfig } from "./bootstrap/config.js";

async function main(): Promise<void> {
  const config = parseBackendConfig(process.argv.slice(2));
  // 会话令牌只交给 HTTP 入口，子进程无需继承。
  delete process.env.NOWADAYS_HOST_TOKEN;
  const app = createBackendApp(config);
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
    if (!shutdownSource) {
      const port = await listen(app.server, config.port, config.host);
      // 先让启动期间积压的 EOF／信号回调处理完，再决定是否公布端口。
      if (config.watchStdin) await new Promise<void>(resolve => setImmediate(resolve));
      if (!shutdownSource) {
        console.log(JSON.stringify({ event: "listening", host: config.host, port, appRoot: config.appRoot }));
        await shutdownRequested;
      }
    }
  } finally {
    try {
      await app.close();
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      if (config.watchStdin) {
        process.stdin.off("end", stdinClosed);
        process.stdin.off("close", stdinClosed);
        process.stdin.pause();
      }
    }
  }
  console.log(JSON.stringify({ event: "shutdown_complete", source: shutdownSource }));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
