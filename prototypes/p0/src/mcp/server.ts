import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const workspace = process.env.P0_WORKSPACE;
if (!workspace) {
  console.error("P0_WORKSPACE is required");
  process.exit(1);
}

const root = path.resolve(workspace);
const countsPath = path.join(root, ".p0-effect-counts.json");

function safePath(relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  return resolved;
}

type EffectCounts = Record<string, number>;

function readCounts(): EffectCounts {
  try {
    return JSON.parse(fs.readFileSync(countsPath, "utf8")) as EffectCounts;
  } catch {
    return {};
  }
}

function bumpEffect(tool: string): number {
  const counts = readCounts();
  const next = (counts[tool] ?? 0) + 1;
  counts[tool] = next;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(countsPath, JSON.stringify(counts, null, 2), "utf8");
  return next;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

const server = new McpServer({
  name: "p0-note-tools",
  version: "0.0.0",
});

server.registerTool(
  "append_note",
  {
    description: "Append one line to a note file inside the P0 workspace.",
    inputSchema: {
      path: z.string(),
      text: z.string(),
    },
  },
  async ({ path: relativePath, text }) => {
    const target = safePath(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${text}\n`, "utf8");
    const content = fs.readFileSync(target, "utf8");
    const effectCount = bumpEffect("append_note");
    return jsonResult({
      ok: true,
      path: relativePath,
      bytes: Buffer.byteLength(content, "utf8"),
      lines: content.split("\n").filter((line) => line.length > 0).length,
      effectCount,
    });
  },
);

server.registerTool(
  "read_note",
  {
    description: "Read a note file inside the P0 workspace.",
    inputSchema: {
      path: z.string(),
    },
  },
  async ({ path: relativePath }) => {
    const target = safePath(relativePath);
    const exists = fs.existsSync(target);
    return jsonResult({
      ok: true,
      path: relativePath,
      exists,
      content: exists ? fs.readFileSync(target, "utf8") : "",
    });
  },
);

server.registerTool(
  "append_note_then_hang",
  {
    description:
      "Append one line, then never return a response. Used to simulate a lost tool response while the side effect has already happened.",
    inputSchema: {
      path: z.string(),
      text: z.string(),
    },
  },
  async ({ path: relativePath, text }) => {
    const target = safePath(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${text}\n`, "utf8");
    bumpEffect("append_note_then_hang");
    await new Promise<never>(() => {});
    throw new Error("UNREACHABLE");
  },
);

server.registerTool(
  "get_effect_counts",
  {
    description: "Return per-tool side-effect counts recorded in this workspace.",
    inputSchema: {},
  },
  async () => jsonResult({ ok: true, counts: readCounts() }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
