import {
  AppError,
  ImageServiceDisabledError,
  ImageServiceNotFoundError,
  SceneImageNotConfiguredError,
} from "../domain/errors.js";
import type { ImageServiceProbeResult } from "../domain/image-service.js";
import {
  sceneImageSettingsSchema,
  type SceneImagePreviewResult,
  type SceneImageSettingsInput,
  type SceneImageSettingsRecord,
  type SceneImageSettingsView,
} from "../domain/scene-image-settings.js";
import { AppearanceStore } from "../storage/appearance-store.js";
import { SceneImageSettingsStore } from "../storage/scene-image-settings-store.js";
import {
  buildScenePrompt,
  ComfyUiImageGenerator,
  resolveSceneImageRuntime,
  type SceneImageRuntime,
  type SceneImageRuntimeSource,
} from "../scene/comfyui-generator.js";
import {
  defaultComfyWorkflow,
  validateComfyWorkflow,
  type ComfyWorkflow,
} from "../scene/comfyui-workflow.js";
import { inspectImage } from "./image-inspect.js";
import type {
  ImageServiceDraftInput,
  ImageServiceService,
} from "./image-service.js";
import type { RoleAccess } from "./role-access.js";

export interface SceneImageSettingsServiceOptions {
  now?: () => Date;
  /** 探测与测试生图各自的等待上限。 */
  probeTimeoutMs?: number;
  previewTimeoutMs?: number;
  generator?: ComfyUiImageGenerator;
}

const DEFAULT_PREVIEW_TIMEOUT_MS = 180_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const DEFAULT_PREVIEW_PROMPT = "半身肖像，柔和自然光，背景简洁，细节清晰";

/**
 * 角色生图配置：服务在全局维护，角色只选模型、锚点提示词与采样参数。
 * 首版只支持文生图，图生图的锚点图上传留给下一包。
 */
export class SceneImageSettingsService {
  private readonly now: () => Date;
  private readonly probeTimeoutMs: number;
  private readonly previewTimeoutMs: number;
  private readonly generator: ComfyUiImageGenerator;
  readonly source: SceneImageRuntimeSource;

  constructor(
    private readonly roleAccess: RoleAccess,
    private readonly imageServices: ImageServiceService,
    options: SceneImageSettingsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
    this.previewTimeoutMs = options.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
    this.generator = options.generator ?? new ComfyUiImageGenerator();
    this.source = {
      getSettings: (roleId) => this.read(roleId),
      findServiceRecord: (serviceId) => this.imageServices.findRecord(serviceId),
      findService: (serviceId) => this.imageServices.findConnection(serviceId),
    };
  }

  get(roleId: string): SceneImageSettingsView {
    const settings = this.read(roleId);
    if (settings === null) {
      return { settings: null, service: null, configured: false };
    }
    // 读取和修正配置不该依赖凭据可用；探测与生成再解析密钥。
    const service = this.imageServices.findRecord(settings.serviceId);
    return {
      settings,
      service:
        service === null
          ? null
          : {
              serviceId: service.serviceId,
              name: service.name,
              enabled: service.enabled,
              baseUrl: service.config.baseUrl,
            },
      configured: service !== null && service.enabled,
    };
  }

  save(roleId: string, input: SceneImageSettingsInput): SceneImageSettingsView {
    this.roleAccess.requireReady(roleId);
    const service = this.imageServices.findRecord(input.serviceId);
    if (service === null) {
      throw new ImageServiceNotFoundError(input.serviceId);
    }
    if (!service.enabled) {
      throw new ImageServiceDisabledError(input.serviceId);
    }
    if (input.workflow !== null) {
      // 自定义工作流在保存时就校验形状，别等生成时才失败。
      validateComfyWorkflow(input.workflow, input.outputNodeId);
    }
    this.roleAccess.withStore(roleId, (storage) =>
      new SceneImageSettingsStore(storage.business.db, roleId).save(
        input,
        this.now().toISOString(),
      ),
    );
    return this.get(roleId);
  }

  /**
   * 探测当前配置能不能出图。可传候选服务、草稿连接或工作流，
   * 让页面在保存前先验证一次（236 §6.2 / 278 §5）。
   */
  async probe(
    roleId: string,
    candidate: {
      serviceId?: string | undefined;
      serviceDraft?: ImageServiceDraftInput | undefined;
      workflow?: Record<string, unknown> | null | undefined;
    } = {},
  ): Promise<ImageServiceProbeResult> {
    const settings = this.read(roleId);
    let connection: {
      record: import("../domain/image-service.js").ImageServiceRecord;
      token: string | undefined;
    };
    if (candidate.serviceDraft !== undefined) {
      connection = this.imageServices.resolveDraftConnection(candidate.serviceDraft);
    } else {
      const serviceId = candidate.serviceId ?? settings?.serviceId;
      if (serviceId === undefined) {
        throw new SceneImageNotConfiguredError("还没有选择生图服务，无法探测");
      }
      connection = this.imageServices.resolveConnection(serviceId);
    }
    const workflow = this.workflowOf(
      candidate.workflow === undefined ? (settings?.workflow ?? null) : candidate.workflow,
    );
    return this.imageServices.probeConnection(connection, workflow);
  }

  /**
   * 测试生图：未传草稿字段时走已保存配置，传入草稿时临时合并（不落库），
   * 只回给配置流程，不写进过场图历史与正式配置。
   */
  async preview(
    roleId: string,
    input: {
      prompt?: string | undefined;
      outfitId?: string | null | undefined;
      serviceDraft?: ImageServiceDraftInput | undefined;
      draft?: Partial<SceneImageSettingsInput> | undefined;
    } = {},
  ): Promise<SceneImagePreviewResult> {
    const runtime =
      input.serviceDraft === undefined && input.draft === undefined
        ? this.requireSavedRuntime(roleId)
        : this.resolvePreviewDraftRuntime(roleId, input);
    const rawOutfitId = input.outfitId;
    const outfitId =
      rawOutfitId === undefined || rawOutfitId === null || rawOutfitId.trim() === ""
        ? null
        : rawOutfitId.trim();
    if (outfitId !== null) {
      const outfit = this.roleAccess.withStore(roleId, (storage) =>
        new AppearanceStore(storage.business.db, roleId).getOutfit(outfitId),
      );
      if (outfit === null) {
        throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
          roleId,
          outfitId,
        });
      }
    }
    const outfitPrompt =
      outfitId === null ? "" : (runtime.settings.outfitPrompts[outfitId] ?? "");
    const prompt = buildScenePrompt(
      runtime.settings,
      outfitPrompt,
      input.prompt ?? DEFAULT_PREVIEW_PROMPT,
    );
    const signal = AbortSignal.timeout(this.previewTimeoutMs);
    const generated = await this.generator.generate(runtime, prompt, signal);
    if (generated.data.length > MAX_PREVIEW_BYTES) {
      throw new AppError(400, "IMAGE_WORKFLOW_INVALID", "测试样图超过 8 MiB 上限", {
        byteSize: generated.data.length,
      });
    }
    const inspected = await inspectImage(generated.data, "scene-image.png");
    return {
      mediaType: inspected.mediaType,
      width: inspected.width,
      height: inspected.height,
      byteSize: generated.data.length,
      dataBase64: generated.data.toString("base64"),
      prompt,
    };
  }

  /** 生成器与预览共用的运行时解析。 */
  runtimeOf(roleId: string): SceneImageRuntime | null {
    return resolveSceneImageRuntime(this.source, roleId);
  }

  private requireSavedRuntime(roleId: string): SceneImageRuntime {
    const runtime = resolveSceneImageRuntime(this.source, roleId);
    if (runtime === null) {
      throw new SceneImageNotConfiguredError();
    }
    return runtime;
  }

  private resolvePreviewDraftRuntime(
    roleId: string,
    input: {
      serviceDraft?: ImageServiceDraftInput | undefined;
      draft?: Partial<SceneImageSettingsInput> | undefined;
    },
  ): SceneImageRuntime {
    const saved = this.read(roleId);
    const draft = input.draft ?? {};
    if (
      draft.serviceId !== undefined &&
      input.serviceDraft?.serviceId !== undefined &&
      draft.serviceId !== input.serviceDraft.serviceId
    ) {
      throw new AppError(400, "INVALID_REQUEST", "serviceId 与 serviceDraft.serviceId 不一致");
    }
    const draftServiceConn =
      input.serviceDraft === undefined
        ? null
        : this.imageServices.resolveDraftConnection(input.serviceDraft);
    const effectiveServiceId =
      draft.serviceId ?? draftServiceConn?.record.serviceId ?? saved?.serviceId;
    if (effectiveServiceId === undefined) {
      throw new SceneImageNotConfiguredError("还没有选择生图服务，无法测试生图");
    }
    const savedFields =
      saved === null
        ? undefined
        : {
            serviceId: saved.serviceId,
            modelType: saved.modelType,
            modelPath: saved.modelPath,
            basePrompt: saved.basePrompt,
            negativePrompt: saved.negativePrompt,
            outfitPrompts: saved.outfitPrompts,
            width: saved.width,
            height: saved.height,
            steps: saved.steps,
            cfg: saved.cfg,
            sampler: saved.sampler,
            scheduler: saved.scheduler,
            seed: saved.seed,
            workflow: saved.workflow,
            outputNodeId: saved.outputNodeId,
          };
    const parsed = sceneImageSettingsSchema.safeParse({
      modelType: "text2img",
      ...savedFields,
      ...draft,
      serviceId: effectiveServiceId,
    });
    if (!parsed.success) {
      throw new AppError(400, "INVALID_REQUEST", "生图配置参数不正确", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      });
    }
    if (parsed.data.workflow !== null) {
      validateComfyWorkflow(parsed.data.workflow, parsed.data.outputNodeId);
    }
    const settings: SceneImageSettingsRecord = {
      ...parsed.data,
      roleId,
      updatedAt: this.now().toISOString(),
    };
    if (draftServiceConn !== null) {
      return {
        settings,
        service: draftServiceConn.record,
        token: draftServiceConn.token,
      };
    }
    const connection = this.imageServices.resolveConnection(settings.serviceId);
    if (!connection.record.enabled) {
      throw new ImageServiceDisabledError(settings.serviceId);
    }
    return {
      settings,
      service: connection.record,
      token: connection.token,
    };
  }

  private read(roleId: string): SceneImageSettingsRecord | null {
    return this.roleAccess.withStore(roleId, (storage) =>
      new SceneImageSettingsStore(storage.business.db, roleId).get(),
    );
  }

  private workflowOf(override: Record<string, unknown> | null): ComfyWorkflow {
    return override === null
      ? defaultComfyWorkflow()
      : validateComfyWorkflow(override);
  }
}
