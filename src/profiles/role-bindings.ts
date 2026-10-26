import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AccompanyError, InvalidSpecError } from '../core/errors.js';
import { KeyedSerialExecutor } from '../platform/async/keyed-serial-executor.js';
import { parseConversationWorldbookSource, parseWorldbookOptions } from '../worldbook/schema.js';
import type { ConversationWorldbookSource, EffectiveWorldbook, Worldbook, WorldbookOptions } from '../worldbook/types.js';
import { writeJsonAtomic } from '../storage/atomic-write.js';
import { assertIdentifier, assertKind, type ConversationRef } from '../routing/identity.js';
import type { ArtifactRef, ResolvedRoleCard } from '../artifacts/types.js';

export interface ConversationRoleBinding {
  accountId: string;
  kind: ConversationRef['kind'];
  peerId: string;
  roleCard: ArtifactRef;
  /** Changes on every edit so work started under an older card can be rejected at delivery. */
  revision: string;
  updatedAt: number;
  worldbook?: WorldbookOptions;
  worldbookSource?: ConversationWorldbookSource;
  /** Stable chat history namespace when only worldbook options change. */
  contextRevision?: string;
}

export interface ResolvedConversationRoleBinding extends ConversationRoleBinding {
  card: ResolvedRoleCard;
  contextEpoch?: string;
  worldbookSnapshot?: { book?: Worldbook };
  effectiveWorldbook?: EffectiveWorldbook;
  worldbookUnavailable?: boolean;
}

interface BindingFile {
  version: 1;
  bindings: Record<string, ConversationRoleBinding>;
}

const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Persisted per account and keyed by accountId/kind/peerId. Missing bindings stay missing. */
export class ConversationRoleBindingStore {
  readonly #writes = new KeyedSerialExecutor();

  async list(accountDir: string, accountId: string): Promise<ConversationRoleBinding[]> {
    const file = await this.#read(accountDir, accountId);
    return Object.values(file.bindings).sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.peerId.localeCompare(right.peerId)
    );
  }

  async get(
    accountDir: string,
    conversation: ConversationRef
  ): Promise<ConversationRoleBinding | undefined> {
    const file = await this.#read(accountDir, conversation.accountId);
    return file.bindings[bindingKey(conversation)];
  }

  async set(
    accountDir: string,
    conversation: ConversationRef,
    roleCard: ArtifactRef | null,
    now = Date.now()
  ): Promise<ConversationRoleBinding | undefined> {
    const normalized = normalizeConversation(conversation);
    const key = bindingKey(normalized);
    const filePath = path.join(accountDir, 'role-bindings.json');
    return this.#writes.run(filePath, async () => {
      const file = await this.#read(accountDir, normalized.accountId);
      let result: ConversationRoleBinding | undefined;
      if (roleCard === null) {
        delete file.bindings[key];
        result = undefined;
      } else {
        const parsed = parseArtifactRef(roleCard, 'roleCard');
        result = {
          ...normalized,
          roleCard: parsed,
          revision: crypto.randomUUID(),
          updatedAt: now
        };
        file.bindings[key] = result;
      }
      await this.#write(filePath, file);
      return result;
    });
  }

  async setWorldbook(accountDir: string, conversation: ConversationRef, raw: unknown, expectedRevision: string, now = Date.now(), source?: ConversationWorldbookSource): Promise<ConversationRoleBinding> {
    const normalized = normalizeConversation(conversation);
    const options = parseWorldbookOptions(raw);
    const filePath = path.join(accountDir, 'role-bindings.json');
    return this.#writes.run(filePath, async () => {
      const file = await this.#read(accountDir, normalized.accountId);
      const key = bindingKey(normalized);
      const binding = file.bindings[key];
      if (!binding || binding.revision !== expectedRevision) throw new AccompanyError('worldbook_conflict', '会话绑定已变化，请重新读取后再保存世界书设置。');
      const next = { ...binding, worldbook: options, ...(source === undefined ? {} : { worldbookSource: parseConversationWorldbookSource(source) }), contextRevision: binding.contextRevision ?? binding.revision, revision: crypto.randomUUID(), updatedAt: now };
      file.bindings[key] = next;
      await this.#write(filePath, file);
      return next;
    });
  }

  async #read(accountDir: string, accountId: string): Promise<BindingFile> {
    const filePath = path.join(accountDir, 'role-bindings.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: {} };
      throw new InvalidSpecError(`conversation role bindings are unreadable: ${filePath}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidSpecError(`conversation role bindings must be an object: ${filePath}`);
    }
    const input = raw as { version?: unknown; bindings?: unknown };
    if (input.version !== 1 || !input.bindings || typeof input.bindings !== 'object' || Array.isArray(input.bindings)) {
      throw new InvalidSpecError(`conversation role bindings have an unsupported format: ${filePath}`);
    }
    const bindings: Record<string, ConversationRoleBinding> = {};
    for (const [key, value] of Object.entries(input.bindings as Record<string, unknown>)) {
      const binding = parseBinding(value, accountId, filePath);
      if (bindingKey(binding) !== key) throw new InvalidSpecError(`conversation role binding key mismatch: ${filePath}`);
      bindings[key] = binding;
    }
    return { version: 1, bindings };
  }

  async #write(filePath: string, file: BindingFile): Promise<void> {
    await writeJsonAtomic(filePath, file);
  }
}

export function bindingKey(conversation: ConversationRef): string {
  const normalized = normalizeConversation(conversation);
  return `${normalized.accountId}/${normalized.kind}/${normalized.peerId}`;
}

function normalizeConversation(conversation: ConversationRef): ConversationRef {
  return {
    accountId: assertIdentifier(conversation.accountId, 'accountId'),
    kind: assertKind(conversation.kind),
    peerId: assertIdentifier(conversation.peerId, 'peerId')
  };
}

function parseBinding(raw: unknown, accountId: string, file: string): ConversationRoleBinding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSpecError(`conversation role binding must be an object: ${file}`);
  }
  const input = raw as Partial<ConversationRoleBinding>;
  const conversation = normalizeConversation({
    accountId: typeof input.accountId === 'string' ? input.accountId : '',
    kind: input.kind as ConversationRef['kind'],
    peerId: typeof input.peerId === 'string' ? input.peerId : ''
  });
  if (conversation.accountId !== accountId) throw new InvalidSpecError(`conversation role binding account mismatch: ${file}`);
  if (typeof input.revision !== 'string' || !input.revision || typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt)) {
    throw new InvalidSpecError(`conversation role binding revision is invalid: ${file}`);
  }
  if (input.contextRevision !== undefined && (typeof input.contextRevision !== 'string' || !input.contextRevision || input.contextRevision.length > 128)) throw new InvalidSpecError('invalid role history context revision');
  return {
    ...conversation,
    roleCard: parseArtifactRef(input.roleCard, 'roleCard'),
    revision: input.revision,
    updatedAt: input.updatedAt,
    ...(input.contextRevision !== undefined ? { contextRevision: input.contextRevision } : {}),
    ...(input.worldbook !== undefined ? { worldbook: parseWorldbookOptions(input.worldbook) } : {}),
    ...(input.worldbookSource !== undefined ? { worldbookSource: parseConversationWorldbookSource(input.worldbookSource) } : {})
  };
}

function parseArtifactRef(raw: unknown, label: string): ArtifactRef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError(`${label} must be an artifact ref`);
  const input = raw as Partial<ArtifactRef>;
  if (input.source !== 'public' && input.source !== 'private') throw new InvalidSpecError(`${label}.source must be public or private`);
  if (typeof input.id !== 'string' || !REF_ID.test(input.id)) throw new InvalidSpecError(`${label}.id is invalid`);
  if (input.revision !== undefined && (typeof input.revision !== 'string' || !REF_ID.test(input.revision))) {
    throw new InvalidSpecError(`${label}.revision is invalid`);
  }
  return { source: input.source, id: input.id, ...(input.revision ? { revision: input.revision } : {}) };
}
