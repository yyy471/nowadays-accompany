export function readThemePreset(): 'daylight' | 'nightwave' {
  try { return window.localStorage.getItem('nowadays.theme-preset.v1') === 'nightwave' ? 'nightwave' : 'daylight'; }
  catch { return 'daylight'; }
}

/** 启动封面与业务页均从当前主题读取窗口配色。 */
export function syncWindowTheme(preset: 'daylight' | 'nightwave') {
  if (!window.nowadaysDesk) return;
  const scope = document.querySelector(`[data-ui-theme="xiacheng"][data-ui-preset="${preset}"]`);
  if (scope) {
    const canvas = getComputedStyle(scope).getPropertyValue('--nd-semantic-color-canvas').trim();
    window.nowadaysDesk.setWindowTheme(preset, canvas);
  }
}
