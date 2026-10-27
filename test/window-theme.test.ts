import { describe, expect, it, vi } from 'vitest';
import { applyWindowTheme } from '../desktop/window-theme.js';
import { WINDOW_THEME_TOKENS } from '../desktop/window-theme-tokens.js';

function fixture() {
  return { window: { isDestroyed: () => false, setBackgroundColor: vi.fn(), setAccentColor: vi.fn() }, native: { themeSource: 'system' as 'system' | 'light' | 'dark', shouldUseHighContrastColors: false } };
}
describe('native window follows the committed application preset', () => {
  it('switches night then daylight without retaining the last dark frame', () => {
    const { window, native } = fixture();
    expect(applyWindowTheme(window, native, 'nightwave', 'win32')).toBe(true);
    expect(native.themeSource).toBe('dark');
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_THEME_TOKENS.nightwave.backgroundColor);
    expect(window.setAccentColor).toHaveBeenLastCalledWith(WINDOW_THEME_TOKENS.nightwave.accentColor);
    expect(applyWindowTheme(window, native, 'daylight', 'win32')).toBe(true);
    expect(native.themeSource).toBe('light');
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_THEME_TOKENS.daylight.backgroundColor);
    expect(window.setAccentColor).toHaveBeenLastCalledWith(WINDOW_THEME_TOKENS.daylight.accentColor);
  });
  it.each([undefined, null, 'system', '#ffffff', {}, { preset: 'nightwave' }])('rejects unsupported IPC data %j before any mutation', value => {
    const { window, native } = fixture();
    expect(applyWindowTheme(window, native, value, 'win32')).toBe(false);
    expect(native.themeSource).toBe('system');expect(window.setBackgroundColor).not.toHaveBeenCalled();expect(window.setAccentColor).not.toHaveBeenCalled();
  });
  it('does not customize an already destroyed window', () => {
    const { window, native } = fixture();window.isDestroyed = () => true;
    expect(applyWindowTheme(window, native, 'nightwave', 'win32')).toBe(false);
    expect(native.themeSource).toBe('system');expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });
  it('defers border highlighting to the OS in high contrast', () => {
    const { window, native } = fixture();native.shouldUseHighContrastColors = true;
    applyWindowTheme(window, native, 'nightwave', 'win32');expect(window.setAccentColor).toHaveBeenCalledWith(null);
  });
  it('does not call Windows-only accent APIs on another platform', () => {
    const { window, native } = fixture();applyWindowTheme(window, native, 'nightwave', 'linux');
    expect(native.themeSource).toBe('dark');expect(window.setAccentColor).not.toHaveBeenCalled();
  });
});
