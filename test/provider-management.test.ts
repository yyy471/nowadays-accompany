import { describe, expect, it, vi } from 'vitest';
import { parseProvider } from '../src/providers/types.js';
import type { ProviderDto } from '../desktop/renderer/src/types.js';
import { previewAndDeleteProvider, providerEditDraft, providerEditPayload, type ProviderRequest } from '../desktop/renderer/src/lib/provider-management.js';

export const complexProvider: ProviderDto = {
  id: 'service-a', adapterId: 'openai-compatible-v1', baseUrl: 'https://one.example/v1', location: 'cloud',
  credential: { ref: 'provider/service-a', configured: true }, capabilities: ['chat', 'image.understand'],
  models: [{ id: 'chat-a', capabilities: ['chat'], input: ['text'], supportsTools: true, parameters: { temperature: 0.2, nested: { privateOption: ['x'] } } },
    { id: 'vision-a', capabilities: ['image.understand'], input: ['text', 'image'], supportsTools: false, parameters: { detail: 'high' } }],
  mediaTransports: ['inline', 'url'], limits: { maxConcurrent: 3, maxQueue: 7 },
  timeouts: { requestMs: 15000, pollIntervalMs: 1000, pollTimeoutMs: 45000 }, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
  options: { settingsModels: { chat: 'chat-a' }, vendor: { headers: ['custom'], budget: 6 } }
};

describe('existing service edit payload', () => {
  it('round trips a real DTO through the strict backend parser and retains complex unedited fields', () => {
    const before = structuredClone(complexProvider);
    const draft = providerEditDraft(complexProvider); draft.baseUrl = 'https://one.example/v2';
    const payload = providerEditPayload(complexProvider, draft);
    expect(payload.inferLocationFromUrl).toBe(true);
    const parsed = parseProvider(payload.provider);
    expect(parsed.models).toEqual(before.models);
    expect(parsed.options).toEqual(before.options);
    expect(parsed.limits).toEqual(before.limits);
    expect(parsed.timeouts).toEqual(before.timeouts);
    expect(parsed.retry).toEqual(before.retry);
    expect(parsed.mediaTransports).toEqual(before.mediaTransports);
    expect(parsed.credentialRef).toBe(before.credential.ref);
    expect(payload.provider).not.toHaveProperty('credential');
    expect(payload.provider).not.toHaveProperty('capabilities');
    payload.provider.models[0]!.parameters.temperature = 9;
    expect(complexProvider).toEqual(before);
  });
  it('requires a fresh key across origins, and never carries the previous reference to the new origin', () => {
    const draft = { ...providerEditDraft(complexProvider), baseUrl: 'https://two.example/v1' };
    expect(() => providerEditPayload(complexProvider, draft)).toThrow('重新输入');
    const payload = providerEditPayload(complexProvider, { ...draft, secret: 'new-key' });
    expect(payload.secret).toBe('new-key'); expect(payload.provider).not.toHaveProperty('credentialRef');
    expect(() => parseProvider(payload.provider)).not.toThrow();
    expect(providerEditPayload({ ...complexProvider, credential: { ref: 'shared/custom', configured: false } }, draft).provider).not.toHaveProperty('credentialRef');
  });
  it('renames a model without replacing capabilities, parameters, or other options', () => {
    const draft = providerEditDraft(complexProvider); draft.modelIds[0] = 'renamed';
    const payload = providerEditPayload(complexProvider, draft);
    expect(payload.provider.models[0]).toEqual({ ...complexProvider.models[0], id: 'renamed' });
    expect(payload.provider.options).toEqual({ ...complexProvider.options, settingsModels: { chat: 'renamed' } });
    expect(() => providerEditPayload(complexProvider, { ...draft, modelIds: ['same', 'same'] })).toThrow();
  });
});

describe('delete ordering', () => {
  const impact = { ok: true, providerId: 'service-a', exists: true, affectedAccounts: ['10001', '10002'] };
  it('makes only GET before explicit confirmation, then one DELETE and returns actual impact', async () => {
    let accept!: (value: boolean) => void;
    const request = vi.fn().mockResolvedValueOnce(impact).mockResolvedValueOnce({ ok: true, removed: true, affectedAccounts: ['10003'] });
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const pending = previewAndDeleteProvider('service-a', request as ProviderRequest, confirm);
    await Promise.resolve();
    expect(request.mock.calls).toEqual([['/providers/service-a/impact']]); expect(confirm).toHaveBeenCalledWith(impact);
    accept(true); expect(await pending).toEqual({ ok: true, removed: true, affectedAccounts: ['10003'] });
    expect(request.mock.calls[1]).toEqual(['/providers/service-a', { method: 'DELETE' }]);
  });
  it('cancellation and unmount after confirmation cause zero writes', async () => {
    for (const active of [true, false]) {
      let alive = true;
      const request = vi.fn().mockResolvedValue(impact);
      await previewAndDeleteProvider('service-a', request as ProviderRequest, async () => { alive = active; return !active; }, () => alive);
      expect(request.mock.calls).toEqual([['/providers/service-a/impact']]);
    }
  });
  it('preview failure or nonexistent service never asks for destructive confirmation or deletes', async () => {
    for (const response of [new Error('network'), { ...impact, exists: false }, { ...impact, providerId: 'wrong' }]) {
      const request = response instanceof Error ? vi.fn().mockRejectedValue(response) : vi.fn().mockResolvedValue(response);
      const confirm = vi.fn().mockResolvedValue(true);
      await expect(previewAndDeleteProvider('service-a', request as ProviderRequest, confirm)).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled();
    }
  });
});
