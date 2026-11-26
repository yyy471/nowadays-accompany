import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { workspaceTools } from "../src/worker.mjs";

test("原生 write、edit 只允许当前工程工作区", async () => {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), "pi-workspace-"));
  try {
    const root = await fs.realpath(await fs.mkdir(path.join(temp.path, "job"), { recursive: true }));
    const other = path.join(temp.path, "other");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, "sample.txt"), "before");
    await fs.symlink(other, path.join(root, "linked"), "junction");
    const [write, edit] = await workspaceTools(root, sdk);
    const change = file => edit.execute("edit", { path: file, edits: [{ oldText: "before", newText: "after" }] });
    const save = file => write.execute("write", { path: file, content: "before" });
    await save("nested/sample.txt");
    await change("nested/sample.txt");
    assert.equal(await fs.readFile(path.join(root, "nested/sample.txt"), "utf8"), "after");
    for (const file of [path.join(other, "sample.txt"), "linked/sample.txt"]) {
      await assert.rejects(save(file), /PI_WORKSPACE_PATH_DENIED/);
      await assert.rejects(change(file), /PI_WORKSPACE_PATH_DENIED/);
    }
    assert.equal(await fs.readFile(path.join(other, "sample.txt"), "utf8"), "before");
  } finally { await temp.remove(); }
});
