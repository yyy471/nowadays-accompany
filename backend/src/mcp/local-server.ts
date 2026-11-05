import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const workspace = process.env.NOWADAYS_WORKSPACE;
if (!workspace) {
  console.error("NOWADAYS_WORKSPACE is required");
  process.exit(1);
}
const root = fs.realpathSync(path.resolve(workspace));
const MAX_TEXT_BYTES = 1_000_000;

const server = new McpServer({
  name: "nowadays-local-tools",
  version: "0.1.0",
});

server.registerTool(
  "workspace_read",
  {
    description:
      "Read a UTF-8 text file inside the role workspace. Paths are relative to the workspace root.",
    inputSchema: {
      path: z.string().min(1),
    },
  },
  async ({ path: relativePath }) => {
    const target = safePath(relativePath, true);
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      throw new Error("NOT_A_FILE");
    }
    const buffer = fs.readFileSync(target);
    const truncated = buffer.byteLength > MAX_TEXT_BYTES;
    const content = buffer
      .subarray(0, MAX_TEXT_BYTES)
      .toString("utf8");
    return jsonResult({
      ok: true,
      path: relativePath,
      bytes: buffer.byteLength,
      truncated,
      content,
    });
  },
);

server.registerTool(
  "workspace_write",
  {
    description:
      "Write or append UTF-8 text to a file inside the role workspace. Missing parent directories are created.",
    inputSchema: {
      path: z.string().min(1),
      content: z.string(),
      append: z.boolean().optional(),
    },
  },
  async ({ path: relativePath, content, append }) => {
    const target = safePath(relativePath, false);
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    assertInsideWorkspace(fs.realpathSync(directory));
    if (append) {
      fs.appendFileSync(target, content, "utf8");
    } else {
      fs.writeFileSync(target, content, "utf8");
    }
    return jsonResult({
      ok: true,
      path: relativePath,
      bytes: Buffer.byteLength(content, "utf8"),
      append: append === true,
    });
  },
);

server.registerTool(
  "workspace_search",
  {
    description:
      "Search file names and UTF-8 text contents under a workspace directory. Returns matching paths and lines.",
    inputSchema: {
      query: z.string().min(1),
      path: z.string().optional(),
      maxResults: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ query, path: relativePath, maxResults }) => {
    const searchRoot = safePath(relativePath ?? ".", true);
    if (!fs.statSync(searchRoot).isDirectory()) {
      throw new Error("NOT_A_DIRECTORY");
    }
    const limit = maxResults ?? 50;
    const lower = query.toLowerCase();
    const matches: Array<{ path: string; line?: number; text?: string }> = [];
    let visited = 0;
    let truncated = false;
    const walk = (directory: string, depth: number): void => {
      if (matches.length >= limit || visited > 2000 || depth > 12) {
        truncated = true;
        return;
      }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        const absolute = path.join(directory, entry.name);
        const relative = path
          .relative(root, absolute)
          .split(path.sep)
          .join("/");
        if (entry.isDirectory()) {
          walk(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        visited += 1;
        if (entry.name.toLowerCase().includes(lower)) {
          matches.push({ path: relative });
          if (matches.length >= limit) {
            truncated = true;
            return;
          }
        }
        const stat = fs.statSync(absolute);
        if (stat.size > MAX_TEXT_BYTES) {
          continue;
        }
        let text: string;
        try {
          text = fs.readFileSync(absolute, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index]?.toLowerCase().includes(lower)) {
            matches.push({
              path: relative,
              line: index + 1,
              text: (lines[index] ?? "").slice(0, 500),
            });
            if (matches.length >= limit) {
              truncated = true;
              return;
            }
          }
        }
      }
    };
    walk(searchRoot, 0);
    return jsonResult({
      ok: true,
      root: path.relative(root, searchRoot).split(path.sep).join("/") || ".",
      matches,
      truncated,
    });
  },
);

server.registerTool(
  "command_run",
  {
    description:
      "Run a command directly inside the role workspace. The command inherits the user environment; output is captured.",
    inputSchema: {
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    },
  },
  async ({ command, args, cwd, timeoutMs }) => {
    const workingDirectory = safePath(cwd ?? ".", true);
    if (!fs.statSync(workingDirectory).isDirectory()) {
      throw new Error("NOT_A_DIRECTORY");
    }
    return jsonResult(
      await runCommand(
        command,
        args ?? [],
        workingDirectory,
        timeoutMs ?? 30_000,
      ),
    );
  },
);

function safePath(relativePath: string, mustExist: boolean): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  const target = path.resolve(root, relativePath);
  if (!isInsideWorkspace(target)) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  const targetStat = lstatIfExists(target);
  if (targetStat !== null) {
    let real: string;
    try {
      real = fs.realpathSync(target);
    } catch {
      throw new Error("PATH_OUTSIDE_WORKSPACE");
    }
    assertInsideWorkspace(real);
    return real;
  }
  if (mustExist) {
    throw new Error("PATH_NOT_FOUND");
  }
  let ancestor = path.dirname(target);
  while (true) {
    if (lstatIfExists(ancestor) !== null) {
      let real: string;
      try {
        real = fs.realpathSync(ancestor);
      } catch {
        throw new Error("PATH_OUTSIDE_WORKSPACE");
      }
      assertInsideWorkspace(real);
      break;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("PATH_OUTSIDE_WORKSPACE");
    }
    ancestor = parent;
  }
  return target;
}

function lstatIfExists(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function isInsideWorkspace(target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function assertInsideWorkspace(target: string): void {
  if (!isInsideWorkspace(target)) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
}

function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_TEXT_BYTES) {
        truncated = true;
        return next.slice(0, MAX_TEXT_BYTES);
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr,
        truncated,
        error: error.message,
      });
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
