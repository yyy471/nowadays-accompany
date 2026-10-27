import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { UiThemeProvider } from './appearance';
import { createThemeTransition } from './theme-transition';
import { ThemeWeather } from './theme-weather';
import './theme-transition.css';

export type ThemePreset = 'daylight' | 'nightwave';
const STORAGE_KEY = 'nowadays.theme-preset.v1';
const PresetContext = createContext<{ preset: ThemePreset; select: (preset: ThemePreset) => void }>({ preset: 'daylight', select() {} });

/** 只保存本机外观偏好，不写账号配置，不发送业务请求。 */
export function readThemePreset(): ThemePreset {
  try { return window.localStorage.getItem(STORAGE_KEY) === 'nightwave' ? 'nightwave' : 'daylight'; }
  catch { return 'daylight'; }
}

export function ThemePresetProvider({ children }: { children: ReactNode }) {
  const [preset, setPreset] = useState<ThemePreset>(readThemePreset);
  const [weather, setWeather] = useState<ThemePreset>();
  const transition = useRef<ReturnType<typeof createThemeTransition> | undefined>(undefined);
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
    });
    transition.current = controller;
    return () => { controller.dispose(); transition.current = undefined; };
  }, []);
  const select = useCallback((next: ThemePreset) => transition.current?.select(next), []);
  return <PresetContext.Provider value={{ preset, select }}><UiThemeProvider theme="xiacheng" preset={preset}>{children}{weather && <ThemeWeather preset={weather}/>}</UiThemeProvider></PresetContext.Provider>;
}

export function useThemePreset() { return useContext(PresetContext); }
