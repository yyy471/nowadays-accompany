import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  AutonomyBudgetExhaustedError,
  ExecutionSupersededError,
  ModelRequestFailedError,
  TaskEndedError,
} from "../domain/errors.js";
import type {
  AgentRound,
  AgentRunResult,
  AgentToolCallRecord,
  ConversationTool,
  ConversationToolOutcome,
} from "../domain/conversation.js";
import {
  isIncompleteCompletion,
  type ModelContinuation,
  type ModelMessage,
  type ModelPort,
  type ModelToolCall,
  type ModelToolSpec,
} from "../domain/model.js";
import type { ConversationStore } from "../storage/conversation-store.js";
import type { RoleStore } from "../storage/role-store.js";

export interface AgentModelHandle {
  model: ModelPort;
  resourceId: string;
  modelName: string;
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages";
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
  systemPrompt: () => string;
  signal: AbortSignal;
  checkRunning: () => void;
  emitDelta: (text: string) => void;
  ensureTask: () => string;
  now: () => Date;
  maxToolRounds?: number;
  purpose?: "user_chat" | "autonomous";
  meter?: AgentCallMeter | null;
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
  pendingCalls: PendingToolCall[];
  statePatch: Record<string, unknown>;
  rounds: AgentRound[];
  taskId: string | null;
  modelCallId: string | null;
  wireMapping: Record<string, string>;
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

  constructor(
    private readonly deps: AgentGraphDeps,
    checkpointer: SqliteSaver,
  ) {
    this.toolMap = new Map(deps.tools.map((tool) => [tool.name, tool]));
    this.maxToolRounds = deps.maxToolRounds ?? 8;
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
    const initialState: AgentGraphValue = {
      executionId: input.executionId,
      roleId: input.roleId,
      windowId: input.windowId,
      round: 0,
      messages: input.messages,
      text: "",
      pendingCalls: [],
      statePatch: {},
      rounds: [],
      taskId: input.taskId ?? null,
      modelCallId: null,
      wireMapping: {},
    };
    const result = (await this.graph.invoke(
      input.resume === true ? (null as unknown as AgentGraphValue) : initialState,
      {
        configurable: { thread_id: input.executionId },
        recursionLimit: this.maxToolRounds * 2 + 4,
      },
    )) as AgentGraphValue;
    return {
      text: result.text,
      statePatch: result.statePatch,
      rounds: result.rounds,
      taskId: result.taskId,
    };
  }

  async modelNode(state: AgentStateValue): Promise<Partial<AgentGraphValue>> {
    this.deps.checkRunning();
    this.checkTask(state.roleId, state.taskId);
    const current = this.deps.resolveModel();
    const counted = this.deps.meter?.consume("model") ?? false;
    const callId = this.deps.store.startModelCall({
      executionId: state.executionId,
      resourceId: current.resourceId,
      modelName: current.modelName,
      protocol: current.protocol,
      purpose: this.deps.purpose ?? "user_chat",
      counted,
      now: this.deps.now().toISOString(),
    });
    let roundText = "";
    const calls: PendingToolCall[] = [];
    let usage: { inputTokens?: number; outputTokens?: number } | null = null;
    let completed: {
      stopReason: string;
      incomplete?: boolean;
      continuation?: ModelContinuation;
      rawResponse?: unknown;
    } | null = null;
    try {
      for await (const event of current.model.stream({
        modelName: current.modelName,
        system: this.deps.systemPrompt(),
        messages: state.messages,
        tools: this.toolSpecs(),
        signal: this.deps.signal,
      })) {
        if (event.type === "text_delta") {
          this.deps.emitDelta(event.text);
          roundText += event.text;
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
          usage = {
            ...(event.inputTokens === undefined
              ? {}
              : { inputTokens: event.inputTokens }),
            ...(event.outputTokens === undefined
              ? {}
              : { outputTokens: event.outputTokens }),
          };
          continue;
        }
        completed = {
          stopReason: event.stopReason,
          ...(event.incomplete === undefined
            ? {}
            : { incomplete: event.incomplete }),
          ...(event.continuation === undefined
            ? {}
            : { continuation: event.continuation }),
          ...(event.rawResponse === undefined
            ? {}
            : { rawResponse: event.rawResponse }),
        };
      }
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
      this.deps.store.finishModelCall({
        modelCallId: callId,
        status: "succeeded",
        errorCode: null,
        usage,
        rawResponse: completed.rawResponse,
        continuation: completed.continuation,
        now: this.deps.now().toISOString(),
      });
    } catch (error) {
      this.deps.store.finishModelCall({
        modelCallId: callId,
        status: "failed",
        errorCode:
          error instanceof Error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "MODEL_REQUEST_FAILED",
        now: this.deps.now().toISOString(),
      });
      throw error;
    }
    this.deps.checkRunning();
    const text = state.text + roundText;
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
        text,
        pendingCalls: [],
        modelCallId: callId,
        round: state.round + 1,
      };
    }
    if (state.round + 1 >= this.maxToolRounds) {
      throw new ToolRoundLimitError(this.maxToolRounds);
    }
    return {
      messages: [...state.messages, assistant],
      text,
      pendingCalls: calls,
      modelCallId: callId,
      round: state.round + 1,
    };
  }

  async toolsNode(state: AgentStateValue): Promise<Partial<AgentGraphValue>> {
    this.deps.checkRunning();
    this.checkTask(state.roleId, state.taskId);
    const toolMessages: ModelMessage[] = [];
    const roundRecords: AgentToolCallRecord[] = [];
    const mapping: Record<string, string> = { ...state.wireMapping };
    let taskId = state.taskId;
    let statePatch = state.statePatch;
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
      const tool = this.toolMap.get(call.name);
      if (!tool) {
        const outcome = failedOutcome(
          "UNKNOWN_TOOL",
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
        const patch = outcome.status === "success" ? patchOf(args) : null;
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
        toolMessages.push(toolResultMessage(call, outcome));
        continue;
      }
      if (tool.source !== "mcp") {
        const outcome = await this.executeInternal(tool, call, state, taskId, index, checkDispatch);
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
          outcome = await this.executeExternal(
            tool,
            call,
            args,
            state,
            taskId,
            toolCallId,
            reservation,
          );
        }
      } catch (error) {
        reservation?.cancel();
        throw error;
      }
      roundRecords.push({
        wireCallId: call.wireCallId,
        toolCallId,
        name: call.name,
        arguments: call.arguments,
        result: outcome,
      });
      toolMessages.push(toolResultMessage(resultCall, outcome));
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
      taskId,
      wireMapping: mapping,
    };
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

  private async executeExternal(
    tool: ConversationTool,
    call: PendingToolCall,
    args: Record<string, unknown>,
    state: AgentStateValue,
    taskId: string,
    toolCallId: string,
    reservation: AgentToolReservation | null,
  ): Promise<ConversationToolOutcome> {
    this.deps.roleStore.markToolCallRunning(state.roleId, toolCallId);
    this.deps.store.appendStreamEvent({
      windowId: state.windowId,
      executionId: state.executionId,
      type: "tool_started",
      payload: {
        executionId: state.executionId,
        toolCallId,
        toolName: call.name,
      },
      now: this.deps.now().toISOString(),
    });
    let outcome: ConversationToolOutcome;
    try {
      outcome = await tool.execute(args, {
        roleId: state.roleId,
        windowId: state.windowId,
        executionId: state.executionId,
        taskId,
        autonomous: this.deps.purpose === "autonomous",
        signal: this.deps.signal,
        checkDispatch: () => {
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
      });
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
      this.recordExternalToolMetering(
        state,
        taskId,
        toolCallId,
        reservation,
      );
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
    return outcome;
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
    return this.deps.tools.map((tool) => ({
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
    const stepKey = `tool:${state.executionId}:${state.round}:${index}:${call.name}`;
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
    .addEdge(START, "model")
    .addConditionalEdges("model", (state) =>
      state.pendingCalls.length > 0 ? "tools" : END,
    )
    .addEdge("tools", "model")
    .compile({ checkpointer });
}

function toolResultMessage(
  call: PendingToolCall,
  outcome: ConversationToolOutcome,
): ModelMessage {
  return {
    role: "tool",
    toolCallId: call.wireCallId,
    toolName: call.name,
    content: truncate(
      JSON.stringify({
        status: outcome.status,
        ...(outcome.diagnosticCode === undefined
          ? {}
          : { diagnosticCode: outcome.diagnosticCode }),
        result: outcome.adaptedResult ?? null,
      }),
      8000,
    ),
  };
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

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit
    ? value
    : `${chars.slice(0, limit).join("")}\n[内容已截断]`;
}
