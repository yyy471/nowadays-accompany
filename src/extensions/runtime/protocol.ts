import type { ChatKind } from '../../routing/identity.js';
import type { PluginHookName } from '../contracts.js';
import type { ToolHandlerOutcome } from '../execution/executor.js';

export const PLUGIN_PROTOCOL_VERSION = 1 as const;

/** Every task request carries the state snapshot, so these bounds must stay mutually satisfiable. */
export const PLUGIN_RUNTIME_LIMITS = {
  maxRequestBytes: 64 * 1024,
  maxStateBytes: 16 * 1024,
  maxConfigBytes: 8 * 1024,
  maxMessageBytes: 8 * 1024,
  maxHistoryItems: 20,
  maxHistoryBytes: 16 * 1024,
  maxAdditions: 8,
  maxAdditionSource: 200,
  maxAdditionBytes: 4_096,
  maxHookResultBytes: 12 * 1024,
  maxResponseTextBytes: 8 * 1024,
  maxErrorText: 200
} as const;

export interface PluginScopeToken {
  kind: ChatKind;
  peerId: string;
  /** Opaque role-history epoch supplied by AccountService. */
  contextEpoch: string;
  accountShared: boolean;
}

export interface PluginMessageSnapshot {
  text: string;
  senderId?: string;
  at?: boolean;
}

export interface PluginHistorySnapshot {
  direction: 'in' | 'out';
  text: string;
}

export interface PluginExecutionContext {
  accountId: string;
  conversation: { kind: ChatKind; peerId: string };
  scope: PluginScopeToken;
  turnId: string;
  message?: PluginMessageSnapshot;
  history: PluginHistorySnapshot[];
  config: Record<string, unknown>;
}

export interface PluginAfterTurnContext extends Omit<PluginExecutionContext, 'message'> {
  outcome: 'sent' | 'suppressed' | 'failed';
  replyText?: string;
  errorCode?: string;
}

export interface PluginToolExecutionContext {
  accountId: string;
  conversation: { kind: ChatKind; peerId: string };
  scope: PluginScopeToken;
  invocationId: string;
  config: Record<string, unknown>;
}

export interface PluginBeforeContextResult {
  additions: Array<{ source: string; text: string }>;
}

export type PluginTaskRequest =
  | {
    type: 'beforeContext';
    id: number;
    timeoutMs: number;
      deadlineAt: number;
    scopeToken: string;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
    context: PluginExecutionContext;
    state: Record<string, unknown>;
  }
  | {
    type: 'afterTurn';
    id: number;
    timeoutMs: number;
      deadlineAt: number;
    scopeToken: string;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
    context: PluginAfterTurnContext;
    state: Record<string, unknown>;
  }
  | {
    type: 'tool';
    id: number;
    timeoutMs: number;
      deadlineAt: number;
    scopeToken: string;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
    toolId: string;
    declaredToolId: string;
    invocationId: string;
    args: Record<string, unknown>;
    context: PluginToolExecutionContext;
    state: Record<string, unknown>;
  }
  | {
    type: 'stop';
    id: number;
    timeoutMs: number;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
  };

export interface PluginHandshake {
  type: 'handshake';
  protocolVersion: 1;
  accountId: string;
  pluginKey: string;
  runtimeGeneration: string;
  tools: string[];
  hooks: PluginHookName[];
  error?: string;
}

export type PluginResponse =
  | {
    type: 'response';
    id: number;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
    scopeToken: string;
    task: 'beforeContext';
    errorCode?: string;
    result: PluginBeforeContextResult;
    state: Record<string, unknown>;
    error?: string;
  }
  | {
    type: 'response';
    id: number;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
    scopeToken: string;
    task: 'afterTurn';
    errorCode?: string;
    state: Record<string, unknown>;
    error?: string;
  }
  | {
    type: 'response';
    id: number;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
    scopeToken: string;
    task: 'tool';
    errorCode?: string;
    result: ToolHandlerOutcome;
    state: Record<string, unknown>;
    error?: string;
  }
  | {
    type: 'response';
    id: number;
    protocolVersion: 1;
    accountId: string;
    pluginKey: string;
    runtimeGeneration: string;
    task: 'stop';
    errorCode?: string;
    error?: string;
  };

export type PluginTaskResponse = PluginResponse | {
  type: 'init_error';
  protocolVersion: 1;
  accountId: string;
  pluginKey: string;
  runtimeGeneration: string;
  error: string;
  errorCode?: string;
};

export function pluginScopeTokenString(scope: PluginScopeToken): string {
  return scope.accountShared ? 'account' : JSON.stringify([scope.kind, scope.peerId, scope.contextEpoch]);
}

export function pluginWorkerSource(): string {
  return String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');

let mod;
let toolNames = [];
let hookNames = [];
let generationFailed = false;
const activeTasks = new Map();

const HOOK_NAMES = ['beforeContext', 'afterTurn', 'init', 'dispose'];

function moduleValue() {
  if (!mod) return undefined;
  const defaultExport = mod.default;
  const named = mod;
  if (defaultExport && typeof defaultExport === 'object') {
    const merged = { ...defaultExport, tools: defaultExport.tools ?? named.tools };
    for (const key of HOOK_NAMES) {
      if (typeof named[key] === 'function' && typeof merged[key] !== 'function') merged[key] = named[key];
    }
    return merged;
  }
  return named;
}

function callable(value) {
  return typeof value === 'function' ? value : undefined;
}

function toolHandler(toolId) {
  const value = moduleValue();
  const declared = callable(value && value.tools ? value.tools[toolId] : undefined);
  if (declared) return declared;
  return HOOK_NAMES.indexOf(toolId) >= 0 ? undefined : callable(value && value[toolId]);
}

function hookHandler(name) {
  const value = moduleValue();
  const direct = callable(value && value[name]);
  if (direct) return direct;
  const hooks = value && value.hooks;
  if (hooks && typeof hooks === 'object') return callable(hooks[name]);
}

function withTimeout(task, ms, controller) {
  const signal = controller.signal;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const reason = new Error('plugin handler timed out after ' + ms + 'ms');
      reason.code = 'plugin_handler_timeout';
      if (!signal.aborted) controller.abort(reason);
      reject(reason);
    }, ms);
    timer.unref && timer.unref();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(task).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function plainState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeAdditions(value) {
  const additions = value && Array.isArray(value.additions) ? value.additions : [];
  return additions.slice(0, workerData.limits.maxAdditions).map((entry) => ({
    source: typeof entry.source === 'string' ? entry.source.slice(0, workerData.limits.maxAdditionSource) : 'plugin',
    text: typeof entry.text === 'string' ? entry.text.slice(0, workerData.limits.maxAdditionBytes) : ''
  })).filter((entry) => entry.text);
}

async function initialize() {
  mod = await import(pathToFileURL(workerData.entry).href);
  toolNames = workerData.declarations.tools.filter((entry) => typeof toolHandler(entry.id) === 'function').map((entry) => entry.id);
  hookNames = workerData.declarations.hooks.filter((entry) => typeof hookHandler(entry.name) === 'function').map((entry) => entry.name);
  const controller = new AbortController();
  const init = hookHandler('init') || (moduleValue() && moduleValue().init);
  if (typeof init === 'function') {
    await withTimeout(() => init({
      accountId: workerData.accountId,
      pluginKey: workerData.pluginKey,
      config: workerData.config,
      declarations: workerData.declarations
    }), workerData.limits.initTimeoutMs, controller);
  }
  parentPort.postMessage({
    type: 'handshake',
    protocolVersion: 1,
    accountId: workerData.accountId,
    pluginKey: workerData.pluginKey,
    runtimeGeneration: workerData.runtimeGeneration,
    tools: toolNames,
    hooks: hookNames
  });
}

async function runTask(msg, state, controller, timeoutMs) {
  const shared = { ...msg.context, accountId: msg.accountId, state, signal: controller.signal, config: msg.context.config };
  if (msg.type === 'beforeContext') {
    if (hookNames.indexOf('beforeContext') < 0) return { additions: [] };
    const value = await withTimeout(() => hookHandler('beforeContext')({
      ...shared,
      config: workerData.config,
      message: msg.context.message,
      history: msg.context.history,
      turnId: msg.context.turnId
    }), timeoutMs, controller);
    return { additions: normalizeAdditions(value) };
  }
  if (msg.type === 'afterTurn') {
    if (hookNames.indexOf('afterTurn') < 0) return undefined;
    await withTimeout(() => hookHandler('afterTurn')({
      ...shared,
      config: workerData.config,
      outcome: msg.context.outcome,
      replyText: msg.context.replyText,
      errorCode: msg.context.errorCode
    }), timeoutMs, controller);
    return undefined;
  }
  if (msg.type === 'stop') {
    const dispose = hookHandler('dispose') || (moduleValue() && moduleValue().dispose);
    if (typeof dispose === 'function') {
      await withTimeout(() => dispose({
        accountId: workerData.accountId,
        pluginKey: workerData.pluginKey,
        config: workerData.config
      }), workerData.limits.disposeTimeoutMs, controller);
    }
    return undefined;
  }
  if (msg.type === 'tool') {
    const handler = toolNames.indexOf(msg.declaredToolId) >= 0 ? toolHandler(msg.declaredToolId) : undefined;
    if (!handler) throw new Error('handler_not_ready');
    const value = await withTimeout(() => handler(msg.args, {
      ...shared,
      invocationId: msg.invocationId
    }), timeoutMs, controller);
    return value;
  }
  throw new Error('unsupported plugin task');
}

let queue = Promise.resolve();

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object' || msg.type === 'handshake') return;
  if (msg.type === 'cancel') {
    const controller = activeTasks.get(msg.id);
    if (controller && !controller.signal.aborted) controller.abort(new Error('plugin task cancelled'));
    return;
  }
  if (generationFailed) return;
  queue = queue.then(async () => {
    if (generationFailed) return;
    let result;
    const state = plainState(msg.state);
    let error;
    let errorCode;
    const controller = new AbortController();
    activeTasks.set(msg.id, controller);
    try {
      const remaining = Number.isFinite(msg.deadlineAt) ? msg.deadlineAt - Date.now() : msg.timeoutMs;
      const timeoutMs = Math.min(msg.timeoutMs, remaining);
      if (msg.type !== 'stop' && timeoutMs <= 0) {
        const timeoutError = new Error('plugin task deadline elapsed before execution');
        timeoutError.code = 'plugin_handler_timeout';
        throw timeoutError;
      }
      result = await runTask(msg, state, controller, timeoutMs);
    } catch (caught) {
      error = String(caught && caught.message || caught).slice(0, 300);
      errorCode = typeof caught?.code === 'string' ? caught.code : undefined;
      if (errorCode === 'plugin_handler_timeout') generationFailed = true;
    } finally {
      activeTasks.delete(msg.id);
    }
    if (msg.type === 'stop') {
      parentPort.postMessage({
        type: 'response', id: msg.id, protocolVersion: 1, accountId: msg.accountId,
        pluginKey: msg.pluginKey, runtimeGeneration: msg.runtimeGeneration, task: 'stop', error, errorCode
      });
      return;
    }
    const response = {
      type: 'response', id: msg.id, protocolVersion: 1, accountId: msg.accountId,
      pluginKey: msg.pluginKey, runtimeGeneration: msg.runtimeGeneration, scopeToken: msg.scopeToken,
      state: plainState(state), error, errorCode
    };
    if (msg.type === 'beforeContext') Object.assign(response, { task: 'beforeContext', result: result || { additions: [] } });
    else if (msg.type === 'afterTurn') Object.assign(response, { task: 'afterTurn' });
    else Object.assign(response, { task: 'tool', result: result });
    parentPort.postMessage(response);
  }).catch(() => {});
});

initialize().catch((error) => {
  generationFailed = true;
  parentPort.postMessage({
    type: 'init_error',
    protocolVersion: 1,
    accountId: workerData.accountId,
    pluginKey: workerData.pluginKey,
    runtimeGeneration: workerData.runtimeGeneration,
    error: String(error && error.message || error).slice(0, 300),
    errorCode: typeof error?.code === 'string' ? error.code : undefined
  });
});
`;
}
