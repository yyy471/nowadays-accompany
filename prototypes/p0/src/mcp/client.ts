import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultServerEntry = path.join(moduleDir, "server.ts");
const defaultTsxEntry = path.join(
  moduleDir,
  "..",
  "..",
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);

export class McpToolError extends Error {
  readonly code = "MCP_TOOL_ERROR";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "McpToolError";
  }
}

export interface McpToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

export function adaptMcpToolResult(toolName: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    return result;
  }
  const record = result as McpToolResultLike;
  const blocks = Array.isArray(record.content) ? record.content : [];
  const textBlock = blocks.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  if (record.isError) {
    const detail =
      textBlock?.text ??
      JSON.stringify(record.structuredContent ?? record.content ?? record);
    throw new McpToolError(`MCP_TOOL_ERROR:${toolName}:${detail}`);
  }
  if (record.structuredContent !== undefined) {
    return record.structuredContent;
  }
  if (textBlock) {
    try {
      return JSON.parse(textBlock.text) as unknown;
    } catch {
      return textBlock.text;
    }
  }
  return record;
}

export interface McpConnectionOptions {
  workspace: string;
  serverEntry?: string;
  tsxEntry?: string;
  stderr?: "pipe" | "inherit";
}

export interface McpConnection {
  client: Client;
  callJson(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export async function connectMcp(
  options: McpConnectionOptions,
): Promise<McpConnection> {
  const serverEntry = options.serverEntry ?? defaultServerEntry;
  const tsxEntry = options.tsxEntry ?? defaultTsxEntry;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxEntry, serverEntry],
    cwd: path.dirname(serverEntry),
    env: {
      ...process.env,
      P0_WORKSPACE: options.workspace,
    } as Record<string, string>,
    stderr: options.stderr ?? "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", () => {});
  }

  const client = new Client(
    { name: "p0-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  return {
    client,
    async callJson(toolName, args) {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return adaptMcpToolResult(toolName, result);
    },
    async close() {
      await client.close();
    },
  };
}
