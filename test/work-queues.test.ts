import { describe, expect, it } from 'vitest';
import { ConversationQueues } from '../src/work/conversation-queues.js';
import { BackpressureError } from '../src/core/errors.js';

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('ConversationQueues', () => {
  it('serializes one conversation and runs different conversations in parallel', async () => {
    const queues = new ConversationQueues({ maxPending: 10, maxPerConversation: 10 });
    const order: string[] = [];
    const hold = gate();

    const first = queues.enqueue('a', async () => {
      await hold.promise;
      order.push('a1');
    });
    const second = queues.enqueue('a', async () => {
      order.push('a2');
    });
    const other = queues.enqueue('b', async () => {
      order.push('b1');
    });

    await other;
    expect(order).toEqual(['b1']);
    hold.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['b1', 'a1', 'a2']);
    await queues.drain();
  });

  it('rejects when the total or per-conversation bound is reached', async () => {
    const queues = new ConversationQueues({ maxPending: 1, maxPerConversation: 1 });
    const hold = gate();
    const running = queues.enqueue('a', () => hold.promise);

    await expect(queues.enqueue('a', async () => {})).rejects.toBeInstanceOf(BackpressureError);
    expect(queues.tryEnqueue('b', async () => {})).toBe(false);
    hold.release();
    await running;
    await queues.drain();
  });

  it('fires high and low watermarks once per crossing', async () => {
    const events: string[] = [];
    const queues = new ConversationQueues({
      maxPending: 4,
      maxPerConversation: 4,
      highWaterRatio: 0.75,
      lowWaterRatio: 0.25,
      onHighWater: () => events.push('high'),
      onLowWater: () => events.push('low')
    });
    const hold = gate();
    const tasks = [1, 2, 3].map((index) => queues.enqueue(`k${index}`, () => hold.promise));
    expect(events).toEqual(['high']);
    hold.release();
    await Promise.all(tasks);
    await queues.drain();
    expect(events).toEqual(['high', 'low']);
  });
});
