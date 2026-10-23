import { describe, expect, it } from 'vitest';
import { RuntimeLifecycle } from '../src/application/lifecycle/runtime-lifecycle.js';
import { silentLogger } from '../src/core/logger.js';

describe('runtime lifecycle', () => {
  it('runs stop, drain and dispose phases in order', async () => {
    const lifecycle = new RuntimeLifecycle({ logger: silentLogger('lifecycle-test') });
    const events: string[] = [];
    lifecycle.add('dispose', 'last', () => { events.push('dispose'); });
    lifecycle.add('stop', 'first', () => { events.push('stop'); });
    lifecycle.add('drain', 'second', async () => { events.push('drain'); });
    await lifecycle.close();
    expect(events).toEqual(['stop', 'drain', 'dispose']);
    expect(lifecycle.closed).toBe(true);
  });

  it('keeps releasing resources after a step fails', async () => {
    const lifecycle = new RuntimeLifecycle({ logger: silentLogger('lifecycle-test') });
    const events: string[] = [];
    lifecycle.add('stop', 'broken', () => { throw new Error('boom'); });
    lifecycle.add('stop', 'next', () => { events.push('next'); });
    lifecycle.add('dispose', 'last', () => { events.push('last'); });
    await expect(lifecycle.close()).resolves.toBeUndefined();
    expect(events).toEqual(['next', 'last']);
  });

  it('closes once and refuses new steps afterwards', async () => {
    const lifecycle = new RuntimeLifecycle({ logger: silentLogger('lifecycle-test') });
    let runs = 0;
    lifecycle.add('dispose', 'counted', () => { runs += 1; });
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    await lifecycle.close();
    expect(runs).toBe(1);
    expect(() => lifecycle.add('dispose', 'late', () => {})).toThrow(/after close/);
  });
});
