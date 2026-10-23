/** 错误文本里可能出现带鉴权的 URL，不能原样进入日志或 API。 */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export function sanitizeErrorText(raw: string, limit = 300): string {
  let text = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => sanitizeUrl(match));
  if (text.length > limit) text = `${text.slice(0, limit)}…`;
  return text;
}
