import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { PortAllocator } from '../src/instances/ports.js';
import { InvalidSpecError } from '../src/core/errors.js';

describe('PortAllocator', () => {
  it('rejects duplicate reservations and out-of-range ports', () => {
    const allocator = new PortAllocator({ start: 4100, end: 4110 });
    allocator.reserve(4100);
    expect(() => allocator.reserve(4100)).toThrow(InvalidSpecError);
    expect(() => allocator.reserve(4099)).toThrow(InvalidSpecError);
  });

  it('hands out distinct adjacent pairs', () => {
    const allocator = new PortAllocator({ start: 4200, end: 4210 });
    const first = allocator.reservePair();
    const second = allocator.reservePair();
    expect(first.ws).toBe(first.http + 1);
    expect(second.http).toBeGreaterThan(first.ws);
    expect(new Set([first.http, first.ws, second.http, second.ws]).size).toBe(4);
  });

  it('reuses a released port', () => {
    const allocator = new PortAllocator({ start: 4300, end: 4305 });
    allocator.reserve(4300);
    allocator.release(4300);
    expect(() => allocator.reserve(4300)).not.toThrow();
  });

  it('detects an occupied port and skips it when allocating', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const allocator = new PortAllocator({ start: 4400, end: 4402 });

    expect(await allocator.isFree(address.port)).toBe(false);
    const allocated = await allocator.allocate([4400]);
    expect(allocated).toBe(4401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
