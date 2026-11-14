import path from "node:path";
import {
  AppError,
  ImageServiceDisabledError,
  ImageServiceNotFoundError,
  ModelBindingMissingError,
  ModelRequestFailedError,
  SceneImageAnchorImageRequiredError,
  SceneImageChatModelRequiredError,
  SceneImageNotConfiguredError,
} from "../domain/errors.js";
import type {
  OutfitAssetRecord,
  OutfitRecord,
  UploadedImage,
} from "../domain/appearance.js";
import type { ImageServiceProbeResult } from "../domain/image-service.js";
import {
  isIncompleteCompletion,
  type ModelImageAttachment,
  type ModelPort,
  type ModelRequest,
} from "../domain/model.js";
import {
  sceneImageSettingsSchema,
  type AnchorPromptTarget,
  type SceneImageAnchorPromptResult,
  type SceneImagePreviewResult,
  type SceneImageSettingsInput,
  type SceneImageSettingsRecord,
  type SceneImageSettingsView,
} from "../domain/scene-image-settings.js";
import { resolveCredential } from "../model/credentials.js";
import { HttpModelAdapter } from "../model/protocols.js";
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
import { AppearanceService } from "./appearance-service.js";
import type { CredentialResolver } from "./credential-resolver.js";
import { inspectImage } from "./image-inspect.js";
import type {
  ImageServiceDraftInput,
  ImageServiceService,
} from "./image-service.js";
import type {
  ModelBindingResolver,
  ResolvedModelBinding,
} from "./model-binding-resolver.js";
import {
  resolveClaimedModelBinding,
  type ModelCallClaim,
} from "./model-maintenance.js";
import type { RoleAccess } from "./role-access.js";

export type AnchorPromptModelFactory = (
  binding: ResolvedModelBinding,
) => ModelPort;

export interface SceneImageSettingsServiceOptions {
  now?: () => Date;
  /** 探测、锚点提示词生成与测试生图各自的等待上限。 */
  probeTimeoutMs?: number;
  previewTimeoutMs?: number;
  anchorPromptTimeoutMs?: number;
  generator?: ComfyUiImageGenerator;
  bindings?: ModelBindingResolver | null;
  appearance?: AppearanceService;
  appRoot?: string;
  credentialResolver?: CredentialResolver;
  modelFactory?: AnchorPromptModelFactory;
  maintenance?: {
    isUnder(resourceId: string): boolean;
    wait(resourceId: string, signal?: AbortSignal): Promise<void>;
  } | null;
  claim?: {
    claim(roleId: string, resourceId: string): ModelCallClaim;
  } | null;
}

export interface GenerateAnchorPromptInput {
  target: AnchorPromptTarget;
  outfitId?: string | undefined;
  previousPrompt?: string | undefined;
  uploadedImage?: UploadedImage | undefined;
}

const DEFAULT_PREVIEW_TIMEOUT_MS = 180_000;
const DEFAULT_ANCHOR_PROMPT_TIMEOUT_MS = 60_000;
const DEFAULT_ANCHOR_PROMPT_MAX_TOKENS = 600;
const MAX_ANCHOR_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BASE_PROMPT_CHARS = 2_000;
const MAX_OUTFIT_PROMPT_CHARS = 1_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const DEFAULT_PREVIEW_PROMPT = "半身肖像，柔和自然光，背景简洁，细节清晰";

/**
 * 角色生图配置：服务在全局维护，角色只选模型、锚点提示词与采样参数。
 * 首版只支持文生图，支持由绑定对话模型读取锚点图生成基础/服饰提示词。
 */
export class SceneImageSettingsService {
  private readonly now: () => Date;
  private readonly probeTimeoutMs: number;
  private readonly previewTimeoutMs: number;
  private readonly anchorPromptTimeoutMs: number;
  private readonly generator: ComfyUiImageGenerator;
  private readonly appearance: AppearanceService;
  private readonly bindings: ModelBindingResolver | null;
  private readonly modelFactory: AnchorPromptModelFactory;
  private readonly maintenance: SceneImageSettingsServiceOptions["maintenance"];
  private readonly claim: SceneImageSettingsServiceOptions["claim"];
  readonly source: SceneImageRuntimeSource;

  constructor(
    private readonly roleAccess: RoleAccess,
    private readonly imageServices: ImageServiceService,
    options: SceneImageSettingsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
    this.previewTimeoutMs = options.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
    this.anchorPromptTimeoutMs =
      options.anchorPromptTimeoutMs ?? DEFAULT_ANCHOR_PROMPT_TIMEOUT_MS;
    this.generator = options.generator ?? new ComfyUiImageGenerator();
    this.appearance = options.appearance ?? new AppearanceService(roleAccess);
    this.bindings = options.bindings ?? null;
    this.modelFactory =
      options.modelFactory ??
      ((binding) => {
        const credential =
          options.credentialResolver === undefined
            ? resolveCredential(
                options.appRoot ?? process.cwd(),
                binding.config.credentialRef,
              )
            : options.credentialResolver.resolve(
                binding.resourceId,
                binding.config.credentialRef,
              );
        return new HttpModelAdapter(binding.config, credential);
      });
    this.maintenance = options.maintenance ?? null;
    this.claim = options.claim ?? null;
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

  /**
   * 调用角色当前绑定的对话模型读取角色/服饰锚点图，生成基础或服饰锚点提示词。
   * 仅返回生成结果，不直接修改已保存配置，便于用户多次重新生成并测试生图后手动保存。
   */
  async generateAnchorPrompt(
    roleId: string,
    input: GenerateAnchorPromptInput,
    signal?: AbortSignal,
  ): Promise<SceneImageAnchorPromptResult> {
    const requestedOutfitId =
      input.outfitId === undefined || input.outfitId.trim() === ""
        ? null
        : input.outfitId.trim();
    if (input.target === "outfit" && requestedOutfitId === null) {
      throw new AppError(400, "INVALID_REQUEST", "生成服饰锚点提示词必须指定服饰", {
        target: input.target,
      });
    }

    const context = this.roleAccess.withStore(roleId, (storage) => {
      const role = storage.business.getRole(roleId);
      const store = new AppearanceStore(storage.business.db, roleId);
      if (input.target === "outfit") {
        const outfit = store.getOutfit(requestedOutfitId!);
        if (outfit === null) {
          throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
            roleId,
            outfitId: requestedOutfitId,
          });
        }
        return {
          displayName: role.displayName,
          outfit,
          defaultAsset: outfit.home ?? outfit.sprites[0] ?? null,
        };
      }
      const outfits = store.listOutfits();
      const currentOutfitId =
        typeof role.state.outfitId === "string" && role.state.outfitId.trim() !== ""
          ? role.state.outfitId
          : null;
      const picked = pickBaseAnchorAsset(outfits, currentOutfitId);
      return {
        displayName: role.displayName,
        outfit: picked.outfit,
        defaultAsset: picked.asset,
      };
    });

    const anchorImage = await this.resolveAnchorImage(
      roleId,
      input.target,
      context.outfit,
      context.defaultAsset,
      input.uploadedImage,
    );

    if (this.bindings === null) {
      throw new SceneImageChatModelRequiredError();
    }

    const timeoutSignal = AbortSignal.timeout(this.anchorPromptTimeoutMs);
    const requestSignal =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal]);

    let claimed: { binding: ResolvedModelBinding; release: () => void };
    try {
      const resolved = await resolveClaimedModelBinding<ResolvedModelBinding>(
        () => this.bindings!.resolveChat(roleId),
        this.maintenance,
        (resourceId) =>
          this.claim == null
            ? { admitted: true, release: () => undefined }
            : this.claim.claim(roleId, resourceId),
        requestSignal,
      );
      if (resolved === null) {
        throw new AppError(499, "SCENE_IMAGE_ANCHOR_CANCELED", "锚点提示词生成已取消");
      }
      claimed = resolved;
    } catch (error) {
      if (error instanceof ModelBindingMissingError) {
        throw new SceneImageChatModelRequiredError();
      }
      throw error;
    }

    try {
      const model = this.modelFactory(claimed.binding);
      const messages = buildAnchorPromptRequest({
        target: input.target,
        displayName: context.displayName,
        outfit: context.outfit,
        previousPrompt: input.previousPrompt,
        image: anchorImage.attachment,
      });
      const request: ModelRequest = {
        modelName: claimed.binding.modelName,
        system: messages.system,
        messages: [
          {
            role: "user",
            content: messages.user,
            images: [anchorImage.attachment],
          },
        ],
        tools: [],
        maxOutputTokens: DEFAULT_ANCHOR_PROMPT_MAX_TOKENS,
        signal: requestSignal,
      };

      let output = "";
      let completed = false;
      let stopReason: string | undefined;
      try {
        for await (const event of model.stream(request)) {
          if (event.type === "text_delta") {
            output += event.text;
          } else if (event.type === "completed") {
            if (isIncompleteCompletion(event)) {
              stopReason = event.stopReason;
            } else {
              completed = true;
            }
          }
        }
      } catch (error) {
        if (signal?.aborted === true) {
          throw new AppError(499, "SCENE_IMAGE_ANCHOR_CANCELED", "锚点提示词生成已取消");
        }
        if (error instanceof AppError) {
          throw error;
        }
        throw new ModelRequestFailedError("对话模型生成锚点提示词失败", {
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (!completed) {
        throw new ModelRequestFailedError("对话模型未完整返回锚点提示词", {
          ...(stopReason === undefined ? {} : { stopReason }),
        });
      }
      const maxChars =
        input.target === "outfit"
          ? MAX_OUTFIT_PROMPT_CHARS
          : MAX_BASE_PROMPT_CHARS;
      const prompt = cleanGeneratedAnchorPrompt(output, maxChars);
      if (prompt.length === 0) {
        throw new ModelRequestFailedError("对话模型没有返回可用的锚点提示词");
      }
      return {
        target: input.target,
        outfitId: input.target === "outfit" ? requestedOutfitId : null,
        prompt,
        source: anchorImage.source,
      };
    } finally {
      claimed.release();
    }
  }

  private async resolveAnchorImage(
    roleId: string,
    target: AnchorPromptTarget,
    outfit: OutfitRecord | null,
    defaultAsset: OutfitAssetRecord | null,
    uploadedImage: UploadedImage | undefined,
  ): Promise<{
    attachment: ModelImageAttachment;
    source: SceneImageAnchorPromptResult["source"];
  }> {
    if (uploadedImage !== undefined) {
      if (uploadedImage.data.length === 0) {
        throw new AppError(400, "IMAGE_DECODE_FAILED", "图片无法解码", {
          fileName: uploadedImage.fileName,
        });
      }
      if (uploadedImage.data.length > MAX_ANCHOR_IMAGE_BYTES) {
        throw new AppError(413, "IMAGE_TOO_LARGE", "图片超过 32 MiB 上限", {
          fileName: uploadedImage.fileName,
        });
      }
      const inspected = await inspectImage(
        uploadedImage.data,
        uploadedImage.fileName,
      );
      return {
        attachment: {
          mediaType: inspected.mediaType,
          dataBase64: uploadedImage.data.toString("base64"),
        },
        source: {
          kind: "uploaded",
          fileName: path.basename(uploadedImage.fileName) || "anchor-image",
          outfitId: target === "outfit" ? (outfit?.outfitId ?? null) : null,
          outfitName: target === "outfit" ? (outfit?.name ?? null) : null,
        },
      };
    }

    if (defaultAsset === null) {
      throw new SceneImageAnchorImageRequiredError();
    }
    const file = this.appearance.readAsset(roleId, defaultAsset.assetId);
    return {
      attachment: {
        mediaType: file.mediaType,
        dataBase64: file.data.toString("base64"),
      },
      source: {
        kind: "outfit_asset",
        fileName: file.fileName,
        outfitId: outfit?.outfitId ?? null,
        outfitName: outfit?.name ?? null,
      },
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

function pickBaseAnchorAsset(
  outfits: readonly OutfitRecord[],
  currentOutfitId: string | null,
): { outfit: OutfitRecord | null; asset: OutfitAssetRecord | null } {
  const currentOutfit =
    currentOutfitId === null
      ? null
      : (outfits.find((item) => item.outfitId === currentOutfitId) ?? null);
  if (currentOutfit?.home !== null && currentOutfit?.home !== undefined) {
    return { outfit: currentOutfit, asset: currentOutfit.home };
  }
  const anyHomeOutfit = outfits.find((item) => item.home !== null) ?? null;
  if (anyHomeOutfit?.home !== null && anyHomeOutfit?.home !== undefined) {
    return { outfit: anyHomeOutfit, asset: anyHomeOutfit.home };
  }
  if (currentOutfit !== null && currentOutfit.sprites.length > 0) {
    return { outfit: currentOutfit, asset: currentOutfit.sprites[0]! };
  }
  const anySpriteOutfit =
    outfits.find((item) => item.sprites.length > 0) ?? null;
  if (anySpriteOutfit !== null) {
    return { outfit: anySpriteOutfit, asset: anySpriteOutfit.sprites[0]! };
  }
  return { outfit: null, asset: null };
}

function buildAnchorPromptRequest(input: {
  target: AnchorPromptTarget;
  displayName: string;
  outfit: OutfitRecord | null;
  previousPrompt?: string | undefined;
  image: ModelImageAttachment;
}): { system: string; user: string } {
  const previous = (input.previousPrompt ?? "").trim();
  const characterLabel = input.displayName.trim() || "该角色";
  if (input.target === "base") {
    const system = [
      "你是文生图（MOSS-Image）角色一致性提示词助手。",
      "请认真观察用户提供的角色锚点图，提炼该角色跨场景保持不变的「基础锚点提示词」。",
      "只包含：画风质感（如二次元插画、日系厚涂或写实摄影质感等）、年龄与性别气质、脸型五官、瞳色神态、发型发长发色刘海、肤色身形等恒定外观特征。",
      "严格禁止描写当前所穿服装、鞋袜配饰、背景环境、拍摄构图、动作或光线（服饰和场景会在后续分别拼接）。",
      "直接输出一行中文短语，用中文全角逗号“，”分隔，约 40～140 字；不要输出标题、前缀、序号、引号、Markdown 或任何解释。",
    ].join("\n");
    const userLines = [
      `角色名：${characterLabel}`,
      previous.length === 0
        ? "请根据这张锚点图生成基础锚点提示词。"
        : `上一版提示词：${previous}\n请重新核对参考图细节，生成一版更准确或换一种精准措辞的基础锚点提示词（避免原封不动照抄上一版）。`,
    ];
    return { system, user: userLines.join("\n") };
  }

  const outfitLabel = input.outfit?.name?.trim() || "当前服饰";
  const outfitDesc = input.outfit?.description?.trim() ?? "";
  const system = [
    "你是文生图（MOSS-Image）服饰一致性提示词助手。",
    "请认真观察用户提供的服饰参考图，提炼角色身上的「服饰锚点提示词」。",
    "只包含：上衣、外套、裙装或裤装、鞋袜、领饰腰带、包袋帽子以及可见服饰配色、材质纹理与剪裁版型细节。",
    "严格禁止描写脸型、发色、发型、瞳色、身材、背景环境、构图或动作（这些属于基础锚点和场景描述）。",
    "直接输出一行中文短语，用中文全角逗号“，”分隔，约 25～110 字；不要输出标题、前缀、序号、引号、Markdown 或任何解释。",
  ].join("\n");
  const userLines = [
    `角色名：${characterLabel}`,
    `服饰名称：${outfitLabel}`,
    ...(outfitDesc.length === 0 ? [] : [`服饰备注：${outfitDesc}`]),
    previous.length === 0
      ? "请根据这张服饰参考图生成服饰锚点提示词。"
      : `上一版提示词：${previous}\n请重新核对参考图服装细节，生成一版更准确或换一种精准措辞的服饰锚点提示词（避免原封不动照抄上一版）。`,
  ];
  return { system, user: userLines.join("\n") };
}

function cleanGeneratedAnchorPrompt(raw: string, maxChars: number): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text
      .replace(/^```[^\n]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
  }
  text = text
    .replace(
      /^(?:基础锚点提示词|服饰锚点提示词|角色锚点提示词|提示词|prompt)\s*[：:]\s*/i,
      "",
    )
    .replace(/^["'“”‘’「」]+/, "")
    .replace(/["'“”‘’「」]+$/, "")
    .replace(/\r?\n+/g, "，")
    .replace(/[，,]\s*[，,]+/g, "，")
    .replace(/^[，,\s]+|[，,\s]+$/g, "")
    .trim();
  if (text.length <= maxChars) {
    return text;
  }
  const clipped = text.slice(0, maxChars);
  const lastComma = Math.max(clipped.lastIndexOf("，"), clipped.lastIndexOf(","));
  return (lastComma > maxChars * 0.6 ? clipped.slice(0, lastComma) : clipped).trim();
}
