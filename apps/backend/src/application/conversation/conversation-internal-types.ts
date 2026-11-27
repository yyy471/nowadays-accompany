import type http from "node:http";
import type { RoleAccess } from "../role/role-access.js";
import type { AdminToolServices } from "../role/admin-tools.js";
import type { AutonomyService } from "./autonomy-service.js";
import type { CredentialResolver } from "../resources/credential-resolver.js";
import type {
  ModelBindingResolver,
  ResolvedModelBinding,
} from "../resources/model-binding-resolver.js";
import type { ModelPort } from "../../domain/model.js";
import type { RoleActivityGate } from "../../domain/role-activity.js";
import type { TokenUsageCallEvent } from "../../domain/token-usage.js";
import type { AppStore } from "../../storage/core/app-store.js";
import type { RoleStorage } from "../../storage/core/role-storage.js";
import type {
  ConversationStore,
} from "../../storage/conversation/conversation-store.js";
import type { ExecutionRecord } from "../../storage/role/role-store.js";
import type {
  AgentSegmentStopKind,
  ClaimedMessage,
} from "../../domain/conversation.js";
import type { AgentToolCatalog } from "./agent-tools.js";
import type { ConversationPromptBuilder } from "./conversation-prompt-builder.js";
import type { ConversationStreamHub } from "./conversation-stream-hub.js";
import type { ConversationRecovery } from "./conversation-recovery.js";
import type { ConversationExecutionRunner } from "./conversation-execution-runner.js";
import type { ConversationScheduler } from "./conversation-scheduler.js";
import type { DialogueBatchDelivery } from "./dialogue-batch-delivery.js";
import type { InputStateRegistry } from "./input-state.js";
import type { MemoryQueryService } from "../memory/memory-query-service.js";
import type { MemoryRuntime } from "../memory/memory-runtime.js";
import type { RoleExchangeService } from "./role-exchanges.js";
import type { SegmentAnnotationService } from "./segment-annotation-service.js";
import type { SceneImageService } from "../media/scene-image-service.js";

export type ChatModelPortFactory = (binding: ResolvedModelBinding) => ModelPort;

export interface RunningExecution {
  roleId: string;
  windowId: string;
  executionId: string;
  controller: AbortController;
  partialText: string;
  superseded: boolean;
  autonomous: boolean;
  promise: Promise<void>;
}

export interface PendingTaskContinuation {
  engineering?: boolean;
  taskId: string;
  windowId: string;
}

export interface AutonomyExecutionContext {
  activityId: string | null;
  wakeId: string | null;
  intent: string;
  resumed: boolean;
}

export interface ResumableExecution {
  execution: ExecutionRecord;
  taskId: string | null;
  taskStatus: string | null;
  taskOrigin: string | null;
  windowId: string;
}

export interface TaskCatalogEntry {
  roleId: string;
  catalog: AgentToolCatalog;
  modelBinding: ResolvedModelBinding;
}

export interface QueueSegmentAnnotationInput {
  roleId: string;
  windowId: string;
  messageId: string;
  executionId: string;
  outfitId?: string | null;
}

export interface RunExecutionInput {
  storage: RoleStorage;
  store: ConversationStore;
  running: RunningExecution;
  execution: ExecutionRecord;
  pendingMessages: ClaimedMessage[];
  taskId?: string | null;
  autonomy?: AutonomyExecutionContext | null;
  resume?: boolean;
}

export interface StreamEventsInput {
  sharesOnly?: boolean;
  roleId: string;
  windowId: string;
  after: number | null;
  clientId: string | null;
  request: http.IncomingMessage;
  response: http.ServerResponse;
}

export interface ConversationState {
  readonly running: Map<string, RunningExecution>;
  /** 正在使用某个模型服务的执行：维护等待按目标服务直接查询（283 §7 R01）。 */
  readonly inflightResources: Map<
    string,
    { roleId: string; resourceId: string }
  >;
  readonly detached: Set<RunningExecution>;
  readonly segmentAnnotations: Map<string, Set<Promise<void>>>;
  readonly annotationControllers: Set<AbortController>;
  /** 等待维护结束的标注：删除角色时可取消，不影响已经发出的调用（283 §13 R03）。 */
  readonly annotationWaitControllers: Map<string, Set<AbortController>>;
  readonly backgroundToolSettles: Set<Promise<void>>;
  readonly backgroundToolsByRole: Map<string, number>;
  /** 按任务计数的在途后台工具：任务终结后要等它们结算再释放资源（283 R03）。 */
  readonly backgroundToolsByTask: Map<string, number>;
  readonly wakeTimers: Map<string, NodeJS.Timeout>;
  readonly firstActivationCredentialTimers: Map<string, NodeJS.Timeout>;
  readonly dueWakeChecks: Map<string, string>;
  readonly pendingContinuations: Map<string, PendingTaskContinuation[]>;
  readonly taskCatalogs: Map<string, TaskCatalogEntry>;
  /** 正在关闭连接的任务目录：释放资源占用要等它们真正收尾（283 R03）。 */
  readonly closingTaskCatalogs: Set<string>;
  /** 任务已终结但仍有在途后台工具：结算后再关闭工具目录（283 R03）。 */
  readonly catalogClosePending: Set<string>;
  readonly activeStreams: Map<() => void, string>;
  readonly blockedWindows: Set<string>;
  closed: boolean;
}

export interface ConversationContext {
  readonly state: ConversationState;
  readonly appStore: AppStore;
  readonly roleAccess: RoleAccess;
  readonly bindings: ModelBindingResolver;
  readonly memory: MemoryQueryService;
  readonly appRoot: string;
  readonly now: () => Date;
  readonly timeZone: string | undefined;
  readonly batchDelayMs: number | undefined;
  readonly autoRecallLimit: number;
  readonly maxToolRounds: number;
  readonly toolForegroundWaitMs: number;
  readonly modelFactory: ChatModelPortFactory;
  readonly usesHttpModel: boolean;
  readonly credentials: CredentialResolver | null;
  readonly segmentAnnotation: SegmentAnnotationService;
  readonly memoryRuntime: MemoryRuntime | null;
  readonly autonomy: AutonomyService | null;
  readonly activity: RoleActivityGate | null;
  readonly isResourceUnderMaintenance: ((resourceId: string) => boolean) | null;
  readonly waitForMaintenanceEnd:
    | ((resourceId: string, signal?: AbortSignal) => Promise<void>)
    | null;
  readonly hasExternalWork: (roleId: string) => boolean;
  readonly adminServices: AdminToolServices | null;
  readonly onModelCallFinished: ((event: TokenUsageCallEvent) => void) | undefined;
  readonly inputStates: InputStateRegistry;
  readonly exchanges: RoleExchangeService;
  readonly batchDelivery: DialogueBatchDelivery;
  readonly resolveModelCredential: (
    binding: ResolvedModelBinding,
  ) => string | undefined;
  autoScenes: SceneImageService | null;
  prompt: ConversationPromptBuilder;
  streams: ConversationStreamHub;
  recovery: ConversationRecovery;
  runner: ConversationExecutionRunner;
  scheduler: ConversationScheduler;
  schedule(roleId: string): boolean;
  withConversationStore<T>(
    roleId: string,
    action: (store: ConversationStore) => T,
  ): T;
  queueSegmentAnnotation(input: QueueSegmentAnnotationInput): void;
}

/** 该类收尾轮的系统指令所需的分段停止原因；供执行驱动与提示词共用。 */
export type SegmentHaltKind = AgentSegmentStopKind;
