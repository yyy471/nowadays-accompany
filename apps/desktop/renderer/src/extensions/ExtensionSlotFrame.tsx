import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useThemePreset } from '../ui/presets';
import { bindSlotBridge, sendTheme, type SlotControl } from './slot-bridge';

export interface Slot { slot: string; file: string }
export interface Extension {
  extId: string; version: string; status: string; ui: Slot[];
  lastError: { message: string } | null;
}

export function ExtensionSlotFrame({ extension, entry, dismiss }: { extension: Extension; entry: Slot; dismiss?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { preset } = useThemePreset();
  const [height, setHeight] = useState<number>();
  const control = useEffectEvent((command: SlotControl) => {
    if (command.type === 'ext:ready' && frame.current) sendTheme(frame.current, preset);
    if (command.type === 'ext:resize') setHeight(command.height);
    if (command.type === 'ext:dismiss') dismiss?.();
  });
  useLayoutEffect(() => {
    const element = frame.current;
    if (element) return bindSlotBridge(element, extension.extId, extension.version, control);
  }, [extension.extId, extension.version, entry.file]);
  useEffect(() => { if (frame.current) sendTheme(frame.current, preset); }, [preset]);
  return <iframe ref={frame} title={extension.extId + ' · ' + entry.file} data-extension-slot={entry.slot}
    sandbox="allow-scripts" tabIndex={entry.slot === 'overlay' ? -1 : undefined}
    src={`nd-ext://${extension.extId}/${entry.file}?v=${encodeURIComponent(extension.version)}`}
    style={height === undefined ? undefined : { height }} onLoad={() => frame.current && sendTheme(frame.current, preset)}/>;
}
