interface Window { nowadays?: { setWindowTheme?: (preset: 'daylight' | 'nightwave') => Promise<boolean> }; accompany?: Window['nowadays'] }

interface Window {
  nowadaysDesk?: { chooseSkillDirectory: () => Promise<string | null> };
}
