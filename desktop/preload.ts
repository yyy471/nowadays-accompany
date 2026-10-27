import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ArtifactImportMode, ArtifactImportPreview, ArtifactImportResult } from '../src/contracts/artifact-import.js';

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
  setWindowTheme: (preset: 'daylight' | 'nightwave'): Promise<boolean> => ipcRenderer.invoke('nowadays:set-window-theme', preset),
  openArtifactsDirectory: (): Promise<void> => ipcRenderer.invoke('nowadays:open-artifacts-directory'),
  previewArtifactImport: (mode?: ArtifactImportMode): Promise<ArtifactImportPreview | undefined> => ipcRenderer.invoke('nowadays:preview-artifact-import', mode),
  commitArtifactImport: (token: string): Promise<ArtifactImportResult> => ipcRenderer.invoke('nowadays:commit-artifact-import', token),
  chooseRuntimeDirectory: (): Promise<string | null> => ipcRenderer.invoke('nowadays:choose-runtime-directory'),
  openRuntimeDirectory: (): Promise<boolean> => ipcRenderer.invoke('nowadays:open-runtime-directory'),
  onQuitCheck: (handler: (request: { requestId: string }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return;
      const { requestId } = payload as { requestId?: unknown };
      if (typeof requestId === 'string') handler({ requestId });
    };
    ipcRenderer.on('nowadays:quit-check', listener);
    return () => ipcRenderer.removeListener('nowadays:quit-check', listener);
  },
  ackQuit: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke('nowadays:quit-ack', { requestId }),
  keepQuitAlive: (requestId: string): Promise<boolean> => ipcRenderer.invoke('nowadays:quit-alive', requestId),
  onQuitState: (handler: (event: { requestId: string; state: 'cancelled' | 'shuttingDown' }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return;
      const { requestId, state } = payload as { requestId?: unknown; state?: unknown };
      if (typeof requestId === 'string' && (state === 'cancelled' || state === 'shuttingDown')) handler({ requestId, state });
    };
    ipcRenderer.on('nowadays:quit-state', listener);
    return () => ipcRenderer.removeListener('nowadays:quit-state', listener);
  },
  respondQuit: (requestId: string, allowed: boolean): Promise<boolean> =>
    ipcRenderer.invoke('nowadays:quit-response', { requestId, allowed })
}));
