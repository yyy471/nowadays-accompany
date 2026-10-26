import { describe, expect, it, vi } from 'vitest';
import { DraftRegistry, type DraftSource } from '../desktop/renderer/src/lib/drafts/registry.js';
import { TransitionController, type TransitionConfirmOptions } from '../desktop/renderer/src/lib/drafts/transition-controller.js';

function source(id: string, state: Partial<ReturnType<DraftSource['getSnapshot']>> & { owner?: DraftSource['owner'] } = {}): DraftSource {
  const { owner = 'page', ...snapshot } = state;
  return {
    id,
    owner,
    getSnapshot: () => ({
      label: id,
      dirty: false,
      busy: false,
      revision: 1,
      discard: () => {},
      ...snapshot
    })
  };
}

describe('transition controller', () => {
  it('allows a clean scope without confirmation or discard', async () => {
    const registry = new DraftRegistry();
    registry.register(source('clean'));
    const confirm = vi.fn(async () => true);
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm })).resolves.toEqual({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('cancels without discarding or changing anything', async () => {
    const registry = new DraftRegistry();
    const discard = vi.fn();
    registry.register(source('dirty', { dirty: true, discard }));
    const confirm = vi.fn(async () => false);
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm }))
      .resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(confirm).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    expect(registry.hasPending()).toBe(true);
  });

  it('discards each dirty entry once after confirmation', async () => {
    const registry = new DraftRegistry();
    const discardDirty = vi.fn();
    const discardClean = vi.fn();
    registry.register(source('dirty', { dirty: true, discard: discardDirty }));
    registry.register(source('clean', { discard: discardClean }));
    const confirm = vi.fn(async (_options: TransitionConfirmOptions) => true);
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm })).resolves.toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0].description).toContain('dirty');
    expect(confirm.mock.calls[0]?.[0].description).toContain('切换页面');
    expect(discardDirty).toHaveBeenCalledOnce();
    expect(discardClean).not.toHaveBeenCalled();
  });

  it('rejects a busy scope before showing a confirmation', async () => {
    const registry = new DraftRegistry();
    const discard = vi.fn();
    registry.register(source('saving', { dirty: true, busy: true, discard }));
    const confirm = vi.fn(async () => true);
    const controller = new TransitionController(registry);

    const result = await controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm });
    expect(result).toMatchObject({ ok: false, reason: 'busy' });
    expect(result.ok ? '' : result.message).toContain('saving');
    expect(confirm).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it('rejects the old confirmation when the revision changes while open', async () => {
    const registry = new DraftRegistry();
    const discard = vi.fn();
    let revision = 1;
    registry.register({ id: 'dirty', owner: 'page', getSnapshot: () => ({ label: 'dirty', dirty: true, busy: false, revision, discard }) });
    const confirm = vi.fn(async () => { revision = 2; return true; });
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm }))
      .resolves.toEqual({ ok: false, reason: 'changed', message: '编辑状态已变化，请重新操作。' });
    expect(discard).not.toHaveBeenCalled();
  });

  it('rejects the old confirmation when another editor becomes dirty', async () => {
    const registry = new DraftRegistry();
    const discard = vi.fn();
    registry.register(source('dirty', { dirty: true, discard }));
    const confirm = vi.fn(async () => {
      registry.register(source('new', { dirty: true }));
      return true;
    });
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm }))
      .resolves.toEqual({ ok: false, reason: 'changed', message: '编辑状态已变化，请重新操作。' });
    expect(discard).not.toHaveBeenCalled();
  });

  it('rejects the old confirmation when an editor unregisters', async () => {
    const registry = new DraftRegistry();
    const discard = vi.fn();
    const cleanup = registry.register(source('dirty', { dirty: true, discard }));
    const confirm = vi.fn(async () => { cleanup(); return true; });
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm }))
      .resolves.toEqual({ ok: false, reason: 'changed', message: '编辑状态已变化，请重新操作。' });
    expect(discard).not.toHaveBeenCalled();
  });

  it('allows only one confirmation at a time and does not replace its target', async () => {
    const registry = new DraftRegistry();
    registry.register(source('dirty', { dirty: true }));
    let resolveFirst!: (accepted: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }));
    const controller = new TransitionController(registry);

    const first = controller.request({ scope: { kind: 'page' }, actionLabel: '切换页面', confirm });
    await Promise.resolve();
    expect(controller.pending).toBe(true);
    await expect(controller.request({ scope: { kind: 'page' }, actionLabel: '另一个目标', confirm }))
      .resolves.toMatchObject({ ok: false, reason: 'busy' });
    expect(confirm).toHaveBeenCalledOnce();

    resolveFirst(true);
    await expect(first).resolves.toEqual({ ok: true });
    expect(controller.pending).toBe(false);
  });

  it('can allow a transition without discarding local drafts', async () => {
    const registry = new DraftRegistry();
    const discard = vi.fn();
    registry.register(source('dirty', { dirty: true, discard }));
    const confirm = vi.fn(async () => true);
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'all' }, actionLabel: '退出应用', confirm, discardOnAccept: false })).resolves.toEqual({ ok: true });
    expect(discard).not.toHaveBeenCalled();
  });

  it('only checks the requested scope', async () => {
    const registry = new DraftRegistry();
    const pageDiscard = vi.fn();
    const settingsDiscard = vi.fn();
    registry.register(source('page', { dirty: true, discard: pageDiscard }));
    registry.register({ ...source('settings', { dirty: true, discard: settingsDiscard }), owner: 'settings' });
    const confirm = vi.fn(async () => true);
    const controller = new TransitionController(registry);

    await expect(controller.request({ scope: { kind: 'settings' }, actionLabel: '关闭设置', confirm })).resolves.toEqual({ ok: true });
    expect(settingsDiscard).toHaveBeenCalledOnce();
    expect(pageDiscard).not.toHaveBeenCalled();
  });
});
