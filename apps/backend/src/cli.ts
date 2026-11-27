import fs from "node:fs";
import path from "node:path";
import { runCli } from "./cli/commands.js";
import { CliError, HttpClient } from "./cli/client.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:3210";

function readSessionToken(appRoot: string | undefined): string | undefined {
  if (!appRoot) {
    return undefined;
  }
  try {
    const value = fs
      .readFileSync(path.join(appRoot, "runtime", "session.token"), "utf8")
      .trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args: string[] = [];
  let baseUrl = DEFAULT_BASE_URL;
  let token: string | undefined;
  let appRoot: string | undefined;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const tokenArg = argv[index];
    if (tokenArg === "--base-url") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliError("OPTION_VALUE_REQUIRED", "--base-url 需要值");
      }
      baseUrl = value;
      index += 1;
      continue;
    }
    if (tokenArg === "--token") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliError("OPTION_VALUE_REQUIRED", "--token 需要值");
      }
      token = value;
      index += 1;
      continue;
    }
    if (tokenArg === "--app-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliError("OPTION_VALUE_REQUIRED", "--app-root 需要值");
      }
      appRoot = value;
      index += 1;
      continue;
    }
    args.push(tokenArg ?? "");
  }

  const resolvedAppRoot = appRoot ?? process.env.NOWADAYS_APP_ROOT;
  const hostToken =
    token ?? process.env.NOWADAYS_HOST_TOKEN ?? readSessionToken(resolvedAppRoot);
  const client = new HttpClient(
    baseUrl,
    hostToken === undefined ? {} : { hostToken },
  );
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
