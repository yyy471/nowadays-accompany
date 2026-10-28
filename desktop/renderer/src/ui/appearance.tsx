import { createContext, useContext, type ReactNode } from 'react';

export type UiAppearance = { theme?: 'xiacheng'; motion?: 'reduced' | 'full'; preset?: 'daylight' | 'nightwave' };
const AppearanceContext = createContext<UiAppearance>({});

/** reduced是不可解除的下限：祖先或当前任一reduced都优先于后代full。 */
function mergeMotion(inherited: UiAppearance['motion'], local: UiAppearance['motion']): UiAppearance['motion'] {
  if (inherited === 'reduced' || local === 'reduced') return 'reduced';
  return local ?? inherited;
}

/** Internal context bridge for portals and queued requests; adds no DOM scope. */
export function UiAppearanceProvider({ value, children }: { value: UiAppearance; children: ReactNode }) {
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

/** Context only: lets the app controller own themed confirmations without restyling legacy DOM. */
export function UiThemeProvider({ theme, motion, preset, children }: UiAppearance & { children: ReactNode }) {
  const inherited = useContext(AppearanceContext);
  return <AppearanceContext.Provider value={{ theme, motion: mergeMotion(inherited.motion, motion), preset: preset ?? inherited.preset }}>{children}</AppearanceContext.Provider>;
}

/** Opt-in appearance: legacy pages keep their existing theme and behavior. */
export function UiThemeScope({ theme, motion, preset, children, className = '' }: UiAppearance & { theme: 'xiacheng'; children: ReactNode; className?: string }) {
  const inherited = useContext(AppearanceContext);
  const selected = preset ?? inherited.preset;
  const selectedMotion = mergeMotion(inherited.motion, motion);
  return <AppearanceContext.Provider value={{ theme, motion: selectedMotion, preset: selected }}>
    <div data-ui-theme={theme} data-motion={selectedMotion} data-ui-preset={selected} className={`ui-theme-scope ${className}`}>{children}</div>
  </AppearanceContext.Provider>;
}

export function useUiAppearance(): UiAppearance { return useContext(AppearanceContext); }
