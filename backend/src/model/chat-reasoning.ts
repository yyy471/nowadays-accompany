import type { ModelProvider } from "../domain/model-providers.js";

/** Chat 流里的推理字段只供同一模型续轮使用，不能当作回复正文送给用户。 */
export class ChatReasoning {
  private content: string | undefined;
  private reasoning: string | undefined;
  private readonly details: Record<string, unknown>[] = [];

  constructor(private readonly provider: ModelProvider) {}

  append(delta: Record<string, unknown>): void {
    if (typeof delta.reasoning_content === "string") {
      this.content = (this.content ?? "") + delta.reasoning_content;
    }
    if (this.provider !== "openrouter" && this.provider !== "opencode-go") return;
    if (typeof delta.reasoning === "string") this.reasoning = (this.reasoning ?? "") + delta.reasoning;
    if (!Array.isArray(delta.reasoning_details)) return;
    for (const part of delta.reasoning_details) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      // 索引或 ID 标识同一内容块。没有标识的片段保持原始顺序。
      const existing = (part.id == null && part.index == null) ? undefined : this.details.find(item =>
        item.type === part.type &&
        (part.id != null && item.id != null ? part.id === item.id : part.index != null && part.index === item.index),
      );
      if (!existing) {
        this.details.push({ ...part });
        continue;
      }
      for (const [key, value] of Object.entries(part)) {
        if (value == null) continue;
        if (["text", "summary", "data", "signature"].includes(key) && typeof value === "string" && typeof existing[key] === "string") {
          existing[key] += value;
        } else {
          existing[key] = value;
        }
      }
    }
  }

  fields(): Record<string, unknown> {
    return {
      ...(this.content === undefined ? {} : { reasoning_content: this.content }),
      ...(this.details.length ? { reasoning_details: this.details } :
        this.reasoning === undefined ? {} : { reasoning: this.reasoning }),
    };
  }
}
