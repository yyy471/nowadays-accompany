import type http from 'node:http';
import type { EventLog, LoggedEvent } from '../../core/event-log.js';
import type { Metrics } from '../../core/metrics.js';
import { HttpError } from './errors.js';

const MAX_SSE_BUFFER_BYTES = 1_000_000;

function writeSse(response: http.ServerResponse, event: LoggedEvent): boolean {
  if (response.writableEnded) return false;
  if (response.writableLength > MAX_SSE_BUFFER_BYTES) return false;
  response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  return true;
}

export interface SseHubOptions {
  eventLog: EventLog;
  metrics: Metrics;
  maxClients: number;
}

/** SSE 连接上限、续传和背压；路由只负责鉴权后的入口。 */
export class SseHub {
  readonly #options: SseHubOptions;
  readonly #clients = new Set<http.ServerResponse>();

  constructor(options: SseHubOptions) {
    this.#options = options;
  }

  open(request: http.IncomingMessage, response: http.ServerResponse, url: URL): void {
    if (this.#clients.size >= this.#options.maxClients) {
      throw new HttpError(503, `too many SSE clients (limit ${this.#options.maxClients})`, 'sse_limit');
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    response.write(': connected\n\n');
    this.#clients.add(response);
    this.#options.metrics.set('sse.clients', this.#clients.size);
    const lastHeader = request.headers['last-event-id'];
    const lastQuery = url.searchParams.get('lastEventId');
    const resumeRaw = Array.isArray(lastHeader) ? lastHeader[0] : lastHeader ?? lastQuery;
    let lastWritten = this.#options.eventLog.latestId;
    let missed: LoggedEvent[] = [];
    if (resumeRaw !== undefined && resumeRaw !== null && resumeRaw !== '') {
      const sinceId = Number(resumeRaw);
      if (Number.isFinite(sinceId)) {
        lastWritten = Math.max(0, sinceId);
        missed = this.#options.eventLog.since(lastWritten);
      }
    }
    for (const event of missed) {
      if (!writeSse(response, event)) break;
      lastWritten = event.id;
    }
    if (missed.length > 0) this.#options.metrics.inc('sse.replayed', missed.length);
    const unsubscribe = this.#options.eventLog.onAppend((event) => {
      if (event.id <= lastWritten) return;
      if (!writeSse(response, event)) {
        response.end();
        return;
      }
      lastWritten = event.id;
      this.#options.metrics.inc('sse.events_sent');
    });
    const heartbeat = setInterval(() => {
      if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
        response.end();
        return;
      }
      response.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.#clients.delete(response);
      this.#options.metrics.set('sse.clients', this.#clients.size);
    });
  }

  close(): void {
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    this.#options.metrics.set('sse.clients', 0);
  }
}
