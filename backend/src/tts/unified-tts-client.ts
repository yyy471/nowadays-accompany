import { z } from "zod";
import {
  TtsCanceledError,
  TtsProbeFailedError,
  TtsProtocolInvalidError,
  TtsSynthesisFailedError,
} from "../domain/errors.js";
import { voiceCapabilitiesSchema } from "../domain/voice-capabilities.js";
import type {
  SynthesizedAudio,
  VoiceLanguage,
  VoicePresetVoice,
  VoiceProbeResult,
} from "../domain/voice.js";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  MAX_TTS_AUDIO_BYTES,
  createRequestScope,
  endpoint,
  readResponseBody,
  readWavResponse,
  responseDetail,
} from "./transport.js";

export interface UnifiedTtsReferenceInput {
  mode: string;
  text: string | null;
  fileName: string;
  mediaType: string;
  data: Buffer;
}

export type UnifiedTtsSource =
  | { kind: "reference"; reference: UnifiedTtsReferenceInput }
  | { kind: "preset"; voiceId: string };

export interface UnifiedTtsSynthesisInput {
  text: string;
  source: UnifiedTtsSource;
  language: VoiceLanguage | null;
  speed: number | null;
  emotion?: string;
  signal?: AbortSignal;
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

const healthSchema = z.object({
  protocol: z.literal("nowadays-tts-v1"),
  service: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  ready: z.boolean(),
  capabilities: voiceCapabilitiesSchema.safeExtend({
    engines: z.record(z.string(), z.object({ ready: z.boolean(), active: z.boolean() })).optional(),
    defaultEngine: z.string().min(1).optional(),
  }),
});

const voicesSchema = z
  .object({
    voices: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            label: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.voices.map((voice) => voice.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "预置音色 ID 不能重复",
        path: ["voices"],
      });
    }
  });

/** Nowadays TTS 统一协议：健康发现、预置音色列表和 multipart 合成。 */
export class UnifiedTtsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS,
    private readonly maxAudioBytes: number = MAX_TTS_AUDIO_BYTES,
  ) {}

  async probe(signal?: AbortSignal): Promise<VoiceProbeResult> {
    if (signal?.aborted === true) {
      throw new TtsCanceledError();
    }
    const scope = createRequestScope(this.baseUrl, signal, this.timeoutMs);
    try {
      const health = await this.readHealth(scope);
      const voices =
        health.ready && health.capabilities.presetVoices
          ? await this.readVoices(scope)
          : null;
      return { ...health, voices };
    } finally {
      scope.cleanup();
    }
  }

  async synthesize(input: UnifiedTtsSynthesisInput): Promise<SynthesizedAudio> {
    if (input.signal?.aborted === true) {
      throw new TtsCanceledError();
    }
    const form = buildForm(input);
    const scope = createRequestScope(
      this.baseUrl,
      input.signal,
      this.timeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await fetch(endpoint(this.baseUrl, "tts"), {
          method: "POST",
          body: form,
          redirect: "manual",
          signal: scope.signal,
        });
      } catch {
        throw scope.error();
      }
      if (!response.ok) {
        if (isRedirect(response.status)) {
          scope.abortUpstream();
          throw new TtsSynthesisFailedError("语音服务返回了重定向，已拒绝跟随", {
            status: response.status,
          });
        }
        let detail: string;
        try {
          detail = await responseDetail(response);
        } catch {
          throw scope.error();
        }
        throw new TtsSynthesisFailedError(detail, {
          status: response.status,
        });
      }
      return await readWavResponse(response, scope, this.maxAudioBytes);
    } finally {
      scope.cleanup();
    }
  }

  private async readHealth(
    scope: ReturnType<typeof createRequestScope>,
  ): Promise<Omit<VoiceProbeResult, "voices">> {
    const response = await this.request("health", scope);
    if (!response.ok) {
      if (isRedirect(response.status)) {
        scope.abortUpstream();
        throw new TtsProbeFailedError("语音服务返回了重定向，已拒绝跟随", {
          status: response.status,
        });
      }
      throw new TtsProbeFailedError(
        await readFailureDetail(response, scope),
        { status: response.status },
      );
    }
    const raw = await readJsonBody(response, scope, "健康响应");
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { protocol?: unknown }).protocol !== "nowadays-tts-v1"
    ) {
      throw new TtsProtocolInvalidError("语音服务协议不是 nowadays-tts-v1");
    }
    const parsed = healthSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TtsProtocolInvalidError("健康响应不符合 nowadays-tts-v1 协议");
    }
    const { engines, defaultEngine, ...capabilities } = parsed.data.capabilities;
    return { ...parsed.data, capabilities };
  }

  private async readVoices(
    scope: ReturnType<typeof createRequestScope>,
  ): Promise<VoicePresetVoice[]> {
    const response = await this.request("voices", scope);
    if (!response.ok) {
      if (isRedirect(response.status)) {
        scope.abortUpstream();
        throw new TtsProbeFailedError("语音服务返回了重定向，已拒绝跟随", {
          status: response.status,
        });
      }
      throw new TtsProbeFailedError(
        await readFailureDetail(response, scope),
        { status: response.status },
      );
    }
    const raw = await readJsonBody(response, scope, "音色列表");
    const parsed = voicesSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TtsProtocolInvalidError("音色列表不符合 nowadays-tts-v1 协议");
    }
    return parsed.data.voices;
  }

  private async request(
    path: string,
    scope: ReturnType<typeof createRequestScope>,
  ): Promise<Response> {
    try {
      return await fetch(endpoint(this.baseUrl, path), {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: scope.signal,
      });
    } catch {
      throw scope.error();
    }
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function buildForm(input: UnifiedTtsSynthesisInput): FormData {
  const form = new FormData();
  form.set("text", input.text);
  if (input.source.kind === "reference") {
    form.set("mode", "reference");
    form.set("reference_mode", input.source.reference.mode);
    form.append(
      "reference_audio",
      new Blob([new Uint8Array(input.source.reference.data)], {
        type: input.source.reference.mediaType,
      }),
      input.source.reference.fileName,
    );
    if (input.source.reference.text !== null) {
      form.set("reference_text", input.source.reference.text);
    }
  } else {
    form.set("mode", "preset");
    form.set("voice_id", input.source.voiceId);
  }
  if (input.language !== null) {
    form.set("language", input.language);
  }
  if (input.speed !== null) {
    form.set("speed", String(input.speed));
  }
  if (input.emotion !== undefined) {
    form.set("emotion", input.emotion);
  }
  return form;
}

async function readJsonBody(
  response: Response,
  scope: ReturnType<typeof createRequestScope>,
  label: string,
): Promise<unknown> {
  let raw: Buffer;
  try {
    raw = await readResponseBody(response, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof TtsSynthesisFailedError) {
      throw new TtsProtocolInvalidError(`${label}超过大小上限`);
    }
    throw scope.error();
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new TtsProtocolInvalidError(`${label}不是有效 JSON`);
  }
}

async function readFailureDetail(
  response: Response,
  scope: ReturnType<typeof createRequestScope>,
): Promise<string> {
  try {
    return await responseDetail(response);
  } catch {
    throw scope.error();
  }
}
