// 启动封面与工作区共用本机偏好，首帧读取时无需加载 React。
export type MotionPreference = 'system' | 'reduced' | 'full';
const STORAGE_KEY = 'nowadays.motion-preference.v1';
const LEGACY_STORAGE_KEY = 'accompany.motion-preference.v1';

export function readMotionPreference(): MotionPreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return value === 'reduced' || value === 'full' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyMotionPreference(preference: MotionPreference): void {
  if (preference === 'system') document.documentElement.removeAttribute('data-motion');
  else document.documentElement.setAttribute('data-motion', preference);
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 系统偏好仍然生效。
  }
}
