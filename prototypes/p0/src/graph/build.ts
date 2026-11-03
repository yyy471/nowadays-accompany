import { END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { serializeError } from "../domain/errors.js";
import type {
  RunEvent,
  ToolExecutor,
  ToolReconciler,
} from "../domain/runtime.js";
import type {
  ChatModelPort,
  ModelContext,
  PendingTool,
  ToolCallStatus,
  ToolResultRecord,
} from "../domain/types.js";
import { Barrier } from "../model/barrier.js";
import { ToolOutcomeUnknownError } from "../mcp/executor.js";
import type { BusinessStore } from "../storage/business.js";
import { P0State } from "./state.js";

export interface GraphDeps {
  store: BusinessStore;
  model: ChatModelPort;
  executor: ToolExecutor;
  emit: (event: RunEvent) => void;
  barrier?: Barrier;
  pauseAfterTool?: boolean;
  faultMode?: "commit_fail";
  reconcile?: ToolReconciler;
}

interface LoadedContext {
  roleId: string;
  windowId: string;
  userMessage: string;
  context: ModelContext;
}

interface UnknownResolution {
  status: ToolCallStatus;
  result: unknown;
  error: unknown;
}

export function buildP0Graph(deps: GraphDeps, checkpointer: SqliteSaver) {
  function readContext(executionId: string, turn: number): LoadedContext {
    const execution = deps.store.getExecution(executionId);
    const role = deps.store.getRole(execution.roleId);
    deps.store.recordContextVersion(execution.id, role.stateVersion);
    const triggerMessage = execution.triggerMessageId
      ? deps.store.getMessage(execution.triggerMessageId)
      : undefined;
    const messages = deps.store
      .getContextMessages(execution.windowId)
      .map((row) => ({
        role: row.sender,
        content: row.content,
        status: row.status,
      }));
    const toolResults = deps.store.getToolResults(execution.id);
    return {
      roleId: role.id,
      windowId: execution.windowId,
      userMessage: triggerMessage?.content ?? "",
      context: {
        executionId: execution.id,
        roleId: role.id,
        windowId: execution.windowId,
        turn,
        userMessage: triggerMessage?.content ?? "",
        settings: role.settings,
        state: role.state,
        stateVersion: role.stateVersion,
        messages,
        toolResults,
      },
    };
  }

  function emitContext(
    type: "context_loaded" | "context_refreshed",
    executionId: string,
    loaded: LoadedContext,
  ): void {
    deps.emit({
      type,
      executionId,
      stateVersion: loaded.context.stateVersion,
      toolResults: loaded.context.toolResults.length,
    });
  }

  async function loadContext(state: typeof P0State.State) {
    const loaded = readContext(state.executionId, state.modelTurn);
    emitContext("context_loaded", state.executionId, loaded);
    return loaded;
  }

  async function modelNode(state: typeof P0State.State) {
    // 恢复可能直接落在模型节点；每次决策前都重新读取业务库，不能沿用检查点里的旧 context。
    const loaded = readContext(state.executionId, state.modelTurn);
    emitContext("context_refreshed", state.executionId, loaded);
    const context = loaded.context;

    const decision = await deps.model.decide(context, {
      emit: (chunk) =>
        deps.emit({
          type: "delta",
          executionId: state.executionId,
          text: chunk,
        }),
      ...(deps.barrier ? { barrier: deps.barrier } : {}),
    });
    deps.store.saveDecision({
      executionId: state.executionId,
      turn: context.turn,
      context,
      decision,
    });

    if (decision.type === "tool") {
      const execution = deps.store.getExecution(state.executionId);
      if (execution.status !== "running") {
        deps.emit({
          type: "stale_decision_rejected",
          executionId: state.executionId,
          status: execution.status,
          reason: "tool_request",
          toolName: decision.toolName,
        });
        throw new Error(`EXECUTION_NOT_RUNNING:${execution.status}`);
      }
      return {
        ...loaded,
        pendingTool: {
          toolName: decision.toolName,
          args: decision.args,
        },
        pendingToolStepKey: `${state.executionId}:turn-${context.turn}:${decision.toolName}`,
        modelTurn: context.turn + 1,
      };
    }

    const chunks = decision.chunks ?? [decision.text];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      deps.emit({
        type: "delta",
        executionId: state.executionId,
        text: chunk,
      });
      if (decision.blockAfterChunks === index + 1 && deps.barrier) {
        await deps.barrier.wait(decision.barrierKey ?? "default");
      }
    }
    return {
      ...loaded,
      finalText: decision.text,
      stateUpdate: decision.stateUpdate ?? {},
      pendingTool: null,
      pendingToolStepKey: null,
      modelTurn: context.turn + 1,
    };
  }

  async function registerTool(state: typeof P0State.State) {
    const pending = state.pendingTool;
    if (!pending) {
      throw new Error("NO_PENDING_TOOL");
    }
    const stepKey = state.pendingToolStepKey;
    if (!stepKey) {
      throw new Error("PENDING_TOOL_STEP_KEY_MISSING");
    }
    const execution = deps.store.getExecution(state.executionId);
    if (execution.status !== "running") {
      deps.emit({
        type: "stale_tool_registration_rejected",
        executionId: state.executionId,
        status: execution.status,
        toolName: pending.toolName,
      });
      throw new Error(`EXECUTION_NOT_RUNNING:${execution.status}`);
    }
    const registered = deps.store.registerToolCall({
      executionId: state.executionId,
      roleId: state.roleId,
      goal: `P0 task: ${state.userMessage.slice(0, 80)}`,
      stepKey,
      toolName: pending.toolName,
      args: pending.args,
    });
    deps.emit({
      type: registered.reused
        ? "tool_registration_reused"
        : "tool_registered",
      executionId: state.executionId,
      toolCallId: registered.toolCallId,
      taskId: registered.taskId,
      toolName: pending.toolName,
    });
    return {
      toolCallId: registered.toolCallId,
      taskId: registered.taskId,
    };
  }

  async function resolveUnknown(
    pending: PendingTool,
    error: unknown,
  ): Promise<UnknownResolution> {
    if (deps.reconcile) {
      const outcome = await deps.reconcile({
        toolName: pending.toolName,
        args: pending.args,
        error,
        executor: deps.executor,
      });
      return outcome.status === "success"
        ? { status: "success", result: outcome.result, error: null }
        : { status: outcome.status, result: null, error: outcome.error };
    }
    return { status: "unknown", result: null, error };
  }

  function toOutcome(
    toolCallId: string,
    pending: PendingTool,
    resolution: UnknownResolution,
  ): ToolResultRecord {
    return {
      toolCallId,
      toolName: pending.toolName,
      status: resolution.status,
      result: resolution.result,
      error: resolution.error,
    };
  }

  function saveAndReport(
    state: typeof P0State.State,
    toolCallId: string,
    pending: PendingTool,
    resolution: UnknownResolution,
  ) {
    deps.store.saveToolResult({
      executionId: state.executionId,
      toolCallId,
      status: resolution.status,
      result: resolution.result,
      error: resolution.error,
    });
    deps.emit({
      type: "tool_result_saved",
      executionId: state.executionId,
      toolCallId,
      toolName: pending.toolName,
      status: resolution.status,
    });
    return {
      pendingTool: null,
      pendingToolStepKey: null,
      lastToolOutcome: toOutcome(toolCallId, pending, resolution),
    };
  }

  async function executeTool(state: typeof P0State.State) {
    const pending = state.pendingTool;
    const toolCallId = state.toolCallId;
    if (!pending || !toolCallId) {
      throw new Error("TOOL_CALL_NOT_REGISTERED");
    }

    const savedResult = deps.store.getToolResult(toolCallId);
    if (savedResult) {
      deps.emit({
        type: "tool_result_reused",
        executionId: state.executionId,
        toolCallId,
        toolName: pending.toolName,
        status: savedResult.status,
      });
      return {
        pendingTool: null,
        pendingToolStepKey: null,
        lastToolOutcome: savedResult,
      };
    }

    const toolCall = deps.store.getToolCall(toolCallId);
    if (toolCall.status === "running") {
      // 上一次尝试已发出但结果未确认：先核查，不能重发。
      const resolution = await resolveUnknown(pending, {
        name: "PreviousAttemptRunning",
        message: `Tool call ${toolCallId} was already running without a saved result`,
        code: "PREVIOUS_ATTEMPT_RUNNING",
      });
      return saveAndReport(state, toolCallId, pending, resolution);
    }
    if (toolCall.status !== "pending") {
      throw new Error(`TOOL_CALL_TERMINAL_WITHOUT_RESULT:${toolCall.status}`);
    }

    const execution = deps.store.getExecution(state.executionId);
    if (execution.status !== "running") {
      deps.emit({
        type: "stale_tool_dispatch_rejected",
        executionId: state.executionId,
        status: execution.status,
        toolName: pending.toolName,
      });
      throw new Error(`EXECUTION_NOT_RUNNING:${execution.status}`);
    }

    deps.store.markToolCallRunning(toolCallId);
    deps.emit({
      type: "tool_started",
      executionId: state.executionId,
      toolCallId,
      toolName: pending.toolName,
    });

    let resolution: UnknownResolution;
    try {
      const result = await deps.executor.callTool(
        pending.toolName,
        pending.args,
      );
      resolution = { status: "success", result, error: null };
    } catch (caught) {
      const serialized = serializeError(caught);
      if (caught instanceof ToolOutcomeUnknownError) {
        resolution = await resolveUnknown(pending, serialized);
      } else {
        resolution = { status: "failed", result: null, error: serialized };
      }
    }

    return saveAndReport(state, toolCallId, pending, resolution);
  }

  async function pauseGate(state: typeof P0State.State) {
    const resumeValue = interrupt({
      executionId: state.executionId,
      toolCallId: state.toolCallId,
      phase: "after_tool_result_saved",
    });
    deps.emit({
      type: "resumed",
      executionId: state.executionId,
      value: resumeValue,
    });
    return {};
  }

  async function commitReply(state: typeof P0State.State) {
    if (!state.finalText) {
      throw new Error("FINAL_TEXT_MISSING");
    }
    try {
      const committed = deps.store.commitTurn({
        executionId: state.executionId,
        replyText: state.finalText,
        stateUpdate: state.stateUpdate ?? {},
        ...(deps.faultMode ? { faultMode: deps.faultMode } : {}),
      });
      deps.emit({
        type: "completed",
        executionId: state.executionId,
        replyMessageId: committed.replyMessageId,
        stateVersion: committed.stateVersion,
        alreadyCommitted: committed.alreadyCommitted,
      });
      return {};
    } catch (error) {
      deps.emit({
        type: "commit_failed",
        executionId: state.executionId,
        error: serializeError(error),
      });
      throw error;
    }
  }

  const workflow = new StateGraph(P0State)
    .addNode("load_context", loadContext)
    .addNode("model", modelNode)
    .addNode("register_tool", registerTool)
    .addNode("execute_tool", executeTool)
    .addNode("commit_reply", commitReply)
    .addEdge(START, "load_context")
    .addEdge("load_context", "model")
    .addConditionalEdges(
      "model",
      (state): "tool" | "final" => (state.pendingTool ? "tool" : "final"),
      { tool: "register_tool", final: "commit_reply" },
    )
    .addEdge("register_tool", "execute_tool");

  if (deps.pauseAfterTool) {
    workflow
      .addNode("pause_gate", pauseGate)
      .addEdge("execute_tool", "pause_gate")
      .addEdge("pause_gate", "load_context");
  } else {
    workflow.addEdge("execute_tool", "load_context");
  }

  workflow.addEdge("commit_reply", END);

  return workflow.compile({ checkpointer });
}
