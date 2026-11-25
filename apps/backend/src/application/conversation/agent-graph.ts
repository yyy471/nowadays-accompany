import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  AutonomyBudgetExhaustedError,
  ExecutionSupersededError,
  ModelRequestFailedError,
  TaskEndedError,
  ToolBackgroundedError,
} from "../../domain/errors.js";
import type {
  AgentRound,
  AgentRunResult,
  AgentSegmentStopKind,
  AgentTaskAction,
  AgentToolCallRecord,
  BackgroundToolSettlement,
  ConversationTool,
  ConversationToolContext,
  ConversationToolOutcome,
} from "../../domain/conversation.js";
import {
  isIncompleteCompletion,
  type MemoryDelivery,
  type ModelContinuation,
  type ModelMessage,
  type ModelMessageSource,
  type ModelPort,
  type ModelProtocol,
  type ModelToolCall,
  type ModelToolSpec,
  type ModelUsage,
} from "../../domain/model.js";
import { mergeModelUsage, type TokenUsageCallEvent } from "../../domain/token-usage.js";
import { webReadingReference } from "../../domain/web-reading.js";
import type { ModelProvider } from "../../domain/model-providers.js";
import type { WorldbookSelection } from "../../domain/worldbook.js";
import type { ConversationStore } from "../../storage/conversation/conversation-store.js";
import type { RoleStore } from "../../storage/role/role-store.js";
import { decisionQuery, selectAgentContext, type AgentSystemPrompt } from "./agent-context.js";

export interface AgentModelHandle {
  model: ModelPort;
  resourceId: string;
  modelName: string;
  protocol: ModelProtocol;
  provider?: ModelProvider;
  baseUrl?: string;
  maxInputChars?: number;
  maxOutputChars?: number;
}

export interface AgentToolReservation {
  counted: boolean;
  committed: boolean;
  commit(): void;
  cancel(): void;
}

export interface AgentCallMeter {
  consume(kind: "model" | "tool"): boolean;
  reserveTool(toolCallId: string): AgentToolReservation;
}

export interface AgentGraphDeps {
  store: ConversationStore;
  roleStore: RoleStore;
  resolveModel: () => AgentModelHandle;
  tools: ConversationTool[];
  systemPrompt: (messages: readonly ModelMessage[], round: number) => string | AgentSystemPrompt;
  evidenceQuery?: (taskId: string | null) => string;
  selectEvidence?: (input: {
    roleId: string;
    windowId: string;
    taskId: string | null;
    query: string;
    messages: readonly ModelMessage[];
    initialRound: boolean;
  }) => ModelMessage[];
  prepareModelMessages?: (messages: readonly ModelMessage[]) => ModelMessage[];
  onModelAccepted?: (input: {
    worldbookSelection: WorldbookSelection[];
    memoryReads: MemoryDelivery[];
    roleId: string;
    windowId: string;
    taskId: string | null;
    executionId: string;
    modelCallId: string;
    messages: readonly ModelMessage[];
  }) => void;
  signal: AbortSignal;
  checkRunning: () => void;
  /** 可保存节点入口的停止检查；中途吐字不检查，避免半句落库。 */
  checkStopBoundary?: () => void;
  /** 外部工具派发前的检查；转后台后由服务改用新的存储句柄核对任务。 */
  checkDispatch?: () => void;
  emitDelta: (text: string) => void;
  ensureTask: () => string;
  now: () => Date;
  /** 本轮开始决策时的业务本地日期。 */
  localDate?: string;
  maxToolRounds?: number;
  purpose?: "user_chat" | "autonomous";
  meter?: AgentCallMeter | null;
  /** 外部工具前台等待窗口（毫秒），0 表示不启用自动转后台。 */
  toolForegroundWaitMs?: number;
  /** 慢工具在后台结算（真实结果已保存）后的回调。 */
  onBackgroundToolSettled?: (settlement: BackgroundToolSettlement) => void;
  /** 工具越过前台窗口转入后台时通知服务更新派发检查上下文。 */
  onToolBackgrounded?: () => void;
  /** 转后台时登记仍在执行的工具 promise，供空闲判断与退出时等待结算。 */
  registerBackgroundTool?: (settlement: Promise<void>, roleId: string) => void;
  /** 本段即将收尾（轮次上限、显式续行、暂停或熔断）时通知服务调整系统提示。 */
  onSegmentHalt?: (kind: AgentSegmentStopKind) => void;
  /** 模型调用结束时上报全局 Token 账本（DL-183）。 */
  onModelCallFinished?: (event: TokenUsageCallEvent) => void;
}

/** 办事任务单段执行上限；达到后提交进度回复并自动切段续行（DL-154）。 */
export const DEFAULT_MAX_TOOL_ROUNDS = 15;

/** 同一工具／错误码连续失败达到该次数即熔断（DL-154）。 */
export const CIRCUIT_FAILURE_THRESHOLD = 3;

/** 角色有意重申的短句直接流出。只比较同一执行紧邻工具轮、已经发布的整段。 */
const MIN_TOOL_ROUND_ECHO_CHARS = 48;

function previousToolRoundText(state: AgentGraphValue): string {
  if (state.round === 0 || state.messages.at(-1)?.role !== "tool") return "";
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]!;
    if (message.role === "tool") continue;
    if (message.role === "assistant" && message.toolCalls?.length &&
        state.text.endsWith(message.content) && Array.from(message.content.trim()).length >= MIN_TOOL_ROUND_ECHO_CHARS) {
      return message.content;
    }
    break;
  }
  return "";
}

interface PendingToolCall {
  wireCallId: string;
  name: string;
  arguments: unknown;
}

interface AgentGraphValue {
  executionId: string;
  roleId: string;
  windowId: string;
  round: number;
  messages: ModelMessage[];
  text: string;
  lastRoundEchoOnly: boolean;
  pendingCalls: PendingToolCall[];
  statePatch: Record<string, unknown>;
  rounds: AgentRound[];
  taskAction: AgentTaskAction | null;
  taskId: string | null;
  modelCallId: string | null;
  wireMapping: Record<string, string>;
  stopKind: AgentSegmentStopKind | null;
  successfulToolCalls: number;
  progressNotes: number;
}

const AgentState = Annotation.Root({
  executionId: Annotation<string>(),
  roleId: Annotation<string>(),
  windowId: Annotation<string>(),
  round: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  messages: Annotation<ModelMessage[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  text: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  lastRoundEchoOnly: Annotation<boolean>({ reducer: (_previous, next) => next, default: () => false }),
  pendingCalls: Annotation<PendingToolCall[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  statePatch: Annotation<Record<string, unknown>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  rounds: Annotation<AgentRound[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  taskAction: Annotation<AgentTaskAction | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  taskId: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  modelCallId: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  wireMapping: Annotation<Record<string, string>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  stopKind: Annotation<AgentSegmentStopKind | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  successfulToolCalls: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  progressNotes: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
});

type AgentStateValue = typeof AgentState.State;

export class ToolRoundLimitError extends Error {
  readonly code = "TOOL_ROUND_LIMIT";

  constructor(maxRounds: number) {
    super(`单次决策达到 ${maxRounds} 个模型／工具回合上限`);
    this.name = "ToolRoundLimitError";
  }
}

export class AgentGraphRunner {
  private readonly toolMap: Map<string, ConversationTool>;
  private readonly maxToolRounds: number;
  private readonly graph: ReturnType<typeof buildGraph>;
  private resuming = false;
  private firstModelBoundary = true;
  /** 本次执行开始时的任务编号；用于判断轮次上限后能否续行。 */
  private initialTaskId: string | null = null;

  constructor(
    private readonly deps: AgentGraphDeps,
    checkpointer: SqliteSaver,
  ) {
    this.toolMap = new Map(deps.tools.map((tool) => [tool.name, tool]));
    this.maxToolRounds = deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.graph = buildGraph(this, checkpointer);
  }

  async run(input: {
    executionId: string;
    roleId: string;
    windowId: string;
    messages: ModelMessage[];
    taskId?: string | null;
    resume?: boolean;
  }): Promise<AgentRunResult> {
    this.resuming = input.resume === true;
    this.firstModelBoundary = true;
    this.initialTaskId = input.taskId ?? null;
    const initialState: AgentGraphValue = {
      executionId: input.executionId,
      roleId: input.roleId,
      windowId: input.windowId,
      round: 0,
      messages: input.messages,
      text: "",
      lastRoundEchoOnly: false,
      pendingCalls: [],
      statePatch: {},
      rounds: [],
      taskAction: null,
      taskId: input.taskId ?? null,
      modelCallId: null,
      wireMapping: {},
      stopKind: null,
      successfulToolCalls: 0,
      progressNotes: 0,
    };
    const result = (await this.graph.invoke(
      input.resume === true ? (null as unknown as AgentGraphValue) : initialState,
      {
        configurable: { thread_id: input.executionId },
        recursionLimit: this.maxToolRounds * 2 + 6,
      },
    )) as AgentGraphValue;
    return {
      text: result.text,
      lastRoundEchoOnly: result.lastRoundEchoOnly === true,
      statePatch: result.statePatch,
      rounds: result.rounds,
      taskId: result.taskId,
      taskAction: result.taskAction ?? null,
      segment: {
        stopKind: result.stopKind ?? null,
        successfulToolCalls: result.successfulToolCalls ?? 0,
        progressNotes: result.progressNotes ?? 0,
      },
    };
  }

  async modelNode(state: AgentStateValue): Promise<Partial<AgentGraphValue>> {
    return this.modelRound(state, true);
  }

  /** 收尾轮：工具清单照旧提供以保持上下文稳定，但返回的调用一律不派发。 */
  async closingNode(state: AgentStateValue): Promise<Partial<AgentGraphValue>> {
    return this.modelRound(state, false);
  }

  private async modelRound(
    state: AgentStateValue,
    allowTools: boolean,
  ): Promise<Partial<AgentGraphValue>> {
    this.deps.checkStopBoundary?.();
    this.deps.checkRunning();
    this.checkTask(state.roleId, state.taskId);
    const current = this.deps.resolveModel();
    const prompt = this.deps.systemPrompt(state.messages, state.round);
    const evidenceQuery = this.deps.evidenceQuery?.(state.taskId) ?? "";
    const evidence = this.deps.selectEvidence?.({
      roleId: state.roleId,
      windowId: state.windowId,
      taskId: state.taskId,
      query: decisionQuery(evidenceQuery, state.messages),
      messages: state.messages,
      initialRound: state.round === 0,
    }) ?? [];
    const currentIndex = state.messages.findIndex((message) =>
      message.source?.currentUserRequest === true || (
        message.role === "assistant" && message.toolCalls !== undefined
      ),
    );
    const evidenceIndex = currentIndex < 0 ? state.messages.length : currentIndex;
    const messages = [
      ...state.messages.slice(0, evidenceIndex),
      ...evidence,
      ...state.messages.slice(evidenceIndex),
    ];
    const resuming = this.resuming && this.firstModelBoundary;
    const originalModel = resuming && state.modelCallId !== null
      ? this.deps.roleStore.db.prepare(
          "SELECT 1 FROM model_calls WHERE model_call_id = ? AND role_id = ? AND resource_id = ?",
        ).get(state.modelCallId, state.roleId, current.resourceId) !== undefined
      : true;
    const { worldbookSelection, memoryReads, ...request } = selectAgentContext({
      request: {
        modelName: current.modelName,
        resourceId: current.resourceId,
        sessionId: `${state.roleId}/${state.windowId}`,
        system: "",
        messages: this.deps.prepareModelMessages?.(messages) ?? messages,
        // 收尾仍提供工具定义；返回的调用一律不派发。
        tools: this.toolSpecs(),
        signal: this.deps.signal,
      },
      prompt: typeof prompt === "string" ? { required: prompt, optional: [] } : prompt,
      protocol: current.protocol,
      ...(current.provider === undefined ? {} : { provider: current.provider }),
      baseUrl: current.baseUrl ?? "",
      ...(current.maxInputChars === undefined ? {} : { maxInputChars: current.maxInputChars }),
      ...(current.maxOutputChars === undefined ? {} : { maxOutputChars: current.maxOutputChars }),
      resuming,
      originalModelResource: originalModel,
      evidenceQuery,
    });
    this.firstModelBoundary = false;
    this.deps.checkRunning();
    const counted = this.deps.meter?.consume("model") ?? false;
    const callId = this.deps.store.startModelCall({
      executionId: state.executionId,
      resourceId: current.resourceId,
      modelName: current.modelName,
      protocol: current.protocol,
      taskId: state.taskId,
      callKind: "primary_decision",
      purpose: this.deps.purpose ?? "user_chat",
      counted,
      now: this.deps.now().toISOString(),
    });
    let roundText = "";
    const previous = previousToolRoundText(state);
    let comparingPrefix = previous.length > 0;
    let echoChars = 0;
    // 只暂存仍与上一轮相同的开头。第一次出现差异时，把暂存内容原样交付。
    const publish = (chunk: string): void => {
      const offset = roundText.length;
      roundText += chunk;
      if (!comparingPrefix) {
        this.deps.emitDelta(chunk);
        return;
      }
      const prefixLength = Math.min(previous.length - offset, chunk.length);
      if (!previous.startsWith(chunk.slice(0, prefixLength), offset)) {
        comparingPrefix = false;
        this.deps.emitDelta(roundText);
      } else if (roundText.length >= previous.length) {
        comparingPrefix = false;
        echoChars = previous.length;
        const remainder = chunk.slice(prefixLength);
        if (remainder) this.deps.emitDelta(remainder);
      }
    };
    const flushPartialPrefix = (): void => {
      if (!comparingPrefix || !roundText) return;
      comparingPrefix = false;
      this.deps.emitDelta(roundText);
    };
    let accepted = false;
    const onAccepted = (): void => {
      if (accepted) return;
      accepted = true;
      this.deps.onModelAccepted?.({
        roleId: state.roleId,
        windowId: state.windowId,
        taskId: state.taskId,
        executionId: state.executionId,
        modelCallId: callId,
        messages: request.messages,
        memoryReads,
        worldbookSelection,
      });
    };
    const calls: PendingToolCall[] = [];
    let usage: ModelUsage | null = null;
    let completed: {
      stopReason: string;
      incomplete?: boolean;
      continuation?: ModelContinuation;
      rawResponse?: unknown;
    } | null = null;
    let streamFailure: { error: unknown } | null = null;
    try {
      for await (const event of current.model.stream({ ...request, onAccepted })) {
        // 注入适配器以第一个已产生的事件证明已实际消费请求。
        if (!this.deps.signal.aborted) onAccepted();
        if (event.type === "text_delta") {
          publish(event.text);
          continue;
        }
        if (event.type === "tool_call") {
          calls.push({
            wireCallId: event.callId,
            name: event.name,
            arguments: event.arguments,
          });
          continue;
        }
        if (event.type === "usage") {
          usage = mergeModelUsage(usage, event);
          continue;
        }
        completed = {
          stopReason: event.stopReason,
          ...(event.incomplete === undefined
            ? {}
            : { incomplete: event.incomplete }),
          ...(event.continuation === undefined
            ? {}
            : { continuation: { ...event.continuation, resourceId: current.resourceId } }),
          ...(event.rawResponse === undefined
            ? {}
            : { rawResponse: event.rawResponse }),
        };
      }
      flushPartialPrefix();
      if (completed === null) {
        throw new ModelRequestFailedError("模型流未收到完整终态", {
          reason: "STREAM_TRUNCATED",
        });
      }
      if (isIncompleteCompletion(completed)) {
        throw new ModelRequestFailedError("模型响应显式不完整", {
          reason: "INCOMPLETE_RESPONSE",
          stopReason: completed.stopReason,
        });
      }
    } catch (error) {
      streamFailure = { error };
    }
    const finishedAt = this.deps.now().toISOString();
    const callStatus: "succeeded" | "failed" =
      streamFailure === null && completed !== null ? "succeeded" : "failed";
    // 角色库 finishModelCall 与全局账本上报相互隔离：避免角色并发删除或写库异常吞掉已发生的消耗，也防止成功调用误报 failed。
    try {
      if (streamFailure === null && completed !== null) {
        this.deps.store.finishModelCall({
          modelCallId: callId,
          status: "succeeded",
          errorCode: null,
          usage,
          rawResponse: completed.rawResponse,
          continuation: completed.continuation,
          now: finishedAt,
        });
      } else {
        const failureError = streamFailure?.error;
        this.deps.store.finishModelCall({
          modelCallId: callId,
          status: "failed",
          errorCode:
            failureError instanceof Error && "code" in failureError
              ? String((failureError as { code?: unknown }).code)
              : "MODEL_REQUEST_FAILED",
          ...(usage === null ? {} : { usage }),
          now: finishedAt,
        });
      }
    } finally {
      this.deps.onModelCallFinished?.({
        sourceCallId: `role:${state.roleId}:${callId}`,
        roleId: state.roleId,
        resourceId: current.resourceId,
        modelName: current.modelName,
        protocol: current.protocol,
        category: this.deps.purpose === "autonomous" ? "autonomy" : "dialogue",
        status: callStatus,
        occurredAt: finishedAt,
        usage,
      });
    }
    if (streamFailure !== null) {
      // 未满整段即断流仍是部分有效正文。已被用户新消息打断时，旧执行禁止再吐字。
      if (!this.deps.signal.aborted) flushPartialPrefix();
      throw streamFailure.error;
    }
    if (completed === null) {
      throw new ModelRequestFailedError("模型流未收到完整终态", {
        reason: "STREAM_TRUNCATED",
      });
    }
    this.deps.checkRunning();
    const delivery = {
      text: state.text + roundText.slice(echoChars),
      lastRoundEchoOnly: echoChars > 0 && echoChars === roundText.length,
    };
    const toolCalls: ModelToolCall[] = calls.map((call) => ({
      callId: call.wireCallId,
      name: call.name,
      arguments: call.arguments,
    }));
    const assistant: ModelMessage = {
      role: "assistant",
      content: roundText,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(completed.continuation === undefined
        ? {}
        : { continuation: completed.continuation }),
    };
    if (calls.length === 0) {
      return {
        messages: [...state.messages, assistant],
        ...delivery,
        pendingCalls: [],
        modelCallId: callId,
        round: state.round + 1,
      };
    }
    if (!allowTools) {
      // 收尾轮模型仍想调用工具时不再派发：本轮只提交文字说明。
      return {
        messages: [...state.messages, { role: "assistant", content: roundText }],
        ...delivery,
        pendingCalls: [],
        modelCallId: callId,
        round: state.round + 1,
      };
    }
    if (state.round + 1 >= this.maxToolRounds) {
      // 办事任务达到单段上限：本轮已请求的调用在工具节点按「未派发」回填，
      // 由收尾轮汇报已保存的进度；任务保持 active 交回服务排队续行（DL-154）。
      // 无任务的普通对话仍按原失败语义处理。
      if (state.taskId === null && this.initialTaskId === null) {
        throw new ToolRoundLimitError(this.maxToolRounds);
      }
      this.deps.onSegmentHalt?.("round_limit");
      return {
        messages: [...state.messages, assistant],
        ...delivery,
        pendingCalls: calls,
        modelCallId: callId,
        round: state.round + 1,
        stopKind: "round_limit",
      };
    }
    return {
      messages: [...state.messages, assistant],
      ...delivery,
      pendingCalls: calls,
      modelCallId: callId,
      round: state.round + 1,
    };
  }

  async toolsNode(state: AgentStateValue): Promise<Partial<AgentGraphValue>> {
    this.deps.checkStopBoundary?.();
    this.deps.checkRunning();
    this.checkTask(state.roleId, state.taskId);
    const toolMessages: ModelMessage[] = [];
    const roundRecords: AgentToolCallRecord[] = [];
    let taskAction = state.taskAction;
    const mapping: Record<string, string> = { ...state.wireMapping };
    let taskId = state.taskId;
    let statePatch = state.statePatch;
    let stopKind = state.stopKind;
    let successfulToolCalls = state.successfulToolCalls;
    let progressNotes = state.progressNotes;
    const pendingWireIds = new Set(
      state.pendingCalls.map((call) => call.wireCallId),
    );
    let sourceAssistantIndex = -1;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index];
      if (
        message?.role === "assistant" &&
        message.toolCalls?.some((call) => pendingWireIds.has(call.callId))
      ) {
        sourceAssistantIndex = index;
        break;
      }
    }
    const sourceAssistant =
      sourceAssistantIndex >= 0 ? state.messages[sourceAssistantIndex] : undefined;
    // 无服务端续传材料时可安全改用内部调用编号，使后续请求与业务记录一致。
    const normalizeCallIds =
      this.resuming &&
      sourceAssistant !== undefined &&
      sourceAssistant.role === "assistant" &&
      sourceAssistant.continuation === undefined;
    const checkDispatch = (): void => {
      this.deps.checkRunning();
      this.checkTask(state.roleId, taskId);
    };
    for (const [index, call] of state.pendingCalls.entries()) {
      this.deps.checkRunning();
      this.checkTask(state.roleId, taskId);
      if (stopKind !== null) {
        // 本段已停止派发（暂停／续行／熔断／轮次上限）：同批剩余调用标为未派发，
        // 仍需给出配对的工具结果消息，保持下一轮请求结构合法。
        const outcome = failedOutcome(
          skippedCode(stopKind),
          "本段已停止派发，该调用未执行",
        );
        roundRecords.push({
          wireCallId: call.wireCallId,
          toolCallId: null,
          name: call.name,
          arguments: call.arguments,
          result: outcome,
        });
        toolMessages.push(toolResultMessage(call, outcome));
        continue;
      }
      const tool = this.toolMap.get(call.name);
      if (!tool) {
        const outcome = failedOutcome(
          call.name.startsWith("ext_") ? "EXTENSION_UNAVAILABLE" : "UNKNOWN_TOOL",
          `模型请求了不存在的工具 ${call.name}`,
        );
        roundRecords.push({
          wireCallId: call.wireCallId,
          toolCallId: null,
          name: call.name,
          arguments: call.arguments,
          result: outcome,
        });
        toolMessages.push(toolResultMessage(call, outcome));
        continue;
      }
      if (tool.source === "state") {
        const args = asObject(call.arguments);
        const outcome = await this.executeInternal(tool, call, state, taskId, index, checkDispatch);
        const patch =
          outcome.status === "success"
            ? (outcome.statePatch ?? patchOf(args))
            : null;
        if (patch !== null) {
          statePatch = { ...statePatch, ...patch };
        }
        roundRecords.push({
          wireCallId: call.wireCallId,
          toolCallId: null,
          name: call.name,
          arguments: call.arguments,
          result: outcome,
        });
        toolMessages.push(toolResultMessage(call, outcome, {
          internalStepKey: internalToolStepKey(state, index, call.name),
        }));
        continue;
      }
      const recorded = typeof tool.recorded === "function" ? tool.recorded(asObject(call.arguments) ?? {}) : tool.recorded;
      if (tool.source !== "mcp" && !recorded) {
        const outcome = await this.executeInternal(tool, call, state, taskId, index, checkDispatch);
        // 一次互聊唤醒只决策一个发言。工具已双边落库后直接结束该图，无需再消耗一轮模型额度。
        if (tool.source === "autonomy" && tool.name === "role_chat_reply" && outcome.status === "success") {
          roundRecords.push({ wireCallId: call.wireCallId, toolCallId: null, name: call.name, arguments: call.arguments, result: outcome });
          taskAction = { kind: "finish", status: "completed", endReason: "ROLE_EXCHANGE_DELIVERED" };
          break;
        }
        if (tool.source === "task" && outcome.status === "success") {
          taskAction = taskActionFromArgs(call.name, call.arguments) ?? taskAction;
          if (call.name === "task_progress") {
            progressNotes += 1;
          }
          if (
            call.name === "task_pause" ||
            call.name === "task_continue" ||
            call.name === "task_finish"
          ) {
            const note = asObject(call.arguments)?.note;
            if (typeof note === "string" && note.trim().length > 0) {
              progressNotes += 1;
            }
          }
          if (call.name === "task_pause") {
            // 立即停止派发同批后续工具，下一节点只允许产出澄清说明（DL-158）。
            stopKind = "pause_requested";
            this.deps.onSegmentHalt?.("pause_requested");
          } else if (call.name === "task_continue") {
            // 模型显式声明分段续行：本段收尾后由服务排队下一执行段（DL-154）。
            stopKind = "continue_requested";
            this.deps.onSegmentHalt?.("continue_requested");
          }
        }
        roundRecords.push({
          wireCallId: call.wireCallId,
          toolCallId: null,
          name: call.name,
          arguments: call.arguments,
          result: outcome,
        });
        toolMessages.push(toolResultMessage(call, outcome, {
          internalStepKey: internalToolStepKey(state, index, call.name),
        }));
        continue;
      }
      const args = asObject(call.arguments);
      if (args === null) {
        const outcome = failedOutcome(
          "INVALID_TOOL_ARGUMENTS",
          "外部工具参数必须是对象",
        );
        roundRecords.push({
          wireCallId: call.wireCallId,
          toolCallId: null,
          name: call.name,
          arguments: call.arguments,
          result: outcome,
        });
        toolMessages.push(toolResultMessage(call, outcome));
        continue;
      }
      taskId ??= this.deps.ensureTask();
      const stepKey = `${state.executionId}:round-${state.round}:call-${index}`;
      const begun = this.deps.roleStore.beginToolCall({
        roleId: state.roleId,
        taskId,
        executionId: state.executionId,
        stepKey,
        toolName: call.name,
        args,
      });
      const toolCallId = begun.toolCall.toolCallId;
      mapping[call.wireCallId] = toolCallId;
      const resultCall = normalizeCallIds
        ? { ...call, wireCallId: toolCallId }
        : call;
      const reservation = begun.duplicate
        ? null
        : this.reserveToolMeter(toolCallId);
      let outcome: ConversationToolOutcome;
      try {
        if (begun.duplicate) {
          try {
            const saved = this.deps.roleStore.getToolResult(
              state.roleId,
              toolCallId,
            );
            outcome = {
              status: saved.status,
              rawResponse: saved.rawResponse,
              adaptedResult: saved.adaptedResult,
              ...(saved.diagnosticCode === null
                ? {}
                : { diagnosticCode: saved.diagnosticCode }),
              ...(saved.error === null ? {} : { error: saved.error }),
            };
          } catch {
            outcome = await this.executeExternal(
              tool,
              call,
              args,
              state,
              taskId,
              toolCallId,
              null,
            );
          }
        } else {
          outcome = await this.executeExternalTracked(
            tool,
            call,
            args,
            state,
            taskId,
            toolCallId,
            reservation,
            () => {
              // 转后台后执行随之结束，已累计的调用编号映射需要先持久化。
              if (state.modelCallId !== null) {
                this.deps.store.attachWireCallIds(state.modelCallId, mapping);
              }
            },
          );
        }
      } catch (error) {
        if (!(error instanceof ToolBackgroundedError)) {
          reservation?.cancel();
        }
        throw error;
      }
      roundRecords.push({
        wireCallId: call.wireCallId,
        toolCallId,
        name: call.name,
        arguments: call.arguments,
        result: checkpointToolOutcome(outcome),
      });
      toolMessages.push(toolResultMessage(resultCall, outcome, { toolCallId }));
      if (!begun.duplicate && outcome.status === "success") {
        successfulToolCalls += 1;
      }
      // 同一工具／错误码连续失败达到阈值即熔断，同批剩余调用不再派发（DL-154）。
      const streak = this.failureStreak(state.roleId, taskId);
      if (streak !== null && streak.count >= CIRCUIT_FAILURE_THRESHOLD) {
        stopKind = "circuit_breaker";
        this.deps.onSegmentHalt?.("circuit_breaker");
      }
    }
    if (state.modelCallId !== null) {
      this.deps.store.attachWireCallIds(state.modelCallId, mapping);
    }
    const normalizedMessages =
      normalizeCallIds && sourceAssistantIndex >= 0
        ? state.messages.map((message, index) => {
            if (
              index !== sourceAssistantIndex ||
              message.role !== "assistant" ||
              message.toolCalls === undefined
            ) {
              return message;
            }
            return {
              ...message,
              toolCalls: message.toolCalls.map((toolCall) => {
                const normalized = mapping[toolCall.callId];
                return normalized === undefined
                  ? toolCall
                  : { ...toolCall, callId: normalized };
              }),
            };
          })
        : state.messages;
    return {
      ...(roundRecords.at(-1)?.name === "role_chat_reply" && taskAction?.kind === "finish" && taskAction.endReason === "ROLE_EXCHANGE_DELIVERED" ? {text: "本轮角色间发言已送达。"} : {}),
      messages: [...normalizedMessages, ...toolMessages],
      pendingCalls: [],
      rounds: [
        ...state.rounds,
        {
          round: state.round,
          text: "",
          toolCalls: roundRecords,
        },
      ],
      statePatch,
      taskAction,
      taskId,
      wireMapping: mapping,
      stopKind,
      successfulToolCalls,
      progressNotes,
    };
  }

  /** 连续失败查询只影响熔断判定，存储异常时按「无连续失败」处理。 */
  private failureStreak(
    roleId: string,
    taskId: string | null,
  ): { count: number; toolName: string; code: string } | null {
    if (taskId === null) {
      return null;
    }
    try {
      return this.deps.roleStore.taskToolFailureStreak(roleId, taskId);
    } catch {
      return null;
    }
  }

  private checkTask(roleId: string, taskId: string | null): void {
    if (taskId === null) {
      return;
    }
    let status: string;
    try {
      status = this.deps.roleStore.getTask(roleId, taskId).status;
    } catch {
      status = "missing";
    }
    if (status !== "active") {
      throw new TaskEndedError(taskId, status);
    }
  }

  private beginExternal(
    state: AgentStateValue,
    taskId: string,
    toolCallId: string,
    toolName: string,
  ): void {
    this.deps.roleStore.markToolCallRunning(state.roleId, toolCallId);
    this.deps.store.appendStreamEvent({
      windowId: state.windowId,
      executionId: state.executionId,
      type: "tool_started",
      payload: {
        executionId: state.executionId,
        toolCallId,
        toolName,
      },
      now: this.deps.now().toISOString(),
    });
  }

  private externalContext(
    state: AgentStateValue,
    taskId: string,
    reservation: AgentToolReservation | null,
  ): ConversationToolContext {
    return {
      roleId: state.roleId,
      windowId: state.windowId,
      executionId: state.executionId,
      taskId,
      autonomous: this.deps.purpose === "autonomous",
      ...(this.deps.localDate === undefined
        ? {}
        : { localDate: this.deps.localDate }),
      signal: this.deps.signal,
      checkDispatch: () => {
        if (this.deps.checkDispatch !== undefined) {
          this.deps.checkDispatch();
          return;
        }
        this.deps.checkRunning();
        this.checkTask(state.roleId, taskId);
      },
      ...(reservation === null
        ? {}
        : {
            onDispatch: () => {
              reservation.commit();
            },
          }),
    };
  }

  /** 保存外部工具结果、结算计量并追加流事件；前台路径的统一收尾。 */
  private settleExternal(
    state: AgentStateValue,
    taskId: string,
    toolCallId: string,
    reservation: AgentToolReservation | null,
    outcome: ConversationToolOutcome,
  ): void {
    const shouldRecord = reservation === null || reservation.committed;
    if (!shouldRecord) {
      reservation?.cancel();
    }
    this.deps.roleStore.saveToolResult({
      roleId: state.roleId,
      toolCallId,
      status: outcome.status,
      ...(outcome.rawResponse === undefined
        ? {}
        : { rawResponse: outcome.rawResponse }),
      ...(outcome.adaptedResult === undefined
        ? {}
        : { adaptedResult: outcome.adaptedResult }),
      ...(outcome.diagnosticCode === undefined
        ? {}
        : { diagnosticCode: outcome.diagnosticCode }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    if (shouldRecord) {
      this.recordExternalToolMetering(state, taskId, toolCallId, reservation);
    }
    this.deps.store.appendStreamEvent({
      windowId: state.windowId,
      executionId: state.executionId,
      type: "tool_result_saved",
      payload: {
        executionId: state.executionId,
        toolCallId,
        status: outcome.status,
      },
      now: this.deps.now().toISOString(),
    });
  }

  private async executeExternal(
    tool: ConversationTool,
    call: PendingToolCall,
    args: Record<string, unknown>,
    state: AgentStateValue,
    taskId: string,
    toolCallId: string,
    reservation: AgentToolReservation | null,
  ): Promise<ConversationToolOutcome> {
    this.beginExternal(state, taskId, toolCallId, call.name);
    let outcome: ConversationToolOutcome;
    try {
      outcome = await tool.execute(
        args,
        this.externalContext(state, taskId, reservation),
      );
    } catch (error) {
      if (
        error instanceof TaskEndedError ||
        error instanceof ExecutionSupersededError ||
        error instanceof AutonomyBudgetExhaustedError
      ) {
        if (reservation !== null && !reservation.committed) {
          reservation.cancel();
        }
        const stopped = failedOutcome(error.code, error.message);
        this.deps.roleStore.saveToolResult({
          roleId: state.roleId,
          toolCallId,
          status: stopped.status,
          ...(stopped.adaptedResult === undefined
            ? {}
            : { adaptedResult: stopped.adaptedResult }),
          ...(stopped.diagnosticCode === undefined
            ? {}
            : { diagnosticCode: stopped.diagnosticCode }),
          ...(stopped.error === undefined ? {} : { error: stopped.error }),
        });
        if (reservation?.committed === true) {
          this.recordExternalToolMetering(
            state,
            taskId,
            toolCallId,
            reservation,
          );
        }
        throw error;
      }
      if (reservation !== null && !reservation.committed) {
        reservation.cancel();
      }
      outcome = failedOutcome(
        error instanceof Error && "code" in error
          ? String((error as { code?: unknown }).code)
          : "TOOL_EXECUTION_FAILED",
        error instanceof Error ? error.message : "工具执行失败",
      );
    }
    this.settleExternal(state, taskId, toolCallId, reservation, outcome);
    return outcome;
  }

  /**
   * 带前台等待窗口的外部工具执行：工具在窗口内完成则走前台路径；
   * 越过窗口则记录模式变化、持久化已累计的调用编号映射并抛出
   * ToolBackgroundedError，工具调用本身继续在后台执行，真实结果
   * 保存后经 onBackgroundToolSettled 交回原任务。
   */
  private async executeExternalTracked(
    tool: ConversationTool,
    call: PendingToolCall,
    args: Record<string, unknown>,
    state: AgentStateValue,
    taskId: string,
    toolCallId: string,
    reservation: AgentToolReservation | null,
    onBackgrounded: () => void,
  ): Promise<ConversationToolOutcome> {
    const waitMs = this.deps.toolForegroundWaitMs ?? 0;
    if (!(waitMs > 0)) {
      return this.executeExternal(
        tool,
        call,
        args,
        state,
        taskId,
        toolCallId,
        reservation,
      );
    }
    this.beginExternal(state, taskId, toolCallId, call.name);
    let settled = false;
    let settledOutcome: ConversationToolOutcome | undefined;
    let settledError: { error: unknown; structured: boolean } | undefined;
    let settlementError: unknown = undefined;
    let backgrounded = false;
    const classifyError = (
      error: unknown,
    ): { outcome: ConversationToolOutcome; structured: boolean } => {
      const structured =
        error instanceof TaskEndedError ||
        error instanceof ExecutionSupersededError ||
        error instanceof AutonomyBudgetExhaustedError;
      const code =
        error instanceof Error && "code" in error
          ? String((error as { code?: unknown }).code)
          : "TOOL_EXECUTION_FAILED";
      const message = error instanceof Error ? error.message : "工具执行失败";
      return { outcome: failedOutcome(code, message), structured };
    };
    const reportSettlement = (outcome: ConversationToolOutcome): void => {
      try {
        if (reservation !== null && !reservation.committed) {
          reservation.cancel();
        }
        this.deps.onBackgroundToolSettled?.({
          roleId: state.roleId,
          taskId,
          windowId: state.windowId,
          executionId: state.executionId,
          toolCallId,
          toolName: call.name,
          purpose: this.deps.purpose ?? "user_chat",
          outcome,
          counted: reservation?.counted ?? false,
          committed: reservation?.committed ?? false,
        });
      } catch {
        // 执行已转后台，结算失败留给启动恢复按未知结果处理。
      }
    };
    const executePromise = tool.execute(
      args,
      this.externalContext(state, taskId, reservation),
    );
    // 结算处理器先于 Promise.race 挂载，保证边界竞争时先记录结算结果。
    void executePromise.then(
      (outcome) => {
        if (backgrounded) {
          reportSettlement(outcome);
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        settledOutcome = outcome;
        try {
          this.settleExternal(state, taskId, toolCallId, reservation, outcome);
        } catch (error) {
          // 前台结算失败需要传回图执行，由既有失败路径记录并从检查点恢复。
          settlementError = error;
        }
      },
      (error) => {
        const { outcome, structured } = classifyError(error);
        try {
          if (reservation !== null && !reservation.committed) {
            reservation.cancel();
          }
        } catch (cancelError) {
          if (!backgrounded) {
            settlementError = cancelError;
          }
        }
        if (backgrounded) {
          reportSettlement(outcome);
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        settledError = { error, structured };
        if (structured) {
          try {
            this.deps.roleStore.saveToolResult({
              roleId: state.roleId,
              toolCallId,
              status: outcome.status,
              ...(outcome.adaptedResult === undefined
                ? {}
                : { adaptedResult: outcome.adaptedResult }),
              ...(outcome.diagnosticCode === undefined
                ? {}
                : { diagnosticCode: outcome.diagnosticCode }),
              ...(outcome.error === undefined ? {} : { error: outcome.error }),
            });
            if (reservation?.committed === true) {
              this.recordExternalToolMetering(
                state,
                taskId,
                toolCallId,
                reservation,
              );
            }
          } catch (saveError) {
            settlementError ??= saveError;
          }
          return;
        }
        settledOutcome = outcome;
        try {
          this.settleExternal(state, taskId, toolCallId, reservation, outcome);
        } catch (settleError) {
          settlementError ??= settleError;
        }
      },
    );
    let timer: NodeJS.Timeout | null = null;
    const waitPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(reject, waitMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([executePromise, waitPromise]);
      if (settlementError !== undefined) {
        throw settlementError;
      }
      return outcome;
    } catch (error) {
      if (settled) {
        // 工具恰好压在窗口边界完成，按前台结果处理。
        if (settlementError !== undefined) {
          throw settlementError;
        }
        if (settledError !== undefined) {
          if (settledError.structured) {
            throw settledError.error;
          }
          return settledOutcome ?? failedOutcome("TOOL_EXECUTION_FAILED", "工具执行失败");
        }
        return settledOutcome ?? failedOutcome("TOOL_EXECUTION_FAILED", "工具执行失败");
      }
      try {
        this.deps.checkRunning();
      } catch {
        // 执行已被新消息替代或任务已停止：不再转后台，等工具实际结算后
        // 由原执行收尾，避免在结果保存前排队任务续行。
        return await executePromise;
      }
      backgrounded = true;
      this.deps.onToolBackgrounded?.();
      this.deps.roleStore.switchToolCallMode({
        roleId: state.roleId,
        toolCallId,
        mode: "background",
      });
      this.deps.store.appendStreamEvent({
        windowId: state.windowId,
        executionId: state.executionId,
        type: "tool_backgrounded",
        payload: {
          executionId: state.executionId,
          toolCallId,
          toolName: call.name,
        },
        now: this.deps.now().toISOString(),
      });
      onBackgrounded();
      this.deps.registerBackgroundTool?.(
        executePromise.then(
          () => undefined,
          () => undefined,
        ),
        state.roleId,
      );
      throw new ToolBackgroundedError(toolCallId, taskId, state.windowId);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  private recordExternalToolMetering(
    state: AgentStateValue,
    taskId: string,
    toolCallId: string,
    reservation: AgentToolReservation | null,
  ): void {
    this.deps.store.recordToolMetering({
      executionId: state.executionId,
      taskId,
      toolCallId,
      purpose: this.deps.purpose ?? "user_chat",
      counted: reservation?.counted ?? false,
      now: this.deps.now().toISOString(),
    });
  }

  private toolSpecs(): ModelToolSpec[] {
    const tools = this.deps.tools;
    this.toolMap.clear();
    for (const tool of tools) this.toolMap.set(tool.name, tool);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  private reserveToolMeter(toolCallId: string): AgentToolReservation | null {
    if (
      this.deps.purpose !== "autonomous" ||
      this.deps.meter === null ||
      this.deps.meter === undefined
    ) {
      return null;
    }
    return this.deps.meter.reserveTool(toolCallId);
  }

  private meterTool(): boolean {
    if (this.deps.meter === null || this.deps.meter === undefined) {
      return false;
    }
    return this.deps.meter.consume("tool");
  }

  private async executeInternal(
    tool: ConversationTool,
    call: PendingToolCall,
    state: AgentStateValue,
    taskId: string | null,
    index: number,
    checkDispatch: () => void,
  ): Promise<ConversationToolOutcome> {
    const stepKey = internalToolStepKey(state, index, call.name);
    const previous = this.deps.store.getInternalToolReceipt(state.executionId, stepKey);
    if (previous?.outcome !== null && previous?.outcome !== undefined) return previous.outcome;
    const common = {
      executionId: state.executionId,
      windowId: state.windowId,
      taskId,
      stepKey,
      toolName: call.name,
      purpose: this.deps.purpose ?? "user_chat",
    };
    if (previous !== null) {
      // 实际副作用可能已完成，不能因节点检查点未保存就重复执行。
      const outcome: ConversationToolOutcome = {
        status: "unknown",
        diagnosticCode: "PROCESS_INTERRUPTED",
        adaptedResult: { error: { code: "PROCESS_INTERRUPTED", message: "内部操作已进入执行，结果尚未确认，请先核查实际记录。" } },
      };
      this.deps.store.saveInternalToolReceipt({ ...common, counted: previous.counted, outcome, now: this.deps.now().toISOString() });
      return outcome;
    }
    const counted = this.deps.purpose === "autonomous" ? this.meterTool() : false;
    this.deps.store.saveInternalToolReceipt({ ...common, counted, now: this.deps.now().toISOString() });
    let outcome: ConversationToolOutcome;
    try {
      outcome = await tool.execute(asObject(call.arguments) ?? {}, {
        roleId: state.roleId,
        windowId: state.windowId,
        executionId: state.executionId,
        taskId,
        autonomous: this.deps.purpose === "autonomous",
        ...(this.deps.localDate === undefined
          ? {}
          : { localDate: this.deps.localDate }),
        signal: this.deps.signal,
        checkDispatch,
      });
    } catch (error) {
      const diagnostic = failedOutcome(
        error instanceof Error && "code" in error ? String(error.code) : "TOOL_EXECUTION_FAILED",
        error instanceof Error ? error.message : "内部工具执行失败",
      );
      // 抛错可能发生在副作用之后；明确失败由工具返回，未返回的结果保留未知。
      this.deps.store.saveInternalToolReceipt({ ...common, counted, outcome: { ...diagnostic, status: "unknown" }, now: this.deps.now().toISOString() });
      throw error;
    }
    this.deps.store.saveInternalToolReceipt({ ...common, counted, outcome, now: this.deps.now().toISOString() });
    return outcome;
  }
}

function buildGraph(deps: AgentGraphRunner, checkpointer: SqliteSaver) {
  return new StateGraph(AgentState)
    .addNode("model", (state) => deps.modelNode(state))
    .addNode("tools", (state) => deps.toolsNode(state))
    .addNode("closing", (state) => deps.closingNode(state))
    .addEdge(START, "model")
    .addConditionalEdges("model", (state) =>
      state.pendingCalls.length > 0 ? "tools" : END,
    )
    // 本段已决定停止派发时，工具节点之后只做一轮无工具的收尾说明就结束。
    .addConditionalEdges("tools", (state) => {
      if (state.taskAction?.kind === "finish" && state.taskAction.endReason === "ROLE_EXCHANGE_DELIVERED" &&
        state.rounds.at(-1)?.toolCalls.at(-1)?.name === "role_chat_reply") return END;
      return state.stopKind !== null ? "closing" : "model";
    })
    .addEdge("closing", END)
    .compile({ checkpointer });
}

/** 未派发调用的诊断码：区分暂停、续行、熔断与轮次上限四种收尾原因。 */
function skippedCode(kind: AgentSegmentStopKind): string {
  switch (kind) {
    case "pause_requested":
      return "TOOL_SKIPPED_AFTER_PAUSE";
    case "continue_requested":
      return "TOOL_SKIPPED_AFTER_CONTINUE";
    case "circuit_breaker":
      return "TOOL_SKIPPED_AFTER_CIRCUIT_BREAKER";
    case "round_limit":
      return "TOOL_SKIPPED_AFTER_ROUND_LIMIT";
  }
}

function toolResultMessage(
  call: PendingToolCall,
  outcome: ConversationToolOutcome,
  source?: ModelMessageSource,
): ModelMessage {
  return {
    role: "tool",
    toolCallId: call.wireCallId,
    toolName: call.name,
    ...(source === undefined ? {} : { source: { ...source, ...(outcome.memoryReads ? { memoryReads: outcome.memoryReads } : {}) } }),
    content: JSON.stringify({
        status: outcome.status,
        ...(outcome.diagnosticCode === undefined
          ? {}
          : { diagnosticCode: outcome.diagnosticCode }),
        result: outcome.adaptedResult ?? null,
    }),
  };
}

function checkpointToolOutcome(outcome: ConversationToolOutcome): ConversationToolOutcome {
  if (outcome.status !== "success" || !webReadingReference(outcome.adaptedResult)) return outcome;
  // 预取原文留在外部工具事实，图检查点仅保存可恢复的来源引用。
  const { rawResponse: _rawResponse, ...record } = outcome;
  return record;
}

function internalToolStepKey(state: AgentStateValue, index: number, toolName: string): string {
  return `tool:${state.executionId}:${state.round}:${index}:${toolName}`;
}

function failedOutcome(
  code: string,
  message: string,
): ConversationToolOutcome {
  return {
    status: "failed",
    diagnosticCode: code,
    adaptedResult: { error: { code, message } },
    error: { code, message },
  };
}

function patchOf(args: unknown): Record<string, unknown> | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const patch = (args as { patch?: unknown }).patch;
  return patch !== null &&
    typeof patch === "object" &&
    !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : null;
}

/**
 * 从 task_pause／task_finish 的调用参数推导任务决策。
 * 工具执行成功后才生效；崩溃重放时由参数重新推导，天然幂等。
 */
function taskActionFromArgs(
  toolName: string,
  args: unknown,
): AgentTaskAction | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const record = args as Record<string, unknown>;
  if (toolName === "task_pause") {
    const reason =
      typeof record.reason === "string" ? record.reason.trim() : "";
    if (reason.length === 0) {
      return null;
    }
    return {
      kind: "pause",
      reason,
      ...(typeof record.note === "string" && record.note.length > 0
        ? { note: record.note }
        : {}),
    };
  }
  if (toolName === "task_finish") {
    const status =
      record.status === "completed" || record.status === "failed"
        ? record.status
        : null;
    const endReason =
      typeof record.endReason === "string" ? record.endReason.trim() : "";
    if (status === null || endReason.length === 0) {
      return null;
    }
    return {
      kind: "finish",
      status,
      endReason,
      ...(typeof record.note === "string" && record.note.length > 0
        ? { note: record.note }
        : {}),
    };
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
