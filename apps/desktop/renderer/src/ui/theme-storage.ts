export function readThemePreset(): 'daylight' | 'nightwave' {
  try { return window.localStorage.getItem('nowadays.theme-preset.v1') === 'nightwave' ? 'nightwave' : 'daylight'; }
  catch { return 'daylight'; }
}
