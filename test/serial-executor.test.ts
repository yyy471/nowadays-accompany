import { describe, expect, it } from 'vitest';
import { SerialExecutor } from '../src/platform/async/serial-executor.js';
import { KeyedSerialExecutor } from '../src/platform/async/keyed-serial-executor.js';

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('SerialExecutor', () => {
  it('serializes tasks in submission order and survives a failure', async () => {
    const executor = new SerialExecutor();
    const order: string[] = [];
    const hold = gate();
    const first = executor.run(async () => {
      await hold.promise;
      order.push('first');
    });
    const failed = executor.run(async () => {
      order.push('failed');
      throw new Error('boom');
    });
    const last = executor.run(async () => {
      order.push('last');
    });

    hold.release();
    await first;
    await expect(failed).rejects.toThrow('boom');
    await last;
    expect(order).toEqual(['first', 'failed', 'last']);
    expect(executor.active).toBe(false);
    expect(executor.pending).toBe(0);
    await executor.close();
  });

  it('releases the executor after synchronous throws from the first and queued tasks', async () => {
    const executor = new SerialExecutor();
    const order: string[] = [];
    const first = executor.run(() => {
      order.push('first');
      throw new Error('sync-first');
    });
    const second = executor.run(() => {
      order.push('second');
      throw new Error('sync-second');
    });
    const last = executor.run(() => {
      order.push('last');
      return 'done';
    });

    await expect(first).rejects.toThrow('sync-first');
    await expect(second).rejects.toThrow('sync-second');
    await expect(last).resolves.toBe('done');
    await expect(executor.drain()).resolves.toBeUndefined();
    await expect(executor.close()).resolves.toBeUndefined();
    expect(order).toEqual(['first', 'second', 'last']);
    expect(executor.active).toBe(false);
    expect(executor.pending).toBe(0);
  });

  it('rejects new work after close and waits for accepted work', async () => {
    const executor = new SerialExecutor();
    const hold = gate();
    let finished = false;
    const running = executor.run(async () => {
      await hold.promise;
      finished = true;
    });
    const closing = executor.close();
    await expect(executor.run(async () => {})).rejects.toThrow('closed');
    expect(finished).toBe(false);
    hold.release();
    await running;
    await closing;
    expect(finished).toBe(true);
    await expect(executor.run(async () => {})).rejects.toThrow('closed');
  });

  it('enforces the pending bound without counting the running task', async () => {
    const executor = new SerialExecutor({ maxPending: 0 });
    const hold = gate();
    const running = executor.run(() => hold.promise);
    await expect(executor.run(async () => {})).rejects.toThrow('full');
    hold.release();
    await running;
    await executor.drain();
  });
});

describe('KeyedSerialExecutor', () => {
  it('serializes one key, runs different keys independently, and reclaims idle keys', async () => {
    const executor = new KeyedSerialExecutor({ maxPendingPerKey: 8 });
    const order: string[] = [];
    const hold = gate();
    const first = executor.run('a', async () => {
      await hold.promise;
      order.push('a1');
    });
    const second = executor.run('a', async () => {
      order.push('a2');
    });
    const other = executor.run('b', async () => {
      order.push('b1');
    });

    await other;
    expect(order).toEqual(['b1']);
    hold.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['b1', 'a1', 'a2']);
    expect(executor.size).toBe(0);
    await executor.close();
  });

  it('does not let one failed key block another task on the same key', async () => {
    const executor = new KeyedSerialExecutor();
    const failed = executor.run('a', async () => {
      throw new Error('boom');
    });
    const next = executor.run('a', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    await executor.close();
  });

  it('reclaims a key after a synchronous throw and runs queued work', async () => {
    const executor = new KeyedSerialExecutor();
    const failed = executor.run('a', () => {
      throw new Error('sync-boom');
    });
    const queuedFailure = executor.run('a', () => {
      throw new Error('queued-sync-boom');
    });
    const next = executor.run('a', () => 'ok');

    await expect(failed).rejects.toThrow('sync-boom');
    await expect(queuedFailure).rejects.toThrow('queued-sync-boom');
    await expect(next).resolves.toBe('ok');
    expect(executor.size).toBe(0);
    await expect(executor.run('a', () => 'reused')).resolves.toBe('reused');
    expect(executor.size).toBe(0);
    await expect(executor.close()).resolves.toBeUndefined();
  });

  it('rejects new work after close and waits for every key', async () => {
    const executor = new KeyedSerialExecutor();
    const hold = gate();
    let finished = false;
    const running = executor.run('a', async () => {
      await hold.promise;
      finished = true;
    });
    const closing = executor.close();
    await expect(executor.run('b', async () => {})).rejects.toThrow('closed');
    expect(finished).toBe(false);
    hold.release();
    await running;
    await closing;
    expect(finished).toBe(true);
    expect(executor.size).toBe(0);
  });
});
