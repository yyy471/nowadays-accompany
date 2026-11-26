import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const managedPiCommand = "nowadays-pi";
const piEntry = new URL("../../../pi-mcp/src/server.mjs", import.meta.url);

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolCallResult {
  isError: boolean;
  content: unknown;
  structuredContent?: unknown;
}

export class McpToolClient {
  private closed = false;

  private constructor(private readonly client: Client) {}

  static async connect(
    config: McpServerConfig,
    options: { cwd?: string; timeoutMs?: number; onClose?: () => void } = {},
  ): Promise<McpToolClient> {
    const pi = config.command === managedPiCommand;
    const transport = new StdioClientTransport({
      command: pi ? process.execPath : config.command,
      args: pi ? [fileURLToPath(piEntry)] : config.args,
      cwd: options.cwd ?? process.cwd(),
      env: pi ? { PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
        ...(process.platform === "win32" && { PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }),
      } : { ...process.env, ...config.env } as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client(
      { name: "nowadays-backend", version: "0.1.0" },
      { capabilities: {} },
    );
    if (options.onClose) client.onclose = options.onClose;
    try {
      await withTimeout(
        client.connect(transport),
        options.timeoutMs ?? 15_000,
        "MCP_CONNECT_TIMEOUT",
      );
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return new McpToolClient(client);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    const deadline = Date.now() + 30_000;
    do {
      const result = await withTimeout(this.client.listTools(cursor ? { cursor } : {}), Math.max(1, deadline - Date.now()), "MCP_LIST_TIMEOUT");
      tools.push(...result.tools.map(tool => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })));
      cursor = result.nextCursor;
      if (cursor) {
        if (cursors.has(cursor) || Date.now() >= deadline) throw new Error("MCP_LIST_INCOMPLETE");
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; meta?: Record<string, unknown> } = {},
  ): Promise<McpToolCallResult> {
    const result = await withTimeout(
      this.client.callTool({ name, arguments: args, ...(options.meta && { _meta: options.meta }) }),
      options.timeoutMs ?? 60_000,
      "MCP_TOOL_TIMEOUT",
    );
    return {
      isError: result.isError === true,
      content: result.content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.client.close();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(code));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
