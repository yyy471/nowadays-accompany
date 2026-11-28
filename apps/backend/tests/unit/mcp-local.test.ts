import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { McpToolClient } from "../../src/mcp/client.js";

test("workspace and command modes expose their own tools", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = await McpToolClient.connect({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/local-server.ts"],
    env: { NOWADAYS_WORKSPACE: root },
  });
  t.after(() => client.close());
  const commandClient = await McpToolClient.connect({ command: process.execPath, args: ["--import", "tsx", "src/mcp/local-server.ts", "--mode", "command"], env: { NOWADAYS_WORKSPACE: root } });
  t.after(() => commandClient.close());
  assert.equal(client.serverName, "nowadays-local-tools");
  assert.equal(commandClient.serverName, "nowadays-local-tools");
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "workspace_read",
      "workspace_search",
      "workspace_write",
    ],
  );

  const write = await callJson(client, "workspace_write", {
    path: "notes/a.md",
    content: "hello workspace\n第二行",
  });
  assert.deepEqual(write, {
    ok: true,
    path: "notes/a.md",
    bytes: Buffer.byteLength("hello workspace\n第二行", "utf8"),
    append: false,
  });
  const read = await callJson(client, "workspace_read", {
    path: "notes/a.md",
  });
  assert.equal(read.content, "hello workspace\n第二行");
  assert.equal(read.truncated, false);

  const search = await callJson(client, "workspace_search", {
    query: "workspace",
  });
  assert.equal(search.ok, true);
  assert.equal(
    (search.matches as Array<{ path: string }>).some(
      (match) => match.path === "notes/a.md",
    ),
    true,
  );

  assert.deepEqual((await commandClient.listTools()).map(tool => tool.name), ["command_run"]);
  const command = await callJson(commandClient, "command_run", {
    command: process.execPath,
    args: ["-e", "console.log('tool-ok')"],
  });
  assert.equal(command.ok, true);
  assert.match(command.stdout as string, /tool-ok/);

  const missingCommand = await callJson(commandClient, "command_run", {
    command: path.join(root, "missing-executable"),
  });
  assert.equal(missingCommand.ok, false);
  assert.equal(missingCommand.timedOut, false);
  assert.match(missingCommand.error as string, /ENOENT/);

  if (process.platform === "win32") {
    const cmd = await callJson(commandClient, "command_run", { command: "cmd", args: ["/c", "echo", "command-ok"] });
    assert.equal(cmd.ok, true);
    assert.match(cmd.stdout as string, /command-ok/);
  }
  const escaped = await client.callTool("workspace_read", {
    path: "../outside.txt",
  });
  assert.equal(escaped.isError, true);
});

test("stdio transport uses SDK defaults and explicitly configured environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-first-hop-"));
  const preload = path.join(root, "check-env.mjs");
  const previous = process.env.NOWADAYS_FAKE_HOST_SECRET;
  process.env.NOWADAYS_FAKE_HOST_SECRET = "host-only-marker";
  fs.writeFileSync(preload, "if (process.env.NOWADAYS_FAKE_HOST_SECRET !== undefined || process.env.NOWADAYS_FAKE_CONFIG !== 'configured-marker') process.exit(91);");
  try {
    const client = await McpToolClient.connect({ command: process.execPath, args: ["--import", pathToFileURL(preload).href, "--import", "tsx", "src/mcp/local-server.ts"], env: { NOWADAYS_WORKSPACE: root, NOWADAYS_FAKE_CONFIG: "configured-marker" } });
    try {
      assert.equal(client.serverName, "nowadays-local-tools");
      assert.deepEqual((await client.listTools()).map(tool => tool.name).sort(), ["workspace_read", "workspace_search", "workspace_write"]);
    } finally { await client.close(); }
  } finally {
    if (previous === undefined) delete process.env.NOWADAYS_FAKE_HOST_SECRET; else process.env.NOWADAYS_FAKE_HOST_SECRET = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("command child strips sensitive variables while preserving configured PATH", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-second-hop-"));
  const names = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NOWADAYS_HOST_TOKEN", "NODE_OPTIONS"];
  const env: Record<string, string> = { NOWADAYS_WORKSPACE: root, PATH: root };
  for (const name of names) env[name] = name === "NODE_OPTIONS" ? "--no-warnings" : "fake-marker";
  const client = await McpToolClient.connect({ command: process.execPath, args: ["--import", "tsx", "src/mcp/local-server.ts", "--mode", "command"], env });
  try {
    assert.equal(client.serverName, "nowadays-local-tools");
    const result = await callJson(client, "command_run", { command: "node", args: ["-e", `console.log(JSON.stringify({ present: ${JSON.stringify(names)}.filter(name => process.env[name] !== undefined), keys: Object.keys(process.env), PATH: process.env.PATH, workspace: process.env.NOWADAYS_WORKSPACE }))`] });
    assert.equal(result.ok, true);
    const child = JSON.parse(result.stdout as string) as { present: string[]; keys: string[]; PATH?: string; workspace?: string };
    assert.deepEqual(child.present, []);
    const keys = child.keys.map(key => process.platform === "win32" ? key.toUpperCase() : key);
    const allowed = process.platform === "win32"
      ? ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "NOWADAYS_WORKSPACE"]
      : ["PATH", "HOME", "TMPDIR", "LANG", "NOWADAYS_WORKSPACE"];
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(keys.filter(key => !allowed.includes(key)), []);
    assert.equal(child.workspace, fs.realpathSync(root));
    assert.ok(child.PATH);
    assert.equal(child.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
    assert.ok(child.PATH.split(path.delimiter).includes(root));
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("local MCP validates modes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mode-"));
  const config = { command: process.execPath, args: ["--import", "tsx", "src/mcp/local-server.ts", "--mode", "workspace"], env: { NOWADAYS_WORKSPACE: root } };
  try {
    const client = await McpToolClient.connect(config);
    try { assert.deepEqual((await client.listTools()).map(tool => tool.name).sort(), ["workspace_read", "workspace_search", "workspace_write"]); } finally { await client.close(); }
    await assert.rejects(McpToolClient.connect({ ...config, args: [...config.args.slice(0, -1), "invalid"] }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace writes reject existing and missing-parent directory links", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-mcp-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-mcp-out-"));
  const linked = path.join(root, "linked");
  fs.symlinkSync(
    outside,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  const client = await McpToolClient.connect({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/local-server.ts"],
    env: { NOWADAYS_WORKSPACE: root },
  });
  try {
    const direct = await client.callTool("workspace_write", {
      path: "linked/direct.txt",
      content: "should fail",
    });
    assert.equal(direct.isError, true);
    assert.equal(fs.existsSync(path.join(outside, "direct.txt")), false);

    const nested = await client.callTool("workspace_write", {
      path: "linked/new-directory/note.txt",
      content: "should fail",
    });
    assert.equal(nested.isError, true);
    assert.equal(
      fs.existsSync(path.join(outside, "new-directory", "note.txt")),
      false,
    );

    const normal = await callJson(client, "workspace_write", {
      path: "plain/deep/file.txt",
      content: "inside",
    });
    assert.equal(normal.ok, true);
    assert.equal(
      fs.readFileSync(path.join(root, "plain", "deep", "file.txt"), "utf8"),
      "inside",
    );
  } finally {
    await client.close();
    fs.rmSync(linked, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("workspace_read uses a bounded descriptor read for oversized files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-mcp-read-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "large.txt");
  const descriptor = fs.openSync(file, "w");
  try {
    const prefix = Buffer.alloc(1_000_001, 0x61);
    fs.writeSync(descriptor, prefix, 0, prefix.length, 0);
    fs.ftruncateSync(descriptor, 8_000_000);
  } finally {
    fs.closeSync(descriptor);
  }
  const marker = path.join(root, "unbounded-read.txt");
  const target = fs.realpathSync(file);
  const preload = path.join(root, "instrument-read.mjs");
  fs.writeFileSync(
    preload,
    [
      'import fs from "node:fs";',
      "const readSync = fs.readSync;",
      "fs.readSync = (...args) => {",
      '  if (typeof args[3] === "number" && args[3] > 1_000_001) {',
      `    fs.writeFileSync(${JSON.stringify(marker)}, String(args[3]));`,
      "  }",
      "  return readSync.apply(fs, args);",
      "};",
      "const readFileSync = fs.readFileSync;",
      "fs.readFileSync = (...args) => {",
      `  if (args[0] === ${JSON.stringify(target)}) {`,
      `    fs.writeFileSync(${JSON.stringify(marker)}, "readFileSync");`,
      "  }",
      "  return readFileSync.apply(fs, args);",
      "};",
    ].join("\n"),
  );
  const client = await McpToolClient.connect({
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(preload).href,
      "--import",
      "tsx",
      "src/mcp/local-server.ts",
    ],
    env: { NOWADAYS_WORKSPACE: root },
  });
  try {
    const read = await callJson(client, "workspace_read", {
      path: "large.txt",
    });
    assert.equal(read.ok, true);
    assert.equal(read.bytes, 8_000_000);
    assert.equal(read.truncated, true);
    assert.equal(read.content, "a".repeat(1_000_000));
    assert.equal(fs.existsSync(marker), false, "不得整文件读取，读取长度也不得超过 MAX_TEXT_BYTES + 1");
  } finally {
    await client.close();
  }
});

async function callJson(
  client: McpToolClient,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool(name, args);
  if (result.isError) {
    throw new Error(`MCP_TOOL_ERROR:${JSON.stringify(result.content)}`);
  }
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error("MCP_TOOL_TEXT_MISSING");
  }
  return JSON.parse(text) as Record<string, unknown>;
}
