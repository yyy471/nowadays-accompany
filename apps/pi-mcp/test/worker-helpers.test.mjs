import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStepWriter, normalizeWorkspacePath } from "../src/worker-helpers.mjs";

test("并发 schedule 合并落盘，最终快照完整且无残留临时文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-step-writer-"));
  try {
    const stepLogPath = path.join(dir, "steps.json");
    const steps = [];
    const stepWriter = createStepWriter(stepLogPath, () => JSON.stringify({ steps: [...steps] }));
    // 50 次快速追加，期间完全不 await，模拟并发 tool_execution_end。
    for (let index = 0; index < 50; index += 1) {
      steps.push({ index, at: new Date().toISOString() });
      stepWriter.schedule();
    }
    await stepWriter.flush();
    const snapshot = JSON.parse(await fs.readFile(stepLogPath, "utf8"));
    assert.equal(snapshot.steps.length, 50);
    assert.deepEqual(snapshot.steps.map(step => step.index), Array.from({ length: 50 }, (_, index) => index));
    const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("normalizeWorkspacePath 去掉 @ 前缀、归一化 Unicode 空格并保留越界路径", () => {
  const root = path.resolve(os.tmpdir(), "pi-normalize-root");
  assert.equal(normalizeWorkspacePath("@notes.txt", root), path.resolve(root, "notes.txt"));
  assert.equal(normalizeWorkspacePath(" a b.txt", root), path.resolve(root, " a b.txt"));
  assert.equal(normalizeWorkspacePath(path.join("nested", "file.txt"), root), path.resolve(root, "nested", "file.txt"));
  // .. 路径必须原样保留为 root 之外，交由 checked() 的工作区围栏拒绝。
  const escaped = normalizeWorkspacePath("../secret.txt", root);
  assert.equal(escaped, path.resolve(root, "../secret.txt"));
  assert.ok(path.relative(root, escaped).startsWith(".."));
  for (const invalid of [undefined, null, "", 42]) {
    assert.throws(() => normalizeWorkspacePath(invalid, root), /PI_WORKSPACE_PATH_DENIED/);
  }
});

test("worker 不再导入 SDK 私有 paths 模块", async () => {
  const source = await fs.readFile(new URL("../src/worker.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("./utils/paths.js"));
  assert.doesNotMatch(source, /import\.meta\.resolve\(\s*["']@earendil-works\/pi-coding-agent["']\s*\)/);
});
