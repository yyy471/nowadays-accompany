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
  | "tool_backgrounded"
  | "tool_result_saved"
  | "message_segments"
  | "segment_annotations"
  | "scene_image_task"
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

export interface MessageSegmentRecord {
  segmentId: string;
  messageId: string;
  windowId: string;
  ordinal: number;
  kind: "speech" | "narration";
  text: string;
  startOffset: number;
  endOffset: number;
  outfitId: string | null;
  spriteAssetId: string | null;
  annotatedAt: string | null;
  createdAt: string;
}

export interface MessageDetail {
  message: MessageRecord;
  segments: MessageSegmentRecord[];
}

/** 打开窗口时读取的未完成回复快照；正文文字仍以流事件为增量。 */
export interface ConversationActiveReply {
  messageId: string;
  executionId: string;
  text: string;
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
  | "autonomy"
  | "task";

export interface ConversationToolContext {
  roleId: string;
  windowId: string;
  executionId: string;
  taskId: string | null;
  autonomous?: boolean;
  /** 本轮开始决策时的业务本地日期，用于每日穿搭登记。 */
  localDate?: string;
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
  /** 状态工具校验后实际并入本轮提交的补丁。 */
  statePatch?: Record<string, unknown>;
}

export interface ConversationTool extends ModelToolSpec {
  source: ConversationToolSource;
  /**
   * 为 true 时按外部工具记录管道落库（tool_calls／tool_results／计量），
   * 但执行体仍由运行时提供，例如 skill_run。
   */
  recorded?: boolean;
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

/** 角色通过 task_pause／task_finish 表达的任务决策，提交回复后生效。 */
export type AgentTaskAction =
  | { kind: "pause"; reason: string; note?: string }
  | {
      kind: "finish";
      status: "completed" | "failed";
      endReason: string;
      note?: string;
    };

export interface BackgroundToolSettlement {
  roleId: string;
  taskId: string | null;
  windowId: string | null;
  executionId: string;
  toolCallId: string;
  toolName: string;
  purpose: "user_chat" | "autonomous";
  outcome: ConversationToolOutcome;
  counted: boolean;
  committed: boolean;
}

export interface AgentRunResult {
  text: string;
  statePatch: Record<string, unknown>;
  rounds: AgentRound[];
  taskId: string | null;
  taskAction: AgentTaskAction | null;
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
