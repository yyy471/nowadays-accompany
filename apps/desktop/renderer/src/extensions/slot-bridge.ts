import { api, ApiError } from '../api';

function validPayload(payload: unknown) {
  // postMessage 也可传 Map、循环引用等，提前拒绝会被 JSON 序列化丢弃或改写的值。
  const limit = 16 * 1024;
  let remaining = limit;
  try {
    const json = JSON.stringify(payload, function (key, value) {
      const raw = this[key];
      remaining -= (Array.isArray(this) ? 0 : key.length) + (typeof raw === 'string' ? raw.length + 1 : 1);
      if (remaining < 0 || raw === undefined || typeof raw === 'bigint' || typeof raw === 'function' || typeof raw === 'symbol' ||
          (typeof raw === 'number' && !Number.isFinite(raw)) ||
          (raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
            Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) {
        throw Error('INVALID_PAYLOAD');
      }
      return value;
    });
    return new TextEncoder().encode(json).length <= limit;
  } catch { return false; }
}

export function slotCommand(expected: Window | null, event: MessageEvent) {
  if (!expected || event.source !== expected) return;
  const message = event.data;
  if (message?.type === 'ext:action' && typeof message.id === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(message.id) &&
      typeof message.action === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(message.action) && validPayload(message.payload)) {
    return { type: 'ext:action' as const, id: message.id, action: message.action, payload: message.payload as unknown };
  }
  if (message?.type === 'ext:ready' || message?.type === 'ext:dismiss') return { type: message.type as 'ext:ready' | 'ext:dismiss' };
  if (message?.type === 'ext:resize' && Number.isFinite(message.height)) {
    return { type: 'ext:resize' as const, height: Math.max(48, Math.min(640, Math.round(message.height))) };
  }
}

type Command = NonNullable<ReturnType<typeof slotCommand>>;
export type SlotControl = Exclude<Command, {type: 'ext:action'}>;
type RequestAction = (path: string, options: {method: string; body: object}) => Promise<{data: unknown}>;

export function bindSlotBridge(frame: HTMLIFrameElement, extId: string, version: string,
  control: (command: SlotControl) => void, request: RequestAction = api) {
  const parent = frame.ownerDocument.defaultView!;
  let generation = 0;
  const navigated = () => { generation++; };
  function receive(event: MessageEvent) {
    const target = frame.contentWindow;
    const command = slotCommand(target, event);
    if (!command || !frame.isConnected || !target) return;
    if (command.type !== 'ext:action') { control(command); return; }
    // 子页消息只投影普通动作字段；共玩参数只能由宿主按钮构造。
    void dispatch({ action: command.action, payload: command.payload }, { type: 'host:action-result', id: command.id });
  }
  async function dispatch(body: object, envelope: object) {
    const target = frame.contentWindow;
    if (!frame.isConnected || !target) return;
    // 跨文档导航会复用 WindowProxy，每次 load 单独标记当前文档。
    const started = generation;
    let result;
    try {
      const { data } = await request('/v1/extensions/' + extId + '/ui-action', {
        method: 'POST', body: { version, ...body }
      });
      result = { ...envelope, ok: true, data };
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      result = { ...envelope, ok: false, error: code ?? 'EXTENSION_UI_ACTION_FAILED' };
    }
    if (started === generation && frame.isConnected && frame.contentWindow === target)
      target.postMessage(result, '*');
  }
  frame.addEventListener('load', navigated);
  parent.addEventListener('message', receive);
  return {
    play(event: MouseEvent, slot: string, file: string, action: string, roleId: string) {
      if (event.isTrusted) return dispatch({ slot, file, action, roleId, coplay: true, payload: null },
        { type: 'ext:coplay-result', action });
    },
    dispose() {
      generation++;
      frame.removeEventListener('load', navigated);
      parent.removeEventListener('message', receive);
    }
  };
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
