import fs from "node:fs";
import { applyRoleTransfer, exportRoleTransfer, preflightRoleTransfer } from "../application/role-transfer.js";
import { parseBackendConfig } from "../bootstrap/config.js";

const help = [
  "export --app-root <dir> --role <id> --out <file>",
  "preflight --app-root <dir> --in <file> [--map <mapping.json>]",
  "apply --app-root <dir> --in <file> [--map <mapping.json>] --token <token> [--choice local|package]",
  "mapping.json 是对象，键为预检输出的 bindings[].key，值为目标安装的服务 ID。",
];

function readMapping(file: string | undefined): Record<string, string> {
  if (file === undefined) return {};
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== "string" || item === "")) {
    throw new Error("ROLE_TRANSFER_MAPPING_INVALID");
  }
  return value as Record<string, string>;
}

function run(args: readonly string[]) {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("ROLE_TRANSFER_NODE_24_REQUIRED");
  const [command, ...rawOptions] = args;
  if (command === "--help" || command === "-h" || command === undefined) return { usage: help };
  const allowed =
    command === "export" ? ["--role", "--out"] :
    command === "preflight" ? ["--in", "--map"] :
    command === "apply" ? ["--in", "--map", "--token", "--choice"] : null;
  if (!allowed) throw new Error("ROLE_TRANSFER_COMMAND_UNKNOWN");
  const opts = new Map<string, string>();
  for (let i = 0; i < rawOptions.length; i += 2) {
    const option = rawOptions[i]!;
    const value = rawOptions[i + 1];
    if (!value || value.startsWith("--") || opts.has(option) || (option !== "--app-root" && !allowed.includes(option))) {
      throw new Error("ROLE_TRANSFER_ARGUMENT_INVALID");
    }
    opts.set(option, value);
  }
  const required = (name: string) => {
    const value = opts.get(name);
    if (!value) throw new Error(`ROLE_TRANSFER_OPTION_REQUIRED:${name}`);
    return value;
  };
  const config = parseBackendConfig(["--app-root", required("--app-root")]);
  if (command === "export") return exportRoleTransfer(config, required("--role"), required("--out"));
  const file = required("--in");
  const mapping = readMapping(opts.get("--map"));
  if (command === "preflight") return preflightRoleTransfer(config, file, mapping);
  const choice = opts.get("--choice");
  if (choice !== undefined && choice !== "local" && choice !== "package") throw new Error("ROLE_TRANSFER_CHOICE_INVALID");
  return applyRoleTransfer(config, file, required("--token"), mapping, choice);
}

try {
  process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`);
} catch (error) {
  const raw = error instanceof Error ? error.message : "";
  const code = /^(?:ROLE_TRANSFER_[A-Z0-9_]+|INSTALLATION_BUSY)(?::|$)/.test(raw) ? raw.split(":")[0] : "ROLE_TRANSFER_FAILED";
  process.stderr.write(`${JSON.stringify({ error: { code, message: code === "INSTALLATION_BUSY" ?
    "安装正在运行，请关闭后端后重试" : code } })}\n`);
  process.exitCode = 1;
}
