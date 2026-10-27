import { createPortal } from 'react-dom';
import type { ThemePreset } from './presets';

/** 独立命名快照让树叶越过换景边缘，装饰不进入焦点或接管鼠标。 */
export function ThemeWeather({ preset }: { preset: ThemePreset }) {
  return createPortal(<div className="ui-theme-weather" data-ui-palette="xiacheng" data-ui-preset={preset} aria-hidden="true">
    {preset === 'nightwave' ? [1, 2, 3].map(index => <svg key={index} className={`ui-theme-leaf ui-theme-leaf-${index}`} viewBox="0 0 48 72" fill="none">
      <path d="M25 4C18 12 3 19 6 38c2 14 14 18 17 29 3-12 20-19 19-35C41 17 28 13 25 4Z" fill="currentColor"/>
      <path d="M24 63c-4-19-1-35 1-51M23 42l-9-9m10 0 9-10M23 51l11-11" stroke="var(--nd-semantic-color-canvas)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>) : <div className="ui-theme-dawn"/>}
  </div>, document.body);
}
