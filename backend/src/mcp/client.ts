import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<McpToolClient> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...config.env } as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client(
      { name: "nowadays-backend", version: "0.1.0" },
      { capabilities: {} },
    );
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
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<McpToolCallResult> {
    const result = await withTimeout(
      this.client.callTool({ name, arguments: args }),
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
