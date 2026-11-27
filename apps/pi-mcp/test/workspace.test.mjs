import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import { workspaceTools } from "../src/worker.mjs";

test("原生 write、edit 只允许当前工程工作区", async () => {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), "pi-workspace-"));
  try {
    const root = await fs.realpath(await fs.mkdir(path.join(temp.path, "job"), { recursive: true }));
    const other = path.join(temp.path, "other");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, "sample.txt"), "before");
    await fs.mkdir(path.join(other, "secrets"));
    await fs.writeFile(path.join(other, "secrets", "master.key"), "fictional-secret");
    await fs.link(path.join(other, "sample.txt"), path.join(root, "hardlink.txt"));
    await fs.symlink(other, path.join(root, "linked"), "junction");
    const [read, write, edit, draftTest] = await workspaceTools(root, sdk);
    const change = file => edit.execute("edit", { path: file, edits: [{ oldText: "before", newText: "after" }] });
    const save = file => write.execute("write", { path: file, content: "before" });
    const unicodeFile = path.join(root, "unicode\u00a0space.txt");
    await fs.writeFile(unicodeFile, "unicode fixture");
    assert.match(JSON.stringify(await read.execute("read", { path: pathToFileURL(unicodeFile).href })), /unicode fixture/);
    await save("nested/sample.txt");
    await change("nested/sample.txt");
    assert.equal(await fs.readFile(path.join(root, "nested/sample.txt"), "utf8"), "after");
    for (const file of [path.join(other, "sample.txt"), path.join(other, "secrets", "master.key"), "linked/sample.txt", "hardlink.txt"]) {
      await assert.rejects(read.execute("read", { path: file }), /PI_WORKSPACE_PATH_DENIED/);
      await assert.rejects(save(file), /PI_WORKSPACE_PATH_DENIED/);
      await assert.rejects(change(file), /PI_WORKSPACE_PATH_DENIED/);
    }
    assert.equal(await fs.readFile(path.join(other, "sample.txt"), "utf8"), "before");
    await fs.writeFile(path.join(root, "example.mjs"), "import { test } from 'node:test'; test('ok', () => {});");
    const testResult = await draftTest.execute("test", { file: "example.mjs" });
    assert.equal(testResult.details.exitCode, 0, testResult.content[0].text);
    await fs.writeFile(path.join(root, "example[1].mjs"), "import { test } from 'node:test'; test('brackets', () => {});");
    const bracketResult = await draftTest.execute("test", { file: "example[1].mjs" });
    assert.equal(bracketResult.details.exitCode, 0, bracketResult.content[0].text);
    assert.match(bracketResult.content[0].text, /brackets/);
    await fs.writeFile(path.join(root, "literal{a,b}!(x).mjs"), "import { test } from 'node:test'; test('literal glob', () => {});");
    await fs.writeFile(path.join(root, "!negated.mjs"), "import { test } from 'node:test'; test('negated glob', () => {});");
    await assert.rejects(draftTest.execute("test", { file: "literal{a,b}!(x).mjs" }), /PI_WORKSPACE_PATH_DENIED/);
    await assert.rejects(draftTest.execute("test", { file: "!negated.mjs" }), /PI_WORKSPACE_PATH_DENIED/);
    await fs.writeFile(path.join(root, "permissions.mjs"), `import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { spawnSync } from 'node:child_process'; test('permissions', () => { assert.throws(() => fs.readFileSync(${JSON.stringify(path.join(other, "secrets", "master.key"))}), { code: 'ERR_ACCESS_DENIED' }); assert.throws(() => spawnSync(process.execPath, ['-e', '']), { code: 'ERR_ACCESS_DENIED' }); });`);
    const permissions = await draftTest.execute("test", { file: "permissions.mjs" });
    assert.equal(permissions.details.exitCode, 0, permissions.content[0].text);
    await fs.writeFile(path.join(root, "slow.mjs"), "setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const pending = draftTest.execute("test", { file: "slow.mjs" }, controller.signal);
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(pending, /PI_DRAFT_TEST_CANCELLED/);
    await fs.writeFile(path.join(root, "flood.mjs"), "process.stdout.write('x'.repeat(40000)); process.stderr.write('y'.repeat(40000));");
    await assert.rejects(draftTest.execute("test", { file: "flood.mjs" }), /PI_DRAFT_TEST_OUTPUT_LIMIT/);
    await fs.writeFile(path.join(root, "environment.mjs"), `import { test } from 'node:test'; import assert from 'node:assert/strict'; import path from 'node:path'; test('env', () => { for (const key of ['PI_FIXTURE_SECRET','HOME','USERPROFILE','APPDATA','PATH','NODE_OPTIONS']) assert.ok(!process.env[key], key); for (const key of ['TEMP','TMP']) assert.ok(!path.relative(process.cwd(), process.env[key]).startsWith('..')); });`);
    process.env.PI_FIXTURE_SECRET = "fictional";
    try {
      const environment = await draftTest.execute("test", { file: "environment.mjs" });
      assert.equal(environment.details.exitCode, 0, environment.content[0].text);
    } finally { delete process.env.PI_FIXTURE_SECRET; }
    await fs.writeFile(path.join(root, "timeout.mjs"), "import fs from 'node:fs'; fs.writeFileSync('timeout.pid', String(process.pid)); setInterval(() => {}, 1000);");
    await assert.rejects(draftTest.execute("test", { file: "timeout.mjs" }), /PI_DRAFT_TEST_TIMEOUT/);
    const pid = Number(await fs.readFile(path.join(root, "timeout.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await fs.mkdir(path.join(root, "directory.js"));
    await fs.link(path.join(root, "example.mjs"), path.join(root, "hard.mjs"));
    for (const file of ["directory.js", "hard.mjs"]) await assert.rejects(draftTest.execute("test", { file }), /PI_WORKSPACE_PATH_DENIED/);
    await fs.writeFile(path.join(root, "ordinary.js"), "require('node:test').test('ordinary', () => {});");
    const ordinary = await draftTest.execute("test", { file: "ordinary.js" });
    assert.equal(ordinary.details.exitCode, 0, ordinary.content[0].text);
    await fs.writeFile(path.join(root, "failure.mjs"), "import { test } from 'node:test'; test('fails', () => { throw Error('fixture'); });");
    const failure = await draftTest.execute("test", { file: "failure.mjs" });
    assert.notEqual(failure.details.exitCode, 0);
    assert.match(failure.content[0].text, /Exit code: 1/);
    for (const file of ["../other/sample.js", path.join(root, "example.mjs"), "nested", "linked/sample.js"]) {
      await assert.rejects(draftTest.execute("test", { file }), /PI_WORKSPACE_PATH_DENIED/);
    }
  } finally { await temp.remove(); }
});
