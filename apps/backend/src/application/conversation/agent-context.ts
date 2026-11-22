import { AppError } from "../../domain/errors.js";
import type { MemoryDelivery, ModelMessage, ModelProtocol, ModelRequest } from "../../domain/model.js";
import type { ModelProvider } from "../../domain/model-providers.js";
import type { WorldbookMatch, WorldbookSelection } from "../../domain/worldbook.js";
import { renderWebReadingPrefix, webReadingCandidates, webReadingRequest } from "../../domain/web-reading.js";
import { serializeModelRequest } from "../../model/protocols.js";
import { createLocalDateFormatter } from "../../storage/memory/evidence.js";
import { readsInExcerpt } from "../memory/memory-read-projection.js";

// 无显式绑定容量时，以 UTF-16 字符计量序列化后的生成请求和回复预留。
export const DEFAULT_AGENT_INPUT_CHARS = 128_000;
export const DEFAULT_AGENT_OUTPUT_RESERVE_CHARS = 4_096;

export interface AgentSystemPrompt {
  required: string;
  optional: readonly (string | { text: string; recall: MemoryDelivery })[];
  worldbook?: readonly WorldbookMatch[];
  requiredFooter?: string;
  dialogueClock?: { today: string; timeZone: string | undefined };
}

interface MessageGroup {
  messages: ModelMessage[];
  required: boolean;
  active: boolean;
  index: number;
}

/** 只裁本次出站投影，图状态和持久化原文保留给后续轮次及回查。 */
export function selectAgentContext(input: {
  request: ModelRequest;
  prompt: AgentSystemPrompt;
  protocol: ModelProtocol;
  provider?: ModelProvider;
  baseUrl: string;
  maxInputChars?: number;
  maxOutputChars?: number;
  resuming: boolean;
  originalModelResource?: boolean;
  evidenceQuery: string;
}): ModelRequest & { worldbookSelection: WorldbookSelection[]; memoryReads: MemoryDelivery[] } {
  const maxInputChars = input.maxInputChars ?? DEFAULT_AGENT_INPUT_CHARS;
  const reserve = input.maxOutputChars ?? DEFAULT_AGENT_OUTPUT_RESERVE_CHARS;
  const request = { ...input.request, system: input.prompt.required, messages: [] as ModelMessage[] };
  const groups = groupMessages(input.request.messages, input);
  // 原文里的“今天”指说话当天。将日期附到相应的出站消息，同时纳入各协议的容量计算。
  const clock = input.prompt.dialogueClock;
  const dateLabels = new Map<string, string>();
  if (clock) {
    const formatDate = createLocalDateFormatter(clock.timeZone);
    for (const { source } of input.request.messages) {
      if (!source?.messageId || !source.sentAt) continue;
      const date = formatDate(source.sentAt);
      if (date !== clock.today) dateLabels.set(source.messageId, `[消息发送日 ${date}]`);
    }
  }
  const selected = new Map<number, ModelMessage[]>();
  for (const group of groups) {
    if (group.active) {
      selected.set(group.index, group.messages.map((message) =>
        message.role === "tool" ? referenceMessage(message) : message,
      ));
    } else if (group.required) {
      selected.set(group.index, group.messages);
    }
  }
  const withSelection = (): ModelRequest => {
    let hasDates = false;
    const messages = [...selected.entries()].sort(([a], [b]) => a - b).flatMap(([, group]) => group).map(message => {
      const label = message.source?.messageId && dateLabels.get(message.source.messageId);
      if (!label) return message;
      hasDates = true;
      return { ...message, content: `${label}\n${message.content}` };
    });
    const dateNote = hasDates && clock ? `本轮当地日期 ${clock.today}。旧消息中相对日期以其发送日为准。` : "";
    const system = [request.system, dateNote, input.prompt.requiredFooter].filter(Boolean).join("\n");
    return { ...request, system, messages };
  };
  const size = () => serializeModelRequest(input.protocol, input.baseUrl, withSelection(), input.provider).length;
  const fits = () => size() + reserve <= maxInputChars;
  const minimumChars = size();
  if (minimumChars + reserve > maxInputChars) {
    throw new AppError(422, "MODEL_CONTEXT_EXCEEDED", "模型容量不足以容纳本轮必要上下文", {
      maxInputChars,
      outputReserveChars: reserve,
      minimumInputChars: minimumChars,
    });
  }
  const query = decisionQuery(input.evidenceQuery, input.request.messages);
  const terms = contextTerms(query);
  const rank = (message: ModelMessage) => contextRelevance(query, terms, message);
  const addGroup = (group: MessageGroup, messages: ModelMessage[]): boolean => {
    const previous = selected.get(group.index);
    selected.set(group.index, messages);
    if (fits()) return true;
    if (previous === undefined) selected.delete(group.index);
    else selected.set(group.index, previous);
    return false;
  };

  const optionalGroups = groups.filter((group) => !group.required && !group.active);
  const relevant = groups.flatMap((group) => {
    if (group.active) return group.messages.flatMap((message, index) =>
      message.role === "tool" ? [{ group, index, rank: rank(message) + 0.5 }] : [],
    );
    if (group.required) return [];
    const score = Math.max(...group.messages.map((message) => rank(message) + (message.source?.webPrefetch ? 0.5 : 0)));
    return score > 0 ? [{ group, index: -1, rank: score }] : [];
  });
  // 优先装入当前步骤的原文，显式引用的旧事实优先于无关的新回执。
  relevant.sort((a, b) => b.rank - a.rank || b.group.index - a.group.index);
  for (const { group, index } of relevant) {
    if (index < 0) {
      const message = group.messages[0]!;
      if (!addGroup(group, group.messages)) {
        fitRelevantPartial(message, terms, message.source?.webPrefetch === true,
          (replacement) => addGroup(group, [replacement]));
      }
      continue;
    }
    const message = group.messages[index]!;
    const replace = (replacement: ModelMessage) => {
      const next = [...selected.get(group.index)!];
      next[index] = replacement;
      return addGroup(group, next);
    };
    if (!replace(message)) fitRelevantPartial(message, terms, true, replace);
  }
  // 设定按整条取舍，同一次调用同时受设定上限和真实协议请求上限约束。
  const worldbookSelection: WorldbookSelection[] = [];
  let worldbookChars = 0;
  let includedEntries = 0;
  for (const match of input.prompt.worldbook ?? []) {
    const heading = includedEntries === 0
      ? "\n已知世界设定，只在合适时自然使用。原文明确的事实可以肯定地说，亲历需有经历作依据。未交代的具体规则、物件状态和他人经历保持未知，有理由推测时说出不确定。可以运用日常常识、演绎自己此刻的言行。"
      : "";
    const line = heading + "\n" + JSON.stringify({ 条目: match.title, 设定: match.content });
    let included = false;
    if (includedEntries < 6 && worldbookChars + line.length <= 4000) {
      const previous = request.system;
      request.system += line;
      included = fits();
      if (included) {
        includedEntries++;
        worldbookChars += line.length;
      } else {
        request.system = previous;
      }
    }
    worldbookSelection.push({ revision: match.revision, bookId: match.bookId, entryId: match.entryId,
      messageIds: match.messageIds, status: included ? "included" : "budget_omitted" });
  }
  const memoryReads: MemoryDelivery[] = [];
  for (const part of input.prompt.optional) {
    const line = typeof part === "string" ? part : part.text;
    const previous = request.system;
    request.system = `${previous}\n${line}`;
    if (!fits()) request.system = previous;
    else if (typeof part !== "string") memoryReads.push(part.recall);
  }
  for (const group of optionalGroups.slice().reverse()) {
    if (!selected.has(group.index) && !addGroup(group, group.messages)) {
      addGroup(group, group.messages.map(referenceMessage));
    }
  }
  const final = withSelection();
  for (const message of final.messages) {
    if (message.source?.memoryReads) memoryReads.push(...message.source.memoryReads);
  }
  return { ...final, worldbookSelection, memoryReads };
}

function fitRelevantPartial(
  message: ModelMessage,
  terms: readonly string[],
  deliverWebPage: boolean,
  replace: (message: ModelMessage) => boolean,
): void {
  if (message.role === "tool" && (webReadingCandidates(message.content) || webReadingRequest(message.content))) {
    if (deliverWebPage) fitWebPrefix(message, replace);
    return;
  }
  if (!historyReference(message)) return;
  const reads = message.source?.memoryReads;
  if (message.role === "tool" && reads?.length && message.toolName === "memory_search") {
    // 按完整搜索结果缩减，避免把被截掉的后排记录也计入召回。
    const body = JSON.parse(message.content) as { result: { items: Array<{title: string; snippet: string}> } };
    for (let count = reads.length - 1; count > 0; count--) {
      const content = JSON.stringify({ ...body, result: { ...body.result, items: body.result.items.slice(0, count) } });
      if (replace({ ...message, content, source: { ...message.source, memoryReads: reads.slice(0, count) } })) return;
    }
    const first = body.result.items[0];
    if (!first) return;
    const detail = first.snippet || first.title;
    let low = 1, high = detail.length;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const snippet = detail.slice(0, beforeSurrogatePair(detail, size));
      const content = JSON.stringify({ ...body, result: { ...body.result, items: [{ type: reads[0]!.type, id: reads[0]!.id, snippet }] } });
      if (snippet && replace({ ...message, content, source: { ...message.source, memoryReads: reads.slice(0,1) } })) low = size + 1;
      else high = size - 1;
    }
    return;
  }
  const matches = terms.flatMap((term) => {
    const pattern = new RegExp(term, "giu");
    const match = pattern.exec(message.content);
    if (match === null) return [];
    const unique = pattern.exec(message.content) === null;
    return [{
      offset: match.index,
      length: match[0].length,
      score: term.length + (unique ? 12 : 0) + (/[a-z]/i.test(term) && /\d/.test(term) ? 16 : 0),
    }];
  });
  const anchor = matches.sort((a, b) => b.score - a.score)[0];
  if (anchor === undefined) return;

  // 原文连续摘录围绕命中位置展开，最终长度仍由实际协议编码计算。
  let low = 0;
  let high = 2_048;
  while (low <= high) {
    const padding = Math.floor((low + high) / 2);
    const start = Math.max(0, anchor.offset - Math.floor(padding / 3));
    const end = Math.min(message.content.length, anchor.offset + anchor.length + Math.ceil(padding * 2 / 3));
    const from = beforeSurrogatePair(message.content, start);
    const to = beforeSurrogatePair(message.content, end);
    const reference = historyReference(message, message.source?.messageId ? from : undefined);
    const content = `[原文摘录 UTF-16 ${from}–${to}；回查：${reference}]\n${message.content.slice(from, to)}`;
    const visible = reads?.length ? readsInExcerpt(message.content, message.role === "tool" ? message.toolName ?? "" : "", reads, from, to) : undefined;
    // 太小的摘录可能只含编号。向两端扩展直到出现正文，或保留原来的回查提示。
    if (visible && !visible.length) { low = padding + 1; continue; }
    if (replace({ ...message, source: { ...message.source, summary: true, ...(visible && { memoryReads: visible }) }, content })) low = padding + 1;
    else high = padding - 1;
  }
}

function beforeSurrogatePair(content: string, offset: number): number {
  const codeUnit = content.charCodeAt(offset);
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff && offset > 0 ? offset - 1 : offset;
}

function fitWebPrefix(message: ModelMessage, replace: (message: ModelMessage) => boolean): void {
  // 网页按完整片段裁选，保留送达原文的精确位置。
  let low = 1;
  let high = (webReadingCandidates(message.content)?.fragments.length ?? 0) - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const content = renderWebReadingPrefix(message.content, middle);
    if (content !== undefined && replace({ ...message, content })) low = middle + 1;
    else high = middle - 1;
  }
}

export function decisionQuery(goalAndRequests: string, messages: readonly ModelMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === "assistant" && message.toolCalls?.length);
  return latest?.role === "assistant"
    ? `${latest.content}\n${JSON.stringify(latest.toolCalls)}\n${goalAndRequests}`
    : goalAndRequests;
}

export function contextTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_:-]{3,}|[\p{Script=Han}]{2,10}/gu) ?? [])]
    .filter((term) => !["arguments", "callid", "name", "null", "true", "false"].includes(term))
    .slice(0, 32);
}

function contextRelevance(query: string, terms: readonly string[], message: ModelMessage): number {
  const source = message.source;
  if ([source?.messageId, source?.toolCallId, source?.internalStepKey, source?.evidenceId]
    .some((id) => id !== undefined && query.includes(id))) return 1000;
  const text = message.content.toLowerCase();
  return terms.filter((term) => text.includes(term)).length;
}

function groupMessages(
  messages: readonly ModelMessage[],
  input: {
    protocol: ModelProtocol;
    provider?: ModelProvider;
    baseUrl: string;
    request: ModelRequest;
    resuming: boolean;
    originalModelResource?: boolean;
  },
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const lastUser = messages.reduce((last, message, index) => message.role === "user" ? index : last, -1);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const continuation = message.role === "assistant" ? message.continuation : undefined;
    const sameResource = input.originalModelResource !== false &&
      (continuation?.resourceId === undefined || continuation.resourceId === input.request.resourceId);
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      let projected = message;
      if (message.role === "tool" && message.source?.historical !== true) projected = asHistoricalFact(message);
      if (message.role === "assistant" && continuation && !sameResource) {
        const { continuation: _previous, ...text } = message;
        projected = text;
      }
      groups.push({
        index,
        messages: [projected],
        required: message.role === "user" && (
          message.source?.currentUserRequest === true || message.source === undefined
        ),
        active: false,
      });
      continue;
    }
    const start = index;
    const results: Extract<ModelMessage, { role: "tool" }>[] = [];
    for (let following = index + 1; following < messages.length; following += 1) {
      const result = messages[following]!;
      if (result.role !== "tool" || result.source?.historical === true) break;
      results.push(result);
      index = following;
    }
    const original = continuation?.protocol === input.protocol && continuation.provider === input.provider &&
      continuation.modelName === input.request.modelName &&
      continuation.baseUrl === input.baseUrl && continuation.items.length > 0;
    const paired = results.length === message.toolCalls.length &&
      new Set(results.map((result) => result.toolCallId)).size === results.length &&
      message.toolCalls.every((call) => results.some((result) => result.toolCallId === call.callId));
    // 同一用户轮次可能连续调用多批工具。有签名或推理的原生调用必须与其结果整组保留。
    const providerChain = (input.provider !== undefined || input.protocol === "google-gemini") &&
      start > lastUser && original &&
      (input.request.resourceId === undefined || continuation?.resourceId === input.request.resourceId);
    const latest = index === messages.length - 1 && (original || (!continuation && !input.resuming));
    if (paired && sameResource && (providerChain || latest)) {
      groups.push({ index: start, messages: [message, ...results], required: true, active: true });
      continue;
    }
    if (message.content.length > 0) {
      groups.push({ index: start, messages: [{ role: "assistant", content: message.content }], required: false, active: false });
    }
    results.forEach((result, offset) => {
      groups.push({
        index: start + offset + 1,
        messages: [asHistoricalFact(result)],
        required: false,
        active: false,
      });
    });
  }
  return groups;
}

function asHistoricalFact(message: Extract<ModelMessage, { role: "tool" }>): ModelMessage {
  return { ...message, source: { ...message.source, historical: true } };
}

function historyReference(message: ModelMessage, offset?: number): string | undefined {
  const source = message.source;
  const id = source?.messageId ?? source?.toolCallId ?? source?.internalStepKey ?? source?.evidenceId;
  const kind = source?.messageId ? "message" : source?.internalStepKey ? "internal" : source?.toolCallId ? "tool" : "evidence";
  const page = offset === undefined ? "" : `, offset=${offset}`;
  return id ? `history_lookup(kind="${kind}", id="${id}", scope="${source?.scope ?? "window"}"${page})` : undefined;
}

function referenceMessage(message: ModelMessage): ModelMessage {
  const source = message.source;
  const reference = historyReference(message) ?? "请核对最近的已保存操作";
  const web = message.role === "tool" ? webReadingCandidates(message.content) : undefined;
  const webCallId = web?.sourceToolCallId ?? source?.toolCallId;
  const outcome = message.role === "tool" ? /"status":"(success|failed|unknown)"/.exec(message.content)?.[1] : undefined;
  const summary = message.role === "tool"
    ? web && webCallId
      ? `网页原文未装入上下文，可用 web_reading(mode="read", toolCallId="${webCallId}", offset=${web.fragments[0]?.startOffset ?? web.next?.offset ?? 0}) 分段读取`
      : `工具 ${message.toolName ?? "调用"}${outcome === undefined ? "" : ` 的记录状态为 ${outcome}`}`
    : `${Array.from(message.content.replace(/\s+/g, " ")).slice(0, 65).join("")}…`;
  return {
    ...message,
    source: { ...source, summary: true, ...(source?.memoryReads ? { memoryReads: [] } : {}) },
    content: `[内容摘要] ${summary}；原文回查：${reference}`,
  };
}
