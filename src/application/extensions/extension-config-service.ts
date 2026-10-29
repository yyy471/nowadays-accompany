import type {
  ExtensionConfigKind,
  ExtensionConfigUpdateInput,
  ExtensionConfigUpdateResult,
  ExtensionConfigView
} from '../../contracts/extension-access.js';
import type { AccountService } from '../accounts/account-service.js';
import { AccompanyError, InvalidSpecError } from '../../core/errors.js';
import { contentRevision, parseExtensionConfigValue } from '../../extensions/config-value.js';
import { isPluginKey, isPluginSkillId } from '../../extensions/contracts.js';
import type { ConfigStore } from '../../providers/config-store.js';
import { defaultAccountPolicy, type AccountPolicy } from '../../providers/types.js';

export interface ExtensionConfigServiceOptions {
  config: ConfigStore;
  accounts: AccountService;
}

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Account-scoped plain JSON configuration for plugins and Skills. */
export class ExtensionConfigService {
  readonly #options: ExtensionConfigServiceOptions;

  constructor(options: ExtensionConfigServiceOptions) {
    this.#options = options;
  }

  async read(accountId: string, kind: ExtensionConfigKind, id: string): Promise<ExtensionConfigView> {
    assertKind(kind);
    if (kind === 'plugin') {
      assertPluginKey(id);
      const view = await this.#options.accounts.readPluginConfig(accountId, id);
      return { accountId, kind, id, config: view.config, revision: view.revision };
    }
    assertSkillId(id);
    const configs = skillConfigs(this.#options.config.snapshot().accountPolicies[accountId]);
    const config = Object.hasOwn(configs, id) ? configs[id] : {};
    return { accountId, kind, id, config: structuredClone(config), revision: skillConfigRevision(id, config) };
  }

  async update(
    accountId: string,
    kind: ExtensionConfigKind,
    id: string,
    input: ExtensionConfigUpdateInput
  ): Promise<ExtensionConfigUpdateResult> {
    assertKind(kind);
    if (typeof input.expectedRevision !== 'string' || !input.expectedRevision) {
      throw new InvalidSpecError('expectedRevision 必须是当前配置 revision。');
    }
    if (kind === 'plugin') {
      assertPluginKey(id);
      const saved = await this.#options.accounts.savePluginConfig(
        accountId,
        id,
        input.config,
        input.expectedRevision
      );
      return {
        accountId,
        kind,
        id,
        config: saved.config,
        revision: saved.revision,
        ...(saved.reload ? { reload: saved.reload } : {})
      };
    }
    assertSkillId(id);
    const config = parseExtensionConfigValue(input.config, 'Skill 配置');
    const version = this.#options.config.version;
    const snapshot = this.#options.config.snapshot();
    const policy = snapshot.accountPolicies[accountId] ?? defaultAccountPolicy();
    const configs = skillConfigs(policy);
    const current = Object.hasOwn(configs, id) ? configs[id] : {};
    if (skillConfigRevision(id, current) !== input.expectedRevision) {
      throw new AccompanyError('extension_config_conflict', 'Skill 配置已被修改，请刷新后重试。');
    }
    const nextConfigs: Record<string, Record<string, unknown>> = Object.create(null);
    Object.assign(nextConfigs, configs);
    if (Object.keys(config).length > 0) nextConfigs[id] = config;
    else delete nextConfigs[id];
    try {
      await this.#options.config.updateAccountPolicy(accountId, version, (base) => {
        const skills = { ...(base.skills ?? {}) };
        if (Object.keys(nextConfigs).length > 0) skills.configs = nextConfigs;
        else delete skills.configs;
        const next: AccountPolicy = { ...base };
        if (Object.keys(skills).length > 0) next.skills = skills;
        else delete next.skills;
        return next;
      });
    } catch (error) {
      if (error instanceof AccompanyError && error.code === 'extension_conflict') {
        throw new AccompanyError('extension_config_conflict', 'Skill 配置已被修改，请刷新后重试。');
      }
      throw error;
    }
    return {
      accountId,
      kind,
      id,
      config,
      revision: skillConfigRevision(id, config)
    };
  }
}

function skillConfigs(policy: AccountPolicy | undefined): Record<string, Record<string, unknown>> {
  return policy?.skills?.configs ?? {};
}

function skillConfigRevision(id: string, config: Record<string, unknown>): string {
  return contentRevision({ kind: 'skill', id, config });
}

function assertKind(kind: ExtensionConfigKind): void {
  if (kind !== 'plugin' && kind !== 'skill') throw new InvalidSpecError('kind 必须是 plugin 或 skill。');
}

function assertPluginKey(id: string): void {
  if (!isPluginKey(id)) throw new InvalidSpecError('插件配置 id 必须使用 public/plugin/<id> 或 private/plugin/<id>。');
}

function assertSkillId(id: string): void {
  if (!SKILL_ID.test(id) && !isPluginSkillId(id)) {
    throw new InvalidSpecError('Skill 配置 id 必须是有效 Skill id 或完整插件 Skill 命名空间。');
  }
}
