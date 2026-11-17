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
  | "execution_failed"
  | "task_cancelled";

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

/** 已接收但暂未安排回复的原因；用于桌面端区分排队、停止与缺少模型。 */
export type ConversationWaitReason =
  | "ROLE_STOPPED"
  | "MODEL_MISSING"
  | "BUSY"
  | "WINDOW_BLOCKED"
  | "QUEUE_PENDING";

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
  /** 回复落库时确定的服饰主页立绘（standee）素材；历史按素材标识读取。 */
  homeAssetId: string | null;
  voiceEmotion: string | null;
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
  | "task"
  | "admin";

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

/**
 * 单段执行的结束原因（DL-154 / DL-158）：
 * - `round_limit`：达到单段模型／工具轮次上限，任务继续保持 active 并自动续行；
 * - `continue_requested`：模型显式调用 task_continue 声明分段落续行；
 * - `pause_requested`：模型调用 task_pause，本段停止派发并转为等待用户澄清；
 * - `circuit_breaker`：同一工具／错误码连续失败或连续多段无进展，强制熔断暂停。
 */
export type AgentSegmentStopKind =
  | "round_limit"
  | "continue_requested"
  | "pause_requested"
  | "circuit_breaker";

export interface AgentSegmentSummary {
  /** 本段结束原因；正常回复为 null。 */
  stopKind: AgentSegmentStopKind | null;
  /** 本段成功结算的外部／记录型工具调用数（用于续行无进展熔断）。 */
  successfulToolCalls: number;
  /** 本段保存的进度笔记数（含 task_pause／task_finish 附带的笔记）。 */
  progressNotes: number;
}

export interface AgentRunResult {
  text: string;
  statePatch: Record<string, unknown>;
  rounds: AgentRound[];
  taskId: string | null;
  taskAction: AgentTaskAction | null;
  segment: AgentSegmentSummary;
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
