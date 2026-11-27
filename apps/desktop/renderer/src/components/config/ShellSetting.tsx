import { Switch } from '../../ui/switch';

export function ShellSetting({ allowShell, disabled, save }: {
  allowShell?: boolean; disabled: boolean; save: (patch: { allowShell: boolean }) => void;
}) {
  return <section className="nd-usage-section" aria-label="本机 Shell 权限">
    <Switch label="允许 Pi 使用完整本机 Shell（高风险）" checked={allowShell ?? false} disabled={disabled}
      aria-describedby="engineering-shell-caption" onCheckedChange={value => save({ allowShell: value })}/>
    <p id="engineering-shell-caption" className="nd-usage-caption">关闭时，Pi 的本机工具仅可读写草稿目录，并使用受控的 draft_test。开启后，Pi 获得当前账户权限的本机 Shell，可访问个人文件、修改文件与运行系统命令。变更仅影响新工程。</p>
  </section>;
}
