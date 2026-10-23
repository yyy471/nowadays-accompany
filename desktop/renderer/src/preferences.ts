export type MotionPreference = 'system' | 'reduced' | 'full';

const MOTION_PREFERENCE_KEY = 'nowadays.motion-preference.v1';

export function readMotionPreference(): MotionPreference {
  try {
    const value = window.localStorage.getItem(MOTION_PREFERENCE_KEY)
      ?? window.localStorage.getItem('accompany.motion-preference.v1');
    return value === 'reduced' || value === 'full' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyMotionPreference(preference: MotionPreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', preference);
  try {
    window.localStorage.setItem(MOTION_PREFERENCE_KEY, preference);
  } catch {
    // The system preference remains active when local storage is unavailable.
  }
}
