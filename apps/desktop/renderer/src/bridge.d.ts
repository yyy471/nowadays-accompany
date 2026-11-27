interface Window { nowadays?: { setWindowTheme?: (preset: 'daylight' | 'nightwave') => Promise<boolean> }; accompany?: Window['nowadays'] }

type DeskIntent = { id: number; action: 'hide' | 'quit' | 'cancel' };
interface Window {
  nowadaysDesk?: {
    coverPainted(color: string): void;
    boot(): Promise<{ ok: true; skipRolePicker: boolean } | { ok: false; reason: string }>;
    onIntent(callback: (request: DeskIntent) => void): () => void;
    waiting(id: number): void;
    reply(id: number, accepted: boolean): void;
    hostHeaders?: Record<string, string>; chooseSkillDirectory: () => Promise<string | null> };
}
