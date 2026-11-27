import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useThemePreset } from '../ui/presets';
import { bindSlotBridge, sendTheme, type SlotControl } from './slot-bridge';
import type { ExtensionTool } from './tool-scope';
import { Button, Select } from '../ui';
import { RoleFace, type RoleFaceImage } from '../components/RoleFace';
import type { RoleListItem } from '../types';
import { coplayControls, type CoplayAction } from './coplay-controls';

export interface Slot { slot: string; file: string; coplay?: CoplayAction[] }
export interface Extension {
  extId: string; version: string; status: string; ui: Slot[]; tools: ExtensionTool[];
  lastError: { code?: string; message: string } | null;
}

type Bridge = ReturnType<typeof bindSlotBridge>;

function PlayButton({ text, play, disabled }: { text: string; disabled: boolean; play: (event: MouseEvent) => ReturnType<Bridge['play']> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <span className="extension-play-action"><Button size="sm" busy={busy} disabled={disabled}
    onClick={async event => {
      if (!event.nativeEvent.isTrusted || busy) return;
      setError('');
      setBusy(true);
      try {
        const result = await play(event.nativeEvent);
        if (result && !result.ok) setError('本次共玩未成功 · ' + result.error);
      } finally { setBusy(false); }
    }}>{text}</Button>{error && <small role="alert">{error}</small>}</span>;
}

export function ExtensionSlotFrame({ extension, entry, roles, image, onFrameFocus, dismiss }: { extension: Extension; entry: Slot; roles: RoleListItem[]; image?: RoleFaceImage; onFrameFocus?: () => void; dismiss?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof bindSlotBridge> | null>(null);
  const [documentId, setDocumentId] = useState(0);
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
  const reportFocus = useEffectEvent(() => onFrameFocus?.());
  useEffect(() => {
    if (!onFrameFocus) return;
    let raf = 0;
    const blur = () => { raf = requestAnimationFrame(() => { if (document.activeElement === frame.current) reportFocus(); }); };
    window.addEventListener('blur', blur);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('blur', blur); };
  }, [!!onFrameFocus]);
  const iframe = <iframe ref={frame} title={extension.extId + ' · ' + entry.file} data-extension-slot={entry.slot}
    sandbox="allow-scripts" tabIndex={entry.slot === 'overlay' ? -1 : undefined}
    src={`nd-ext://${extension.extId}/${entry.file}?v=${encodeURIComponent(extension.version)}`}
    style={height === undefined ? undefined : { height }} onLoad={() => { setDocumentId(value => value + 1); if (frame.current) sendTheme(frame.current, preset); }}/>;
  if (!controls) return iframe;
  const { choices, target, buttons } = controls;
  return <div className="extension-coplay">
    <div className="extension-coplay-bar">
      <span>一起玩的角色</span><RoleFace name={target?.displayName ?? ''} image={image?.roleId === target?.roleId ? image : undefined}/>
      <Select aria-label="一起玩的角色" value={target?.roleId ?? ''} onChange={event => setSelected(event.target.value)}>
        {!target && <option value="">选择角色</option>}
        {choices.map(role => <option key={role.roleId} value={role.roleId}>{role.displayName}</option>)}
      </Select>
      {buttons.map(({ action, text }) => <PlayButton key={JSON.stringify([documentId, action, target?.roleId])} disabled={!target} text={text}
        play={event => target && bridge.current?.play(event, entry.slot, entry.file, action, target.roleId)}/>)}
    </div>
    {iframe}
  </div>;
}
