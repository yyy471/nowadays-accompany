import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InjectionSettingsStore } from '../src/injection/settings.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith('nowadays-injection-settings-')) throw new Error('unexpected fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ filePath: string; runtimeDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-injection-settings-'));
  roots.push(root);
  return { filePath: path.join(root, 'injection.json'), runtimeDir: path.join(root, 'runtime') };
}

describe('injection settings', () => {
  it('persists the opt-in resume flag across reloads', async () => {
    const h = await fixture();
    const store = await InjectionSettingsStore.load({ filePath: h.filePath });
    await store.set({ runtimeDir: h.runtimeDir, resumeLastListen: true });
    await store.dispose();

    const loaded = await InjectionSettingsStore.load({ filePath: h.filePath });
    expect(loaded.get()).toEqual({
      runtimeDir: path.resolve(h.runtimeDir),
      resumeLastListen: true
    });

    await loaded.set({ runtimeDir: h.runtimeDir, resumeLastListen: false });
    await loaded.dispose();
    const disabled = await InjectionSettingsStore.load({ filePath: h.filePath });
    expect(disabled.get().resumeLastListen).toBe(false);
    await disabled.dispose();
  });

  it('keeps the flag off when omitted and rejects non-boolean values', async () => {
    const h = await fixture();
    const store = await InjectionSettingsStore.load({ filePath: h.filePath });
    await store.set({ runtimeDir: h.runtimeDir });
    expect((await InjectionSettingsStore.load({ filePath: h.filePath })).get().resumeLastListen).toBeUndefined();
    await expect(store.set({ runtimeDir: h.runtimeDir, resumeLastListen: 'yes' })).rejects.toMatchObject({
      code: 'injection_settings_invalid'
    });
    await store.dispose();
  });
});
