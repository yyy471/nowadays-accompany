import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopUserDataPath } from '../desktop/branding.js';

describe('nowadays desktop data continuity', () => {
  it('uses nowadays for a fresh installation', () => {
    expect(desktopUserDataPath('/appdata', () => false)).toBe(path.join('/appdata', 'nowadays'));
  });
  it('keeps existing legacy credentials and instance lock in place', () => {
    expect(desktopUserDataPath('/appdata', (directory) => directory === path.join('/appdata', 'Accompany')))
      .toBe(path.join('/appdata', 'Accompany'));
  });
  it('prefers legacy data if both names exist', () => {
    expect(desktopUserDataPath('/appdata', () => true)).toBe(path.join('/appdata', 'Accompany'));
  });
});
