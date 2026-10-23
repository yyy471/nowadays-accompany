import { contextBridge, ipcRenderer } from 'electron';

interface BridgeInfo {
  apiBaseUrl: string;
  token: string;
  version: string;
  platform: string;
}

const PREFIX = '--nowadays-info=';

function readInfo(): BridgeInfo {
  const raw = process.argv.find((value) => value.startsWith(PREFIX));
  if (raw) {
    try {
      return JSON.parse(decodeURIComponent(raw.slice(PREFIX.length))) as BridgeInfo;
    } catch {
      // fall through to the empty bridge
    }
  }
  return { apiBaseUrl: '', token: '', version: '', platform: process.platform };
}

contextBridge.exposeInMainWorld('nowadays', Object.freeze({
  ...readInfo(),
  chooseRuntimeDirectory: (): Promise<string | null> => ipcRenderer.invoke('nowadays:choose-runtime-directory'),
  openRuntimeDirectory: (): Promise<boolean> => ipcRenderer.invoke('nowadays:open-runtime-directory')
}));
