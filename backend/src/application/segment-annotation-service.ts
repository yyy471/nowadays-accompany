import type { OutfitRecord } from "../domain/appearance.js";
import type { MessageSegmentRecord } from "../domain/conversation.js";
import type { ModelPort, ModelRequest, ModelUsage } from "../domain/model.js";
import { isIncompleteCompletion } from "../domain/model.js";
import { mergeModelUsage, type TokenUsageCallEvent } from "../domain/token-usage.js";
import type { MessageSegmentKind } from "../domain/message-segments.js";
import type { VoiceProtocol, VoiceSettingsRecord } from "../domain/voice.js";
import { AppearanceStore } from "../storage/appearance-store.js";
import { VoiceStore } from "../storage/voice-store.js";
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
  /** 解析角色关联的全局语音服务运行态，确保随服务默认引擎／停用状态同步。 */
  resolveVoiceRuntime?: (
    settings: VoiceSettingsRecord,
  ) => {
    protocol: VoiceProtocol;
    enabled: boolean;
    ttsEngine: string | null;
  };
  /** 模型调用结束时上报全局 Token 账本（DL-183）。 */
  onModelCallFinished?: (event: TokenUsageCallEvent) => void;
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
  outfitName: string | null;
  segments: readonly AnnotationSegmentInput[];
  sprites: readonly AnnotationSpriteInput[];
  rolePersona?: string;
  recentTurns?: ReadonlyArray<{ sender: "user" | "assistant"; content: string }>;
  voiceEmotion?: {
    enabled: boolean;
    ttsEngine: string | null;
  } | null;
}

export interface SegmentAnnotationPick {
  segmentId: string;
  spriteAssetId: string | null;
  voiceEmotion?: string | null;
}

// 推理与可见 JSON 共用供应商的输出 token 配额；未声明容量时也保持单次调用有界。
const MAX_ANNOTATION_TOKENS = 4096;

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
  private readonly resolveVoiceRuntime:
    | SegmentAnnotationServiceOptions["resolveVoiceRuntime"]
    | undefined;
  private readonly onModelCallFinished: ((event: TokenUsageCallEvent) => void) | undefined;
  private readonly activeMessages = new Map<string, Set<Promise<number>>>();

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
    this.resolveVoiceRuntime = options.resolveVoiceRuntime;
    this.onModelCallFinished = options.onModelCallFinished;
  }

  /** 若指定消息的句段标注仍在执行，最多等待 timeoutMs 让语音首句拿到情绪指令。 */
  async awaitMessage(
    messageId: string,
    timeoutMs: number = 1800,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const active = this.activeMessages.get(messageId);
    if (active === undefined || active.size === 0 || timeoutMs <= 0) {
      return;
    }
    const done = Promise.allSettled([...active]).then(() => undefined);
    await waitWithTimeoutAndAbort(done, timeoutMs, signal);
  }

  annotate(input: SegmentAnnotationRequest): Promise<number> {
    let tasks = this.activeMessages.get(input.messageId);
    if (tasks === undefined) {
      tasks = new Set();
      this.activeMessages.set(input.messageId, tasks);
    }
    let settled = false;
    const task = this.runAnnotate(input).finally(() => {
      settled = true;
      const current = this.activeMessages.get(input.messageId);
      current?.delete(task);
      if (current !== undefined && current.size === 0) {
        this.activeMessages.delete(input.messageId);
      }
    });
    if (!settled) {
      tasks.add(task);
    } else if (tasks.size === 0) {
      this.activeMessages.delete(input.messageId);
    }
    return task;
  }

  private async runAnnotate(input: SegmentAnnotationRequest): Promise<number> {
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
              callKind: "segment_annotation",
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
      outfitName: prepared.outfit?.name ?? null,
      segments: prepared.segments,
      sprites: (prepared.outfit?.sprites ?? []).map((sprite) => ({
        spriteAssetId: sprite.assetId,
        displayName: sprite.displayName,
        fileName: sprite.fileName,
      })),
      ...(prepared.hasVoiceEmotion
        ? {
            rolePersona: prepared.rolePersona,
            recentTurns: prepared.recentTurns,
            voiceEmotion: {
              enabled: true,
              ttsEngine: prepared.ttsEngine,
            },
          }
        : {}),
    });
    const maxVisibleChars = binding.config.maxOutputChars;
    const modelRequest: ModelRequest = {
      modelName: binding.modelName,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      tools: [],
      // 字符声明只保守收紧请求；可见文本的字符上限由接收端另按实际长度校验。
      maxOutputTokens: Math.min(MAX_ANNOTATION_TOKENS, maxVisibleChars ?? MAX_ANNOTATION_TOKENS),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    let output = "";
    let completed = false;
    let usage: ModelUsage | null = null;
    let rawResponse: unknown;
    let failureCode: string | null = null;
    try {
      for await (const event of model.stream(modelRequest)) {
        if (event.type === "text_delta") {
          if (maxVisibleChars !== undefined && output.length + event.text.length > maxVisibleChars) {
            failureCode = "ANNOTATION_OUTPUT_TOO_LONG";
          } else if (failureCode === null) {
            output += event.text;
          }
        } else if (event.type === "usage") {
          usage = mergeModelUsage(usage, event);
        } else if (event.type === "completed") {
          completed = !isIncompleteCompletion(event);
          rawResponse = event.rawResponse;
        }
      }
      if (!completed && failureCode === null) {
        failureCode = "INCOMPLETE_RESPONSE";
      }
    } catch (error) {
      failureCode = errorCodeOf(error);
    }
    const finishedAt = this.now().toISOString();
    const status: "succeeded" | "failed" = failureCode === null ? "succeeded" : "failed";
    try {
      this.access.withStore(input.roleId, (storage) => {
        new ConversationStore(
          storage.business.db,
          input.roleId,
          this.timeZone,
        ).finishModelCall({
          modelCallId,
          status,
          errorCode: failureCode,
          usage,
          ...(rawResponse === undefined ? {} : { rawResponse }),
          now: finishedAt,
        });
      });
    } catch {
      // 记录失败不阻断已取得的标注结果；未闭合的调用由后续清理处理。
    }
    this.onModelCallFinished?.({
      sourceCallId: `role:${input.roleId}:${modelCallId}`,
      roleId: input.roleId,
      resourceId: binding.resourceId,
      modelName: binding.modelName,
      protocol: binding.config.protocol,
      category: "annotation",
      status,
      occurredAt: finishedAt,
      usage,
    });
    if (failureCode !== null) {
      return 0;
    }
    const picks = parseSegmentAnnotationOutput(output, {
      segmentIds: new Set(prepared.segments.map((segment) => segment.segmentId)),
      spriteAssetIds: new Set(
        (prepared.outfit?.sprites ?? []).map((sprite) => sprite.assetId),
      ),
      ...(prepared.hasVoiceEmotion
        ? {
            speechSegmentIds: new Set(
              prepared.segments
                .filter((segment) => segment.kind === "speech")
                .map((segment) => segment.segmentId),
            ),
          }
        : {}),
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
          outfitId: prepared.outfit?.outfitId ?? null,
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
    outfit: OutfitRecord | null;
    segments: AnnotationSegmentInput[];
    purpose: "user_chat" | "autonomous";
    hasVoiceEmotion: boolean;
    ttsEngine: string | null;
    rolePersona: string;
    recentTurns: Array<{ sender: "user" | "assistant"; content: string }>;
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
      const loadedOutfit =
        outfitId === null
          ? null
          : new AppearanceStore(storage.business.db, input.roleId).getOutfit(
              outfitId,
            );
      const outfit =
        loadedOutfit !== null && loadedOutfit.sprites.length > 0
          ? loadedOutfit
          : null;
      const voiceSettings = new VoiceStore(
        storage.business.db,
        input.roleId,
      ).getSettings();
      const effectiveVoice =
        voiceSettings === null
          ? null
          : this.resolveVoiceRuntime
            ? this.resolveVoiceRuntime(voiceSettings)
            : {
                protocol: voiceSettings.protocol,
                enabled: voiceSettings.enabled,
                ttsEngine: voiceSettings.ttsEngine,
              };
      const hasVoiceEmotion =
        effectiveVoice !== null &&
        effectiveVoice.enabled &&
        effectiveVoice.protocol === "nowadays-tts-v1" &&
        pending.some((segment) => segment.kind === "speech");
      if (outfit === null && !hasVoiceEmotion) {
        return null;
      }
      const recentTurns = hasVoiceEmotion
        ? store.listRecentContextBefore(input.windowId, input.messageId, 4).map((turn) => ({
            sender: turn.sender,
            content: truncateText(turn.content, 240),
          }))
        : [];
      return {
        displayName: role.displayName,
        outfit,
        segments: pending.map(mapPendingSegment),
        purpose: store.getExecutionPurpose(input.executionId),
        hasVoiceEmotion,
        ttsEngine: effectiveVoice?.ttsEngine ?? null,
        rolePersona: hasVoiceEmotion ? truncateText(role.definitionText, 300) : "",
        recentTurns,
      };
    });
  }
}

export function buildSegmentAnnotationPrompt(input: AnnotationModelInput): {
  system: string;
  user: string;
} {
  const hasSprites = input.sprites.length > 0;
  const hasVoice = input.voiceEmotion?.enabled === true;
  if (!hasVoice) {
    const system = [
      `你是对话演出的立绘标注器，为角色「${input.displayName}」当前服饰「${input.outfitName ?? ""}」的句段选择最合适的差分立绘。`,
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

  const formatExample = hasSprites
    ? '{"segments":[{"segmentId":"...","spriteAssetId":"可选或null","voiceEmotion":"对白句段填写简短情绪语气"}]}'
    : '{"segments":[{"segmentId":"...","voiceEmotion":"简短情绪语气"}]}';
  const engineHint =
    input.voiceEmotion?.ttsEngine === "indextts"
      ? "- voiceEmotion 面向 IndexTTS 情感合成，优先使用凝练明确的中文情绪/神态词（如：温柔、开心、傲娇、撒娇、俏皮、委屈、难过、哭泣、紧张、害怕、兴奋、激动、惊喜、生气、愤怒、嫌弃、无奈、平静）或 2～6 字情绪短语。"
      : "- voiceEmotion 面向自然语言语音指令（如 CosyVoice3），请结合说话动机输出 4～16 字中文语气与神态指示（如「温柔轻声哄人」「嘴硬傲娇带点羞涩」「轻快含笑打趣」「委屈低声强装平静」「惊喜扬眉」），兼顾音调轻重与气息感。";
  const systemLines = [
    `你是对话演出的配音与表演导演，为角色「${input.displayName}」${
      hasSprites && input.outfitName ? `当前服饰「${input.outfitName}」` : ""
    }的句段标注语音情绪指令${hasSprites ? "与差分立绘" : ""}。`,
    "只输出 JSON 对象，不要代码块和解释，格式：",
    formatExample,
    "规则：",
    "- 以对话真实感与戏剧张力为先，结合角色人设（rolePersona）、前文对话（recentTurns）、相邻旁白描写（narration）与台词潜台词判断每句台词的实际语气，不要千篇一律回落成平淡或温柔。",
    "- voiceEmotion 仅对 kind=\"speech\" 的对白句段输出，kind=\"narration\" 旁白句段设为 null 或省略；多句对白请体现合理的情绪递进与起伏。",
    engineHint,
    ...(hasSprites
      ? [
          "- spriteAssetId 只能使用给出的列表或设为 null；表情在句段开始时切换，不需要切换可省略。",
        ]
      : []),
    "- 只标注给出的句段，禁止修改原文。",
  ];
  const userPayload: Record<string, unknown> = {
    ...(input.rolePersona ? { rolePersona: input.rolePersona } : {}),
    ...(input.recentTurns && input.recentTurns.length > 0
      ? { recentTurns: input.recentTurns }
      : {}),
    segments: input.segments.map((segment) => ({
      segmentId: segment.segmentId,
      ordinal: segment.ordinal,
      kind: segment.kind,
      text: segment.text,
    })),
    ...(hasSprites ? { sprites: input.sprites } : {}),
  };
  return {
    system: systemLines.join("\n"),
    user: JSON.stringify(userPayload),
  };
}

export function parseSegmentAnnotationOutput(
  text: string,
  allowed: {
    segmentIds: ReadonlySet<string>;
    spriteAssetIds: ReadonlySet<string>;
    speechSegmentIds?: ReadonlySet<string>;
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
  const allowVoice = allowed.speechSegmentIds !== undefined;
  const picks: SegmentAnnotationPick[] = [];
  const seen = new Set<string>();
  for (const item of segments) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const segmentId = record.segmentId;
    if (
      typeof segmentId !== "string" ||
      seen.has(segmentId) ||
      !allowed.segmentIds.has(segmentId)
    ) {
      continue;
    }
    const rawSprite = record.spriteAssetId;
    const validSprite =
      typeof rawSprite === "string" && allowed.spriteAssetIds.has(rawSprite)
        ? rawSprite
        : null;
    if (!allowVoice) {
      if (validSprite === null) {
        continue;
      }
      seen.add(segmentId);
      picks.push({ segmentId, spriteAssetId: validSprite });
      continue;
    }
    const isSpeech = allowed.speechSegmentIds!.has(segmentId);
    const voiceEmotion = isSpeech ? normalizeVoiceEmotion(record.voiceEmotion) : null;
    if (validSprite === null && voiceEmotion === null) {
      continue;
    }
    seen.add(segmentId);
    picks.push({
      segmentId,
      spriteAssetId: validSprite,
      ...(voiceEmotion === null ? {} : { voiceEmotion }),
    });
  }
  return picks;
}

function normalizeVoiceEmotion(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'「『【]+|["'」』】]+$/g, "")
    .trim();
  if (
    cleaned.length === 0 ||
    cleaned.toLowerCase() === "null" ||
    cleaned.toLowerCase() === "none" ||
    cleaned === "无"
  ) {
    return null;
  }
  return [...cleaned].slice(0, 40).join("");
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chars = [...normalized];
  return chars.length <= maxChars ? normalized : `${chars.slice(0, maxChars).join("")}…`;
}

async function waitWithTimeoutAndAbort(
  promise: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        if (signal !== undefined) {
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
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
