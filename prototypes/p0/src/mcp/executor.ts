import { serializeError } from "../domain/errors.js";
import type {
  ReconcileOutcome,
  ToolExecutor,
  ToolReconciler,
} from "../domain/runtime.js";
import { connectMcp, McpToolError, type McpConnection } from "./client.js";

export class ToolOutcomeUnknownError extends Error {
  readonly code = "TOOL_OUTCOME_UNKNOWN";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ToolOutcomeUnknownError";
  }
}

export class ToolExecutionFailedError extends Error {
  readonly code = "TOOL_EXECUTION_FAILED";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ToolExecutionFailedError";
  }
}

export class McpToolExecutor implements ToolExecutor {
  private connection: McpConnection | null = null;

  constructor(
    private readonly workspace: string,
    private readonly defaultTimeoutMs = 5000,
  ) {}

  private async ensureConnection(): Promise<McpConnection> {
    if (!this.connection) {
      this.connection = await connectMcp({ workspace: this.workspace });
    }
    return this.connection;
  }

  private async dropConnection(): Promise<void> {
    const current = this.connection;
    this.connection = null;
    if (current) {
      await current.close().catch(() => {});
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<unknown> {
    let connection: McpConnection;
    try {
      connection = await this.ensureConnection();
    } catch (error) {
      throw new ToolExecutionFailedError(
        `TOOL_CONNECT_FAILED:${toolName}:${
          error instanceof Error ? error.message : String(error)
        }`,
        serializeError(error),
      );
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ToolOutcomeUnknownError(
            `TOOL_RESPONSE_TIMEOUT:${toolName}:${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        connection.callJson(toolName, args),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof McpToolError) {
        throw new ToolExecutionFailedError(
          `TOOL_CALL_FAILED:${toolName}:${error.message}`,
          serializeError(error),
        );
      }
      if (error instanceof ToolOutcomeUnknownError) {
        await this.dropConnection();
        throw error;
      }
      // 请求已经交给连接后失联：服务器可能已执行，不能当作明确失败。
      await this.dropConnection();
      throw new ToolOutcomeUnknownError(
        `TOOL_RESPONSE_LOST:${toolName}:${
          error instanceof Error ? error.message : String(error)
        }`,
        serializeError(error),
      );
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async close(): Promise<void> {
    await this.dropConnection();
  }
}

export function createNoteWriteReconciler(
  mode: "verify" | "unverifiable",
): ToolReconciler {
  return async ({ toolName, args, executor }): Promise<ReconcileOutcome> => {
    if (mode === "unverifiable") {
      return {
        status: "unknown",
        error: {
          name: "ReconcileUnavailable",
          message: "No readback channel is available for this tool",
          code: "RECONCILE_UNAVAILABLE",
        },
      };
    }
    if (toolName !== "append_note_then_hang") {
      return {
        status: "unknown",
        error: {
          name: "NoReconciler",
          message: `No reconciler registered for ${toolName}`,
          code: "NO_RECONCILER",
        },
      };
    }
    const relativePath = String(args.path ?? "");
    const expectedLine = `${String(args.text ?? "")}\n`;
    try {
      const read = (await executor.callTool(
        "read_note",
        { path: relativePath },
        2000,
      )) as { exists: boolean; content: string };
      if (read.exists && read.content.endsWith(expectedLine)) {
        return {
          status: "success",
          result: {
            reconciled: true,
            path: relativePath,
            content: read.content,
          },
        };
      }
      return {
        status: "unknown",
        error: {
          name: "EffectNotConfirmed",
          message: "Readback did not match the expected side effect",
          code: "EFFECT_NOT_CONFIRMED",
        },
      };
    } catch (error) {
      return {
        status: "unknown",
        error: serializeError(error),
      };
    }
  };
}
