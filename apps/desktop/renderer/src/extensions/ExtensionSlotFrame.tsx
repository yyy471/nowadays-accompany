import { useEffect, useRef, useState } from 'react';
import { useThemePreset } from '../ui/presets';
import { sendTheme, slotCommand } from './slot-bridge';

export interface Slot { slot: string; file: string }
export interface Extension {
  extId: string; version: string; status: string; ui: Slot[];
  lastError: { message: string } | null;
}

export function ExtensionSlotFrame({ extension, entry, dismiss }: { extension: Extension; entry: Slot; dismiss?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { preset } = useThemePreset();
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    sendTheme(element, preset);
    function receive(event: MessageEvent) {
      const command = slotCommand(element?.contentWindow ?? null, event);
      if (command?.type === 'ext:ready' && element) sendTheme(element, preset);
      if (command?.type === 'ext:resize') setHeight(command.height);
      if (command?.type === 'ext:dismiss') dismiss?.();
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [preset, dismiss]);
  return <iframe ref={frame} title={extension.extId + ' · ' + entry.file} data-extension-slot={entry.slot}
    sandbox="allow-scripts" tabIndex={entry.slot === 'overlay' ? -1 : undefined}
    src={`nd-ext://${extension.extId}/${entry.file}?v=${encodeURIComponent(extension.version)}`}
    style={height === undefined ? undefined : { height }} onLoad={() => frame.current && sendTheme(frame.current, preset)}/>;
}
