import { z } from "zod";
import type { VoiceCapabilities } from "./voice.js";

export const VOICE_LANGUAGE_CODE_PATTERN =
  /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

export const voiceLanguageCodeSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(VOICE_LANGUAGE_CODE_PATTERN, "语言代码格式不正确");

export const voiceCapabilitiesSchema = z
  .object({
    referenceModes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().min(1).max(200),
            requiresReferenceText: z.boolean(),
          })
          .strict(),
      )
      .max(32),
    presetVoices: z.boolean(),
    languages: z.array(voiceLanguageCodeSchema).max(32),
    speed: z
      .object({
        min: z.number().min(0.1).max(10),
        max: z.number().min(0.1).max(10),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.referenceModes.map((mode) => mode.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "参考模式 ID 不能重复",
        path: ["referenceModes"],
      });
    }
    if (new Set(value.languages).size !== value.languages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "语言不能重复",
        path: ["languages"],
      });
    }
    if (value.speed !== null && value.speed.min > value.speed.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "语速范围下限不能大于上限",
        path: ["speed"],
      });
    }
    if (
      value.speed !== null &&
      (value.speed.min > 1 || value.speed.max < 1)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "语速范围必须包含默认语速 1.0",
        path: ["speed"],
      });
    }
  });

/** 解析健康接口或已保存的能力声明；无效内容返回 null。 */
export const voiceEngineStatusSchema = z
  .object({
    ready: z.boolean(),
    active: z.boolean(),
    onDemand: z.boolean().optional(),
  })
  .strict();

export const voiceEnginesSchema = z.record(
  z.string().min(1).max(64),
  voiceEngineStatusSchema,
);

const PARSE_FAILED = Symbol("parse-failed");

function parseJsonInput(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return PARSE_FAILED;
  }
}

export function parseVoiceEngines(
  raw: unknown,
): Record<string, z.infer<typeof voiceEngineStatusSchema>> | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const value = parseJsonInput(raw);
  if (value === PARSE_FAILED) {
    return null;
  }
  const parsed = voiceEnginesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseVoiceCapabilities(raw: unknown): VoiceCapabilities | null {
  const value = parseJsonInput(raw);
  if (value === PARSE_FAILED) {
    return null;
  }
  const parsed = voiceCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
