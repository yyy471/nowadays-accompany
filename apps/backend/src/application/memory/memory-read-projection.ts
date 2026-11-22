import type { MemoryDelivery } from "../../domain/model.js";

/** 只有真实记忆文字落入摘录时才记账，编号、JSON 键和回查提示不算。 */
export function readsInExcerpt(content: string, name: string, reads: readonly MemoryDelivery[], from: number, to: number): MemoryDelivery[] {
  if (!reads.length || to <= from) return [];
  if (from === 0 && to >= content.length) return [...reads];
  const result = JSON.parse(content).result;
  if (!result || result.truncated || name === "history_lookup") return [];
  const parts = name === "memory_search" ? result.items : [result];
  if (!Array.isArray(parts) || parts.length !== reads.length) return [];
  let next = 0;
  return reads.filter((_read, index) => {
    const part = JSON.stringify(parts[index]);
    const offset = content.indexOf(part, next);
    if (offset < 0) return false;
    next = offset + part.length;
    for (const hit of part.matchAll(/"(?:title|snippet|summary|subjectiveExperience|content|text|quoteContext)"\s*:\s*"((?:\\.|[^"\\])+)"/g)) {
      const end = offset + hit.index + hit[0].length - 1;
      if (end > from && end - hit[1]!.length < to) return true;
    }
    return false;
  });
}

/** 老库回执只有业务结果，通过正式工具的返回字段恢复记录标识。 */
export function savedMemoryReads(name: string, result: Record<string, unknown> | undefined): MemoryDelivery[] {
  if (!result) return [];
  if (name === "memory_search" && Array.isArray(result.items)) {
    return result.items.flatMap(item => {
      if (!item || !["event","daily_summary","diary"].includes(item.type) || typeof item.id !== "string") return [];
      return [{ type: item.type, id: item.id, ...(typeof result.retrievalId === "string" && { retrievalId: result.retrievalId }) }];
    });
  }
  if (name === "memory_event" && typeof result.eventId === "string") return [{ type: "event", id: result.eventId }];
  if ((name === "memory_summary" || (name === "memory_summary_evidence" && Array.isArray(result.items) && result.items.length > 0))
    && typeof result.summaryId === "string") return [{ type: "daily_summary", id: result.summaryId }];
  if (name === "memory_diary" && typeof result.diaryId === "string" && result.content) return [{ type: "diary", id: result.diaryId }];
  return [];
}
