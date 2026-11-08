import { ControlButton } from '../../ui';
import { useThemePreset, type ThemePreset } from '../../ui/presets';

/** 昼夜主题为外观切换，不承担账号或页面导航职责。 */
export function ThemeSwitcher({ disabled = false }: { disabled?: boolean }) {
  const { preset, select } = useThemePreset();
  const choices: ReadonlyArray<{ id: ThemePreset; label: string }> = [{ id: 'daylight', label: '白昼来信' }, { id: 'nightwave', label: '晚风电台' }];
  return <div className="ui-theme-switcher" role="group" aria-label="昼夜主题">
    {choices.map(choice => <ControlButton key={choice.id} aria-pressed={preset === choice.id} disabled={disabled} onClick={() => select(choice.id)}>
      <span className={`ui-theme-symbol is-${choice.id}`} aria-hidden="true">{choice.id === 'daylight' ? '☀' : '☾'}</span><span>{choice.label}</span>
    </ControlButton>)}
  </div>;
}
