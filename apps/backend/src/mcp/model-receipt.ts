import type { ModelProtocol, ModelUsage } from "../domain/model.js";
import { mergeModelUsage } from "../domain/token-usage.js";
import { normalizeUsage } from "../model/protocols.js";
import { readGeminiUsage } from "../model/google-gemini.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** 旁读流中的终态和累计用量，转发的原始事件和字节保持原序。 */
export class PiModelReceipt {
  usage: ModelUsage | null = null;
  completed = false;
  failed = false;
  private chatFinished = false;
  private counters: Record<string, number> = {};
  private decoder = new TextDecoder();
  private pending = "";
  private data: string[] = [];

  constructor(private protocol: ModelProtocol) {}

  private inspect(data: string, streamed: boolean) {
    if (streamed && data === "[DONE]") {
      if (this.protocol === "openai-chat") this.completed = this.chatFinished;
      return;
    }
    const chunk = record(JSON.parse(data));
    if (chunk.error || chunk.type === "error" || ["response.failed", "response.incomplete"].includes(String(chunk.type))) this.failed = true;
    let usage: ModelUsage | null;
    if (this.protocol === "anthropic-messages") {
      const u = record(chunk.usage ?? record(chunk.message).usage);
      this.remember(u);
      const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = this.counters;
      const hasInput = [input_tokens, cache_read_input_tokens, cache_creation_input_tokens].some(x => x !== undefined);
      usage = normalizeUsage({
        inputTokens: hasInput ? (input_tokens ?? 0) + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0) : undefined,
        cachedTokens: cache_read_input_tokens, cacheCreationTokens: cache_creation_input_tokens, outputTokens: output_tokens,
      });
      if (chunk.type === "message_stop") this.completed = true;
    } else if (this.protocol === "google-gemini") {
      this.remember(record(chunk.usageMetadata));
      usage = readGeminiUsage(this.counters);
      if (Array.isArray(chunk.candidates) && chunk.candidates.some(c => record(c).finishReason)) this.completed = true;
    } else {
      const u = record(record(chunk.response).usage ?? chunk.usage);
      usage = normalizeUsage({
        inputTokens: u.input_tokens ?? u.prompt_tokens, outputTokens: u.output_tokens ?? u.completion_tokens,
        cachedTokens: record(u.input_tokens_details).cached_tokens ?? record(u.prompt_tokens_details).cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens,
      });
      if (Array.isArray(chunk.choices) && chunk.choices.some(c => record(c).finish_reason)) this.chatFinished = true;
      if (chunk.type === "response.completed") this.completed = true;
    }
    if (usage) this.usage = mergeModelUsage(this.usage, usage);
    if (!streamed) {
      this.completed = !this.failed && Object.keys(chunk).length > 0 && !["failed", "incomplete", "cancelled"].includes(String(chunk.status));
      this.failed = !this.completed;
    }
  }

  private remember(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.counters[key] = value;
    }
  }

  json(text: string) { this.inspect(text, false); }

  push(bytes: Uint8Array) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    for (const line of lines) this.line(line);
  }

  end() {
    this.line(this.pending + this.decoder.decode());
    this.line("");
  }

  private line(raw: string) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line && this.data.length) this.inspect(this.data.splice(0).join("\n"), true);
    else if (line.startsWith("data:")) this.data.push(line.slice(5).trimStart());
  }
}
