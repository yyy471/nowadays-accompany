import path from 'node:path';

/** Keep legacy credentials and Electron instance locks in place. */
export function desktopUserDataPath(appData: string, exists: (directory: string) => boolean): string {
  const legacy = path.join(appData, 'Accompany');
  return exists(legacy) ? legacy : path.join(appData, 'nowadays');
}
