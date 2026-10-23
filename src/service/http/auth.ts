import crypto from 'node:crypto';
import type http from 'node:http';
import { HttpError } from './errors.js';

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

export function authorize(request: http.IncomingMessage, pathname: string, token?: string): void {
  if (!token || pathname === '/health' || pathname === '/health/ready') return;
  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !safeEqual(provided, token)) throw new HttpError(401, 'unauthorized', 'unauthorized');
}
