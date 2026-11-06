import { ModelBindingMissingError } from "../domain/errors.js";
import {
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_MEMORY_RETRY_DELAYS_MS,
  DEFAULT_OUTPUT_RESERVE_CHARS,
  type MemoryFormationInput,
  type MemoryModelCapacity,
  type MemoryModelPort,
} from "../domain/memory.js";
import { isIncompleteCompletion, type ModelPort } from "../domain/model.js";
import { resolveCredential } from "../model/credentials.js";
import { HttpModelAdapter } from "../model/protocols.js";
import { rolePaths } from "../bootstrap/config.js";
import type { AppStore } from "../storage/app-store.js";
import { MemoryStore } from "../storage/memory-store.js";
import { RoleStorage } from "../storage/role-storage.js";
import { MemoryService } from "./memory-service.js";
import type { ModelBindingResolver, ResolvedModelBinding } from "./model-binding-resolver.js";
import type { RoleAccess } from "./role-access.js";

export type MemoryModelFactory = (
  binding: ResolvedModelBinding,
) => MemoryModelPort;

export interface MemoryRuntimeOptions {
  timeZone?: string;
  now?: () => Date;
  enabled?: boolean;
  idleMs?: number;
}

interface QueueState {
  running: boolean;
  pendingEvidence: boolean;
  pendingTaskIds: string[];
  pendingManual: boolean;
  pendingScheduled: boolean;
  promise: Promise<void> | null;
}

const IDLE_WAKE_MS = 60_000;
const MAINTENANCE_RECHECK_MS = 3_600_000;

export class MemoryRuntime {
  private readonly queues = new Map<string, QueueState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly timeZone: string | undefined;
  private readonly now: () => Date;
  private readonly enabled: boolean;
  private readonly idleWakeMs: number;
  private readonly modelFactory: MemoryModelFactory;
  private readonly customModelFactory: boolean;
  private readonly appRoot: string;
  private closed = false;

  constructor(
    private readonly appStore: AppStore,
    private readonly roleAccess: RoleAccess,
    private readonly bindings: ModelBindingResolver,
    appRoot: string,
    private readonly dataRoot: string,
    options: MemoryRuntimeOptions & { modelFactory?: MemoryModelFactory } = {},
  ) {
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
    this.enabled = options.enabled ?? true;
    this.idleWakeMs = options.idleMs ?? IDLE_WAKE_MS;
    this.appRoot = appRoot;
    this.customModelFactory = options.modelFactory !== undefined;
    this.modelFactory =
      options.modelFactory ??
      ((binding) => this.createHttpMemoryModel(binding));
  }

  recoverOnStartup(): number {
    if (!this.enabled || this.closed) {
      return 0;
    }
    const now = this.now().toISOString();
    let recovered = 0;
    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") {
        continue;
      }
      try {
        const storage = RoleStorage.openExisting(
          rolePaths(this.dataRoot, index.roleId),
        );
        try {
          recovered += new MemoryStore(
            storage.business.db,
          ).recoverInterruptedBatches(index.roleId, now);
        } finally {
          storage.close();
        }
        this.armTimer(index.roleId);
      } catch {
        // 单个角色损坏不应阻止后端启动；读取时仍会返回存储错误。
      }
    }
    return recovered;
  }

  notifyEvidence(roleId: string): void {
    this.enqueue(roleId, (queue) => {
      queue.pendingEvidence = true;
    });
  }

  notifyTaskFinished(roleId: string, taskId: string): void {
    this.enqueue(roleId, (queue) => {
      if (!queue.pendingTaskIds.includes(taskId)) {
        queue.pendingTaskIds.push(taskId);
      }
    });
  }

  runPending(roleId: string): Promise<void> {
    return this.enqueue(roleId, (queue) => {
      queue.pendingManual = true;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await Promise.all(
      [...this.queues.values()]
        .map((queue) => queue.promise)
        .filter((promise): promise is Promise<void> => promise !== null),
    );
  }

  private enqueue(
    roleId: string,
    mark: (queue: QueueState) => void,
  ): Promise<void> {
    if (!this.enabled || this.closed) {
      return Promise.resolve();
    }
    const queue = this.queues.get(roleId) ?? {
      running: false,
      pendingEvidence: false,
      pendingTaskIds: [],
      pendingManual: false,
      pendingScheduled: false,
      promise: null,
    };
    this.queues.set(roleId, queue);
    mark(queue);
    if (queue.running) {
      return queue.promise ?? Promise.resolve();
    }
    queue.running = true;
    queue.promise = this.drain(roleId, queue).finally(() => {
      queue.running = false;
      queue.promise = null;
      if (
        queue.pendingEvidence ||
        queue.pendingTaskIds.length > 0 ||
        queue.pendingManual ||
        queue.pendingScheduled
      ) {
        void this.drain(roleId, queue);
      }
    });
    return queue.promise;
  }

  private async drain(roleId: string, queue: QueueState): Promise<void> {
    try {
      while (
        queue.pendingEvidence ||
        queue.pendingTaskIds.length > 0 ||
        queue.pendingManual ||
        queue.pendingScheduled
      ) {
        const evidence = queue.pendingEvidence;
        const taskIds = queue.pendingTaskIds.splice(0);
        const manual = queue.pendingManual;
        const scheduled = queue.pendingScheduled;
        queue.pendingEvidence = false;
        queue.pendingManual = false;
        queue.pendingScheduled = false;
        try {
          await this.runOnce(roleId, { evidence, taskIds, manual, scheduled });
        } catch {
          // 后台整理失败保留待处理证据，下次触发或重启后继续重试。
        }
      }
    } finally {
      this.armTimer(roleId);
    }
  }

  private armTimer(roleId: string): void {
    if (!this.enabled || this.closed) {
      return;
    }
    const existing = this.timers.get(roleId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(roleId);
    }
    let wakeAt: number | null = null;
    try {
      const storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
      try {
        const store = new MemoryStore(storage.business.db);
        const retryAt = store.nextFailedRetryAt(roleId);
        if (retryAt !== null) {
          wakeAt = Date.parse(retryAt);
        }
        const maintenanceRetryAt = this.maintenanceRetryAt(store, roleId);
        if (maintenanceRetryAt !== null) {
          const at = Date.parse(maintenanceRetryAt);
          if (wakeAt === null || at < wakeAt) {
            wakeAt = at;
          }
        }
        const maintenanceCheckAt = this.maintenanceCheckAt(store, roleId);
        if (maintenanceCheckAt !== null) {
          const at = Date.parse(maintenanceCheckAt);
          if (wakeAt === null || at < wakeAt) {
            wakeAt = at;
          }
        }
        for (const stats of store.pendingMessageStats(roleId)) {
          if (stats.count < 30) {
            continue;
          }
          const idleAt = Date.parse(stats.lastOccurredAt) + this.idleWakeMs;
          if (wakeAt === null || idleAt < wakeAt) {
            wakeAt = idleAt;
          }
        }
      } finally {
        storage.close();
      }
    } catch {
      return;
    }
    if (wakeAt === null || Number.isNaN(wakeAt)) {
      return;
    }
    const delay = Math.max(0, wakeAt - this.now().getTime());
    const timer = setTimeout(() => {
      this.timers.delete(roleId);
      void this.enqueue(roleId, (queue) => {
        queue.pendingScheduled = true;
      });
    }, delay);
    timer.unref?.();
    this.timers.set(roleId, timer);
  }

  private maintenanceRetryAt(store: MemoryStore, roleId: string): string | null {
    const latest = store.latestMaintenanceBatch(roleId);
    if (
      latest === null ||
      latest.status !== "failed" ||
      latest.finishedAt === null
    ) {
      return null;
    }
    if (
      store.listRefineCandidates(roleId, store.getCurrentRound(roleId))
        .length === 0
    ) {
      return null;
    }
    const index = Math.min(
      Math.max(latest.attemptCount - 1, 0),
      DEFAULT_MEMORY_RETRY_DELAYS_MS.length - 1,
    );
    return new Date(
      Date.parse(latest.finishedAt) +
        (DEFAULT_MEMORY_RETRY_DELAYS_MS[index] ?? 3_600_000),
    ).toISOString();
  }

  private maintenanceCheckAt(
    store: MemoryStore,
    roleId: string,
  ): string | null {
    if (
      store.listRefineCandidates(roleId, store.getCurrentRound(roleId))
        .length === 0
    ) {
      return null;
    }
    const latest = store.latestMaintenanceBatch(roleId);
    if (latest === null) {
      // 首次出现候选时立即安排一次维护检查。
      return this.now().toISOString();
    }
    if (latest.status !== "completed" || latest.finishedAt === null) {
      return null;
    }
    return new Date(
      Date.parse(latest.finishedAt) + MAINTENANCE_RECHECK_MS,
    ).toISOString();
  }

  private createHttpMemoryModel(binding: ResolvedModelBinding): MemoryModelPort {
    return new HttpMemoryModel(
      new HttpModelAdapter(
        binding.config,
        resolveCredential(this.appRoot, binding.config.credentialRef),
      ),
      binding,
    );
  }

  private async runOnce(
    roleId: string,
    input: {
      evidence: boolean;
      taskIds: string[];
      manual: boolean;
      scheduled: boolean;
    },
  ): Promise<void> {
    let binding: ResolvedModelBinding;
    try {
      binding = this.bindings.resolveMemory(roleId);
    } catch (error) {
      if (error instanceof ModelBindingMissingError) {
        return;
      }
      throw error;
    }
    this.roleAccess.requireReady(roleId);
    const storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
    try {
      const store = new MemoryStore(storage.business.db);
      const model = this.customModelFactory
        ? this.modelFactory(binding)
        : new RefreshingMemoryModel(
            () => this.bindings.refresh(binding, roleId),
            (current) => this.createHttpMemoryModel(current),
          );
      const capacity = memoryCapacityOf(binding);
      const service = new MemoryService(store, model, {
        modelInfo: {
          modelName: binding.modelName,
          protocol: binding.config.protocol,
        },
        ...(capacity === null ? {} : { capacity }),
        requestOverheadChars: Array.from(MEMORY_SYSTEM_PROMPT).length + 1_000,
        idleMs: this.idleWakeMs,
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
        now: this.now,
      });
      if (input.evidence || input.scheduled) {
        service.onEvidenceRegistered(roleId);
      }
      for (const taskId of input.taskIds) {
        service.onTaskFinished(roleId, taskId);
      }
      if (input.manual && store.listPendingTriggers(roleId).length === 0) {
        service.enqueueManual(roleId);
      }
      const dueRetry =
        input.scheduled &&
        store.hasDueFailedEvidence(roleId, this.now().toISOString());
      const nowIso = this.now().toISOString();
      const maintenanceRetryAt = this.maintenanceRetryAt(store, roleId);
      const dueMaintenance =
        maintenanceRetryAt !== null && maintenanceRetryAt <= nowIso;
      const checkAt = this.maintenanceCheckAt(store, roleId);
      const dueMaintenanceCheck = checkAt !== null && checkAt <= nowIso;
      if (store.listPendingTriggers(roleId).length > 0 || dueRetry) {
        await service.runPending(roleId, { includeRefinement: true });
      } else if (dueMaintenance || dueMaintenanceCheck) {
        await service.runBatch(roleId, { maintenanceOnly: true });
      }
    } finally {
      storage.close();
    }
  }
}

class RefreshingMemoryModel implements MemoryModelPort {
  constructor(
    private readonly resolveBinding: () => ResolvedModelBinding,
    private readonly create: (binding: ResolvedModelBinding) => MemoryModelPort,
  ) {}

  form(input: MemoryFormationInput): Promise<unknown> {
    return this.create(this.resolveBinding()).form(input);
  }
}

/** 从模型资源配置读取可核实容量声明；缺省时返回 null 走保守默认。 */
function memoryCapacityOf(
  binding: ResolvedModelBinding,
): MemoryModelCapacity | null {
  const config = binding.config;
  const maxInputChars =
    typeof config.maxInputChars === "number" ? config.maxInputChars : null;
  const maxOutputChars =
    typeof config.maxOutputChars === "number" ? config.maxOutputChars : null;
  if (maxInputChars === null && maxOutputChars === null) {
    return null;
  }
  return {
    maxInputChars: maxInputChars ?? DEFAULT_MEMORY_BUDGET_CHARS,
    maxOutputChars: maxOutputChars ?? DEFAULT_OUTPUT_RESERVE_CHARS,
    source: "declared",
  };
}

export class HttpMemoryModel implements MemoryModelPort {
  constructor(
    private readonly model: ModelPort,
    private readonly binding: ResolvedModelBinding,
  ) {}

  async form(input: MemoryFormationInput): Promise<unknown> {
    let text = "";
    let completed = false;
    let incomplete = false;
    for await (const event of this.model.stream({
      modelName: this.binding.modelName,
      system: MEMORY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(input) }],
      tools: [],
    })) {
      if (event.type === "text_delta") {
        text += event.text;
      }
      if (event.type === "completed") {
        completed = true;
        incomplete = isIncompleteCompletion(event);
      }
    }
    if (!completed) {
      throw new Error("MEMORY_MODEL_STREAM_TRUNCATED");
    }
    if (incomplete) {
      throw new Error("MEMORY_MODEL_INCOMPLETE");
    }
    const json = extractJson(text);
    return json === null ? text : json;
  }
}

const MEMORY_SYSTEM_PROMPT = [
  "你是记忆整理器，不是对话角色。",
  "阅读用户提供的 JSON（batchId、currentRound、evidence、relatedEvents、refineCandidates、summaryCandidates），只输出一个 JSON 对象，不要 Markdown、解释或代码围栏。",
  '输出格式：{"operations":[...]}；没有合适操作时输出 {"operations":[]}。',
  "可用操作及必需字段：",
  '1. create_event：{"op":"create_event","localKey":"批次内唯一字符串","title":"...","summary":"...","subjectiveExperience":"可选","occurredAtStart":"ISO 时间","occurredAtEnd":"可选 ISO 或 null","experienceDate":"YYYY-MM-DD，必须与 occurredAtStart 的本地日期一致","tags":{"person":[],"topic":[],"place":[],"emotion":[],"source":[]},"evidenceIds":["本批 evidence 中的 evidenceId，至少一个"]}',
  '2. update_event：{"op":"update_event","eventId":"...","expectedVersion":1,"patch":{"title?","summary?","subjectiveExperience?","occurredAtStart?","occurredAtEnd?","tags?"},"addEvidenceIds":["本批 evidence 中的 id，可选"],"reason":"可选"}',
  '3. refine_event：{"op":"refine_event","events":[{"eventId":"refineCandidates 中的 id","expectedVersion":1}],"summary":"概括后的日常摘要","targetSummaryId":"summaryCandidates 中的 id，可选","expectedSummaryVersion":1,"topic":"可选","reason":"可选"}；targetSummaryId 与 expectedSummaryVersion 必须同时提供',
  '4. defer：{"op":"defer","evidenceIds":["本批 evidence 中的 id"],"reason":"可选"}',
  "约束：",
  "- 只能引用输入中实际出现的 evidenceId、eventId、summaryId；不得编造。",
  "- create_event 的 experienceDate 必须与 occurredAtStart 按系统时区计算的本地日期一致。",
  "- update_event 与 refine_event 必须带当前 expectedVersion；版本不一致会整批失败。",
  "- 事件补充优先 update_event；多个低频事件的概括优先 refine_event；证据暂不明确时用 defer。",
  "- subjectiveExperience 只写角色主观感受，事实写入 summary。",
  "- tags 的键只能是 person、topic、place、emotion、source（均为单数），每个值都是字符串数组。",
  '示例（仅示意格式）：{"operations":[{"op":"create_event","localKey":"visit-1","title":"去旧书店","summary":"用户和角色去了旧书店。","occurredAtStart":"2026-11-04T03:00:00.000Z","experienceDate":"2026-11-04","tags":{"person":["用户"],"topic":["旧书"],"place":["旧书店"],"emotion":["怀念"],"source":["对话"]},"evidenceIds":["<取自输入>"]}]}',
].join("\n");

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}
