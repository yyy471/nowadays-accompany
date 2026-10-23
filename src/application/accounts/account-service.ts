import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalArtifactStore } from '../../artifacts/local.js';
import { summarizeProfile, type AccountProfileFile, type ArtifactRef, type ResolvedArtifact } from '../../artifacts/types.js';
import type { AccountSummary } from '../../contracts/accounts.js';
import { InvalidSpecError, IsolationError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { ConversationRoleBinding, ConversationRoleBindingStore, ResolvedConversationRoleBinding } from '../../profiles/role-bindings.js';
import type { AccountDirectory } from '../../profiles/account-directory.js';
import type { AccountDisplayProfile, AccountDisplayStore } from '../../profiles/display.js';
import type { AccountProfileService } from '../../profiles/profile.js';
import { assertIdentifier, type ConversationRef } from '../../routing/identity.js';
import type { AccountPresentation } from './account-presentation.js';
import type { AccountRuntimePort } from '../ports/account-runtime.js';

export interface AccountServiceOptions {
  directory: AccountDirectory;
  profiles: AccountProfileService;
  displays: AccountDisplayStore;
  roleBindings: ConversationRoleBindingStore;
  artifacts: LocalArtifactStore;
  presentation: AccountPresentation;
  runtime: AccountRuntimePort;
  logger: Logger;
  now?: () => number;
}

interface RoleBindingView extends ConversationRoleBinding {
  state: 'ready' | 'missing';
  cardName?: string;
  resolvedRevision?: string;
}

/** 账号列表、展示资料、插件资料、角色绑定与重载用例。 */
export class AccountService {
  readonly #options: AccountServiceOptions;
  readonly #now: () => number;

  constructor(options: AccountServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  locate(accountId: string): { dir: string; instanceId?: string } {
    const snapshot = this.#options.runtime
      .snapshots()
      .find((item) => item.accountId === accountId || item.specAccountId === accountId);
    if (snapshot) {
      return {
        dir: this.#options.directory.forSpec({ dataDir: snapshot.dataDir }, accountId),
        instanceId: snapshot.instanceId
      };
    }
    return { dir: this.#options.directory.path(accountId) };
  }

  async list(options: { avatars?: boolean } = {}): Promise<AccountSummary[]> {
    const entries = new Map<string, { accountId: string; dir: string; slots: Set<string> }>();
    const add = (accountId: string, dir: string): { slots: Set<string> } => {
      const existing = entries.get(accountId);
      if (existing) {
        existing.dir = dir;
        return existing;
      }
      const entry = { accountId, dir, slots: new Set<string>() };
      entries.set(accountId, entry);
      return entry;
    };
    for (const snapshot of this.#options.runtime.snapshots()) {
      for (const accountId of new Set(
        [snapshot.accountId, snapshot.specAccountId].filter((value): value is string => Boolean(value))
      )) {
        add(accountId, this.#options.directory.forSpec({ dataDir: snapshot.dataDir }, accountId))
          .slots.add(snapshot.instanceId);
      }
    }
    for (const accountsRoot of this.#options.directory.accountsRoots()) {
      for (const name of await safeReaddir(accountsRoot)) {
        if (name.startsWith('.')) continue;
        const dir = path.join(accountsRoot, name);
        try {
          if (!(await fs.stat(dir)).isDirectory()) continue;
        } catch {
          continue;
        }
        add(name, dir);
      }
    }

    const result: AccountSummary[] = [];
    const localAvatars = new Map<string, string>();
    for (const entry of entries.values()) {
      let profile: AccountProfileFile | undefined;
      let error: string | undefined;
      try {
        profile = await this.#options.profiles.load(entry.dir);
      } catch (loadError) {
        error = loadError instanceof Error ? loadError.message : String(loadError);
      }
      let summary: AccountSummary['profile'];
      try {
        summary = summarizeProfile(await this.#options.profiles.resolve(entry.dir, entry.accountId));
      } catch (resolveError) {
        error = resolveError instanceof Error ? resolveError.message : String(resolveError);
      }
      const presented = await this.#options.presentation.local(entry.accountId, entry.dir);
      if (options.avatars && presented.display?.avatarDataUrl) {
        localAvatars.set(entry.accountId, presented.display.avatarDataUrl);
      }
      result.push({
        accountId: entry.accountId,
        dir: entry.dir,
        state: error ? 'invalid' : 'ready',
        ...(profile ? { file: profile } : {}),
        ...(summary ? { profile: summary } : {}),
        ...(error ? { error } : {}),
        ...(presented.display
          ? { nickname: presented.display.nickname, signature: presented.display.signature }
          : {}),
        slots: [...entry.slots]
      });
    }
    const finalized = options.avatars
      ? await Promise.all(result.map(async (account) => {
          const avatar = await this.#options.presentation.avatar(
            account.accountId,
            localAvatars.get(account.accountId)
          );
          return avatar ? { ...account, avatarDataUrl: avatar.dataUrl, avatarSource: avatar.source } : account;
        }))
      : result;
    return finalized.sort((left, right) => left.accountId.localeCompare(right.accountId));
  }

  getProfile(accountId: string): Promise<AccountProfileFile | undefined> {
    return this.#options.profiles.load(this.locate(accountId).dir);
  }

  getDisplay(accountId: string): Promise<AccountDisplayProfile> {
    return this.#options.displays.load(this.locate(accountId).dir);
  }

  saveDisplay(accountId: string, raw: unknown): Promise<AccountDisplayProfile> {
    return this.#options.displays.save(this.locate(accountId).dir, raw);
  }

  async saveProfile(
    accountId: string,
    raw: unknown
  ): Promise<{ profile: AccountProfileFile; reload?: { ok: boolean; error?: string } }> {
    const { dir, instanceId } = this.locate(accountId);
    const profile = await this.#options.profiles.save(dir, raw);
    if (!instanceId) return { profile };
    const snapshot = this.#options.runtime.snapshots().find((item) => item.instanceId === instanceId);
    if (!snapshot || !['online', 'degraded', 'awaiting_profile'].includes(snapshot.state)) return { profile };
    try {
      await this.#options.runtime.reload(instanceId);
      return { profile, reload: { ok: true } };
    } catch (error) {
      return {
        profile,
        reload: { ok: false, error: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  async reload(accountId: string): Promise<Array<{ instanceId: string; ok: boolean; error?: string }>> {
    const results: Array<{ instanceId: string; ok: boolean; error?: string }> = [];
    for (const snapshot of this.#options.runtime.snapshots()) {
      if (snapshot.accountId !== accountId) continue;
      if (!['online', 'degraded', 'awaiting_profile'].includes(snapshot.state)) continue;
      try {
        await this.#options.runtime.reload(snapshot.instanceId);
        results.push({ instanceId: snapshot.instanceId, ok: true });
      } catch (error) {
        results.push({
          instanceId: snapshot.instanceId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
  }

  async listAccountArtifacts(accountId: string): Promise<ResolvedArtifact[]> {
    const { dir } = this.locate(accountId);
    const store = new LocalArtifactStore(dir, this.#options.logger.child(`account:${accountId}:artifacts`));
    return (await store.listPublic()).map((artifact) => ({
      ...artifact,
      ref: { ...artifact.ref, source: 'private' as const }
    }));
  }

  async listRoleBindings(accountId: string): Promise<RoleBindingView[]> {
    assertIdentifier(accountId, 'accountId');
    const { dir } = this.locate(accountId);
    const bindings = await this.#options.roleBindings.list(dir, accountId);
    return Promise.all(
      bindings.map(async (binding) => {
        const card = await this.#options.artifacts.resolve('role-card', binding.roleCard, dir);
        return {
          ...binding,
          state: card?.manifest.content ? 'ready' as const : 'missing' as const,
          ...(card?.manifest.name ? { cardName: card.manifest.name } : {}),
          ...(card?.ref.revision ? { resolvedRevision: card.ref.revision } : {})
        };
      })
    );
  }

  async setRoleBinding(
    conversation: ConversationRef,
    roleCard: ArtifactRef | null
  ): Promise<ConversationRoleBinding | undefined> {
    assertIdentifier(conversation.accountId, 'accountId');
    const { dir } = this.locate(conversation.accountId);
    if (roleCard) {
      const card = await this.#options.artifacts.resolve('role-card', roleCard, dir);
      if (!card?.manifest.content) {
        throw new InvalidSpecError(`role card ${roleCard.source}:${roleCard.id} cannot be resolved`);
      }
    }
    return this.#options.roleBindings.set(dir, conversation, roleCard, this.#now());
  }

  async resolveRoleBinding(
    accountId: string,
    conversation: ConversationRef
  ): Promise<ResolvedConversationRoleBinding | undefined> {
    if (conversation.accountId !== accountId) {
      throw new IsolationError('role binding account does not match conversation');
    }
    const { dir } = this.locate(accountId);
    const binding = await this.#options.roleBindings.get(dir, conversation);
    if (!binding) return undefined;
    const artifact = await this.#options.artifacts.resolve('role-card', binding.roleCard, dir);
    if (!artifact?.manifest.content) return undefined;
    const artifactBaseDir = binding.roleCard.source === 'public'
      ? this.#options.artifacts.publicRoot
      : dir;
    const catalogEpoch = binding.roleCard.revision
      ? 0
      : await this.#options.artifacts.catalogEpoch(artifactBaseDir, 'role-card', binding.roleCard.id);
    return {
      ...binding,
      revision: `${binding.revision}:${artifact.ref.source}:${artifact.ref.id}:${artifact.ref.revision}:${catalogEpoch}`,
      card: { ...artifact, content: artifact.manifest.content }
    };
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
