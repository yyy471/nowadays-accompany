import { randomInt } from "node:crypto";
import {
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
  SceneImageConfigSnapshot,
  SceneImageGenerationInput,
  SceneImageGeneratorPort,
  SceneImageLayerMode,
} from "../domain/scene-image.js";
import type { SceneImageSettingsRecord } from "../domain/scene-image-settings.js";
import { ComfyUiClient } from "./comfyui-client.js";
import {
  applyWorkflowParams,
  defaultComfyWorkflow,
  parseComfyWorkflow,
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

/**
 * 组装提示词：角色基础锚点 + 目标服饰锚点 + 本次场景描述。
 * 空段直接跳过，避免出现连续逗号或只剩标点的提示词。
 */
export function buildScenePrompt(
  settings: Pick<SceneImageSettingsRecord, "basePrompt">,
  outfitPrompt: string,
  sceneText: string,
): string {
  return [settings.basePrompt, outfitPrompt, sceneText]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("，");
}

/** 纯背景只传环境描述，整幅图才拼接角色与服饰锚点（236 §6.3）。 */
export function composeSceneImagePrompt(
  settings: Pick<SceneImageSettingsRecord, "basePrompt">,
  layerMode: SceneImageLayerMode,
  outfitPrompt: string,
  sceneText: string,
): string {
  if (layerMode === "background") {
    return sceneText.trim();
  }
  return buildScenePrompt(settings, outfitPrompt, sceneText);
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
  ): Promise<GeneratedSceneImage> {
    const { settings, service } = runtime;
    const workflow: ComfyWorkflow =
      settings.workflow === null
        ? defaultComfyWorkflow()
        : parseComfyWorkflow(settings.workflow);
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
      settings.outputNodeId,
    );
    const client = new ComfyUiClient({
      baseUrl: service.config.baseUrl,
      token: runtime.token,
      generationTimeoutMs:
        service.config.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
    });
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
  /** 未配置真实服务时沿用占位生成器，保持首轮原型的演示行为。 */
  fallback: SceneImageGeneratorPort;
  generator?: ComfyUiImageGenerator;
}

/**
 * 过场图生成入口：配了 ComfyUI 就走真实服务，没配就走占位生成器。
 * 首版这样保留原有离线演示；正式版应改为「未配置即失败」。
 */
export class ConfiguredSceneImageGenerator
  implements SceneImageGeneratorPort
{
  private readonly comfy: ComfyUiImageGenerator;

  constructor(private readonly options: ConfiguredSceneImageGeneratorOptions) {
    this.comfy = options.generator ?? new ComfyUiImageGenerator();
  }

  /** 任务接收时固定配置；未配置真实服务时固定为回退占位生成器。 */
  lock(roleId: string): SceneImageConfigSnapshot | null {
    const settings = this.options.source.getSettings(roleId);
    if (settings === null) {
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
      return this.options.fallback.generate(input);
    }
    const outfitId = input.outfit.outfitId;
    const outfitPrompt =
      input.layerMode === "full_scene" && outfitId !== null
        ? (runtime.settings.outfitPrompts[outfitId] ?? "")
        : "";
    const prompt = composeSceneImagePrompt(
      runtime.settings,
      input.layerMode,
      outfitPrompt,
      input.prompt,
    );
    return this.comfy.generate(runtime, prompt, input.signal);
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
