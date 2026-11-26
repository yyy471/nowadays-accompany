interface Window { nowadays?: { setWindowTheme?: (preset: 'daylight' | 'nightwave') => Promise<boolean> }; accompany?: Window['nowadays'] }

interface Window {
  nowadaysDesk?: { hostHeaders?: Record<string, string>; chooseSkillDirectory: () => Promise<string | null> };
}
