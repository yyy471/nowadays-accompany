import { useLayoutEffect } from 'react';
import { useThemePreset, useThemeTransitionStrategy } from './presets';
import { featherThemeTransition } from './theme-feather';
import { announceLive } from './live-announcer';
import type { ThemeTransitionStrategy } from './theme-transition';

const configThemeTransition: ThemeTransitionStrategy = request => featherThemeTransition(request);
configThemeTransition.queueChanges = true;
configThemeTransition.onSettled = preset => announceLive(`已切换到${preset === 'nightwave' ? '夜间' : '日间'}`);

/** 只在两个配置页可见时接管主题，其他页面保留各自策略。 */
export function ConfigThemeTransition() {
  useThemeTransitionStrategy(configThemeTransition);
  const { preset, requestedPreset } = useThemePreset();
  useLayoutEffect(() => {
    document.querySelectorAll<HTMLElement>('.config-theme-veil [data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === requestedPreset));
    });
  }, [preset, requestedPreset]);
  return null;
}
