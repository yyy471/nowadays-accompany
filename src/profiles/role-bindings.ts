import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InvalidSpecError } from '../core/errors.js';
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
}

export interface ResolvedConversationRoleBinding extends ConversationRoleBinding {
  card: ResolvedRoleCard;
}

interface BindingFile {
  version: 1;
  bindings: Record<string, ConversationRoleBinding>;
}

const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Persisted per account and keyed by accountId/kind/peerId. Missing bindings stay missing. */
export class ConversationRoleBindingStore {
  readonly #writes = new Map<string, Promise<void>>();

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
    const previous = this.#writes.get(filePath) ?? Promise.resolve();
    let result: ConversationRoleBinding | undefined;
    const write = previous.catch(() => {}).then(async () => {
      const file = await this.#read(accountDir, normalized.accountId);
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
    });
    this.#writes.set(filePath, write);
    try {
      await write;
      return result;
    } finally {
      if (this.#writes.get(filePath) === write) this.#writes.delete(filePath);
    }
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
  return {
    ...conversation,
    roleCard: parseArtifactRef(input.roleCard, 'roleCard'),
    revision: input.revision,
    updatedAt: input.updatedAt
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
