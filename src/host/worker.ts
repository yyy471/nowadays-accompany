import { Worker } from 'node:worker_threads';
import type { ResolvedProfile } from '../artifacts/types.js';
import type { Logger } from '../core/logger.js';
import type { OutboundMessage } from '../routing/message.js';
import type { AgentHost, AgentMessageContext, AgentSessionContext } from './contract.js';

export interface WorkerHostOptions {
  accountId: string;
  profile: ResolvedProfile;
  logger: Logger;
  historyLimit?: number;
  pluginTimeoutMs?: number;
}

interface WorkerResult {
  reply?: OutboundMessage;
  sends?: OutboundMessage[];
  state: Record<string, Record<string, unknown>>;
  errors?: string[];
}

interface Pending {
  resolve: (value: WorkerResult) => void;
  reject: (error: unknown) => void;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');

const plugins = [];
function snapshot() {
  const state = {};
  for (const plugin of plugins) state[plugin.stateKey] = plugin.state ?? {};
  return state;
}
function toMessage(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return { segments: [{ type: 'text', data: { text: value } }] };
  if (Array.isArray(value.segments)) return { segments: value.segments };
  return undefined;
}
function withTimeout(task, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('plugin timed out after ' + ms + 'ms')), ms);
    Promise.resolve()
      .then(task)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

async function init() {
  for (const plugin of workerData.plugins) {
    const mod = await import(pathToFileURL(plugin.entry).href);
    plugins.push({ id: plugin.id, stateKey: plugin.stateKey, mod, config: plugin.config ?? {}, state: workerData.state[plugin.stateKey] ?? {} });
  }
  for (const plugin of plugins) {
    if (typeof plugin.mod.onSessionStart === 'function') {
      await withTimeout(() => plugin.mod.onSessionStart({
        accountId: workerData.accountId,
        profile: workerData.profile,
        config: plugin.config,
        state: plugin.state
      }), workerData.pluginTimeoutMs);
    }
  }
  parentPort.postMessage({ type: 'ready', state: snapshot() });
}

async function handleMessage(msg) {
  const sends = [];
  const errors = [];
  let reply;
  for (const plugin of plugins) {
    if (typeof plugin.mod.onMessage !== 'function') continue;
    const context = {
      accountId: msg.payload.accountId,
      profile: msg.payload.profile || workerData.profile,
      roleBinding: msg.payload.roleBinding,
      conversation: msg.payload.conversation,
      message: msg.payload.message,
      history: msg.payload.history,
      config: plugin.config,
      resolvedConfig: msg.payload.config,
      state: plugin.state,
      send: (message) => {
        const normalized = toMessage(message);
        if (normalized) sends.push(normalized);
      }
    };
    try {
      const result = await withTimeout(() => plugin.mod.onMessage(context), workerData.pluginTimeoutMs);
      if (!result) continue;
      if (result.reply) reply = toMessage(result.reply) || reply;
      if (Array.isArray(result.sends)) {
        for (const item of result.sends) {
          const normalized = toMessage(item);
          if (normalized) sends.push(normalized);
        }
      }
      const direct = toMessage(result);
      if (direct) reply = direct;
    } catch (error) {
      errors.push('plugin ' + plugin.id + ': ' + String(error && error.message || error));
    }
  }
  parentPort.postMessage({ type: 'result', id: msg.id, reply, sends, state: snapshot(), errors });
}

async function handleStop(msg) {
  for (const plugin of plugins) {
    if (typeof plugin.mod.onSessionStop === 'function') {
      try {
        await withTimeout(() => plugin.mod.onSessionStop({
          accountId: workerData.accountId,
          profile: workerData.profile,
          config: plugin.config,
          state: plugin.state
        }), workerData.pluginTimeoutMs);
      } catch {}
    }
  }
  parentPort.postMessage({ type: 'stopped', id: msg.id, state: snapshot() });
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'stop') {
    handleStop(msg).catch((error) => parentPort.postMessage({ type: 'error', id: msg.id, error: String(error && error.message || error) }));
    return;
  }
  if (msg.type === 'message') {
    handleMessage(msg).catch((error) => parentPort.postMessage({ type: 'error', id: msg.id, error: String(error && error.message || error) }));
  }
});

init().catch((error) => parentPort.postMessage({ type: 'init_error', error: String(error && error.stack || error) }));
`;

/**
 * 每账号一个 worker，承载该账号的全部插件。
 * 主线程只做能力受限的转发：收发消息、读写历史与本插件状态；插件拿不到 bus/backend/token。
 */
export function createWorkerHost(options: WorkerHostOptions): AgentHost {
  const pluginTimeoutMs = options.pluginTimeoutMs ?? 30_000;
  const historyLimit = options.historyLimit ?? 50;
  let worker: Worker | undefined;
  let ready: Promise<void> | undefined;
  let requestSeq = 0;
  let stopping = false;
  const pending = new Map<number, Pending>();
  const states: Record<string, Record<string, unknown>> = {};
  let turnChain: Promise<unknown> = Promise.resolve();

  const failAll = (error: unknown): void => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };

  const stateKeyFor = (plugin: ResolvedProfile['plugins'][number]): string =>
    plugin.ref.source === 'public' ? plugin.ref.id : `${plugin.ref.source}~plugin~${plugin.ref.id}`;

  const start = async (context: AgentSessionContext): Promise<void> => {
    if (worker) return;
    for (const plugin of options.profile.plugins) {
      states[stateKeyFor(plugin)] = await context.state(stateKeyFor(plugin)).read();
    }
    const created = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        accountId: options.accountId,
        profile: options.profile,
        plugins: options.profile.plugins.map((plugin) => ({
          id: plugin.ref.id,
          stateKey: stateKeyFor(plugin),
          entry: plugin.entry,
          config: plugin.config
        })),
        state: states,
        pluginTimeoutMs
      }
    });
    worker = created;
    ready = new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown): void => {
        const payload = message as { type?: string; error?: string; state?: Record<string, Record<string, unknown>> };
        if (payload?.type === 'ready') {
          created.off('message', onMessage);
          if (payload.state) Object.assign(states, payload.state);
          resolve();
        } else if (payload?.type === 'init_error') {
          created.off('message', onMessage);
          reject(new Error(payload.error ?? 'plugin host init failed'));
        }
      };
      created.on('message', onMessage);
      created.once('error', reject);
      created.once('exit', (code) => {
        reject(new Error(`plugin host exited with code ${code}`));
      });
    });
    created.on('message', (message: unknown) => {
      const payload = message as {
        type?: string;
        id?: number;
        reply?: OutboundMessage;
        sends?: OutboundMessage[];
        state?: Record<string, Record<string, unknown>>;
        errors?: string[];
        error?: string;
      };
      if ((payload?.type === 'result' || payload?.type === 'stopped') && typeof payload.id === 'number') {
        const item = pending.get(payload.id);
        if (!item) return;
        pending.delete(payload.id);
        if (payload.state) Object.assign(states, payload.state);
        item.resolve({ ...(payload.reply ? { reply: payload.reply } : {}), ...(payload.sends ? { sends: payload.sends } : {}), state: states, ...(payload.errors ? { errors: payload.errors } : {}) });
        return;
      }
      if (payload?.type === 'error' && typeof payload.id === 'number') {
        const item = pending.get(payload.id);
        if (!item) return;
        pending.delete(payload.id);
        item.reject(new Error(payload.error ?? 'plugin host error'));
      }
    });
    created.on('error', (error) => {
      options.logger.warn('plugin host worker error', { message: error.message });
      failAll(error);
      worker = undefined;
      ready = undefined;
    });
    created.on('exit', (code) => {
      if (!stopping && code !== 0) options.logger.warn('plugin host worker exited', { code });
      failAll(new Error(`plugin host exited with code ${code}`));
      worker = undefined;
      ready = undefined;
    });
    try {
      await ready;
    } catch (error) {
      await terminate();
      throw error;
    }
    await persistStates(context);
  };

  const persistStates = async (context: AgentSessionContext): Promise<void> => {
    for (const plugin of options.profile.plugins) {
      const key = stateKeyFor(plugin);
      await context.state(key).write(states[key] ?? {});
    }
  };

  const terminate = async (): Promise<void> => {
    stopping = true;
    const active = worker;
    worker = undefined;
    ready = undefined;
    failAll(new Error('plugin host stopped'));
    if (active) await active.terminate().catch(() => {});
    stopping = false;
  };

  const request = (payload: Record<string, unknown>, timeoutMs: number): Promise<WorkerResult> => {
    if (!worker) return Promise.reject(new Error('plugin host is not running'));
    const id = ++requestSeq;
    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`plugin host request timed out after ${timeoutMs}ms`));
        void terminate();
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      worker?.postMessage({ ...payload, id });
    });
  };

  return {
    async onSessionStart(context) {
      await start(context);
    },

    async onMessage(context: AgentMessageContext) {
      const run = turnChain.catch(() => {}).then(async () => {
        if (!worker) await start(context);
        const history = await context.history({ limit: historyLimit });
        const result = await request(
          {
            type: 'message',
            payload: {
              accountId: options.accountId,
              conversation: context.conversation,
              profile: context.profile,
              ...(context.roleBinding ? { roleBinding: context.roleBinding } : {}),
              message: context.message,
              history,
              config: context.resolveConfig()
            }
          },
          pluginTimeoutMs * Math.max(1, options.profile.plugins.length) + 5_000
        );
        if (result.errors?.length) {
          options.logger.warn('plugin errors', { errors: result.errors });
        }
        await persistStates(context);
        for (const send of result.sends ?? []) {
          await context.send(send);
        }
        return result.reply;
      });
      turnChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },

    async onSessionStop(context) {
      await turnChain.catch(() => {});
      if (!worker) return;
      try {
        const result = await request({ type: 'stop' }, 5_000);
        if (result.state) Object.assign(states, result.state);
        await persistStates(context);
      } finally {
        await terminate();
      }
    },

    async dispose() {
      await terminate();
    }
  };
}
