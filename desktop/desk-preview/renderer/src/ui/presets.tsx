import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { UiThemeProvider } from './appearance';
import { createThemeTransition, type ThemeTransitionStrategy } from './theme-transition';
import { ThemeWeather } from './theme-weather';
import './theme-transition.css';

export type ThemePreset = 'daylight' | 'nightwave';
const STORAGE_KEY = 'nowadays.theme-preset.v1';
type PresetContextValue = {
  preset: ThemePreset;
  select: (preset: ThemePreset) => void;
  registerTransitionStrategy: (strategy: ThemeTransitionStrategy) => () => void;
};
const PresetContext = createContext<PresetContextValue>({ preset: 'daylight', select() {}, registerTransitionStrategy: () => () => {} });

/** 只保存本机外观偏好，不写账号配置，不发送业务请求。 */
export function readThemePreset(): ThemePreset {
  try { return window.localStorage.getItem(STORAGE_KEY) === 'nightwave' ? 'nightwave' : 'daylight'; }
  catch { return 'daylight'; }
}

export function ThemePresetProvider({ children }: { children: ReactNode }) {
  const [preset, setPreset] = useState<ThemePreset>(readThemePreset);
  const [weather, setWeather] = useState<ThemePreset>();
  const transition = useRef<ReturnType<typeof createThemeTransition> | undefined>(undefined);
  const strategy = useRef<ThemeTransitionStrategy | undefined>(undefined);
  useLayoutEffect(() => {
    document.documentElement.dataset.uiPreset = preset;
    // 在实际提交新预置时同步原生窗口，冷启动恢复的主题也走同一条路径。
    const bridge = window.nowadays ?? window.accompany;
    if (bridge?.setWindowTheme) void bridge.setWindowTheme(preset).catch(() => undefined);
    return () => { delete document.documentElement.dataset.uiPreset; };
  }, [preset]);
  useEffect(() => {
    const controller = createThemeTransition(readThemePreset(), (next, decoration) => {
      flushSync(() => { setPreset(next); setWeather(decoration); });
    }, strategy.current);
    transition.current = controller;
    return () => { controller.dispose(); transition.current = undefined; };
  }, []);
  const select = useCallback((next: ThemePreset) => transition.current?.select(next), []);
  const registerTransitionStrategy = useCallback((next: ThemeTransitionStrategy) => {
    strategy.current = next;
    transition.current?.setStrategy(next);
    return () => {
      if (strategy.current !== next) return;
      strategy.current = undefined;
      transition.current?.setStrategy(undefined);
    };
  }, []);
  return <PresetContext.Provider value={{ preset, select, registerTransitionStrategy }}><UiThemeProvider theme="xiacheng" preset={preset}>{children}{weather && <ThemeWeather preset={weather}/>}</UiThemeProvider></PresetContext.Provider>;
}

export function useThemePreset() { return useContext(PresetContext); }

/** 页面在自身生命周期内注册外观策略，不增加主题状态或业务副作用。 */
export function useThemeTransitionStrategy(strategy: ThemeTransitionStrategy) {
  const register = useContext(PresetContext).registerTransitionStrategy;
  useLayoutEffect(() => register(strategy), [register, strategy]);
}
