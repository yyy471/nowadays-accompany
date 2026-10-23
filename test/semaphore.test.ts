import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/core/concurrency.js';

describe('Semaphore', () => {
  it('hands the slot directly to the waiter so a new request cannot overtake it', async () => {
    const semaphore = new Semaphore(1);
    const order: string[] = [];
    const first = await semaphore.acquire();
    const second = semaphore.acquire().then((release) => {
      order.push('second');
      return release;
    });

    first();
    const third = semaphore.acquire().then((release) => {
      order.push('third');
      return release;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['second']);
    expect(semaphore.active).toBe(1);
    expect(semaphore.pending).toBe(1);

    const secondRelease = await second;
    expect(semaphore.active).toBe(1);
    secondRelease();

    const thirdRelease = await third;
    expect(order).toEqual(['second', 'third']);
    expect(semaphore.active).toBe(1);
    thirdRelease();
    expect(semaphore.active).toBe(0);
  });

  it('keeps release idempotent and does not wake extra waiters', async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const second = semaphore.acquire();
    first();
    first();
    first();

    const secondRelease = await second;
    expect(semaphore.active).toBe(1);
    expect(semaphore.pending).toBe(0);
    secondRelease();
    secondRelease();
    expect(semaphore.active).toBe(0);
  });

  it('releases the slot when a run task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => {
      throw new Error('task failed');
    })).rejects.toThrow('task failed');
    expect(semaphore.active).toBe(0);

    const release = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    release();
  });

  it('never exceeds the limit while queued callers are activated', async () => {
    const semaphore = new Semaphore(1);
    const seen: number[] = [];
    const gates = Array.from({ length: 3 }, async () => {
      const release = await semaphore.acquire();
      seen.push(semaphore.active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();
    });
    await Promise.all(gates);
    expect(Math.max(...seen)).toBe(1);
    expect(semaphore.active).toBe(0);
  });
});
