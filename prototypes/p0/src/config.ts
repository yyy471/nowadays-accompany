import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const p0Root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function caseDir(...segments: string[]): string {
  return path.join(p0Root, "data", ...segments);
}

export function currentRunId(): string | null {
  return process.env.P0_RUN_ID ?? null;
}

export function prepareCaseDir(...segments: string[]): string {
  const dir = caseDir(...segments);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
