import { createHash } from "node:crypto";
import type { ModelProtocol } from "../../domain/model.js";
import type { ModelProvider } from "../../domain/model-providers.js";

/** DL-202 主对话默认输入与输出 token 预算。 */
export const DEFAULT_DIALOGUE_INPUT_TOKENS = 128_000;
export const DEFAULT_DIALOGUE_OUTPUT_TOKENS = 10_000;

/** 兼容旧字符口径调用与未迁移配置的默认常量。 */
export const DEFAULT_AGENT_INPUT_CHARS = 128_000;
export const DEFAULT_AGENT_OUTPUT_RESERVE_CHARS = 4_096;

/** 单张多模态图片的保守 token 占位（避免把 base64 文本按字符计成数万 token）。 */
const ESTIMATED_TOKENS_PER_IMAGE = 1_024;
const BASE64_IMAGE_PATTERN = /"(?:url|data|image_url)"\s*:\s*"(?:data:image\/[^";]+;base64,)?[A-Za-z0-9+/=]{128,}"/g;

export interface DialogueCapacityConfig {
  /** 显式 token 口径（DL-202）。 */
  contextWindowTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** 显式旧字符口径（向后兼容 DL-164 与旧资源配置）。 */
  maxInputChars?: number;
  maxOutputChars?: number;
}

export interface ResolvedDialogueBudget {
  mode: "tokens" | "chars";
  /** 有效输入上限（tokens 模式下为 token 数；chars 模式下为 UTF-16 字符数）。 */
  effectiveInputLimit: number;
  /** 有效输出预留/上限（tokens 模式下显式传给模型协议；chars 模式下按旧契约参与总量扣除）。 */
  effectiveOutputLimit: number;
  /** 有效总窗口（若声明了总窗口或处于字符模式则给出明确值，否则为 null）。 */
  effectiveContextWindow: number | null;
  /** 仅在 tokens 模式下返回需要透传给协议的 maxOutputTokens。 */
  wireMaxOutputTokens: number | undefined;
}

export interface TokenEstimationMeta {
  method: "protocol_profile" | "conservative_compatible";
  conservative: boolean;
  maxErrorRatio: number;
}

/**
 * 解析主对话有效预算（DL-202）：
 * - 显式提供 token 口径或均未配置时，采用 token 口径（默认 128,000 输入 / 10,000 输出）：
 *   先按模型能力确定输出上限，再取输入目标、模型输入上限与总窗口扣除输出预留三者的最小值。
 * - 仅配置旧字符口径（maxInputChars / maxOutputChars）时，保留字符单位避免静默错算。
 */
export function resolveDialogueBudget(
  config: DialogueCapacityConfig,
): ResolvedDialogueBudget {
  const hasTokenConfig =
    config.contextWindowTokens !== undefined ||
    config.maxInputTokens !== undefined ||
    config.maxOutputTokens !== undefined;
  const hasLegacyCharConfig =
    config.maxInputChars !== undefined || config.maxOutputChars !== undefined;

  if (!hasTokenConfig && hasLegacyCharConfig) {
    const maxInputChars = config.maxInputChars ?? DEFAULT_AGENT_INPUT_CHARS;
    const outputReserveChars =
      config.maxOutputChars ?? DEFAULT_AGENT_OUTPUT_RESERVE_CHARS;
    return {
      mode: "chars",
      effectiveInputLimit: maxInputChars,
      effectiveOutputLimit: outputReserveChars,
      effectiveContextWindow: maxInputChars,
      wireMaxOutputTokens: undefined,
    };
  }

  const effectiveOutputTokens = Math.min(
    DEFAULT_DIALOGUE_OUTPUT_TOKENS,
    config.maxOutputTokens ?? DEFAULT_DIALOGUE_OUTPUT_TOKENS,
  );
  const windowMinusOutput =
    config.contextWindowTokens === undefined
      ? Infinity
      : Math.max(0, config.contextWindowTokens - effectiveOutputTokens);
  const effectiveInputTokens = Math.min(
    DEFAULT_DIALOGUE_INPUT_TOKENS,
    config.maxInputTokens ?? Infinity,
    windowMinusOutput,
  );

  return {
    mode: "tokens",
    effectiveInputLimit: effectiveInputTokens,
    effectiveOutputLimit: effectiveOutputTokens,
    effectiveContextWindow: config.contextWindowTokens ?? null,
    wireMaxOutputTokens: effectiveOutputTokens,
  };
}

interface TokenizerProfile {
  hanWeight: number;
  asciiCharsPerToken: number;
  punctWeight: number;
  safetyMultiplier: number;
  meta: TokenEstimationMeta;
}

function tokenizerProfile(
  protocol: ModelProtocol,
  modelName: string,
  provider?: ModelProvider,
): TokenizerProfile {
  const lower = modelName.toLowerCase();
  if (
    protocol === "anthropic-messages" ||
    lower.includes("claude")
  ) {
    return {
      hanWeight: 1.25,
      asciiCharsPerToken: 3.7,
      punctWeight: 0.45,
      safetyMultiplier: 1.04,
      meta: { method: "protocol_profile", conservative: false, maxErrorRatio: 0.12 },
    };
  }
  if (
    protocol === "google-gemini" ||
    lower.includes("gemini")
  ) {
    return {
      hanWeight: 1.08,
      asciiCharsPerToken: 3.9,
      punctWeight: 0.4,
      safetyMultiplier: 1.04,
      meta: { method: "protocol_profile", conservative: false, maxErrorRatio: 0.12 },
    };
  }
  if (
    lower.startsWith("gpt-") ||
    /^o[134](?:-|$)/.test(lower)
  ) {
    return {
      hanWeight: 1.12,
      asciiCharsPerToken: 3.9,
      punctWeight: 0.4,
      safetyMultiplier: 1.03,
      meta: { method: "protocol_profile", conservative: false, maxErrorRatio: 0.1 },
    };
  }
  // 未知兼容模型采用保守估算并显式标明误差范围，降低触发上游超限的概率。
  return {
    hanWeight: 1.32,
    asciiCharsPerToken: 3.4,
    punctWeight: 0.5,
    safetyMultiplier: 1.08,
    meta: { method: "conservative_compatible", conservative: true, maxErrorRatio: 0.18 },
  };
}

export function getTokenEstimationMeta(
  protocol: ModelProtocol,
  modelName: string,
  provider?: ModelProvider,
): TokenEstimationMeta {
  return tokenizerProfile(protocol, modelName, provider).meta;
}

/**
 * 按协议与模型口径估算文本 token 数。
 * 区分汉字/CJK、ASCII 词块、JSON 结构标点与非 BMP 符号，零原生依赖避免拖慢冷启动。
 */
export function estimateTextTokens(
  text: string,
  protocol: ModelProtocol,
  modelName: string,
  provider?: ModelProvider,
): number {
  if (text.length === 0) return 0;
  const profile = tokenizerProfile(protocol, modelName, provider);
  let hanOrCjk = 0;
  let asciiWord = 0;
  let punctOrSpace = 0;
  let astral = 0;
  let otherUnicode = 0;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      astral += 1;
      i += 1;
      continue;
    }
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      hanOrCjk += 1;
    } else if (
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x5f
    ) {
      asciiWord += 1;
    } else if (code <= 0x7f) {
      punctOrSpace += 1;
    } else {
      otherUnicode += 1;
    }
  }

  const raw =
    hanOrCjk * profile.hanWeight +
    asciiWord / profile.asciiCharsPerToken +
    punctOrSpace * profile.punctWeight +
    otherUnicode * 1.15 +
    astral * 2.5;
  return Math.max(1, Math.ceil(raw * profile.safetyMultiplier));
}

/** 估算实际出站序列化 JSON 请求的 token 占用，对内联 base64 图片按固定图片预算折算。 */
export function estimateWireRequestTokens(
  serializedJson: string,
  protocol: ModelProtocol,
  modelName: string,
  provider?: ModelProvider,
): number {
  let imageCount = 0;
  const stripped = serializedJson.replace(BASE64_IMAGE_PATTERN, () => {
    imageCount += 1;
    return '"image":"[omitted]"';
  });
  return (
    estimateTextTokens(stripped, protocol, modelName, provider) +
    imageCount * ESTIMATED_TOKENS_PER_IMAGE
  );
}

/**
 * 实例级静态块 token 计数缓存（按协议、模型与内容哈希复用，有界防泄漏）。
 * 严禁作为模块级全局可变状态导出。
 */
export class StaticTokenCountCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = 256) {}

  count(
    kind: string,
    text: string,
    protocol: ModelProtocol,
    modelName: string,
    provider?: ModelProvider,
  ): number {
    if (text.length === 0) return 0;
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const key = `${protocol}|${provider ?? ""}|${modelName}|${kind}|${hash}`;
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;
    const tokens = estimateTextTokens(text, protocol, modelName, provider);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, tokens);
    return tokens;
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface CommonPrefixComparison {
  commonPrefixLength: number;
  firstDiffIndex: number | null;
  leftLength: number;
  rightLength: number;
  leftSnippet: string;
  rightSnippet: string;
}

/** 离线前缀稳定性对比：计算两次出站请求的最长共同前缀与首个差异点。 */
export function compareWirePrefixes(
  left: string,
  right: string,
): CommonPrefixComparison {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  const identical = index === left.length && index === right.length;
  return {
    commonPrefixLength: index,
    firstDiffIndex: identical ? null : index,
    leftLength: left.length,
    rightLength: right.length,
    leftSnippet: identical ? "" : left.slice(Math.max(0, index - 24), index + 48),
    rightSnippet: identical ? "" : right.slice(Math.max(0, index - 24), index + 48),
  };
}
