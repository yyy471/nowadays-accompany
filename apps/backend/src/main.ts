import { listen, createBackendApp } from "./bootstrap/app.js";
import { parseBackendConfig } from "./bootstrap/config.js";

async function main(): Promise<void> {
  const config = parseBackendConfig(process.argv.slice(2));
  const app = createBackendApp(config);
  try {
    const port = await listen(app.server, config.port, config.host);
    console.log(
      JSON.stringify({
        event: "listening",
        host: config.host,
        port,
        appRoot: config.appRoot,
      }),
    );

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void app.close().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
