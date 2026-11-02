const FALLBACK_TIME_ZONE = 'UTC';

/** 未显式配置时取宿主时区；取不到就回落到 UTC，保证格式稳定。 */
export function resolveTimeZone(configured?: string): string {
  if (configured && configured.trim()) return configured.trim();
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** 供 system prompt 使用：2026-10-30 周五 14:05（Asia/Shanghai）。 */
export function formatCurrentTime(at: number, timeZone: string): string {
  const parts = partsOf(at, timeZone);
  if (!parts) return `${utcMinute(at)}（UTC）`;
  return `${dateOf(parts)} ${parts.get('weekday') ?? ''} ${clockOf(parts)}（${timeZone}）`.replace(/\s+/g, ' ').trim();
}

/** 供历史检索结果使用：2026-10-30 14:05，不带时区后缀。 */
export function formatMessageTime(at: number, timeZone: string): string {
  const parts = partsOf(at, timeZone);
  if (!parts) return utcMinute(at);
  return `${dateOf(parts)} ${clockOf(parts)}`;
}

function partsOf(at: number, timeZone: string): Map<string, string> | undefined {
  try {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(at));
    const parts = new Map<string, string>();
    for (const part of formatted) parts.set(part.type, part.value);
    return parts;
  } catch {
    return undefined;
  }
}

function dateOf(parts: Map<string, string>): string {
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

function clockOf(parts: Map<string, string>): string {
  return `${parts.get('hour')}:${parts.get('minute')}`;
}

function utcMinute(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}
