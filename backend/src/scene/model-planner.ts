import type { RoleAccess } from "../application/role-access.js";
import type { CredentialResolver } from "../application/credential-resolver.js";
import type { ModelBindingResolver, ResolvedModelBinding } from "../application/model-binding-resolver.js";
import {
  SceneImageCanceledError,
  SceneImagePlanInvalidError,
  SceneImagePlanUnavailableError,
  SceneImagePlannerUnavailableError,
} from "../domain/errors.js";
import { isIncompleteCompletion } from "../domain/model.js";
import type { ModelPort, ModelRequest } from "../domain/model.js";
import type {
  SceneImageLayerMode,
  SceneImagePlanRecord,
  SceneImagePlannerInput,
  SceneImagePlannerPort,
} from "../domain/scene-image.js";
import { resolveCredential } from "../model/credentials.js";
import { HttpModelAdapter } from "../model/protocols.js";
import { ConversationStore } from "../storage/conversation-store.js";
import { resolveClaimedModelBinding } from "../application/model-maintenance.js";
import type { ModelCallClaim } from "../application/model-maintenance.js";

const MAX_CONTENT_CHARS = 4_000;
const MAX_CONTEXT_MESSAGE_CHARS = 600;
const MAX_CONTEXT_MESSAGES = 4;
const MAX_SEGMENT_TEXT_CHARS = 800;
const DEFAULT_MAX_OUTPUT_TOKENS = 900;

export type SceneImagePlannerModelFactory = (
  binding: ResolvedModelBinding,
) => ModelPort;

export interface ModelSceneImagePlannerOptions {
  appRoot: string;
  now?: () => Date;
  timeZone?: string;
  modelFactory?: SceneImagePlannerModelFactory;
  /** 没有可用对话模型或适配器无法初始化时使用，保持手动任务仍可完成。 */
  fallback?: SceneImagePlannerPort | null;
  maxOutputTokens?: number;
  credentialResolver?: CredentialResolver;
  /** 模型服务维护窗口：等待结束并按已保存配置重新解析（278 §2.1）。 */
  maintenance?: {
    isUnder(resourceId: string): boolean;
    wait(resourceId: string, signal?: AbortSignal): Promise<void>;
  } | null;
  /** 在途模型调用登记：与维护检查同一步完成（283 §13 R01）。 */
  claim?: {
    claim(roleId: string, resourceId: string): ModelCallClaim;
  } | null;
}

/**
 * 模型规划器：用角色的对话模型读取目标轮、附近上下文和保存的服饰，
 * 返回画面描述、图层模式与同轮句段区间。模型调用按执行归属登记，
 * 失败时任务进入可追溯的失败状态，不回退成固定规划。
 */
export class ModelSceneImagePlanner implements SceneImagePlannerPort {
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly modelFactory: SceneImagePlannerModelFactory;
  private readonly fallback: SceneImagePlannerPort | null;
  private readonly maxOutputTokens: number;
  private readonly maintenance: ModelSceneImagePlannerOptions["maintenance"];
  private readonly claim:
    | { claim(roleId: string, resourceId: string): ModelCallClaim }
    | null;

  constructor(
    private readonly access: RoleAccess,
    private readonly bindings: ModelBindingResolver,
    private readonly options: ModelSceneImagePlannerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
    this.modelFactory =
      options.modelFactory ??
      ((binding) => {
        const credential =
          options.credentialResolver === undefined
            ? resolveCredential(
                options.appRoot,
                binding.config.credentialRef,
              )
            : options.credentialResolver.resolve(
                binding.resourceId,
                binding.config.credentialRef,
              );
        return new HttpModelAdapter(binding.config, credential);
      });
    this.fallback = options.fallback ?? null;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.maintenance = options.maintenance ?? null;
    this.claim = options.claim ?? null;
  }

  async plan(
    input: SceneImagePlannerInput,
    signal?: AbortSignal,
  ): Promise<SceneImagePlanRecord> {
    let binding: ResolvedModelBinding;
    let releaseClaim: (() => void) | null = null;
    // 维护检查与在途登记同一步完成；改绑后的新目标也会重新检查（283 §12 R02、§13 R01）。
    try {
      const claimed = await resolveClaimedModelBinding(
        () => this.bindings.resolveChat(input.roleId),
        this.maintenance,
        (resourceId) =>
          this.claim === null
            ? { admitted: true, release: () => undefined }
            : this.claim.claim(input.roleId, resourceId),
        signal,
      );
      if (claimed === null) {
        throw new SceneImageCanceledError();
      }
      binding = claimed.binding;
      releaseClaim = claimed.release;
    } catch (error) {
      if (error instanceof SceneImageCanceledError) {
        throw error;
      }
      return this.fallbackPlan(input, signal);
    }
    try {
    let model: ModelPort;
    try {
      model = this.modelFactory(binding);
    } catch {
      return this.fallbackPlan(input, signal);
    }

    const startedAt = this.now().toISOString();
    let modelCallId: string;
    try {
      modelCallId = this.access.withStore(input.roleId, (storage) => {
        const store = new ConversationStore(
          storage.business.db,
          input.roleId,
          this.timeZone,
        );
        return store.startModelCall({
          executionId: input.executionId,
          resourceId: binding.resourceId,
          modelName: binding.modelName,
          protocol: binding.config.protocol,
          purpose: store.getExecutionPurpose(input.executionId),
          counted: false,
          now: startedAt,
        });
      });
    } catch {
      // 先登记后调用：登记失败时不发出模型请求，任务保留可追溯的失败状态。
      throw new SceneImagePlanUnavailableError();
    }

    const prompt = buildSceneImagePlanPrompt(input);
    const request: ModelRequest = {
      modelName: binding.modelName,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      tools: [],
      maxOutputTokens: this.maxOutputTokens,
      ...(signal === undefined ? {} : { signal }),
    };
    let output = "";
    let completed = false;
    let usage: { inputTokens?: number; outputTokens?: number } | null = null;
    let rawResponse: unknown;
    let failureCode: string | null = null;
    try {
      for await (const event of model.stream(request)) {
        if (event.type === "text_delta") {
          output += event.text;
        } else if (event.type === "usage") {
          usage = {
            ...(event.inputTokens === undefined
              ? {}
              : { inputTokens: event.inputTokens }),
            ...(event.outputTokens === undefined
              ? {}
              : { outputTokens: event.outputTokens }),
          };
        } else if (event.type === "completed") {
          completed = !isIncompleteCompletion(event);
          rawResponse = event.rawResponse;
        }
      }
      if (!completed) {
        failureCode = "INCOMPLETE_RESPONSE";
      }
    } catch (error) {
      failureCode = errorCodeOf(error);
    }
    if (modelCallId !== null) {
      try {
        this.access.withStore(input.roleId, (storage) => {
          new ConversationStore(
            storage.business.db,
            input.roleId,
            this.timeZone,
          ).finishModelCall({
            modelCallId,
            status: failureCode === null ? "succeeded" : "failed",
            errorCode: failureCode,
            usage,
            ...(rawResponse === undefined ? {} : { rawResponse }),
            now: this.now().toISOString(),
          });
        });
      } catch {
        // 记录失败不阻断已取得的规划结果。
      }
    }
    if (signal?.aborted === true) {
      throw new SceneImageCanceledError();
    }
    if (failureCode !== null) {
      throw new SceneImagePlanInvalidError("规划模型调用未完成", {
        code: failureCode,
      });
    }
    const parsed = parseSceneImagePlanOutput(output);
    if (parsed === null) {
      throw new SceneImagePlanInvalidError("规划模型没有返回有效的画面方案");
    }
    const requested = input.requestedLayerMode;
    let layerMode: SceneImageLayerMode;
    if (requested !== null) {
      if (parsed.layerMode !== requested) {
        // 手动指定图层优先；缺失、非法或相反图层都拒绝，避免把人物描述当纯背景发给生成端。
        throw new SceneImagePlanInvalidError("规划结果与指定图层冲突", {
          requestedLayerMode: requested,
          plannedLayerMode: parsed.layerMode,
        });
      }
      layerMode = requested;
    } else if (parsed.layerMode !== null) {
      layerMode = parsed.layerMode;
    } else {
      throw new SceneImagePlanInvalidError("规划结果缺少有效图层");
    }
    const first = input.segments[0];
    const last = input.segments.at(-1);
    return {
      description: parsed.description,
      layerMode,
      startSegmentId: parsed.startSegmentId ?? first?.segmentId ?? "",
      endSegmentId: parsed.endSegmentId ?? last?.segmentId ?? "",
    };
    } finally {
      releaseClaim?.();
    }
  }

  private async fallbackPlan(
    input: SceneImagePlannerInput,
    signal?: AbortSignal,
  ): Promise<SceneImagePlanRecord> {
    if (this.fallback === null) {
      throw new SceneImagePlannerUnavailableError();
    }
    return this.fallback.plan(input, signal);
  }
}

export interface SceneImagePlanPrompt {
  system: string;
  user: string;
}

export function buildSceneImagePlanPrompt(
  input: SceneImagePlannerInput,
): SceneImagePlanPrompt {
  const outfitName = input.outfit.name ?? "未指定";
  const outfitLine =
    input.outfit.description === null
      ? `角色当前服饰：${outfitName}。`
      : `角色当前服饰：${outfitName}（${input.outfit.description}）。`;
  const referenceLine = input.outfit.hasCharacterReference
    ? "整幅图可以使用已保存的服饰参考图，人物外观应与该服饰一致。"
    : "没有可用的服饰参考图，人物外观按服饰名称与描述保持连贯。";
  const layerRule =
    input.requestedLayerMode === null
      ? "- background 只画环境背景，不画人物；full_scene 同时画角色与场景。"
      : input.requestedLayerMode === "background"
        ? '- 本次指定 layerMode="background"：只描述环境、光线与氛围，不要描述人物外貌、动作或表情，layerMode 必须输出 "background"。'
        : '- 本次指定 layerMode="full_scene"：描述角色与场景，人物外观与服饰保持一致，layerMode 必须输出 "full_scene"。';
  const system = [
    "你是对话演出的过场图规划器，为角色的一条已保存回复规划一张插画。",
    outfitLine,
    referenceLine,
    "只输出 JSON 对象，不要代码块和解释，格式：",
    '{"description":"...","layerMode":"background|full_scene","startSegmentId":"...","endSegmentId":"..."}',
    "规则：",
    "- description 用中文描述画面主体、动作、环境、光线、构图和氛围，不写台词，不出现文字、字幕、对话气泡或界面元素，不超过 800 字。",
    layerRule,
    "- startSegmentId 与 endSegmentId 必须来自给出的句段，区间首尾都包含，顺序有效，并尽量覆盖画面所对应的情节。",
    "- 区间之外的内容不要画进同一张图。",
  ].join("\n");
  const user = JSON.stringify({
    reply: truncate(input.content, MAX_CONTENT_CHARS),
    requestedLayerMode: input.requestedLayerMode,
    outfit: {
      name: input.outfit.name,
      description: input.outfit.description,
    },
    context: input.context.slice(-MAX_CONTEXT_MESSAGES).map((message) => ({
      sender: message.sender,
      content: truncate(message.content, MAX_CONTEXT_MESSAGE_CHARS),
    })),
    segments: input.segments.map((segment) => ({
      segmentId: segment.segmentId,
      ordinal: segment.ordinal,
      kind: segment.kind,
      text: truncate(segment.text, MAX_SEGMENT_TEXT_CHARS),
    })),
  });
  return { system, user };
}

export interface ParsedSceneImagePlan {
  description: string;
  layerMode: SceneImageLayerMode | null;
  startSegmentId: string | null;
  endSegmentId: string | null;
}

/** 容错解析：允许代码块包裹和前后解释文字，其余字段严格校验。 */
export function parseSceneImagePlanOutput(
  text: string,
): ParsedSceneImagePlan | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (description.length === 0) {
    return null;
  }
  const layerMode =
    record.layerMode === "background" || record.layerMode === "full_scene"
      ? record.layerMode
      : null;
  return {
    description,
    layerMode,
    startSegmentId: nonEmptyString(record.startSegmentId),
    endSegmentId: nonEmptyString(record.endSegmentId),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "MODEL_REQUEST_FAILED";
}
