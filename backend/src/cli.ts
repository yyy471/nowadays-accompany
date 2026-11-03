import { runCli } from "./cli/commands.js";
import { CliError, HttpClient } from "./cli/client.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:3210";

async function main(): Promise<void> {
  const args: string[] = [];
  let baseUrl = DEFAULT_BASE_URL;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base-url") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliError("OPTION_VALUE_REQUIRED", "--base-url 需要值");
      }
      baseUrl = value;
      index += 1;
      continue;
    }
    args.push(token ?? "");
  }

  const client = new HttpClient(baseUrl);
  const result = await runCli(args, client);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main().catch((error: unknown) => {
  const body =
    error instanceof CliError
      ? {
          code: error.code,
          message: error.message,
          ...(error.status === undefined ? {} : { status: error.status }),
        }
      : {
          code: "CLI_ERROR",
          message: error instanceof Error ? error.message : String(error),
        };
  process.stderr.write(`${JSON.stringify({ error: body })}\n`);
  process.exitCode = 1;
});
