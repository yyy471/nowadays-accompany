import { Annotation } from "@langchain/langgraph";
import type {
  ModelContext,
  PendingTool,
  ToolResultRecord,
} from "../domain/types.js";

export const P0State = Annotation.Root({
  executionId: Annotation<string>(),
  roleId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  windowId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  userMessage: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  modelTurn: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  context: Annotation<ModelContext | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  pendingTool: Annotation<PendingTool | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  pendingToolStepKey: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  toolCallId: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  taskId: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  lastToolOutcome: Annotation<ToolResultRecord | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  finalText: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  stateUpdate: Annotation<Record<string, unknown> | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
});

export type P0StateValue = typeof P0State.State;
