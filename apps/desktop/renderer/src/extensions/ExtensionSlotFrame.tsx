import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useThemePreset } from '../ui/presets';
import { bindSlotBridge, sendTheme, type SlotControl } from './slot-bridge';
import type { ExtensionTool } from './tool-scope';
import { Button, Select } from '../ui';
import type { RoleListItem } from '../types';
import { coplayControls, type CoplayAction } from './coplay-controls';

export interface Slot { slot: string; file: string; coplay?: CoplayAction[] }
export interface Extension {
  extId: string; version: string; status: string; ui: Slot[]; tools: ExtensionTool[];
  lastError: { code?: string; message: string } | null;
}

export function ExtensionSlotFrame({ extension, entry, roles, dismiss }: { extension: Extension; entry: Slot; roles: RoleListItem[]; dismiss?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof bindSlotBridge> | null>(null);
  const [selected, setSelected] = useState('');
  const controls = coplayControls(entry.coplay, roles, selected);
  const { preset } = useThemePreset();
  const [height, setHeight] = useState<number>();
  const control = useEffectEvent((command: SlotControl) => {
    if (command.type === 'ext:ready' && frame.current) sendTheme(frame.current, preset);
    if (command.type === 'ext:resize') setHeight(command.height);
    if (command.type === 'ext:dismiss') dismiss?.();
  });
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const binding = bindSlotBridge(element, extension.extId, extension.version, control);
    bridge.current = binding;
    return () => { binding.dispose(); bridge.current = null; };
  }, [extension.extId, extension.version, entry.file]);
  useEffect(() => { if (frame.current) sendTheme(frame.current, preset); }, [preset]);
  const iframe = <iframe ref={frame} title={extension.extId + ' · ' + entry.file} data-extension-slot={entry.slot}
    sandbox="allow-scripts" tabIndex={entry.slot === 'overlay' ? -1 : undefined}
    src={`nd-ext://${extension.extId}/${entry.file}?v=${encodeURIComponent(extension.version)}`}
    style={height === undefined ? undefined : { height }} onLoad={() => frame.current && sendTheme(frame.current, preset)}/>;
  if (!controls) return iframe;
  const { choices, target, buttons } = controls;
  return <div className="extension-coplay">
    <div className="extension-coplay-bar">
      <Select aria-label="陪玩角色" value={target?.roleId ?? ''} onChange={event => setSelected(event.target.value)}>
        {!target && <option value="">选择陪玩角色</option>}
        {choices.map(role => <option key={role.roleId} value={role.roleId}>{role.displayName}</option>)}
      </Select>
      {buttons.map(({ action, text }) => <Button key={action} size="sm" disabled={!target}
        onClick={event => target && void bridge.current?.play(event.nativeEvent, entry.slot, entry.file, action, target.roleId)}>{text}</Button>)}
    </div>
    {iframe}
  </div>;
}
