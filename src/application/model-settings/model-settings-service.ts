import crypto from 'node:crypto';
import { AccompanyError, InvalidSpecError, IsolationError } from '../../core/errors.js';
import type { CapabilityId } from '../../policy/capabilities.js';
import { patchAgentEnabled, patchCapability } from '../../policy/policy.js';
import type { ProviderTestResult } from '../../providers/contract.js';
import type { ConfigStore } from '../../providers/config-store.js';
import type { ProviderRouter, EffectiveCapabilitiesDto } from '../../providers/router.js';
import { buildSimpleProvider, discoverProviderModels, parseModelSetup } from '../../providers/setup.js';
import {
  defaultAccountPolicy,
  parseProvider,
  redactProvider,
  type AccountPolicy,
  type ProviderConfig,
  type ProviderDto
} from '../../providers/types.js';
import { sanitizeErrorText } from '../../platform/security/redaction.js';
import { assertIdentifier, type ChatKind, type ConversationRef } from '../../routing/identity.js';
import {
  CredentialVaultUnavailableError,
  defaultCredentialRef,
  type CredentialVault
} from '../../secrets/vault.js';

export interface ModelSettingsHost {
  stopped(): boolean;
  providerChanged(providerId: string, action: 'upsert' | 'remove' | 'credential'): void;
  policyChanged(accountId?: string): void;
  /** 配置提交后让在线实例重新装载；由宿主决定哪些实例受影响。 */
  reloadAgents(accountId?: string): Promise<void>;
  /** 账号授权撤销后取消失去执行基础的在途任务。 */
  cancelRevokedJobs(accountId: string): Promise<void>;
}

export interface ModelSettingsServiceOptions {
  config: ConfigStore;
  providers: ProviderRouter;
  vault: CredentialVault;
  host: ModelSettingsHost;
}

/** 模型服务维护、凭据、候选发现/验证以及账号模型设置。 */
export class ModelSettingsService {
  readonly #options: ModelSettingsServiceOptions;
  #setupChain: Promise<unknown> = Promise.resolve();

  constructor(options: ModelSettingsServiceOptions) {
    this.#options = options;
  }

  credentialStore(): { kind: string; available: boolean } {
    return { kind: this.#options.vault.kind, available: this.#options.vault.available };
  }

  async listProviders(): Promise<ProviderDto[]> {
    const config = this.#options.config.snapshot();
    const result: ProviderDto[] = [];
    for (const provider of config.providers) {
      result.push(redactProvider(provider, await this.#options.providers.credentialConfigured(provider.id)));
    }
    return result;
  }

  async upsertProvider(
    raw: unknown,
    secret?: string,
    setting?: { capability: string; modelId: string }
  ): Promise<ProviderDto> {
    const parsed = parseProvider(raw);
    const previous = this.#options.config.provider(parsed.id);
    const ref = parsed.credentialRef ?? (secret ? defaultCredentialRef(parsed.id) : undefined);
    const next: ProviderConfig = ref ? { ...parsed, credentialRef: ref } : parsed;
    let previousSecret: string | undefined;
    if (secret !== undefined && secret !== '') {
      if (!this.#options.vault.available) throw new CredentialVaultUnavailableError();
      if (ref) previousSecret = await this.#options.vault.get(ref);
      await this.#options.vault.set(ref!, secret);
    }
    try {
      await this.#options.config.upsertProvider(next, setting);
    } catch (error) {
      if (secret !== undefined && ref) {
        if (previousSecret !== undefined) await this.#options.vault.set(ref, previousSecret).catch(() => {});
        else if (previous?.credentialRef !== ref) await this.#options.vault.delete(ref).catch(() => {});
      }
      throw error;
    }
    this.#options.host.providerChanged(parsed.id, 'upsert');
    await this.#options.host.reloadAgents();
    return redactProvider(
      this.#options.config.provider(parsed.id) ?? next,
      await this.#options.providers.credentialConfigured(parsed.id)
    );
  }

  async deleteProvider(id: string): Promise<{ removed: boolean; affectedAccounts: string[] }> {
    const provider = this.#options.config.provider(id);
    const result = await this.#options.config.removeProvider(id);
    if (result.removed) {
      if (provider?.credentialRef) {
        const stillReferenced = this.#options.config
          .snapshot()
          .providers.some((entry) => entry.id !== id && entry.credentialRef === provider.credentialRef);
        if (!stillReferenced) await this.#options.vault.delete(provider.credentialRef).catch(() => {});
      }
      this.#options.host.providerChanged(id, 'remove');
      await this.#options.host.reloadAgents();
      for (const accountId of result.affectedAccounts) await this.#options.host.cancelRevokedJobs(accountId);
    }
    return result;
  }

  async setProviderCredential(id: string, secret: string): Promise<ProviderDto> {
    const provider = this.#options.config.provider(id);
    if (!provider) throw new InvalidSpecError(`unknown provider: ${id}`);
    if (!this.#options.vault.available) throw new CredentialVaultUnavailableError();
    let ref = provider.credentialRef;
    if (!ref) {
      ref = defaultCredentialRef(id);
      await this.#options.config.upsertProvider({ ...provider, credentialRef: ref });
      this.#options.host.providerChanged(id, 'upsert');
    }
    try {
      await this.#options.vault.set(ref, secret);
    } catch (error) {
      if (!provider.credentialRef) {
        await this.#options.config.upsertProvider(provider).catch(() => {});
      }
      throw error;
    }
    this.#options.host.providerChanged(id, 'credential');
    const current = this.#options.config.provider(id) ?? provider;
    return redactProvider(current, true);
  }

  async deleteProviderCredential(id: string): Promise<ProviderDto> {
    const provider = this.#options.config.provider(id);
    if (!provider) throw new InvalidSpecError(`unknown provider: ${id}`);
    if (provider.credentialRef) await this.#options.vault.delete(provider.credentialRef).catch(() => {});
    this.#options.host.providerChanged(id, 'credential');
    return redactProvider(provider, false);
  }

  testProvider(
    id: string,
    capability: CapabilityId,
    modelId?: string,
    confirmCost = false
  ): Promise<ProviderTestResult> {
    return this.#options.providers.testProvider(id, capability, modelId, confirmCost);
  }

  configureSimpleModel(raw: unknown): Promise<ProviderDto> {
    const save = this.#setupChain.then(() => {
      if (this.#options.host.stopped()) throw new AccompanyError('core_stopped', 'core has stopped');
      return this.#configureSimpleModel(raw);
    });
    this.#setupChain = save.then(() => undefined, () => undefined);
    return save;
  }

  async #configureSimpleModel(raw: unknown): Promise<ProviderDto> {
    const input = parseModelSetup(raw);
    const existing = input.providerId ? this.#options.config.provider(input.providerId) : undefined;
    const provider = buildSimpleProvider(input, existing);
    if (!this.#options.providers.adapterSupports(provider.adapterId, input.capability)) {
      throw new AccompanyError(
        'provider_adapter_unsupported',
        `adapter ${provider.adapterId} does not support ${input.capability}`
      );
    }
    if (input.secret && existing?.credentialRef && this.#options.config.snapshot().providers.some((item) => item.id !== existing.id && item.credentialRef === existing.credentialRef)) {
      provider.credentialRef = `provider/${provider.id}/${crypto.randomBytes(4).toString('hex')}`;
    }
    return this.upsertProvider(provider, input.secret, { capability: input.capability, modelId: input.modelId });
  }

  async #setupCredential(provider: ProviderConfig, secret?: string): Promise<string | undefined> {
    if (secret) return secret;
    if (!provider.credentialRef) return undefined;
    if (!this.#options.vault.available) throw new CredentialVaultUnavailableError();
    return this.#options.vault.get(provider.credentialRef);
  }

  async discoverModels(raw: unknown): Promise<string[]> {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const input = parseModelSetup({ ...value, capability: 'chat', modelId: 'discovery' });
    const existing = input.providerId ? this.#options.config.provider(input.providerId) : undefined;
    const provider = buildSimpleProvider(input, existing);
    return discoverProviderModels(provider, await this.#setupCredential(provider, input.secret));
  }

  async validateSimpleModel(raw: unknown): Promise<ProviderTestResult> {
    const input = parseModelSetup(raw);
    const existing = input.providerId ? this.#options.config.provider(input.providerId) : undefined;
    const provider = buildSimpleProvider(input, existing);
    const startedAt = Date.now();
    const credential = await this.#setupCredential(provider, input.secret);
    const redact = (text: string) => sanitizeErrorText(credential ? text.split(credential).join('[已隐藏]') : text);
    try {
      const result = await this.#options.providers.testDraft(
        provider,
        input.capability,
        input.modelId,
        credential,
        input.confirmCost
      );
      return {
        ...result,
        ...(result.detail ? { detail: redact(result.detail) } : {}),
        capability: input.capability,
        modelId: input.modelId,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      throw new AccompanyError(
        error instanceof AccompanyError ? error.code : 'provider_validation_failed',
        redact(error instanceof Error ? error.message : '模型验证失败')
      );
    }
  }

  testAccountCapability(accountId: string, capability: CapabilityId, confirmCost = false): Promise<ProviderTestResult> {
    const id = assertIdentifier(accountId, 'accountId');
    return this.#options.providers.testAccountCapability(id, capability, confirmCost);
  }

  getAccountPolicy(accountId: string): AccountPolicy {
    const id = assertIdentifier(accountId, 'accountId');
    return this.#options.config.accountPolicy(id) ?? defaultAccountPolicy();
  }

  async setAccountPolicy(accountId: string, raw: unknown): Promise<AccountPolicy> {
    const id = assertIdentifier(accountId, 'accountId');
    const policy = await this.#options.config.setAccountPolicy(id, raw);
    this.#options.host.policyChanged(id);
    await this.#options.host.reloadAgents(id);
    await this.#options.host.cancelRevokedJobs(id);
    return policy;
  }

  async patchAgentEnabled(
    accountId: string,
    enabled: boolean,
    scope?: { kind?: ChatKind; peerId?: string }
  ): Promise<AccountPolicy> {
    const id = assertIdentifier(accountId, 'accountId');
    const current = this.getAccountPolicy(id);
    return this.setAccountPolicy(id, patchAgentEnabled(current, enabled, scope));
  }

  async patchCapabilityEnabled(
    accountId: string,
    capability: CapabilityId,
    enabled: boolean,
    scope?: { kind?: ChatKind; peerId?: string }
  ): Promise<AccountPolicy> {
    const id = assertIdentifier(accountId, 'accountId');
    const current = this.getAccountPolicy(id);
    return this.setAccountPolicy(id, patchCapability(current, capability, enabled, scope));
  }

  effectiveCapabilities(accountId: string, conversation: ConversationRef): Promise<EffectiveCapabilitiesDto> {
    const id = assertIdentifier(accountId, 'accountId');
    if (conversation.accountId !== id) {
      throw new IsolationError('conversation account does not match the requested capability scope');
    }
    return this.#options.providers.effective(id, conversation);
  }

  /** 等待已接受的简化配置任务结束；宿主应在关闭前调用。 */
  async drain(): Promise<void> {
    await this.#setupChain.catch(() => {});
  }
}
