export type MessageSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string; url?: string } }
  | { type: 'at'; data: { qq: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: string; data: Record<string, unknown> };

export interface OutboundMessage {
  segments: MessageSegment[];
}

export function textMessage(text: string): OutboundMessage {
  if (typeof text !== 'string' || text.trim() === '') throw new TypeError('text must be a non-empty string');
  return { segments: [{ type: 'text', data: { text } }] };
}

/** OneBot v11 数组格式；字符串按纯文本处理（SnowLuma 配的 messageFormat=array）。 */
export function normalizeSegments(raw: unknown): MessageSegment[] {
  if (typeof raw === 'string') return [{ type: 'text', data: { text: raw } }];
  if (!Array.isArray(raw)) return [];
  const out: MessageSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const segment = item as { type?: unknown; data?: unknown };
    if (typeof segment.type !== 'string') continue;
    const data =
      segment.data && typeof segment.data === 'object'
        ? (segment.data as Record<string, unknown>)
        : {};
    if (segment.type === 'text') out.push({ type: 'text', data: { text: String(data.text ?? '') } });
    else if (segment.type === 'image') out.push({ type: 'image', data: { file: String(data.file ?? ''), url: data.url ? String(data.url) : undefined } });
    else if (segment.type === 'at') out.push({ type: 'at', data: { qq: String(data.qq ?? '') } });
    else if (segment.type === 'reply') out.push({ type: 'reply', data: { id: String(data.id ?? '') } });
    else out.push({ type: segment.type, data });
  }
  return out;
}

export function messageText(segments: MessageSegment[]): string {
  let text = '';
  for (const segment of segments) {
    if (segment.type === 'text') text += String((segment.data as { text?: unknown }).text ?? '');
    else if (segment.type === 'at') text += `@${String((segment.data as { qq?: unknown }).qq ?? '')}`;
  }
  return text;
}
