import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AccompanyError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { ChatKind } from '../../routing/identity.js';
import type { PluginSource } from '../contracts.js';
import { writeJsonAtomic } from '../../storage/atomic-write.js';
import { SerialExecutor } from '../../platform/async/serial-executor.js';
import { PLUGIN_RUNTIME_LIMITS } from './protocol.js';

export interface PluginStateScope {
  source: PluginSource;
  pluginId: string;
  kind: ChatKind;
  peerId: string;
  contextEpoch: string;
  accountShared: boolean;
}

export type PluginStateRead =
  | { status: 'ready'; state: Record<string, unknown>; stateVersion: string }
  | { status: 'missing'; stateVersion: string }
  | { status: 'conflict'; savedVersion: string }
  | { status: 'unavailable'; reason: string };

interface PluginStateEnvelope {
  version: 1;
  stateVersion: string;
  updatedAt: number;
  scope: PluginStateEnvelopeScope;
  value: Record<string, unknown>;
}

type PluginStateEnvelopeScope =
  | { accountShared: true }
  | { accountShared: false; kind: ChatKind; peerId: string; contextEpoch: string };

export interface PluginStateWriteOptions {
  guard?: () => boolean | Promise<boolean>;
}

const MAX_QUEUED_STATE_FILES = 128;

/** Host-owned, path-generated plugin state namespaces. Plugins never receive a filesystem path. */
export class PluginStateService {
  readonly #root: string;
  readonly #logger?: Logger;
  readonly #chains = new Map<string, SerialExecutor>();

  constructor(accountDir: string, logger?: Logger) {
    this.#root = path.resolve(accountDir);
    this.#logger = logger;
  }

  filePath(scope: PluginStateScope): string {
    validateScope(scope);
    const epochDigest = crypto.createHash('sha256').update(scope.contextEpoch, 'utf8').digest('hex');
    return path.join(
      this.#root,
      'plugin-state',
      scope.source,
      safeSegment(scope.pluginId),
      scope.accountShared ? 'account.json' : `${scope.kind}_${safeSegment(scope.peerId)}_${epochDigest}.json`
    );
  }

  async read(scope: PluginStateScope, stateVersion: string): Promise<PluginStateRead> {
    const file = this.filePath(scope);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', stateVersion };
      this.#logger?.warn('plugin state unreadable', { reason: (error as NodeJS.ErrnoException).code ?? 'io' });
      return { status: 'unavailable', reason: 'plugin_state_unavailable' };
    }
    if (Buffer.byteLength(raw, 'utf8') > PLUGIN_RUNTIME_LIMITS.maxStateBytes) {
      return { status: 'unavailable', reason: 'plugin_state_too_large' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unavailable', reason: 'plugin_state_corrupt' };
    }
    const envelope = parseEnvelope(parsed);
    if (!envelope) return { status: 'unavailable', reason: 'plugin_state_corrupt' };
    if (!sameScope(envelope.scope, scope)) return { status: 'unavailable', reason: 'plugin_state_scope_mismatch' };
    if (envelope.stateVersion !== stateVersion) return { status: 'conflict', savedVersion: envelope.stateVersion };
    return { status: 'ready', state: structuredClone(envelope.value), stateVersion };
  }

  async write(
    scope: PluginStateScope,
    stateVersion: string,
    value: Record<string, unknown>,
    at = Date.now(),
    options: PluginStateWriteOptions = {}
  ): Promise<void> {
    validateScope(scope);
    const envelope: PluginStateEnvelope = { version: 1, stateVersion, updatedAt: at, scope: envelopeScope(scope), value };
    const body = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(body, 'utf8') > PLUGIN_RUNTIME_LIMITS.maxStateBytes) {
      throw new AccompanyError('plugin_state_too_large', 'plugin state exceeds its bounded namespace size');
    }
    const file = this.filePath(scope);
    const chain = this.#chainFor(file);
    await chain.run(async () => {
      await assertWriteAllowed(options.guard);
      const previous = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (previous) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(previous);
        } catch {
          throw new AccompanyError('plugin_state_corrupt', 'plugin state changed to an unreadable value');
        }
        const existing = parseEnvelope(parsed);
        if (!existing || existing.stateVersion !== stateVersion || !sameScope(existing.scope, scope)) {
          throw new AccompanyError('plugin_state_conflict', 'plugin state version changed before write');
        }
      }
      await writeJsonAtomic(file, envelope, {
        beforeCommit: async () => {
          await assertWriteAllowed(options.guard);
          return true;
        }
      });
    });
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#chains.values()].map((chain) => chain.drain()));
  }

  async close(): Promise<void> {
    const chains = [...this.#chains.values()];
    this.#chains.clear();
    await Promise.allSettled(chains.map(async (chain) => {
      await chain.drain();
      await chain.close();
    }));
  }

  #chainFor(file: string): SerialExecutor {
    const existing = this.#chains.get(file);
    if (existing) return existing;
    if (this.#chains.size >= MAX_QUEUED_STATE_FILES) this.#evictIdleChains();
    const chain = new SerialExecutor({ maxPending: 32 });
    this.#chains.set(file, chain);
    return chain;
  }

  /** A drained queue has no ordering left to protect, so its namespace can be dropped. */
  #evictIdleChains(): void {
    for (const [file, chain] of this.#chains) {
      if (!chain.active && chain.pending === 0) this.#chains.delete(file);
    }
  }
}

function parseEnvelope(value: unknown): PluginStateEnvelope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.stateVersion !== 'string' || !raw.stateVersion) return undefined;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return undefined;
  if (!raw.value || typeof raw.value !== 'object' || Array.isArray(raw.value)) return undefined;
  const scope = parseEnvelopeScope(raw.scope);
  if (!scope) return undefined;
  return { version: 1, stateVersion: raw.stateVersion, updatedAt: raw.updatedAt, scope, value: raw.value as Record<string, unknown> };
}

function parseEnvelopeScope(raw: unknown): PluginStateEnvelopeScope | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.accountShared === true) {
    return Object.keys(value).length === 1 ? { accountShared: true } : undefined;
  }
  if (value.accountShared !== false || value.kind !== 'group' && value.kind !== 'private'
    || typeof value.peerId !== 'string' || typeof value.contextEpoch !== 'string') return undefined;
  try {
    safeSegment(value.peerId);
    validateEpoch(value.contextEpoch);
  } catch {
    return undefined;
  }
  if (Object.keys(value).length !== 4) return undefined;
  return { accountShared: false, kind: value.kind, peerId: value.peerId, contextEpoch: value.contextEpoch };
}

function envelopeScope(scope: PluginStateScope): PluginStateEnvelopeScope {
  return scope.accountShared
    ? { accountShared: true }
    : { accountShared: false, kind: scope.kind, peerId: scope.peerId, contextEpoch: scope.contextEpoch };
}

function sameScope(left: PluginStateEnvelopeScope, right: PluginStateScope): boolean {
  if (left.accountShared !== right.accountShared) return false;
  if (left.accountShared) return right.accountShared;
  return !right.accountShared && left.kind === right.kind && left.peerId === right.peerId && left.contextEpoch === right.contextEpoch;
}

function validateScope(scope: PluginStateScope): void {
  safeSegment(scope.pluginId);
  safeSegment(scope.peerId);
  if (scope.source !== 'public' && scope.source !== 'private') {
    throw new AccompanyError('invalid_plugin_state_scope', 'plugin state scope contains an invalid source');
  }
  if (scope.kind !== 'group' && scope.kind !== 'private') {
    throw new AccompanyError('invalid_plugin_state_scope', 'plugin state scope contains an invalid conversation kind');
  }
  if (typeof scope.accountShared !== 'boolean') {
    throw new AccompanyError('invalid_plugin_state_scope', 'plugin state scope has no account-sharing mode');
  }
  validateEpoch(scope.contextEpoch);
}

function validateEpoch(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 2_048) {
    throw new AccompanyError('invalid_plugin_state_scope', 'plugin context epoch is missing or exceeds its bound');
  }
}

async function assertWriteAllowed(guard?: () => boolean | Promise<boolean>): Promise<void> {
  if (guard && !(await guard())) {
    throw new AccompanyError('plugin_execution_guard_changed', 'plugin execution is no longer authorized');
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new AccompanyError('invalid_plugin_state_scope', 'plugin state scope contains an invalid identifier');
  }
  return value;
}
