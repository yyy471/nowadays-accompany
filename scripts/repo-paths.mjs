import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(scriptsDir, "..");
export const backendDir = path.join(repoRoot, "apps", "backend");
export const desktopDir = path.join(repoRoot, "apps", "desktop");
export const rendererDir = path.join(desktopDir, "renderer");
export const docsDir = path.join(repoRoot, "docs");
export const toolsDir = path.join(repoRoot, ".tools");
export const artPipelineDir = path.join(repoRoot, "tools", "art-pipeline");
export const backendTestResultsDir = path.join(backendDir, "test-results");
export const rootTestResultsDir = path.join(repoRoot, "test-results");
export const localNode24Exe = path.join(toolsDir, "node-v24", "node.exe");
