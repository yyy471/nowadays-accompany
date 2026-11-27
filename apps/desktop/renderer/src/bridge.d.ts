type DeskIntent = { id: number; action: 'hide' | 'quit' | 'cancel' };
interface Window {
  nowadaysDesk?: {
    isPackaged: boolean;
    setWindowTheme(preset: 'daylight' | 'nightwave', color: string): void;
    boot(): Promise<{ ok: true; skipRolePicker: boolean } | { ok: false; reason: string; canOpenLogs: boolean }>;
    openBackendLogs(): Promise<{ ok: true } | { ok: false; message: string }>;
    onIntent(callback: (request: DeskIntent) => void): () => void;
    waiting(id: number): void;
    reply(id: number, accepted: boolean): void;
    hostHeaders?: Record<string, string>; chooseSkillDirectory: () => Promise<string | null> };
}
