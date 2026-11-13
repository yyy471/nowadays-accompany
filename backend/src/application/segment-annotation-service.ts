import type { OutfitRecord } from "../domain/appearance.js";
import type { MessageSegmentRecord } from "../domain/conversation.js";
import type { ModelPort, ModelRequest } from "../domain/model.js";
import { isIncompleteCompletion } from "../domain/model.js";
import type { MessageSegmentKind } from "../domain/message-segments.js";
import { AppearanceStore } from "../storage/appearance-store.js";
import { AutonomyStore } from "../storage/autonomy-store.js";
import { ConversationStore } from "../storage/conversation-store.js";
import type { AutonomyService } from "./autonomy-service.js";
import type { RoleAccess } from "./role-access.js";
import type {
  ModelBindingResolver,
  ResolvedModelBinding,
} from "./model-binding-resolver.js";
import { resolveClaimedModelBinding } from "./model-maintenance.js";
import type { ModelCallClaim } from "./model-maintenance.js";

export type AnnotationModelFactory = (
  binding: ResolvedModelBinding,
) => ModelPort;

export interface SegmentAnnotationServiceOptions {
  now?: () => Date;
  timeZone?: string;
  modelFactory: AnnotationModelFactory;
  autonomy?: AutonomyService | null;
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

export interface SegmentAnnotationRequest {
  roleId: string;
  windowId: string;
  messageId: string;
  executionId: string;
  /** 提交时的服饰；未提供时读取角色当前状态。 */
  outfitId?: string | null;
  /** 取消已经发出的模型请求。 */
  signal?: AbortSignal;
  /** 取消尚未领取的维护等待；删除角色时只取消这一类（283 §13 R03）。 */
  waitSignal?: AbortSignal;
}

export interface AnnotationSegmentInput {
  segmentId: string;
  ordinal: number;
  kind: MessageSegmentKind;
  text: string;
}

export interface AnnotationSpriteInput {
  spriteAssetId: string;
  displayName: string;
  fileName: string;
}

export interface AnnotationModelInput {
  displayName: string;
  outfitName: string;
  segments: readonly AnnotationSegmentInput[];
  sprites: readonly AnnotationSpriteInput[];
}

export interface SegmentAnnotationPick {
  segmentId: string;
  spriteAssetId: string;
}

/**
 * 回复提交后为句段选择表情差分。
 * 标注晚于正文保存，失败不影响已保存的回复；结果按句段写回并发布事件。
 */
export class SegmentAnnotationService {
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly modelFactory: AnnotationModelFactory;
  private readonly autonomy: AutonomyService | null;
  private readonly maintenance: SegmentAnnotationServiceOptions["maintenance"];
  private readonly claim:
    | { claim(roleId: string, resourceId: string): ModelCallClaim }
    | null;

  constructor(
    private readonly access: RoleAccess,
    private readonly bindings: ModelBindingResolver,
    options: SegmentAnnotationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
    this.modelFactory = options.modelFactory;
    this.autonomy = options.autonomy ?? null;
    this.maintenance = options.maintenance ?? null;
    this.claim = options.claim ?? null;
  }

  async annotate(input: SegmentAnnotationRequest): Promise<number> {
    const prepared = this.prepare(input);
    if (prepared === null) {
      return 0;
    }
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
        input.waitSignal ?? input.signal,
      );
      if (claimed === null) {
        return 0;
      }
      binding = claimed.binding;
      releaseClaim = claimed.release;
    } catch {
      return 0;
    }
    try {
    if (prepared.purpose === "autonomous" && this.autonomy === null) {
      return 0;
    }
    // 适配器初始化（含凭据读取）先于扣点与调用登记；初始化失败不算一次调用。
    let model: ModelPort;
    try {
      model = this.modelFactory(binding);
    } catch {
      return 0;
    }
    // 扣点与调用登记同事务：登记失败时额度不消耗，额度耗尽时不留下调用记录。
    let modelCallId: string;
    try {
      const startedAt = this.now().toISOString();
      const started = this.access.withStore(input.roleId, (storage) => {
        const db = storage.business.db;
        return db.transaction(() => {
          let counted = false;
          if (prepared.purpose === "autonomous") {
            const budget = new AutonomyStore(
              db,
              input.roleId,
              this.timeZone,
            ).consumePoint({ now: startedAt });
            if (budget.exhausted) {
              return null;
            }
            counted = budget.counted;
          }
          return new ConversationStore(db, input.roleId, this.timeZone)
            .startModelCall({
              executionId: input.executionId,
              resourceId: binding.resourceId,
              modelName: binding.modelName,
              protocol: binding.config.protocol,
              purpose: prepared.purpose,
              counted,
              now: startedAt,
            });
        })();
      });
      if (started === null) {
        return 0;
      }
      modelCallId = started;
    } catch {
      return 0;
    }
    const prompt = buildSegmentAnnotationPrompt({
      displayName: prepared.displayName,
      outfitName: prepared.outfit.name,
      segments: prepared.segments,
      sprites: prepared.outfit.sprites.map((sprite) => ({
        spriteAssetId: sprite.assetId,
        displayName: sprite.displayName,
        fileName: sprite.fileName,
      })),
    });
    const modelRequest: ModelRequest = {
      modelName: binding.modelName,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      tools: [],
      maxOutputTokens: 1200,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    let output = "";
    let completed = false;
    let usage: { inputTokens?: number; outputTokens?: number } | null = null;
    let rawResponse: unknown;
    let failureCode: string | null = null;
    try {
      for await (const event of model.stream(modelRequest)) {
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
      // 记录失败不阻断已取得的标注结果；未闭合的调用由后续清理处理。
    }
    if (failureCode !== null) {
      return 0;
    }
    const picks = parseSegmentAnnotationOutput(output, {
      segmentIds: new Set(prepared.segments.map((segment) => segment.segmentId)),
      spriteAssetIds: new Set(
        prepared.outfit.sprites.map((sprite) => sprite.assetId),
      ),
    });
    if (picks.length === 0) {
      return 0;
    }
    const now = this.now().toISOString();
    return this.access.withStore(input.roleId, (storage) => {
      const store = new ConversationStore(
        storage.business.db,
        input.roleId,
        this.timeZone,
      );
      return store.applySegmentAnnotations({
        messageId: input.messageId,
        windowId: input.windowId,
        executionId: input.executionId,
        annotations: picks.map((pick) => ({
          ...pick,
          outfitId: prepared.outfit.outfitId,
        })),
        now,
      }).length;
    });
    } finally {
      releaseClaim?.();
    }
  }

  private prepare(input: SegmentAnnotationRequest): {
    displayName: string;
    outfit: OutfitRecord;
    segments: AnnotationSegmentInput[];
    purpose: "user_chat" | "autonomous";
  } | null {
    return this.access.withStore(input.roleId, (storage) => {
      const store = new ConversationStore(
        storage.business.db,
        input.roleId,
        this.timeZone,
      );
      const detail = store.getMessageDetail(input.windowId, input.messageId);
      if (detail.message.status === "generating") {
        return null;
      }
      const pending = detail.segments.filter(
        (segment) => segment.annotatedAt === null,
      );
      if (pending.length === 0) {
        return null;
      }
      const role = store.getRoleContext();
      const stateOutfitId =
        typeof role.state.outfitId === "string" ? role.state.outfitId : null;
      const storedOutfitId =
        pending.find((segment) => segment.outfitId !== null)?.outfitId ?? null;
      const outfitId =
        storedOutfitId ??
        (input.outfitId === undefined ? stateOutfitId : input.outfitId);
      if (outfitId === null) {
        return null;
      }
      const outfit = new AppearanceStore(
        storage.business.db,
        input.roleId,
      ).getOutfit(outfitId);
      if (outfit === null || outfit.sprites.length === 0) {
        return null;
      }
      return {
        displayName: role.displayName,
        outfit,
        segments: pending.map(mapPendingSegment),
        purpose: store.getExecutionPurpose(input.executionId),
      };
    });
  }
}

export function buildSegmentAnnotationPrompt(input: AnnotationModelInput): {
  system: string;
  user: string;
} {
  const system = [
    `你是对话演出的立绘标注器，为角色「${input.displayName}」当前服饰「${input.outfitName}」的句段选择最合适的差分立绘。`,
    "只输出 JSON 对象，不要代码块和解释，格式：",
    '{"segments":[{"segmentId":"...","spriteAssetId":"..."}]}',
    "规则：",
    "- 只能使用给出的 spriteAssetId，不要编造。",
    "- 表情在句段开始时切换，并延续到下一次标注；不需要变化或无法判断的句段省略。",
    "- 旁白通常省略，除非明确描述表情或动作。",
    "- 只标注给出的句段。",
  ].join("\n");
  const user = JSON.stringify({
    segments: input.segments.map((segment) => ({
      segmentId: segment.segmentId,
      ordinal: segment.ordinal,
      kind: segment.kind,
      text: segment.text,
    })),
    sprites: input.sprites,
  });
  return { system, user };
}

export function parseSegmentAnnotationOutput(
  text: string,
  allowed: {
    segmentIds: ReadonlySet<string>;
    spriteAssetIds: ReadonlySet<string>;
  },
): SegmentAnnotationPick[] {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const segments = (parsed as { segments?: unknown }).segments;
  if (!Array.isArray(segments)) {
    return [];
  }
  const picks: SegmentAnnotationPick[] = [];
  const seen = new Set<string>();
  for (const item of segments) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const segmentId = record.segmentId;
    const spriteAssetId = record.spriteAssetId;
    if (
      typeof segmentId !== "string" ||
      typeof spriteAssetId !== "string" ||
      seen.has(segmentId) ||
      !allowed.segmentIds.has(segmentId) ||
      !allowed.spriteAssetIds.has(spriteAssetId)
    ) {
      continue;
    }
    seen.add(segmentId);
    picks.push({ segmentId, spriteAssetId });
  }
  return picks;
}

function mapPendingSegment(segment: MessageSegmentRecord): AnnotationSegmentInput {
  return {
    segmentId: segment.segmentId,
    ordinal: segment.ordinal,
    kind: segment.kind,
    text: segment.text,
  };
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
