import type { BrowserWindow, NativeTheme } from 'electron';
import { WINDOW_THEME_TOKENS } from './window-theme-tokens.js';

/** 仅接受两种预置；原生窗口配色不允许由渲染层传入任意设置。 */
export function applyWindowTheme(window: Pick<BrowserWindow, 'isDestroyed' | 'setBackgroundColor' | 'setAccentColor'>, nativeTheme: Pick<NativeTheme, 'themeSource' | 'shouldUseHighContrastColors'>, preset: unknown, platform: NodeJS.Platform): boolean {
  if ((preset !== 'daylight' && preset !== 'nightwave') || window.isDestroyed()) return false;
  const palette = WINDOW_THEME_TOKENS[preset];
  nativeTheme.themeSource = palette.themeSource;
  window.setBackgroundColor(palette.backgroundColor);
  if (platform === 'win32') window.setAccentColor(nativeTheme.shouldUseHighContrastColors ? null : palette.accentColor);
  return true;
}
