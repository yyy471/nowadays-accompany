import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AppError,
  MessageNotFoundError,
  SceneImageAnchorInvalidError,
  SceneImageAssetFileMissingError,
  SceneImageAssetNotFoundError,
  SceneImageCanceledError,
  SceneImageGenerationFailedError,
  SceneImageGenerationTimeoutError,
  SceneImagePlanInvalidError,
  SceneImageSegmentsMissingError,
  SceneImageTaskNotFoundError,
} from "../domain/errors.js";
import type { MessageSegmentRecord } from "../domain/conversation.js";
import type {
  SceneImageConfigSnapshot,
  SceneImageContextMessage,
  SceneImageGeneratorPort,
  SceneImageLayerMode,
  SceneImageOutfitInput,
  SceneImagePlanRecord,
  SceneImagePlannerPort,
  SceneImageReferenceImage,
  SceneImageTaskRecord,
} from "../domain/scene-image.js";
import { rolePaths } from "../bootstrap/config.js";
import type { AppStore } from "../storage/app-store.js";
import { ConversationStore } from "../storage/conversation-store.js";
import {
  SceneImageStore,
  type SceneImageCharacterReference,
} from "../storage/scene-image-store.js";
import type { RoleAccess } from "./role-access.js";
import { inspectImage } from "./image-inspect.js";
import { FakeSceneImageGenerator } from "../scene/fake-generator.js";
import { FixedSceneImagePlanner } from "../scene/fixed-planner.js";

const MAX_SCENE_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS = 2000;
const MAX_ERROR_SUMMARY_CHARS = 500;
const MAX_CONTEXT_MESSAGES = 4;
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const INTERRUPTED_CODE = "SCENE_IMAGE_INTERRUPTED";

export interface SceneImageServiceOptions {
  now?: () => Date;
  planner?: SceneImagePlannerPort;
  generator?: SceneImageGeneratorPort;
  /** 单次生成的等待上限，超时按可追溯的失败结算。 */
  generationTimeoutMs?: number;
  /** 图片完整解码；单独注入便于验证关闭覆盖解码等待。 */
  imageInspector?: typeof inspectImage;
}

export interface RequestSceneImageInput {
  idempotencyKey: string;
  layerMode?: SceneImageLayerMode;
}

export interface SceneImageRequestResult {
  task: SceneImageTaskRecord;
  duplicate: boolean;
}

export interface SceneImageAssetFile {
  data: Buffer;
  mediaType: string;
}

export class SceneImageService {
  private readonly now: () => Date;
  private readonly planner: SceneImagePlannerPort;
  private readonly generator: SceneImageGeneratorPort;
  private readonly generationTimeoutOverride: number | null;
  private readonly inspect: typeof inspectImage;
  private readonly inFlight = new Map<string, Set<Promise<void>>>();
  private readonly controllers = new Set<AbortController>();
  private readonly controllerRoles = new Map<AbortController, string>();
  private closed = false;

  constructor(
    private readonly appStore: AppStore,
    private readonly roleAccess: RoleAccess,
    private readonly dataRoot: string,
    options: SceneImageServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.planner = options.planner ?? new FixedSceneImagePlanner();
    this.generator = options.generator ?? new FakeSceneImageGenerator();
    this.generationTimeoutOverride = options.generationTimeoutMs ?? null;
    this.inspect = options.imageInspector ?? inspectImage;
  }

  /**
   * 从一条已保存的角色回复发起手动任务。
   * 同一幂等键复用原任务，不重复规划或出图。
   */
  requestManual(
    roleId: string,
    windowId: string,
    messageId: string,
    input: RequestSceneImageInput,
  ): SceneImageRequestResult {
    // 接收任务时就固定当前生图配置，规划期间修改模型或锚点不影响本次任务。
    const config = this.generator.lock?.(roleId) ?? null;
    const result = this.roleAccess.withStore(roleId, (storage) => {
      storage.business.getWindow(roleId, windowId);
      const db = storage.business.db;
      const store = new SceneImageStore(db, roleId);
      const anchor = store.getAnchor(windowId, messageId);
      if (anchor === null) {
        throw new MessageNotFoundError(windowId, messageId);
      }
      if (anchor.sender !== "assistant") {
        throw new SceneImageAnchorInvalidError("只能从角色回复发起过场图");
      }
      if (anchor.status === "generating") {
        throw new SceneImageAnchorInvalidError(
          "回复仍在生成，完成或中断后再发起过场图",
        );
      }
      if (anchor.executionId === null) {
        throw new SceneImageAnchorInvalidError("目标回复缺少执行归属");
      }
      const segments = new ConversationStore(db, roleId).listMessageSegments(
        messageId,
      );
      if (segments.length === 0) {
        throw new SceneImageSegmentsMissingError(messageId);
      }
      const first = segments[0]!;
      const last = segments.at(-1)!;
      return store.createTask({
        roleId,
        windowId,
        messageId,
        executionId: anchor.executionId,
        trigger: "manual",
        layerMode: input.layerMode ?? "background",
        startSegmentId: first.segmentId,
        endSegmentId: last.segmentId,
        idempotencyKey: input.idempotencyKey,
        config,
        now: this.nowIso(),
      });
    });
    if (!result.duplicate) {
      this.start(roleId, windowId, result.task.taskId);
    }
    return result;
  }

  getTask(roleId: string, windowId: string, taskId: string): SceneImageTaskRecord {
    return this.roleAccess.withStore(roleId, (storage) => {
      const task = new SceneImageStore(
        storage.business.db,
        roleId,
      ).getTask(windowId, taskId);
      if (task === null) {
        throw new SceneImageTaskNotFoundError(windowId, taskId);
      }
      return task;
    });
  }

  /** 受管图片读取：只按角色归属取图，路径与真实服务配置留在后端。 */
  readAsset(roleId: string, assetId: string): SceneImageAssetFile {
    return this.roleAccess.withStore(roleId, (storage) => {
      const asset = new SceneImageStore(
        storage.business.db,
        roleId,
      ).getAsset(assetId);
      if (asset === null) {
        throw new SceneImageAssetNotFoundError(assetId);
      }
      const filePath = resolveAssetPath(
        storage.paths.sceneImageDir,
        asset.relativePath,
      );
      let data: Buffer;
      try {
        data = fs.readFileSync(filePath);
      } catch {
        throw new SceneImageAssetFileMissingError(assetId);
      }
      if (!matchesMediaType(data, asset.mediaType) || data.length !== asset.byteSize) {
        throw new AppError(
          500,
          "SCENE_IMAGE_ASSET_CORRUPT",
          "过场图素材格式或长度与记录不一致",
          { assetId },
        );
      }
      return { data, mediaType: asset.mediaType };
    });
  }

  /** 启动时把上次未完成的任务结算为可追溯的失败，避免永久停留在执行中。 */
  recoverOnStartup(): number {
    let settled = 0;
    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") {
        continue;
      }
      try {
        settled += this.roleAccess.withStore(index.roleId, (storage) => {
          const store = new SceneImageStore(storage.business.db, index.roleId);
          let count = 0;
          for (const task of store.listUnfinished()) {
            const failed = store.failTask(
              task.taskId,
              INTERRUPTED_CODE,
              "服务重启，未完成的过场图任务已终止",
              this.nowIso(),
            );
            if (failed !== null) {
              count += 1;
            }
          }
          return count;
        });
      } catch {
        // 单个角色库不可读时跳过，不阻塞其他角色启动。
      }
    }
    return settled;
  }

  async waitForIdle(roleId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tasks = this.inFlight.get(roleId);
      if (tasks === undefined || tasks.size === 0) {
        return;
      }
      await delay(10);
    }
    throw new Error("SCENE_IMAGE_IDLE_TIMEOUT");
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
    const tasks = [...this.inFlight.values()].flatMap((set) => [...set]);
    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  /** 中止该角色正在进行的过场图任务并等待收尾；删除角色前调用。 */
  async cancelRole(roleId: string): Promise<void> {
    for (const [controller, id] of this.controllerRoles) {
      if (id === roleId) {
        controller.abort();
      }
    }
    const tasks = this.inFlight.get(roleId);
    if (tasks !== undefined) {
      await Promise.allSettled([...tasks]);
    }
  }

  private start(roleId: string, windowId: string, taskId: string): void {
    if (this.closed) {
      this.settle(roleId, taskId, INTERRUPTED_CODE, "服务已关闭，任务未开始");
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    this.controllerRoles.set(controller, roleId);
    let promise: Promise<void>;
    promise = this.run(roleId, windowId, taskId, controller.signal)
      // 兜底：任何未预期异常都要留下终态，不能让任务停在 generating。
      .catch((error) => {
        this.settle(
          roleId,
          taskId,
          errorCodeOf(error, "SCENE_IMAGE_INTERNAL_ERROR"),
          messageOf(error),
          controller.signal,
        );
      })
      .finally(() => {
        this.controllers.delete(controller);
        this.controllerRoles.delete(controller);
        const tasks = this.inFlight.get(roleId);
        if (tasks !== undefined) {
          tasks.delete(promise);
          if (tasks.size === 0) {
            this.inFlight.delete(roleId);
          }
        }
      });
    const tasks = this.inFlight.get(roleId) ?? new Set<Promise<void>>();
    tasks.add(promise);
    this.inFlight.set(roleId, tasks);
  }

  private async run(
    roleId: string,
    windowId: string,
    taskId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const prepared = this.roleAccess.withStore(roleId, (storage) => {
      const db = storage.business.db;
      const store = new SceneImageStore(db, roleId);
      const task = store.getTask(windowId, taskId);
      if (task === null) {
        return null;
      }
      const anchor = store.getAnchor(windowId, task.messageId);
      if (anchor === null) {
        return null;
      }
      const outfit = store.outfitForMessage(windowId, task.messageId);
      return {
        task,
        content: anchor.content,
        segments: new ConversationStore(db, roleId).listMessageSegments(
          task.messageId,
        ),
        outfit,
        reference:
          outfit === null
            ? null
            : store.characterReferenceForOutfit(outfit.outfitId),
        context: store.listContextMessages(
          windowId,
          anchor.sequence,
          MAX_CONTEXT_MESSAGES,
        ),
        config: store.getTaskConfig(taskId),
        appearanceDir: storage.paths.appearanceDir,
      };
    });
    if (prepared === null) {
      return;
    }
    const { task, segments } = prepared;
    if (segments.length === 0) {
      this.settle(
        roleId,
        taskId,
        "SCENE_IMAGE_SEGMENTS_MISSING",
        "目标回复没有可用的句段",
      );
      return;
    }
    const planning = this.roleAccess.withStore(roleId, (storage) =>
      new SceneImageStore(storage.business.db, roleId).markPlanning(
        taskId,
        this.nowIso(),
      ),
    );
    if (planning === null) {
      return;
    }

    const outfitInput: SceneImageOutfitInput =
      prepared.outfit === null
        ? {
            outfitId: null,
            name: null,
            description: null,
            hasCharacterReference: false,
          }
        : {
            outfitId: prepared.outfit.outfitId,
            name: prepared.outfit.name,
            description: prepared.outfit.description,
            hasCharacterReference: prepared.reference !== null,
          };
    const context: SceneImageContextMessage[] = prepared.context;
    let plan: SceneImagePlanRecord;
    try {
      plan = normalizePlan(
        await raceWithSignal(
          this.planner.plan(
            {
              roleId,
              windowId,
              messageId: task.messageId,
              executionId: task.executionId,
              content: prepared.content,
              segments,
              outfit: outfitInput,
              context,
              requestedLayerMode:
                task.trigger === "manual" ? task.layerMode : null,
            },
            signal,
          ),
          signal,
        ),
        task,
        segments,
      );
    } catch (error) {
      this.settle(
        roleId,
        taskId,
        errorCodeOf(error, "SCENE_IMAGE_PLAN_FAILED"),
        messageOf(error),
        signal,
      );
      return;
    }

    const generating = this.roleAccess.withStore(roleId, (storage) =>
      new SceneImageStore(storage.business.db, roleId).markGenerating(
        taskId,
        plan,
        this.nowIso(),
      ),
    );
    if (generating === null) {
      return;
    }

    // 纯背景图不带角色参考；整幅图在服饰素材可读时才附带，缺失时降级为无参考。
    const references: SceneImageReferenceImage[] =
      plan.layerMode === "full_scene"
        ? this.loadReferenceImages(prepared.reference, prepared.appearanceDir)
        : [];
    // 外层等待上限采用任务接收时固定的服务超时，与客户端内部上限保持一致；
    // 未配置真实服务或旧任务没有快照时用默认值。
    const generationTimeoutMs =
      this.generationTimeoutOverride ??
      prepared.config?.service?.timeoutMs ??
      DEFAULT_GENERATION_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(generationTimeoutMs);
    const generationSignal = AbortSignal.any([signal, timeout]);
    const assertActive = (): void => {
      if (signal.aborted) {
        throw new SceneImageCanceledError();
      }
      if (timeout.aborted) {
        throw new SceneImageGenerationTimeoutError(generationTimeoutMs);
      }
    };
    const paths = rolePaths(this.dataRoot, roleId);
    let writtenPath: string | null = null;
    try {
      // 服务侧竞速：生成器不理会 AbortSignal 时，超时或关闭也能立即结算，
      // 生成器之后返回的结果不再写盘或改变任务状态。
      const generated = await raceWithSignal(
        this.generator.generate({
          roleId,
          prompt: plan.description,
          layerMode: plan.layerMode,
          outfit: {
            outfitId: outfitInput.outfitId,
            name: outfitInput.name,
            description: outfitInput.description,
          },
          ...(references.length === 0 ? {} : { references }),
          ...(prepared.config === null ? {} : { config: prepared.config }),
          signal: generationSignal,
        }),
        generationSignal,
      );
      assertActive();
      if (generated.data.length === 0) {
        throw new SceneImageGenerationFailedError("生成结果为空");
      }
      if (generated.data.length > MAX_SCENE_IMAGE_BYTES) {
        throw new SceneImageGenerationFailedError("生成结果超过 32 MiB 上限");
      }
      // 解码同样参与竞速：关闭或超时不必等完整解码结束。
      const inspected = await raceWithSignal(
        this.inspect(generated.data, "scene-image.png"),
        generationSignal,
      );
      assertActive();
      const assetId = randomUUID();
      const relativePath = `scene-images/${assetId}${inspected.extension}`;
      const absolutePath = path.join(paths.roleDir, relativePath);
      fs.mkdirSync(paths.sceneImageDir, { recursive: true });
      // 排他打开成功即取得新文件的所有权，先登记清理目标再写入；
      // 中途失败会删除已创建的文件，目标已存在时 open 抛 EEXIST，不进入清理。
      const fd = fs.openSync(absolutePath, "wx");
      writtenPath = absolutePath;
      try {
        fs.writeFileSync(fd, generated.data);
      } finally {
        fs.closeSync(fd);
      }
      // 写盘后、提交前再复查一次取消，避免关闭期间落库成功。
      assertActive();
      this.roleAccess.withStore(roleId, (storage) =>
        new SceneImageStore(storage.business.db, roleId).completeTask(
          taskId,
          {
            assetId,
            mediaType: inspected.mediaType,
            relativePath,
            width: inspected.width,
            height: inspected.height,
            byteSize: generated.data.length,
            createdAt: this.nowIso(),
          },
          this.nowIso(),
        ),
      );
    } catch (error) {
      // 清理失败不能阻断结算：保留原失败原因，另行记录未清理文件。
      const cleanupNote = this.discardUncommitted(writtenPath);
      const settled =
        timeout.aborted && !signal.aborted
          ? new SceneImageGenerationTimeoutError(generationTimeoutMs)
          : error;
      this.settle(
        roleId,
        taskId,
        errorCodeOf(settled, "SCENE_IMAGE_GENERATION_FAILED"),
        messageOf(settled),
        signal,
        cleanupNote,
      );
    }
  }

  /**
   * 删除未提交的素材文件。删除被拒绝时返回简短说明，
   * 由调用方写入错误摘要并通过日志留下完整路径。
   */
  private discardUncommitted(filePath: string | null): string | null {
    if (filePath === null) {
      return null;
    }
    try {
      fs.rmSync(filePath, { force: true });
      return null;
    } catch (error) {
      console.warn(
        `[scene-image] 未提交文件未能清理：${filePath}（${messageOf(error)}）`,
      );
      return "未提交文件未能清理";
    }
  }

  /**
   * 读取服饰参考图。素材缺失、格式不符或超出上限时返回空数组，
   * 让生成在无参考图的情况下继续，而不是把整张图判为失败。
   */
  private loadReferenceImages(
    reference: SceneImageCharacterReference | null,
    appearanceDir: string,
  ): SceneImageReferenceImage[] {
    if (reference === null) {
      return [];
    }
    const root = path.resolve(appearanceDir);
    const target = path.resolve(path.dirname(root), reference.relativePath);
    if (!target.startsWith(`${root}${path.sep}`)) {
      return [];
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(target);
    } catch {
      return [];
    }
    if (data.length === 0 || data.length > MAX_REFERENCE_BYTES) {
      return [];
    }
    if (!matchesMediaType(data, reference.mediaType)) {
      return [];
    }
    return [{ role: "character", mediaType: reference.mediaType, data }];
  }

  private settle(
    roleId: string,
    taskId: string,
    code: string,
    summary: string,
    signal?: AbortSignal,
    note?: string | null,
  ): void {
    const interrupted = signal?.aborted === true;
    const errorCode = interrupted ? INTERRUPTED_CODE : code;
    const suffix = note === null || note === undefined ? "" : `（${note}）`;
    const base = interrupted ? "服务关闭时任务未完成" : summary;
    const errorSummary = `${base.slice(
      0,
      Math.max(0, MAX_ERROR_SUMMARY_CHARS - suffix.length),
    )}${suffix}`;
    try {
      this.roleAccess.withStore(roleId, (storage) =>
        new SceneImageStore(storage.business.db, roleId).failTask(
          taskId,
          errorCode,
          errorSummary,
          this.nowIso(),
        ),
      );
    } catch {
      // 角色存储不可用时保留原记录，由下次启动结算。
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function normalizePlan(
  plan: SceneImagePlanRecord,
  task: SceneImageTaskRecord,
  segments: readonly MessageSegmentRecord[],
): SceneImagePlanRecord {
  const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
  const start = byId.get(plan.startSegmentId);
  const end = byId.get(plan.endSegmentId);
  if (start === undefined || end === undefined) {
    throw new SceneImagePlanInvalidError("规划区间不属于目标回复", {
      startSegmentId: plan.startSegmentId,
      endSegmentId: plan.endSegmentId,
    });
  }
  if (start.ordinal > end.ordinal) {
    throw new SceneImagePlanInvalidError("规划区间起止顺序无效");
  }
  const description = plan.description.trim();
  if (description.length === 0) {
    throw new SceneImagePlanInvalidError("画面描述为空");
  }
  if (description.length > MAX_PROMPT_CHARS) {
    throw new SceneImagePlanInvalidError("画面描述过长");
  }
  const layerMode: SceneImageLayerMode =
    task.trigger === "manual" ? task.layerMode : plan.layerMode;
  return {
    description,
    layerMode,
    startSegmentId: start.segmentId,
    endSegmentId: end.segmentId,
  };
}

function resolveAssetPath(sceneImageDir: string, relativePath: string): string {
  const root = path.resolve(sceneImageDir);
  const roleDir = path.dirname(root);
  const target = path.resolve(roleDir, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new SceneImageAssetNotFoundError(path.basename(relativePath));
  }
  return target;
}

function matchesMediaType(data: Buffer, mediaType: string): boolean {
  if (mediaType === "image/png") {
    return (
      data.length >= 8 &&
      data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    );
  }
  if (mediaType === "image/jpeg") {
    return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
  }
  if (mediaType === "image/webp") {
    return (
      data.length >= 12 &&
      data.toString("ascii", 0, 4) === "RIFF" &&
      data.toString("ascii", 8, 12) === "WEBP"
    );
  }
  return false;
}

function errorCodeOf(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.code : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 让等待与信号解耦：信号中止时立即返回，不等底层实现配合。
 * 底层 promise 之后的结果会被忽略，但仍消费其拒绝，避免未处理异常。
 */
function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new SceneImageCanceledError();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
