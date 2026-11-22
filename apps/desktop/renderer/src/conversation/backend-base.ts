/** 桌面壳通过 /api-config.json 暴露本地后端地址；浏览器预览时退回同源代理。 */
let cached: Promise<string | null> | null = null;

export function backendBaseUrl(): Promise<string | null> {
  if (cached === null) {
    cached = fetch('/api-config.json', { cache: 'no-store' })
      .then(response => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (body && typeof body === 'object' && 'backendBaseUrl' in body) {
          const value = (body as { backendBaseUrl?: unknown }).backendBaseUrl;
          if (typeof value === 'string' && value.length > 0) return value.replace(/\/$/, '');
        }
        return null;
      })
      .catch(() => null);
  }
  return cached;
}
