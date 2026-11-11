import {
  ImageServiceDisabledError,
  ImageServiceNotFoundError,
  ImageWorkflowInvalidError,
  SceneImageNotConfiguredError,
} from "../domain/errors.js";
import type { ImageServiceProbeResult } from "../domain/image-service.js";
import type {
  SceneImagePreviewResult,
  SceneImageSettingsInput,
  SceneImageSettingsRecord,
  SceneImageSettingsView,
} from "../domain/scene-image-settings.js";
import { SceneImageSettingsStore } from "../storage/scene-image-settings-store.js";
import { ComfyUiClient } from "../scene/comfyui-client.js";
import {
  buildScenePrompt,
  ComfyUiImageGenerator,
  resolveSceneImageRuntime,
  type SceneImageRuntime,
  type SceneImageRuntimeSource,
} from "../scene/comfyui-generator.js";
import {
  defaultComfyWorkflow,
  parseComfyWorkflow,
  type ComfyWorkflow,
} from "../scene/comfyui-workflow.js";
import { inspectImage } from "./image-inspect.js";
import type { ImageServiceService } from "./image-service.js";
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
      const workflow = parseWorkflowOrThrow(input.workflow);
      if (
        input.outputNodeId !== null &&
        workflow[input.outputNodeId] === undefined
      ) {
        throw new ImageWorkflowInvalidError("输出节点不在工作流里", {
          outputNodeId: input.outputNodeId,
        });
      }
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
   * 探测当前配置能不能出图。可传候选服务与工作流，
   * 让页面在保存前先验证一次（236 §6.2）。
   */
  async probe(
    roleId: string,
    candidate: {
      serviceId?: string | undefined;
      workflow?: Record<string, unknown> | null | undefined;
    } = {},
  ): Promise<ImageServiceProbeResult> {
    const settings = this.read(roleId);
    const serviceId = candidate.serviceId ?? settings?.serviceId;
    if (serviceId === undefined) {
      throw new SceneImageNotConfiguredError("还没有选择生图服务，无法探测");
    }
    const connection = this.imageServices.resolveConnection(serviceId);
    const workflow = this.workflowOf(
      candidate.workflow === undefined ? (settings?.workflow ?? null) : candidate.workflow,
    );
    const client = new ComfyUiClient({
      baseUrl: connection.record.config.baseUrl,
      token: connection.token,
      requestTimeoutMs: this.probeTimeoutMs,
      generationTimeoutMs: this.probeTimeoutMs,
    });
    const started = Date.now();
    const probe = await client.probe(workflow);
    return { probe, elapsedMs: Date.now() - started };
  }

  /** 测试生图：用当前配置真出一张，只回给配置流程，不进过场图历史。 */
  async preview(
    roleId: string,
    input: { prompt?: string | undefined; outfitId?: string | null | undefined } = {},
  ): Promise<SceneImagePreviewResult> {
    const runtime = resolveSceneImageRuntime(this.source, roleId);
    if (runtime === null) {
      throw new SceneImageNotConfiguredError();
    }
    const outfitId = input.outfitId ?? null;
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
      throw new ImageWorkflowInvalidError("测试样图超过 8 MiB 上限", {
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

  private read(roleId: string): SceneImageSettingsRecord | null {
    return this.roleAccess.withStore(roleId, (storage) =>
      new SceneImageSettingsStore(storage.business.db, roleId).get(),
    );
  }

  private workflowOf(override: Record<string, unknown> | null): ComfyWorkflow {
    return override === null
      ? defaultComfyWorkflow()
      : parseWorkflowOrThrow(override);
  }
}

function parseWorkflowOrThrow(value: Record<string, unknown>): ComfyWorkflow {
  try {
    return parseComfyWorkflow(value);
  } catch (error) {
    throw new ImageWorkflowInvalidError(
      error instanceof Error ? error.message : "工作流结构不正确",
    );
  }
}
