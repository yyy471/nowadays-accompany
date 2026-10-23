import { describe, expect, it } from 'vitest';
import {
  ProcessReconciler,
  type ProcessReconcilerHost
} from '../src/application/qq-connections/process-reconciler.js';
import { silentLogger } from '../src/core/logger.js';
import type { SnowLumaProcess } from '../src/injection/snowluma/manager.js';

function process_(pid: number, uin: string, overrides: Partial<SnowLumaProcess> = {}): SnowLumaProcess {
  return { pid, injected: true, connected: true, loggedIn: true, uin, status: 'ready', ...overrides };
}

function create(host: ProcessReconcilerHost, options: { missingThreshold?: number } = {}): ProcessReconciler {
  return new ProcessReconciler({ host, logger: silentLogger('reconciler-test'), ...options });
}

describe('process reconciler', () => {
  it('coalesces concurrent refreshes into one scan', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciler = create({
      listProcesses: async () => {
        calls += 1;
        await gate;
        return [process_(7, '10001')];
      },
      cleanupSlot: async () => {}
    });

    const first = reconciler.refresh();
    const second = reconciler.refresh();
    expect(calls).toBe(1);
    expect(second).toBe(first);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual([process_(7, '10001')]);
    expect(right).toBe(left);
    expect(reconciler.snapshot()).toEqual([process_(7, '10001')]);
  });

  it('keeps mappings and snapshot when the management request fails', async () => {
    let fail = true;
    const cleaned: string[] = [];
    const reconciler = create({
      listProcesses: async () => {
        if (fail) throw new Error('management unavailable');
        return [];
      },
      cleanupSlot: async (slotId) => { cleaned.push(slotId); }
    });
    reconciler.track(9, 'qq-10001', '10001');

    await expect(reconciler.refresh()).rejects.toThrow('management unavailable');
    expect(cleaned).toEqual([]);
    expect(reconciler.slotForProcess(9)).toBe('qq-10001');
    expect(reconciler.snapshot()).toEqual([]);
  });

  it('does not let an older scan remove a connection established after it started', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cleaned: string[] = [];
    const reconciler = create({
      listProcesses: async () => {
        await gate;
        return [];
      },
      cleanupSlot: async (slotId) => { cleaned.push(slotId); }
    });

    const scan = reconciler.refresh();
    reconciler.track(11, 'qq-10002', '10002');
    release();
    await scan;

    expect(cleaned).toEqual([]);
    expect(reconciler.slotForProcess(11)).toBe('qq-10002');
  });

  it('requires two successful missing snapshots but cleans an account change immediately', async () => {
    let current: SnowLumaProcess[] = [process_(13, '10001')];
    const cleaned: string[] = [];
    const reconciler = create({
      listProcesses: async () => current,
      cleanupSlot: async (slotId) => {
        cleaned.push(slotId);
        reconciler.forgetSlot(slotId);
      }
    });
    reconciler.track(13, 'qq-10001', '10001');

    current = [];
    await reconciler.refresh();
    expect(cleaned).toEqual([]);
    expect(reconciler.mappingCount()).toBe(1);
    await reconciler.refresh();
    expect(cleaned).toEqual(['qq-10001']);
    expect(reconciler.mappingCount()).toBe(0);

    current = [process_(13, '10003')];
    reconciler.track(13, 'qq-10003', '10003');
    current = [process_(13, '10004')];
    await reconciler.refresh();
    expect(cleaned).toEqual(['qq-10001', 'qq-10003']);
    expect(reconciler.mappingCount()).toBe(0);
  });

  it('serializes exclusive slot work with cleanup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const reconciler = create({
      listProcesses: async () => [],
      cleanupSlot: async (slotId) => { events.push(`cleanup:${slotId}`); }
    }, { missingThreshold: 1 });
    reconciler.track(17, 'qq-10001', '10001');

    const exclusive = reconciler.runExclusive(async () => {
      events.push('exclusive:start');
      await gate;
      events.push('exclusive:end');
    });
    const scan = reconciler.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['exclusive:start']);
    release();
    await Promise.all([exclusive, scan]);
    expect(events).toEqual(['exclusive:start', 'exclusive:end', 'cleanup:qq-10001']);
  });
});
