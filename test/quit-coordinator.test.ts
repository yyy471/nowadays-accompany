import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuitCoordinator } from '../desktop/quit-coordinator.js';

afterEach(() => {
  vi.useRealTimers();
});

function createCoordinator(overrides: {
  sendCheck?: (requestId: string) => boolean;
  showUnavailableDialog?: () => Promise<boolean>;
  shutdown?: () => Promise<void>;
  ackTimeoutMs?: number;
  livenessTimeoutMs?: number;
  onStateChange?: (event: import('../desktop/quit-coordinator.js').QuitStateChange) => void;
} = {}) {
  let sequence = 0;
  const sendCheck = vi.fn(overrides.sendCheck ?? (() => true));
  const showUnavailableDialog = vi.fn(overrides.showUnavailableDialog ?? (async () => false));
  const shutdown = vi.fn(overrides.shutdown ?? (async () => {}));
  const coordinator = new QuitCoordinator({
    sendCheck,
    showUnavailableDialog,
    shutdown,
    requestId: () => `request-${++sequence}`,
    ackTimeoutMs: overrides.ackTimeoutMs ?? 100,
    livenessTimeoutMs: overrides.livenessTimeoutMs,
    onStateChange: overrides.onStateChange
  });
  return { coordinator, sendCheck, showUnavailableDialog, shutdown };
}

describe('quit coordinator', () => {
  it('allows an arbitrarily long user decision while heartbeats continue', async () => {
    vi.useFakeTimers();
    const { coordinator, showUnavailableDialog } = createCoordinator({ livenessTimeoutMs: 100 });
    const pending = coordinator.request(); coordinator.ack('request-1');
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(80);
      expect(coordinator.keepAlive('request-1')).toBe(true);
    }
    expect(showUnavailableDialog).not.toHaveBeenCalled();
    coordinator.respond('request-1', false); await pending;
  });
  it('invalidates the renderer confirmation and recovers when ACK is followed by silence', async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const { coordinator, showUnavailableDialog, shutdown } = createCoordinator({ livenessTimeoutMs: 100, onStateChange: notify });
    const pending = coordinator.request(); coordinator.ack('request-1');
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(showUnavailableDialog).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({ requestId: 'request-1', state: 'cancelled' });
    expect(coordinator.current).toBe('idle');
    expect(coordinator.respond('request-1', true)).toBe(false);
    expect(coordinator.keepAlive('request-1')).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
  });
  it('runs only one native fallback and notifies shutdown after explicit native approval', async () => {
    const notify = vi.fn();
    const { coordinator, showUnavailableDialog, shutdown } = createCoordinator({ showUnavailableDialog: async () => true, onStateChange: notify });
    const pending = coordinator.request(); coordinator.ack('request-1');
    expect(coordinator.unavailable()).toBe(true);
    expect(coordinator.unavailable()).toBe(false);
    await pending;
    expect(showUnavailableDialog).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(notify.mock.calls.map(call => call[0].state)).toEqual(['cancelled', 'shuttingDown']);
  });
  it('ignores a final decision until the renderer acknowledges the request', () => {
    const { coordinator } = createCoordinator();
    void coordinator.request();
    expect(coordinator.ack('request-1')).toBe(true);
    expect(coordinator.ack('request-1')).toBe(false);
    expect(coordinator.respond('request-1', true)).toBe(true);
  });

  it('stops core only after an acknowledged request is approved', async () => {
    const { coordinator, sendCheck, shutdown } = createCoordinator();
    const pending = coordinator.request();
    expect(coordinator.current).toBe('checking');
    expect(sendCheck).toHaveBeenCalledWith('request-1');
    expect(coordinator.respond('request-1', true)).toBe(false); // not acked yet
    expect(shutdown).not.toHaveBeenCalled();

    expect(coordinator.ack('request-1')).toBe(true);
    expect(coordinator.respond('request-1', true)).toBe(true);
    await pending;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(coordinator.current).toBe('exited');
  });

  it('returns to idle when the renderer denies quitting and can be requested again', async () => {
    const { coordinator, sendCheck, shutdown } = createCoordinator();
    const pending = coordinator.request();
    coordinator.ack('request-1');
    expect(coordinator.respond('request-1', false)).toBe(true);
    await pending;
    expect(shutdown).not.toHaveBeenCalled();
    expect(coordinator.current).toBe('idle');

    void coordinator.request();
    expect(sendCheck).toHaveBeenLastCalledWith('request-2');
  });

  it('ignores unknown and duplicate responses', async () => {
    const { coordinator, shutdown } = createCoordinator();
    const pending = coordinator.request();
    coordinator.ack('request-1');
    expect(coordinator.respond('other', true)).toBe(false);
    expect(coordinator.respond('request-1', false)).toBe(true);
    expect(coordinator.respond('request-1', true)).toBe(false);
    await pending;
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent quit requests', async () => {
    const { coordinator, sendCheck } = createCoordinator();
    const first = coordinator.request();
    const second = coordinator.request();
    expect(second).toBe(first);
    expect(sendCheck).toHaveBeenCalledOnce();
    coordinator.ack('request-1');
    coordinator.respond('request-1', false);
    await first;
  });

  it('treats a missing acknowledgement as unreachable and defaults to cancel', async () => {
    vi.useFakeTimers();
    const { coordinator, showUnavailableDialog, shutdown } = createCoordinator();
    const pending = coordinator.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(showUnavailableDialog).toHaveBeenCalledOnce();
    await pending;
    expect(shutdown).not.toHaveBeenCalled();
    expect(coordinator.current).toBe('idle');
  });

  it('never bounds the user decision once acknowledged', async () => {
    vi.useFakeTimers();
    const { coordinator, showUnavailableDialog, shutdown } = createCoordinator();
    const pending = coordinator.request();
    coordinator.ack('request-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(showUnavailableDialog).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(coordinator.current).toBe('checking');
    expect(coordinator.respond('request-1', true)).toBe(true);
    await pending;
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('acknowledgement after the fallback window is rejected', async () => {
    vi.useFakeTimers();
    const { coordinator, shutdown } = createCoordinator({ showUnavailableDialog: async () => true });
    const pending = coordinator.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(coordinator.ack('request-1')).toBe(false);
    await pending;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(coordinator.current).toBe('exited');
  });

  it('uses the native fallback when the renderer is unavailable and ignores late responses', async () => {
    let resolveDialog!: (allowed: boolean) => void;
    const dialog = new Promise<boolean>((resolve) => { resolveDialog = resolve; });
    const { coordinator, showUnavailableDialog, shutdown } = createCoordinator({
      sendCheck: () => false,
      showUnavailableDialog: () => dialog
    });
    const pending = coordinator.request();
    await Promise.resolve();
    expect(showUnavailableDialog).toHaveBeenCalledOnce();
    expect(coordinator.ack('request-1')).toBe(false);
    expect(coordinator.respond('request-1', true)).toBe(false);
    resolveDialog(false);
    await pending;
    expect(shutdown).not.toHaveBeenCalled();
    expect(coordinator.current).toBe('idle');
  });

  it('cancels an in-flight pre-check when the renderer process is gone', async () => {
    const { coordinator, showUnavailableDialog, shutdown } = createCoordinator();
    const pending = coordinator.request();
    expect(coordinator.cancel()).toBe(true);
    await pending;
    expect(showUnavailableDialog).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(coordinator.current).toBe('idle');
  });

  it('cancels an acknowledged but undecided request without stopping core', async () => {
    const { coordinator, shutdown } = createCoordinator();
    const pending = coordinator.request();
    coordinator.ack('request-1');
    expect(coordinator.cancel()).toBe(true);
    await pending;
    expect(shutdown).not.toHaveBeenCalled();
    expect(coordinator.current).toBe('idle');
  });

  it('ignores cancel when not checking', () => {
    const { coordinator } = createCoordinator();
    expect(coordinator.cancel()).toBe(false);
  });
});
