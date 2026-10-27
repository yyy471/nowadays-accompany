import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const API_PREFIXES = new Set([
  'health',
  'instances',
  'conversations',
  'accounts',
  'artifacts',
  'worldbooks',
  'deployments',
  'slots',
  'metrics',
  'diagnostics',
  'events',
  'providers',
  'skills',
  'jobs',
  'media',
  'injection'
]);

export type UiHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string
) => Promise<boolean>;

/**
 * UI 与 API 同源，静态资源不需要 token（页面在拿到 preload 注入的 token 前就要能加载）。
 * API 前缀一律放行给后面的路由，避免 SPA fallback 吞掉接口。
 */
export function createUiHandler(uiDir?: string): UiHandler {
  if (!uiDir) return async () => false;
  const root = path.resolve(uiDir);
  return async (request, response, pathname) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const prefix = pathname.split('/')[1] ?? '';
    if (API_PREFIXES.has(prefix)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes('\0')) return false;
    const target = path.resolve(root, `.${decoded}`);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    let file = target;
    let stat = await statFile(file);
    if (!stat?.isFile()) {
      if (path.extname(decoded)) return false;
      file = path.join(root, 'index.html');
      stat = await statFile(file);
      if (!stat?.isFile()) return false;
    }
    const body = await fs.readFile(file);
    const extension = path.extname(file).toLowerCase();
    const headers: http.OutgoingHttpHeaders = {
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff'
    };
    if (extension === '.html') headers['content-security-policy'] = UI_CSP;
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  };
}

async function statFile(file: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try {
    return await fs.stat(file);
  } catch {
    return undefined;
  }
}
