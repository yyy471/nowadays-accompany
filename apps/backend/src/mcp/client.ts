import { z } from "zod";
import path from "node:path";
import { managedPiCommand } from "../domain/resource.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export { managedPiCommand };

export function resolvePiEntry(root = process.env.NOWADAYS_PI_MCP_ROOT): string {
  return path.resolve(root || path.resolve(import.meta.dirname, "../../../pi-mcp"), "src", "server.mjs");
}

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

const piTerminal = z.object({
  method: z.literal("notifications/nowadays/pi-terminal"),
  params: z.object({ jobId: z.uuid(), state: z.enum(["completed","failed","cancelled","timed_out"]), summary: z.string().max(1200) }),
});
export type PiReceipt = z.infer<typeof piTerminal>["params"];

export class McpToolClient {
  private closed = false;

  private constructor(private readonly client: Client) {}

  static async connect(
    config: McpServerConfig,
    options: { isolatedEnv?: boolean; cwd?: string; timeoutMs?: number; onClose?: () => void; onPiTerminal?: (receipt: PiReceipt) => void } = {},
  ): Promise<McpToolClient> {
    // MCP SDK 模块仅在真正连接工具服务时按需加载，避免拖慢后端冷启动（410 R2-12）。
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    const pi = config.command === managedPiCommand;
    const transport = new StdioClientTransport({
      command: pi ? process.execPath : config.command,
      args: pi ? [resolvePiEntry()] : config.args,
      cwd: options.cwd ?? process.cwd(),
      env: pi ? { PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
        ...(process.platform === "win32" && { PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }),
      } : config.env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client(
      { name: "nowadays-backend", version: "0.1.0" },
      { capabilities: {} },
    );
    if (pi && options.onPiTerminal) {
      client.setNotificationHandler(piTerminal, event => options.onPiTerminal!(event.params));
      client.onerror = error => console.error("PI_STDIO_PROTOCOL_ERROR", error.message);
    }
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

  get serverName() { return this.client.getServerVersion()?.name; }

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
