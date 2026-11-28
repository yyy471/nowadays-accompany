import { randomInt } from "node:crypto";
import {
  AppError,
  ImageServiceDisabledError,
  SceneImageNotConfiguredError,
  SceneImageServiceChangedError,
} from "../domain/errors.js";
import {
  imageServiceSiteIdentity,
  type ImageServiceRecord,
} from "../domain/image-service.js";
import type {
  GeneratedSceneImage,
  SceneCast,
  SceneImageConfigSnapshot,
  SceneImageGenerationInput,
  SceneImageGeneratorPort,
  SceneImageLayerMode,
  SceneImageReferenceImage,
} from "../domain/scene-image.js";
import type { SceneImageSettingsRecord } from "../domain/scene-image-settings.js";
import { ComfyUiClient } from "./comfyui-client.js";
import {
  applyWorkflowParams,
  backgroundBranch,
  defaultComfyWorkflow,
  parseComfyWorkflow,
  referenceWorkflow,
  type ComfyWorkflow,
} from "./comfyui-workflow.js";

export interface SceneImageRuntime {
  settings: SceneImageSettingsRecord;
  service: ImageServiceRecord;
  token: string | undefined;
}

export interface SceneImageRuntimeSource {
  getSettings(roleId: string): SceneImageSettingsRecord | null;
  /** 只读服务记录，不解析凭据；用于任务接收时固定配置与展示。 */
  findServiceRecord(serviceId: string): ImageServiceRecord | null;
  findService(serviceId: string): {
    record: ImageServiceRecord;
    token: string | undefined;
  } | null;
}

const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;

export const SCENE_PAINTING_STYLE = "精致唯美的日系动画电影插画，具有高完成度数字插画的细腻质感。线稿纤细柔和，边缘清晰，采用轻盈柔润的数字绘色，细致的色彩渐变与层叠的明暗自然交融，材质的细节丰富而干净。环境精致通透并保有自然的空间深度，前景与背景色调协调，绘制质感一致。";
export const CHARACTER_PAINTING_STYLE = "人物的眼睫和眼角勾勒细致，眼睛有多层透明色泽与细小高光，发丝精细分层，皮肤明暗过渡柔和，衣物材质和褶皱细致。";

/** 四段使用同一画法。已解析的出镜人物完整替换默认锚点。 */
export function composeSceneImagePrompt(
  settings: Pick<SceneImageSettingsRecord, "basePrompt" | "modelType">,
  layerMode: SceneImageLayerMode,
  outfitPrompt: string,
  sceneText: string,
  cast?: SceneCast,
): string {
  if (settings.modelType === "img2img") {
    return layerMode === "background" ? sceneText.trim()
      : [settings.basePrompt.trim(), sceneText.trim()].filter(Boolean).join("，");
  }
  if (layerMode === "background" || cast?.length === 0) {
    return [SCENE_PAINTING_STYLE, sceneText.trim()].filter(Boolean).join("\n");
  }
  const appearance = cast === undefined ? settings.basePrompt.trim()
    : cast.map(person => [person.name, person.appearance].filter(Boolean).join("，")).join("；");
  const clothing = cast === undefined ? outfitPrompt.trim()
    : cast.filter(person => person.clothing).map(person => `${person.name}，${person.clothing}`).join("；");
  const portrait = appearance ? appearance.replace(/[。；，]+$/u, "") + "。" + CHARACTER_PAINTING_STYLE : CHARACTER_PAINTING_STYLE;
  return [SCENE_PAINTING_STYLE, portrait, clothing, sceneText.trim()].filter(Boolean).join("\n");
}

/**
 * 取角色当前生效的生图配置。完全没有配置时返回 null，交给调用方决定
 * 是否回退；配了但服务被删除或停用时直接报错，不能静默换成占位图。
 */
export function resolveSceneImageRuntime(
  source: SceneImageRuntimeSource,
  roleId: string,
): SceneImageRuntime | null {
  const settings = source.getSettings(roleId);
  if (settings === null) {
    return null;
  }
  const connection = source.findService(settings.serviceId);
  if (connection === null) {
    throw new SceneImageNotConfiguredError("生图服务已被删除，请重新选择");
  }
  if (!connection.record.enabled) {
    throw new ImageServiceDisabledError(settings.serviceId);
  }
  return {
    settings,
    service: connection.record,
    token: connection.token,
  };
}

/** 按角色配置调用 ComfyUI 出图；预览与正式过场图共用这一条路径。 */
export class ComfyUiImageGenerator {
  async generate(
    runtime: SceneImageRuntime,
    prompt: string,
    signal?: AbortSignal,
    reference?: SceneImageReferenceImage,
    layer: SceneImageLayerMode = "full_scene",
  ): Promise<GeneratedSceneImage> {
    const { settings, service } = runtime;
    const img2img = settings.modelType === "img2img";
    if (img2img && layer === "full_scene" && !settings.workflow) {
      throw new AppError(422, "SCENE_REFERENCE_WORKFLOW_REQUIRED", "图生图需要导入带 LoadImage 的 ComfyUI API 工作流");
    }
    if (img2img && layer === "full_scene" && !reference) {
      throw new AppError(422, "SCENE_REFERENCE_MISSING", "目标回复的服饰没有可用的图生图参考图");
    }
    const background = img2img && layer === "background";
    const configured = settings.workflow && parseComfyWorkflow(settings.workflow);
    const bg = background && configured ? backgroundBranch(configured, settings.outputNodeId) : undefined;
    if (background && !bg && !/moss/i.test(settings.modelPath)) {
      throw new AppError(422, "SCENE_BACKGROUND_WORKFLOW_REQUIRED", "该模型未配置独立的纯背景输出，请在工作流中增加不读取角色参考图的 SaveImage 分支");
    }
    const referenceBranch = img2img && !background && configured ? referenceWorkflow(configured, settings.outputNodeId) : undefined;
    const workflow: ComfyWorkflow = (background ? bg?.workflow : referenceBranch?.workflow ?? configured) ?? defaultComfyWorkflow();
    const patched = applyWorkflowParams(
      workflow,
      {
        prompt,
        negativePrompt: settings.negativePrompt,
        width: settings.width,
        height: settings.height,
        steps: settings.steps,
        cfg: settings.cfg,
        sampler: settings.sampler,
        scheduler: settings.scheduler,
        seed: settings.seed ?? randomInt(0, 2_147_483_647),
        modelPath: settings.modelPath,
      },
      background ? bg?.output ?? null : referenceBranch?.output ?? settings.outputNodeId,
    );
    const client = new ComfyUiClient({
      baseUrl: service.config.baseUrl,
      token: runtime.token,
      generationTimeoutMs:
        service.config.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
    });
    if (referenceBranch && reference) {
      const [imageId, imageNode] = Object.entries(patched.workflow).find(
        ([, node]) => node.class_type === "LoadImage" && typeof node.inputs.image === "string",
      )!;
      imageNode.inputs.image = await client.uploadReference(reference.data, reference.mediaType, signal);
      for (const node of Object.values(patched.workflow)) {
        if (node.class_type === "ImageScale" && Array.isArray(node.inputs.image) && node.inputs.image[0] === imageId) {
          node.inputs.width = settings.width;
          node.inputs.height = settings.height;
        }
      }
    }
    const image = await client.run(patched.workflow, {
      signal,
      outputNodeId: patched.outputNodeId,
    });
    // 真实尺寸由上层解码校验时确认，这里先按请求值回报。
    return {
      data: image.data,
      mediaType: image.mediaType,
      width: settings.width,
      height: settings.height,
    };
  }
}

export interface ConfiguredSceneImageGeneratorOptions {
  source: SceneImageRuntimeSource;
  /**
   * 仅供测试显式注入：未配置生图服务时用占位生成器离线验证任务链路。
   * 正式产品行为是未配置即失败，因此默认不提供回退。
   */
  fallback?: SceneImageGeneratorPort;
  generator?: ComfyUiImageGenerator;
}

/**
 * 过场图生成入口：配了 ComfyUI 就走真实服务，未配置则明确失败
 * （409 SCENE_IMAGE_NOT_CONFIGURED），不会生成占位图。
 * fallback 只在测试显式注入时用于离线验证。
 */
export class ConfiguredSceneImageGenerator
  implements SceneImageGeneratorPort
{
  private readonly comfy: ComfyUiImageGenerator;

  constructor(private readonly options: ConfiguredSceneImageGeneratorOptions) {
    this.comfy = options.generator ?? new ComfyUiImageGenerator();
  }

  /** 任务接收时固定配置；未配置且无测试回退时直接拒绝，不创建任务。 */
  lock(roleId: string): SceneImageConfigSnapshot | null {
    const settings = this.options.source.getSettings(roleId);
    if (settings === null) {
      if (this.options.fallback === undefined) {
        throw new SceneImageNotConfiguredError("角色还没有配置生图服务");
      }
      return { version: 1, settings: null, service: null };
    }
    const service = this.options.source.findServiceRecord(settings.serviceId);
    return {
      version: 1,
      settings,
      service:
        service === null
          ? null
          : {
              protocol: service.config.protocol,
              baseUrl: service.config.baseUrl,
              timeoutMs: service.config.timeoutMs ?? null,
            },
    };
  }

  async generate(input: SceneImageGenerationInput): Promise<GeneratedSceneImage> {
    const runtime = this.runtimeFor(input);
    if (runtime === null) {
      if (this.options.fallback === undefined) {
        throw new SceneImageNotConfiguredError("角色还没有配置生图服务");
      }
      return this.options.fallback.generate(input);
    }
    const outfitId = input.outfit.outfitId;
    const outfitPrompt =
      runtime.settings.modelType === "text2img" && input.layerMode === "full_scene" && outfitId !== null
        ? (runtime.settings.outfitPrompts[outfitId] ?? "")
        : "";
    const prompt = composeSceneImagePrompt(
      runtime.settings,
      input.layerMode,
      outfitPrompt,
      input.prompt,
      input.cast,
    );
    return this.comfy.generate(runtime, prompt, input.signal, input.references?.[0], input.layerMode);
  }

  /**
   * 任务接收时抓取的配置优先；服务地址与超时取自快照，模型和锚点也来自快照。
   * 服务被删除或停用仍在生成阶段明确失败，不回退占位生成器。
   */
  private runtimeFor(
    input: SceneImageGenerationInput,
  ): SceneImageRuntime | null {
    const snapshot = input.config;
    if (snapshot === undefined || snapshot === null) {
      return resolveSceneImageRuntime(this.options.source, input.roleId);
    }
    if (snapshot.settings === null) {
      return null;
    }
    if (snapshot.service === null) {
      throw new SceneImageNotConfiguredError("生图服务已被删除，请重新选择");
    }
    const record = this.options.source.findServiceRecord(
      snapshot.settings.serviceId,
    );
    if (record === null) {
      throw new SceneImageNotConfiguredError("生图服务已被删除，请重新选择");
    }
    // 旧地址配新站点凭据会把令牌发给另一个站点；跨站点变更直接失败。
    const pinnedIdentity = imageServiceSiteIdentity(snapshot.service);
    const currentIdentity = imageServiceSiteIdentity(record.config);
    if (pinnedIdentity !== currentIdentity) {
      throw new SceneImageServiceChangedError(pinnedIdentity, currentIdentity);
    }
    if (!record.enabled) {
      throw new ImageServiceDisabledError(snapshot.settings.serviceId);
    }
    const connection = this.options.source.findService(
      snapshot.settings.serviceId,
    );
    if (connection === null) {
      throw new SceneImageNotConfiguredError("生图服务已被删除，请重新选择");
    }
    return {
      settings: snapshot.settings,
      service: {
        ...record,
        config: {
          protocol: snapshot.service.protocol,
          baseUrl: snapshot.service.baseUrl,
          ...(snapshot.service.timeoutMs === null
            ? {}
            : { timeoutMs: snapshot.service.timeoutMs }),
        },
      },
      token: connection.token,
    };
  }
}
