import { z } from "zod";
import type { VoiceProbeResult, VoiceProtocol } from "./voice.js";

/** 全局语音服务支持统一协议与旧 IndexTTS 桥接协议。 */
export const VOICE_SERVICE_PROTOCOLS = ["nowadays-tts-v1", "indextts"] as const;
export type VoiceServiceProtocol = (typeof VOICE_SERVICE_PROTOCOLS)[number];

export const voiceServiceConfigSchema = z
  .object({
    protocol: z.enum(VOICE_SERVICE_PROTOCOLS),
    baseUrl: z.string().trim().min(1).max(2000),
    /** 全局可选默认语音引擎（如 cosyvoice / indextts）；角色选择「跟随服务默认」时生效。 */
    defaultEngine: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.protocol === "indextts" && value.defaultEngine !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultEngine"],
        message: "旧 IndexTTS 协议不支持多引擎默认选择",
      });
    }
  });

export interface VoiceServiceConfig {
  protocol: VoiceProtocol;
  baseUrl: string;
  defaultEngine?: string;
}

export interface VoiceServiceRecord {
  serviceId: string;
  name: string;
  enabled: boolean;
  config: VoiceServiceConfig;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceServiceProbeResult {
  probe: VoiceProbeResult;
  elapsedMs: number;
}
