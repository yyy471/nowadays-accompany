/** 角色回复的自然句段：文字先独立可读，表情与语音按段关联。 */
export type MessageSegmentKind = "speech" | "narration";

export interface MessageSegmentDraft {
  ordinal: number;
  kind: MessageSegmentKind;
  text: string;
  startOffset: number;
  endOffset: number;
}

const SHORT_SEGMENT_CHARS = 8;
const MAX_MERGED_CHARS = 30;
const CLOSING_MARKS = new Set(["”", "’", "」", "』", "）", ")", "】", "]", '"', "'"]);
const OPENING_BRACKETS = new Set(["（", "(", "【"]);
const CLOSING_BRACKETS = new Set(["）", ")", "】"]);
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "“": "”",
  "「": "」",
  "『": "』",
};

interface LineRange {
  start: number;
  end: number;
}

interface KindSpan {
  start: number;
  end: number;
  kind: MessageSegmentKind;
}

interface TextPiece {
  start: number;
  end: number;
}

interface CollectedPiece extends TextPiece {
  kind: MessageSegmentKind;
  span: number;
}

/**
 * 按自然句段切分回复正文。
 * 先确定显式旁白、星号动作和同行台词的归属，再在范围内断句。
 * 片段范围始终满足 content.slice(startOffset, endOffset) === text。
 */
export function segmentMessage(content: string): MessageSegmentDraft[] {
  const collected: CollectedPiece[] = [];
  let spanIndex = 0;
  for (const line of splitLines(content)) {
    for (const span of classifyLine(content, line)) {
      for (const piece of splitSpan(content, span)) {
        collected.push({
          ...piece,
          kind: pieceKind(span.kind, content.slice(piece.start, piece.end)),
          span: spanIndex,
        });
      }
      spanIndex += 1;
    }
  }
  const merged: CollectedPiece[] = [];
  for (const piece of collected) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.span === piece.span &&
      previous.kind === piece.kind &&
      shouldMerge(content, previous, piece)
    ) {
      previous.end = piece.end;
      continue;
    }
    merged.push({ ...piece });
  }
  return merged.map((piece, ordinal) => {
    const text = content.slice(piece.start, piece.end);
    return {
      ordinal,
      kind: piece.kind,
      text,
      startOffset: piece.start,
      endOffset: piece.end,
    };
  });
}

function splitLines(content: string): LineRange[] {
  const lines: LineRange[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";
    if (char === "\n" || char === "\r") {
      lines.push({ start, end: index });
      start = index + 1;
    }
  }
  lines.push({ start, end: content.length });
  return lines;
}

function classifyLine(content: string, line: LineRange): KindSpan[] {
  const trimmed = trimRange(content, line.start, line.end);
  if (trimmed === null) {
    return [];
  }
  const text = content.slice(trimmed.start, trimmed.end);
  if (isWholeStarNarration(text)) {
    const inner = trimRange(content, trimmed.start + 1, trimmed.end - 1);
    return inner === null ? [] : [{ ...inner, kind: "narration" }];
  }
  const narrationMarker = /^(?:旁白\s*[：:]|【旁白】)\s*/.exec(text);
  if (narrationMarker !== null) {
    const body = skipWhitespace(
      content,
      trimmed.start + narrationMarker[0].length,
      trimmed.end,
    );
    return narrationBodySpans(content, body, trimmed.end);
  }
  const speechMarker = /^(?:台词|对白)\s*[：:]\s*/.exec(text);
  if (speechMarker !== null) {
    const body = skipWhitespace(
      content,
      trimmed.start + speechMarker[0].length,
      trimmed.end,
    );
    return body < trimmed.end
      ? [{ start: body, end: trimmed.end, kind: "speech" }]
      : [];
  }
  return inlineStarSpans(content, trimmed.start, trimmed.end);
}

/** 显式旁白范围内，引号台词和「台词：」「对白：」另起为台词。 */
function narrationBodySpans(
  content: string,
  start: number,
  end: number,
): KindSpan[] {
  const spans: KindSpan[] = [];
  let cursor = start;
  let index = start;
  while (index < end) {
    const speechMarker = /^(?:台词|对白)\s*[：:]\s*/.exec(
      content.slice(index, end),
    );
    if (speechMarker !== null) {
      pushSpan(spans, content, cursor, index, "narration");
      const speechStart = skipWhitespace(
        content,
        index + speechMarker[0].length,
        end,
      );
      pushSpan(spans, content, speechStart, end, "speech");
      return spans;
    }
    const quote = quoteSpanAt(content, index, end);
    if (quote !== null) {
      pushSpan(spans, content, cursor, quote.start, "narration");
      pushSpan(spans, content, quote.start, quote.end, "speech");
      cursor = quote.end;
      index = quote.end;
      continue;
    }
    index += 1;
  }
  pushSpan(spans, content, cursor, end, "narration");
  return spans;
}

/** 行内 *动作* 标为旁白，其余台词正常断句。 */
function inlineStarSpans(content: string, start: number, end: number): KindSpan[] {
  const spans: KindSpan[] = [];
  let cursor = start;
  let index = start;
  while (index < end) {
    if (content[index] !== "*") {
      index += 1;
      continue;
    }
    const close = content.indexOf("*", index + 1);
    if (close === -1 || close >= end) {
      index += 1;
      continue;
    }
    pushSpan(spans, content, cursor, index, "speech");
    pushSpan(spans, content, index + 1, close, "narration");
    index = close + 1;
    cursor = index;
  }
  pushSpan(spans, content, cursor, end, "speech");
  return spans;
}

function pushSpan(
  spans: KindSpan[],
  content: string,
  start: number,
  end: number,
  kind: MessageSegmentKind,
): void {
  const range = trimRange(content, start, end);
  if (range !== null) {
    spans.push({ ...range, kind });
  }
}

function quoteSpanAt(
  content: string,
  index: number,
  end: number,
): TextPiece | null {
  const open = content[index] ?? "";
  const close = QUOTE_PAIRS[open];
  if (close === undefined) {
    return null;
  }
  for (let next = index + 1; next < end; next += 1) {
    if (content[next] === close) {
      return { start: index, end: next + 1 };
    }
  }
  return null;
}

function splitSpan(content: string, span: KindSpan): TextPiece[] {
  const pieces: TextPiece[] = [];
  let start = -1;
  let depth = 0;
  let quoteDepth = 0;
  let index = span.start;
  const closePiece = (end: number): void => {
    if (start >= 0) {
      const range = trimRange(content, start, end);
      if (range !== null) {
        pieces.push(range);
      }
      start = -1;
    }
    depth = 0;
    quoteDepth = 0;
  };
  while (index < span.end) {
    const char = content[index] ?? "";
    if (start < 0) {
      if (isWhitespace(char)) {
        index += 1;
        continue;
      }
      start = index;
    }
    if (OPENING_BRACKETS.has(char)) {
      depth += 1;
      index += 1;
      continue;
    }
    if (CLOSING_BRACKETS.has(char)) {
      depth = Math.max(0, depth - 1);
      index += 1;
      // 行首括号动作段单独成段，后面紧跟的台词另起一段。
      if (
        span.kind === "speech" &&
        depth === 0 &&
        OPENING_BRACKETS.has(content[start] ?? "") &&
        hasContentAfter(content, index, span.end)
      ) {
        closePiece(index);
      }
      continue;
    }
    const quoteClose = QUOTE_PAIRS[char];
    if (quoteClose !== undefined) {
      quoteDepth += 1;
      index += 1;
      continue;
    }
    if (quoteDepth > 0 && Object.values(QUOTE_PAIRS).includes(char)) {
      quoteDepth = Math.max(0, quoteDepth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && quoteDepth === 0 && isSentenceEnd(content, index, span.end)) {
      let end = index + 1;
      while (end < span.end && isSentenceEnd(content, end, span.end)) {
        end += 1;
      }
      while (end < span.end && CLOSING_MARKS.has(content[end] ?? "")) {
        end += 1;
      }
      closePiece(end);
      index = end;
      continue;
    }
    index += 1;
  }
  closePiece(span.end);
  return pieces;
}

function isSentenceEnd(content: string, index: number, end: number): boolean {
  const char = content[index] ?? "";
  if (
    char === "。" ||
    char === "！" ||
    char === "？" ||
    char === "!" ||
    char === "?" ||
    char === "…"
  ) {
    return true;
  }
  if (char === ".") {
    const next = content[index + 1];
    return index + 1 >= end || next === undefined || isWhitespace(next);
  }
  return false;
}

function hasContentAfter(content: string, index: number, end: number): boolean {
  for (let next = index; next < end; next += 1) {
    const char = content[next] ?? "";
    if (char === "\n" || char === "\r") {
      return false;
    }
    if (!isWhitespace(char)) {
      return true;
    }
  }
  return false;
}

function pieceKind(
  spanKind: MessageSegmentKind,
  text: string,
): MessageSegmentKind {
  if (spanKind === "narration") {
    return "narration";
  }
  if (
    isWrappedBy(text, "（", "）") ||
    isWrappedBy(text, "(", ")") ||
    isWrappedBy(text, "【", "】") ||
    isWrappedBy(text, "*", "*") ||
    /^旁白\s*[：:]/.test(text)
  ) {
    return "narration";
  }
  return "speech";
}

function shouldMerge(
  content: string,
  left: TextPiece,
  right: TextPiece,
): boolean {
  const leftChars = countChars(content.slice(left.start, left.end));
  const rightChars = countChars(content.slice(right.start, right.end));
  return (
    (leftChars < SHORT_SEGMENT_CHARS || rightChars < SHORT_SEGMENT_CHARS) &&
    leftChars + rightChars <= MAX_MERGED_CHARS
  );
}

/** 整行旁白要求开星号后第一次闭合就在行尾，行内动作留给后面单独匹配。 */
function isWholeStarNarration(text: string): boolean {
  return (
    text.length >= 3 &&
    text.startsWith("*") &&
    text.endsWith("*") &&
    text.indexOf("*", 1) === text.length - 1
  );
}

function isWrappedBy(text: string, open: string, close: string): boolean {
  return (
    text.length >= open.length + close.length + 1 &&
    text.startsWith(open) &&
    text.endsWith(close)
  );
}

function skipWhitespace(content: string, start: number, end: number): number {
  let index = start;
  while (index < end && isWhitespace(content[index] ?? "")) {
    index += 1;
  }
  return index;
}

function trimRange(
  content: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  let from = start;
  let to = end;
  while (from < to && isWhitespace(content[from] ?? "")) {
    from += 1;
  }
  while (to > from && isWhitespace(content[to - 1] ?? "")) {
    to -= 1;
  }
  return from < to ? { start: from, end: to } : null;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function countChars(value: string): number {
  return Array.from(value).length;
}
