import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { listen } from "../../src/bootstrap/app.js";
import { createFixture } from "../fixtures/conversation-fixture.js";

test("设置页识别单包与技能库，批量选择失效时不留下部分导入", async t => {
  const fixture = createFixture([]);
  t.after(() => fixture.close());
  const { resources } = fixture.app.services;
  const library = path.join(fixture.root, "methods");
  for (const name of ["notes", "sources"]) {
    fs.mkdirSync(path.join(library, name), { recursive: true });
    fs.writeFileSync(path.join(library, name, "SKILL.md"), `---\nname: ${name}\ndescription: 能力简介\n---\n使用方法`);
  }
  assert.equal(resources.discoverSkills("methods").length, 2);
  assert.deepEqual(resources.discoverSkills(path.join(library, "notes")), [resources.discoverSkills(library)[0]]);
  const before = resources.list("skill").length;
  assert.throws(() => resources.importSkills(library, ["notes", "missing"]), /重新识别/);
  assert.equal(resources.list("skill").length, before);
  const items = resources.importSkills(library, ["sources"]);
  assert.deepEqual(items.map(item => [item.name, item.config.sourcePath, item.config.description]), [
    ["sources", path.join(library, "sources"), "能力简介"],
  ]);
});

test("草稿和已保存 MCP 能列出工作区工具，缺启动程序返回可读原因", async t => {
  const fixture = createFixture([]);
  t.after(() => fixture.close());
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  const probe = (body: unknown) => fetch(`http://127.0.0.1:${port}/v1/resources/mcp/probe`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const config = { command: process.execPath, env: { NOWADAYS_WORKSPACE: path.join(fixture.root, "untrusted-workspace") }, args: [
    "--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/mcp/local-server.ts"),
  ] };
  const drafts = await probe(config);
  assert.equal(drafts.status, 200);
  const { tools } = await drafts.json() as { tools: { name: string }[] };
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["workspace_read", "workspace_search", "workspace_write"]);
  const saved = fixture.app.services.resources.create({ name: "本地搜索", kind: "mcp", config });
  const persisted = await probe({ resourceId: saved.resourceId });
  assert.deepEqual(await persisted.json(), { tools });
  const missing = await probe({ command: "nowadays-missing-test-runtime", args: [], env: {} });
  assert.equal(missing.status, 422);
  assert.match((await missing.json() as { error: { message: string } }).error.message, /找不到启动程序/);
});
