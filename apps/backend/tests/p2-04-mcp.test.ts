import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpToolClient } from "../src/mcp/client.js";

test("local MCP tools read, write, search and run commands inside the workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-mcp-"));
  const client = await McpToolClient.connect({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/local-server.ts"],
    env: { NOWADAYS_WORKSPACE: root },
  });
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "command_run",
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

    const command = await callJson(client, "command_run", {
      command: process.execPath,
      args: ["-e", "console.log('tool-ok')"],
    });
    assert.equal(command.ok, true);
    assert.match(command.stdout as string, /tool-ok/);

    const escaped = await client.callTool("workspace_read", {
      path: "../outside.txt",
    });
    assert.equal(escaped.isError, true);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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
