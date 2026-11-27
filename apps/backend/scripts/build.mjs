import { copyFile, mkdir, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const assets = ["application/extensions/runner.mjs", "infra/process-launcher.mjs"];
for (const asset of assets) {
  const destination = path.join(dist, asset);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, "src", asset), destination);
}
for (const entry of ["main.js", "mcp/local-server.js", ...assets]) await access(path.join(dist, entry));
