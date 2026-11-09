import {
  TtsCanceledError,
  TtsSynthesisFailedError,
} from "../domain/errors.js";
import type { SynthesizedAudio, VoiceLanguage } from "../domain/voice.js";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  MAX_TTS_AUDIO_BYTES,
  createRequestScope,
  endpoint,
  readWavResponse,
  responseDetail,
} from "./transport.js";

export { DEFAULT_TTS_TIMEOUT_MS, MAX_TTS_AUDIO_BYTES } from "./transport.js";

export interface IndexTtsSynthesisInput {
  text: string;
  language: VoiceLanguage;
  referencePath: string;
  speed: number;
  emoAlpha: number;
  signal?: AbortSignal;
}

/** IndexTTS 小服务：POST /tts 返回 audio/wav；音色参考传服务可读取的绝对路径。 */
export class IndexTtsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS,
    private readonly maxAudioBytes: number = MAX_TTS_AUDIO_BYTES,
  ) {}

  async synthesize(input: IndexTtsSynthesisInput): Promise<SynthesizedAudio> {
    if (input.signal?.aborted) {
      throw new TtsCanceledError();
    }
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: input.text,
            lang: input.language,
            spk_audio_path: input.referencePath,
            emo_audio_path: null,
            emo_vector: null,
            emo_alpha: input.emoAlpha,
            duration_factor: durationFactor(input.speed),
          }),
          signal: scope.signal,
        });
      } catch {
        throw scope.error();
      }
      if (!response.ok) {
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
}

export function durationFactor(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) {
    return 1;
  }
  return Math.round(Math.min(2, Math.max(0.5, 1 / speed)) * 1000) / 1000;
}
