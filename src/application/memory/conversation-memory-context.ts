import type { ResolvedConversationRoleBinding } from '../../profiles/role-bindings.js';
import type { ConversationRef } from '../../routing/identity.js';
import type { MemorySnapshot } from '../../memory/types.js';
import type { MemoryService } from './memory-service.js';

export interface ConversationMemoryCapture {
  roleBinding: ResolvedConversationRoleBinding;
  memory: MemorySnapshot;
}

export interface ConversationMemoryContextOptions {
  memories: Pick<MemoryService, 'runtimeSnapshot'>;
  /** Resolves the base role/worldbook snapshot; its history epoch scopes the memory read. */
  roles: {
    resolve(accountId: string, conversation: ConversationRef): Promise<ResolvedConversationRoleBinding | undefined>;
  };
}

/**
 * Captures role and memory from one history epoch. A role change during the memory read
 * is rejected later by the existing revision guard; the two snapshots are never mixed.
 */
export class ConversationMemoryContextService {
  readonly #options: ConversationMemoryContextOptions;

  constructor(options: ConversationMemoryContextOptions) {
    this.#options = options;
  }

  async capture(accountId: string, conversation: ConversationRef): Promise<ConversationMemoryCapture | undefined> {
    const roleBinding = await this.#options.roles.resolve(accountId, conversation);
    if (!roleBinding) return undefined;
    const memory = await this.#options.memories.runtimeSnapshot(
      accountId,
      conversation,
      roleBinding.contextEpoch ?? roleBinding.revision
    );
    return { roleBinding, memory };
  }
}
