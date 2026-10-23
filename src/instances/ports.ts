import net from 'node:net';
import { InvalidSpecError } from '../core/errors.js';

export interface PortRange {
  start: number;
  end: number;
}

/**
 * 端口租约：多实例必须各占一份端口，分配器只做「本进程内不重复」，
 * 是否被别的程序占用由 isFree 探测。reservePair 是同步的租约，不探活。
 */
export class PortAllocator {
  readonly #range: PortRange;
  readonly #reserved = new Set<number>();

  constructor(range: PortRange = { start: 3100, end: 3999 }) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start > range.end) {
      throw new InvalidSpecError(`invalid port range ${range.start}-${range.end}`);
    }
    this.#range = range;
  }

  get reserved(): number[] {
    return [...this.#reserved].sort((a, b) => a - b);
  }

  has(port: number): boolean {
    return this.#reserved.has(port);
  }

  reserve(port: number): number {
    this.#assertInRange(port);
    if (this.#reserved.has(port)) throw new InvalidSpecError(`port ${port} already reserved`);
    this.#reserved.add(port);
    return port;
  }

  release(port: number): void {
    this.#reserved.delete(port);
  }

  /** 同步取一对相邻端口（http, ws）；不探测操作系统占用。 */
  reservePair(): { http: number; ws: number } {
    for (let port = this.#range.start; port < this.#range.end; port += 1) {
      if (this.#reserved.has(port) || this.#reserved.has(port + 1)) continue;
      this.#reserved.add(port);
      this.#reserved.add(port + 1);
      return { http: port, ws: port + 1 };
    }
    throw new InvalidSpecError(`no free port pair in ${this.#range.start}-${this.#range.end}`);
  }

  async allocate(exclude: Iterable<number> = []): Promise<number> {
    const excluded = new Set(exclude);
    for (let port = this.#range.start; port <= this.#range.end; port += 1) {
      if (this.#reserved.has(port) || excluded.has(port)) continue;
      if (await this.isFree(port)) {
        this.#reserved.add(port);
        return port;
      }
    }
    throw new InvalidSpecError(`no free port in ${this.#range.start}-${this.#range.end}`);
  }

  async isFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  #assertInRange(port: number): void {
    if (!Number.isInteger(port) || port < this.#range.start || port > this.#range.end) {
      throw new InvalidSpecError(`port ${port} outside ${this.#range.start}-${this.#range.end}`);
    }
  }
}
