import type { ModelMessage, ModelToolSpec } from "./model.js";
import type {
  ExecutionRecord,
  MessageRecord,
  ToolCallRecord,
  ToolResultRecord,
} from "../storage/role-store.js";

export type ConversationStreamType =
  | "execution_started"
  | "message_delta"
  | "tool_started"
  | "tool_result_saved"
  | "message_completed"
  | "message_interrupted"
  | "execution_superseded"
  | "execution_paused"
  | "execution_failed";

export interface ConversationStreamEvent {
  streamEventId: number;
  roleId: string;
  windowId: string | null;
  executionId: string;
  type: ConversationStreamType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PendingWindow {
  windowId: string;
  firstSequence: number;
  lastCreatedAt: string;
  messageCount: number;
}

export interface ClaimedMessage {
  messageId: string;
  windowId: string;
  content: string;
  sequence: number;
  createdAt: string;
}

export interface ConversationMessageView extends ClaimedMessage {
  sender: "user" | "assistant";
  status: string;
}

export interface ConversationExecutionDetail {
  execution: ExecutionRecord;
  triggerMessages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  latestEvents: ConversationStreamEvent[];
}

export interface ConversationInputState {
  roleId: string;
  windowId: string;
  clientId: string;
  expiresAt: string;
}

export interface ConversationContext {
  roleId: string;
  windowId: string;
  executionId: string;
  displayName: string;
  definitionText: string;
  definitionPayload: Record<string, unknown>;
  state: Record<string, unknown>;
  stateVersion: number;
  pendingMessages: ClaimedMessage[];
  recentMessages: ConversationMessageView[];
  recallBriefs: RecallBrief[];
  skillBriefs: SkillBrief[];
  taskId: string | null;
}

export interface RecallBrief {
  type: "event" | "daily_summary" | "diary";
  id: string;
  title: string;
  snippet: string;
}

export interface SkillBrief {
  name: string;
  description: string;
  directory: string;
}

export type ConversationToolSource =
  | "memory"
  | "skill"
  | "mcp"
  | "state"
  | "autonomy";

export interface ConversationToolContext {
  roleId: string;
  windowId: string;
  executionId: string;
  taskId: string | null;
  autonomous?: boolean;
  signal: AbortSignal;
  checkDispatch?: () => void;
  onDispatch?: () => void;
}

export type ToolOutcomeStatus = "success" | "failed" | "unknown";

export interface ConversationToolOutcome {
  status: ToolOutcomeStatus;
  rawResponse?: unknown;
  adaptedResult?: unknown;
  diagnosticCode?: string;
  error?: unknown;
}

export interface ConversationTool extends ModelToolSpec {
  source: ConversationToolSource;
  execute(
    args: Record<string, unknown>,
    context: ConversationToolContext,
  ): Promise<ConversationToolOutcome>;
}

export interface AgentToolCallRecord {
  wireCallId: string;
  toolCallId: string | null;
  name: string;
  arguments: unknown;
  result: ConversationToolOutcome;
}

export interface AgentRound {
  round: number;
  text: string;
  toolCalls: AgentToolCallRecord[];
}

export interface AgentRunResult {
  text: string;
  statePatch: Record<string, unknown>;
  rounds: AgentRound[];
  taskId: string | null;
}

export interface AgentGraphState {
  executionId: string;
  roleId: string;
  windowId: string;
  round: number;
  messages: ModelMessage[];
  text: string;
  statePatch: Record<string, unknown>;
  rounds: AgentRound[];
  taskId: string | null;
  finalText: string;
}
