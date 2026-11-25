export function slotCommand(expected: Window | null, event: MessageEvent) {
  if (!expected || event.source !== expected) return;
  const message = event.data;
  if (message?.type === 'ext:ready' || message?.type === 'ext:dismiss') return { type: message.type as 'ext:ready' | 'ext:dismiss' };
  if (message?.type === 'ext:resize' && Number.isFinite(message.height)) {
    return { type: 'ext:resize' as const, height: Math.max(48, Math.min(640, Math.round(message.height))) };
  }
}

export function sendTheme(frame: HTMLIFrameElement, preset: string) {
  const style = getComputedStyle(frame);
  const tokens: Record<string, string> = {};
  for (const name of style) {
    if (name.startsWith('--nd-semantic-')) tokens[name] = style.getPropertyValue(name).trim();
  }
  // allow-scripts 沙箱使用不透明来源，发送目标始终限定在当前元素的子窗口。
  frame.contentWindow?.postMessage({ type: 'host:theme', preset, tokens }, '*');
}
