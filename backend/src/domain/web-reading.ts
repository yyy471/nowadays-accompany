import { createHash } from "node:crypto";

export interface WebReadingFragment {
  url: string;
  pageVersion: string;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface WebReadingProjection {
  kind: "web_reading";
  fragments: WebReadingFragment[];
  sourceToolCallId?: string;
  next?: { url: string; pageVersion: string; offset: number };
}

export interface WebReadingRequest {
  kind: "web_reading";
  sourceToolCallId?: string;
  request: { offset: number; url?: string; pageVersion?: string; maxChars?: number };
}

// 所有位置均为原始正文中的 UTF-16 半开区间。
export const DEFAULT_WEB_PAGE_CHARS = 8_000;
const WEB_FRAGMENT_CHARS = 2_800;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseWebJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function webPageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function offset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function makeFragment(url: string, pageVersion: string, startOffset: number, text: string): WebReadingFragment {
  return { url, pageVersion, startOffset, endOffset: startOffset + text.length, text };
}

function digestVersion(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf16le").digest("hex")}`;
}

// 结构化 MCP 契约：{ webReading: { url, version?, text } }（完整正文），或
// { webReading: { url, version, fragments: [{ startOffset, text }] } }（局部正文）。
// 也支持同一对象位于 structuredContent 根部或 webReading 内的数组。
function structuredFragments(value: unknown): WebReadingFragment[] {
  const page = record(value);
  const url = webPageUrl(page?.url);
  if (page === undefined || url === undefined) return [];
  const versionValue = page.pageVersion ?? page.version;
  const version = typeof versionValue === "string" && versionValue.trim().length > 0 && versionValue.length <= 512
    ? versionValue
    : undefined;
  if (typeof page.text === "string" && page.text.trim().length > 0) {
    if (page.startOffset === undefined && page.offset === undefined) {
      return [makeFragment(url, version ?? digestVersion(page.text), 0, page.text)];
    }
    const startOffset = page.startOffset ?? page.offset;
    if (version === undefined || !offset(startOffset) || !offset(startOffset + page.text.length)) return [];
    return [makeFragment(url, version, startOffset, page.text)];
  }
  if (version === undefined || !Array.isArray(page.fragments)) return [];
  return page.fragments.flatMap((value: unknown) => {
    const fragment = record(value);
    const startOffset = fragment?.startOffset ?? fragment?.offset;
    const text = fragment?.text;
    return typeof text === "string" && text.trim().length > 0 && offset(startOffset) && offset(startOffset + text.length)
      ? [makeFragment(url, version, startOffset, text)]
      : [];
  });
}

export function extractMcpWebFragments(result: unknown): WebReadingFragment[] {
  const raw = record(result);
  if (raw === undefined || raw.isError === true) return [];
  const structured = record(raw.structuredContent);
  const pages = structured?.webReading ?? structured;
  const found = (Array.isArray(pages) ? pages : [pages]).flatMap(structuredFragments);
  const embedded: WebReadingFragment[] = [];
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      const block = record(item);
      if (block?.type !== "resource") continue;
      const resource = record(block.resource);
      const url = webPageUrl(resource?.uri);
      const text = resource?.text;
      if (url === undefined || typeof text !== "string" || text.trim().length === 0) continue;
      if (found.some((source) => source.url === url && source.text === text)) continue;
      const overlapping = found.filter((source) => source.url === url && source.startOffset < text.length);
      const versions = new Set(overlapping.map((source) => source.pageVersion));
      const mirrored = versions.size === 1 && overlapping.every((source) =>
        text.slice(source.startOffset, source.endOffset) === source.text.slice(0, text.length - source.startOffset));
      embedded.push(makeFragment(url, mirrored ? overlapping[0]!.pageVersion : digestVersion(text), 0, text));
    }
  }
  return mergeWebFragments([...found, ...embedded]);
}

/** 合并同页同版本范围，保留跳读产生的空档。 */
export function mergeWebFragments(fragments: readonly WebReadingFragment[]): WebReadingFragment[] {
  const sorted = [...fragments].sort((a, b) => a.url.localeCompare(b.url) ||
    a.pageVersion.localeCompare(b.pageVersion) || a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const merged: WebReadingFragment[] = [];
  for (const fragment of sorted) {
    const last = merged.at(-1);
    if (last?.url !== fragment.url || last.pageVersion !== fragment.pageVersion || last.endOffset < fragment.startOffset) {
      merged.push({ ...fragment });
      continue;
    }
    const overlap = last.endOffset - fragment.startOffset;
    if (overlap >= 0 && last.text.slice(fragment.startOffset - last.startOffset, fragment.endOffset - last.startOffset) !==
      fragment.text.slice(0, overlap)) continue;
    if (fragment.endOffset > last.endOffset) {
      last.text += fragment.text.slice(overlap);
      last.endOffset = fragment.endOffset;
    }
  }
  return merged;
}

function beforeSurrogate(text: string, end: number): number {
  const last = text.charCodeAt(end - 1);
  return end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

// 优先完整段落，超长段落按源偏移分割。保留空白和原始换行。
export function pageWebFragments(
  fragments: readonly WebReadingFragment[],
  startOffset = 0,
  budget = DEFAULT_WEB_PAGE_CHARS,
  sourceToolCallId?: string,
): WebReadingProjection {
  const page: WebReadingProjection = { kind: "web_reading", fragments: [], ...(sourceToolCallId ? { sourceToolCallId } : {}) };
  let remaining = budget;
  for (const fragment of fragments) {
    const base = Math.max(startOffset, fragment.startOffset);
    let cursor = base - fragment.startOffset;
    if (cursor >= fragment.text.length) continue;
    const char = fragment.text.charCodeAt(cursor);
    if (char >= 0xdc00 && char <= 0xdfff && cursor > 0) cursor -= 1;
    const paragraph = /(?:\r?\n){2,}/g;
    paragraph.lastIndex = cursor;
    let nextBreak = paragraph.exec(fragment.text);
    while (cursor < fragment.text.length) {
      const maxEnd = Math.min(fragment.text.length, cursor + WEB_FRAGMENT_CHARS);
      const naturalEnd = nextBreak ? nextBreak.index + nextBreak[0].length : fragment.text.length;
      let end = beforeSurrogate(fragment.text, Math.min(naturalEnd, maxEnd));
      if (end - cursor > remaining && page.fragments.length === 0) {
        end = beforeSurrogate(fragment.text, cursor + remaining);
      }
      if (end === cursor || end - cursor > remaining) {
        page.next = { url: fragment.url, pageVersion: fragment.pageVersion, offset: fragment.startOffset + cursor };
        return page;
      }
      page.fragments.push(makeFragment(fragment.url, fragment.pageVersion, fragment.startOffset + cursor, fragment.text.slice(cursor, end)));
      remaining -= end - cursor;
      cursor = end;
      if (nextBreak && cursor >= naturalEnd) nextBreak = paragraph.exec(fragment.text);
    }
  }
  return page;
}

function projectionFromValue(value: unknown): WebReadingProjection | undefined {
  const projection = record(value);
  if (projection?.kind !== "web_reading" || !Array.isArray(projection.fragments)) return undefined;
  if (projection.fragments.some((value: unknown) => {
    const fragment = record(value);
    return fragment === undefined || typeof fragment.url !== "string" ||
      typeof fragment.pageVersion !== "string" || typeof fragment.text !== "string" ||
      fragment.text.length === 0 || !offset(fragment.startOffset) ||
      fragment.endOffset !== fragment.startOffset + fragment.text.length;
  })) return undefined;
  return projection as unknown as WebReadingProjection;
}

export function webReadingRequest(content: string): WebReadingRequest | undefined {
  const envelope = record(parseWebJson(content));
  return envelope?.status === "success" ? webReadingReference(envelope.result) : undefined;
}

export function webReadingReference(value: unknown): WebReadingRequest | undefined {
  const result = record(value);
  const request = record(result?.request);
  if (result?.kind !== "web_reading" || !offset(request?.offset)) return undefined;
  if (request.url !== undefined && typeof request.url !== "string") return undefined;
  if (request.pageVersion !== undefined && typeof request.pageVersion !== "string") return undefined;
  if (request.maxChars !== undefined && (!offset(request.maxChars) || request.maxChars < 2 || request.maxChars > DEFAULT_WEB_PAGE_CHARS)) return undefined;
  if (result.sourceToolCallId !== undefined && typeof result.sourceToolCallId !== "string") return undefined;
  return result as unknown as WebReadingRequest;
}

export function webReadingCandidates(content: string): WebReadingProjection | undefined {
  const envelope = record(parseWebJson(content));
  return envelope?.status === "success" ? projectionFromValue(envelope.result) : undefined;
}

export function renderWebReadingPrefix(content: string, count: number): string | undefined {
  const envelope = record(parseWebJson(content));
  const projection = envelope?.status === "success" ? projectionFromValue(envelope.result) : undefined;
  if (projection === undefined) return undefined;
  const firstOmitted = projection.fragments[count];
  return JSON.stringify({
    ...envelope,
    result: {
      ...projection,
      fragments: projection.fragments.slice(0, count),
      ...(firstOmitted && {
        next: { url: firstOmitted.url, pageVersion: firstOmitted.pageVersion, offset: firstOmitted.startOffset },
      }),
    },
  });
}
