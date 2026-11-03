import type { ToolCallStatus, ToolResultRecord } from "../domain/types.js";

export interface RunEvent {
  type: string;
  executionId: string;
  [key: string]: unknown;
}

export interface ToolReconcileInput {
  toolName: string;
  args: Record<string, unknown>;
  error: unknown;
  executor: ToolExecutor;
}

export type ReconcileOutcome =
  | { status: "success"; result: unknown }
  | { status: "failed"; error: unknown }
  | { status: "unknown"; error: unknown };

export type ToolReconciler = (
  input: ToolReconcileInput,
) => Promise<ReconcileOutcome>;

export interface ToolExecutor {
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type { ToolCallStatus, ToolResultRecord };
