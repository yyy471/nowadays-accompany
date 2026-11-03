export type MessageStatus = "received" | "completed" | "interrupted";

export type ExecutionStatus =
  | "running"
  | "paused"
  | "completed"
  | "superseded"
  | "failed";

export type ToolCallStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "unknown";

export type TaskStatus = "active" | "paused" | "completed" | "failed";

export interface PendingTool {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  result: unknown;
  error: unknown;
}

export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
}

export interface ModelContext {
  executionId: string;
  roleId: string;
  windowId: string;
  turn: number;
  userMessage: string;
  settings: Record<string, unknown>;
  state: Record<string, unknown>;
  stateVersion: number;
  messages: ContextMessage[];
  toolResults: ToolResultRecord[];
}

export type ModelDecision =
  | {
      type: "tool";
      toolName: string;
      args: Record<string, unknown>;
      rationale?: string;
    }
  | {
      type: "final";
      text: string;
      stateUpdate?: Record<string, unknown>;
      chunks?: string[];
      blockAfterChunks?: number;
      barrierKey?: string;
    };

export interface ModelOptions {
  emit(chunk: string): void;
  barrier?: {
    wait(key: string): Promise<void>;
  };
}

export interface ChatModelPort {
  decide(context: ModelContext, options: ModelOptions): Promise<ModelDecision>;
}
