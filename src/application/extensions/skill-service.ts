import { createHash } from 'node:crypto';
import type {
  PrivateSkillList,
  PrivateSkillMutation,
  PublicSkillList,
  SkillCopyResult,
  SkillDefinitionView,
  SkillDeleteResult,
  SkillImpact,
  SkillImpactAccount,
  SkillLimitsView,
  SkillPreview,
  SkillPreviewEntry,
  SkillSwitchReference
} from '../../contracts/skills.js';
import { AccompanyError, InvalidSpecError, IsolationError } from '../../core/errors.js';
import { SKILL_PROMPT_LIMITS, selectSkillsForPrompt } from '../../extensions/skill-selection.js';
import type { SkillConfig } from '../../extensions/types.js';
import type { CapabilityId } from '../../policy/capabilities.js';
import type { ConfigStore } from '../../providers/config-store.js';
import { defaultAccountPolicy, parseSkillDefinition, stableStringify, type AccountPolicy } from '../../providers/types.js';
import type { ConversationRef } from '../../routing/identity.js';
import type { ExtensionPolicyService } from './extension-policy-service.js';

export interface SkillServiceOptions {
  config: ConfigStore;
  policy: ExtensionPolicyService;
  /** Actual capability resolution; preview must show the same dependency verdict as the runtime. */
  capabilityEnabled: (accountId: string, conversation: ConversationRef) => (capability: CapabilityId) => boolean;
}

/**
 * Skill definitions and their read-only effective view. User definitions keep the historical
 * account-private-overrides-public rule; plugin Skills live in their own namespace and are never
 * copied here. All writes pass through the ConfigStore mutation chain with a CAS revision.
 */
export class SkillService {
  readonly #config: ConfigStore;
  readonly #policy: ExtensionPolicyService;
  readonly #capabilityEnabled: SkillServiceOptions['capabilityEnabled'];

  constructor(options: SkillServiceOptions) {
    this.#config = options.config;
    this.#policy = options.policy;
    this.#capabilityEnabled = options.capabilityEnabled;
  }

  listPublic(): PublicSkillList {
    const skills = this.#config.snapshot().skills;
    return {
      revision: publicSkillsRevision(skills),
      skills: skills.map((skill) => definitionView(skill, 'public', new Set())),
      limits: limitsView()
    };
  }

  async savePublic(raw: unknown, expectedRevision: string): Promise<PublicSkillList> {
    const skill = parseDefinition(raw);
    const version = this.#config.version;
    const current = this.#config.snapshot().skills;
    this.#assertRevision(publicSkillsRevision(current), expectedRevision, '公用 Skill 定义已变化，请刷新后重试。');
    await this.#config.updateSkills(version, (definitions) => {
      const index = definitions.findIndex((entry) => entry.id === skill.id);
      if (index >= 0) definitions[index] = skill;
      else definitions.push(skill);
      return definitions;
    });
    return this.listPublic();
  }

  async deletePublic(id: string, expectedRevision: string): Promise<SkillDeleteResult> {
    const version = this.#config.version;
    const snapshot = this.#config.snapshot();
    this.#assertRevision(publicSkillsRevision(snapshot.skills), expectedRevision, '公用 Skill 定义已变化，请刷新后重试。');
    const impact = skillImpact(snapshot.skills, snapshot.accountPolicies, id);
    if (!impact.exists) throw new AccompanyError('skill_not_found', `公用 Skill ${id} 不存在。`);
    await this.#config.updateSkills(version, (definitions) => definitions.filter((skill) => skill.id !== id));
    return { removed: true, impact };
  }

  /** Reference analysis is read-only and safe to call before a save or delete is committed. */
  impact(id: string): SkillImpact {
    const snapshot = this.#config.snapshot();
    return skillImpact(snapshot.skills, snapshot.accountPolicies, id);
  }

  listPrivate(accountId: string): PrivateSkillList {
    const snapshot = this.#config.snapshot();
    return this.#privateView(accountId, snapshot.skills, snapshot.accountPolicies[accountId]);
  }

  async savePrivate(accountId: string, raw: unknown, expectedRevision: string): Promise<PrivateSkillMutation> {
    const skill = parseDefinition(raw);
    return this.#writePrivate(accountId, skill, expectedRevision);
  }

  async copyPublicToPrivate(accountId: string, publicId: string, expectedRevision: string): Promise<SkillCopyResult> {
    const publicSkill = this.#config.snapshot().skills.find((skill) => skill.id === publicId);
    if (!publicSkill) throw new AccompanyError('skill_not_found', `公用 Skill ${publicId} 不存在。`);
    const copy = parseDefinition(publicSkill);
    // A copy still needs an explicit account-scope switch; do not inherit the source default.
    copy.enabled = false;
    const mutation = await this.#writePrivate(accountId, copy, expectedRevision);
    return { skills: mutation.skills, copied: true, replaced: mutation.replaced };
  }

  async deletePrivate(accountId: string, id: string, expectedRevision: string): Promise<PrivateSkillMutation> {
    const version = this.#config.version;
    const snapshot = this.#config.snapshot();
    const policy = snapshot.accountPolicies[accountId] ?? defaultAccountPolicy();
    const definitions = policy.skills?.definitions ?? [];
    this.#assertRevision(privateSkillsRevision(definitions), expectedRevision, '账号私有 Skill 定义已变化，请刷新后重试。');
    if (!definitions.some((skill) => skill.id === id)) {
      return { skills: this.#privateView(accountId, snapshot.skills, policy), replaced: false, removed: false };
    }
    await this.#updateDefinitions(accountId, version, () => definitions.filter((skill) => skill.id !== id));
    const latest = this.#config.snapshot();
    return {
      skills: this.#privateView(accountId, latest.skills, latest.accountPolicies[accountId]),
      replaced: false,
      removed: true
    };
  }

  /**
   * Resolves the same effective Skills the runtime injects, then applies the shared prompt budget.
   * No model call, tool execution or configuration write happens here.
   */
  async preview(accountId: string, conversation: ConversationRef): Promise<SkillPreview> {
    if (accountId !== conversation.accountId) {
      throw new IsolationError('skill preview account does not match the conversation account');
    }
    const effective = await this.#policy.effective(
      accountId,
      conversation,
      this.#capabilityEnabled(accountId, conversation)
    );
    const publicIds = new Set(this.#config.snapshot().skills.map((skill) => skill.id));
    const selection = selectSkillsForPrompt(
      effective.skills
        .filter((status) => status.enabled)
        .map((status) => ({
          id: status.skill.id,
          name: status.skill.name,
          source: status.skill.source,
          instructions: status.skill.instructions,
          tools: status.skill.tools
        }))
    );
    const selected = new Set(selection.included.map((skill) => skill.id));
    const exclusionReasons = new Map(selection.excluded.map((skill) => [skill.id, skill.reason]));
    const skills: SkillPreviewEntry[] = effective.skills.map((status) => {
      const reason = exclusionReasons.get(status.skill.id);
      return {
        id: status.skill.id,
        name: status.skill.name,
        source: status.skill.source,
        ...(status.skill.overrides ? { overrides: status.skill.overrides } : {}),
        enabled: status.enabled,
        issues: status.issues.map((issue) => ({ ...issue })),
        unavailableTools: [...status.unavailableTools],
        instructions: status.skill.instructions,
        tools: [...status.skill.tools],
        ...(status.skill.requires?.length ? { requires: [...status.skill.requires] } : {}),
        switchSource: status.switchSource,
        instructionsChars: status.skill.instructions.length,
        toolCount: status.skill.tools.length,
        selected: selected.has(status.skill.id),
        ...(reason ? { selectionReason: reason } : {})
      };
    });
    // A private definition only overrides a public one; the catalog already marks that relation,
    // but legacy callers may pass statuses without it.
    for (const entry of skills) {
      if (!entry.overrides && entry.source === 'private' && publicIds.has(entry.id)) entry.overrides = 'public';
    }
    return {
      accountId,
      conversation: { ...conversation },
      limits: limitsView(),
      instructionsChars: selection.instructionsChars,
      runtimeMayTrim: true,
      skills,
      included: selection.included.map((skill) => skill.id),
      excluded: selection.excluded.map((skill) => ({ id: skill.id, reason: skill.reason }))
    };
  }

  async #writePrivate(accountId: string, skill: SkillConfig, expectedRevision: string): Promise<PrivateSkillMutation> {
    const version = this.#config.version;
    const snapshot = this.#config.snapshot();
    const policy = snapshot.accountPolicies[accountId] ?? defaultAccountPolicy();
    const definitions = policy.skills?.definitions ?? [];
    this.#assertRevision(privateSkillsRevision(definitions), expectedRevision, '账号私有 Skill 定义已变化，请刷新后重试。');
    const replaced = definitions.some((entry) => entry.id === skill.id);
    const stored = structuredClone(skill);
    await this.#updateDefinitions(accountId, version, (current) => {
      const index = current.findIndex((entry) => entry.id === stored.id);
      if (index >= 0) current[index] = stored;
      else current.push(stored);
      return current;
    });
    const latest = this.#config.snapshot();
    return {
      skills: this.#privateView(accountId, latest.skills, latest.accountPolicies[accountId]),
      replaced
    };
  }

  async #updateDefinitions(
    accountId: string,
    expectedVersion: number,
    apply: (definitions: SkillConfig[]) => SkillConfig[]
  ): Promise<void> {
    try {
      await this.#config.updateAccountPolicy(accountId, expectedVersion, (current) => ({
        ...current,
        skills: {
          ...(current.skills ?? {}),
          definitions: apply(current.skills?.definitions ?? [])
        }
      }));
    } catch (error) {
      if (error instanceof AccompanyError && error.code === 'extension_conflict') {
        throw new AccompanyError('skill_conflict', '账号私有 Skill 定义已变化，请刷新后重试。');
      }
      throw error;
    }
  }

  #privateView(
    accountId: string,
    publicSkills: readonly SkillConfig[],
    policy: AccountPolicy | undefined
  ): PrivateSkillList {
    const publicIds = new Set(publicSkills.map((skill) => skill.id));
    const definitions = policy?.skills?.definitions ?? [];
    return {
      accountId,
      revision: privateSkillsRevision(definitions),
      skills: definitions.map((skill) => definitionView(skill, 'private', publicIds)),
      limits: limitsView()
    };
  }

  #assertRevision(actual: string, expected: string, message: string): void {
    if (typeof expected !== 'string' || !expected || actual !== expected) {
      throw new AccompanyError('skill_conflict', message);
    }
  }
}

function parseDefinition(raw: unknown): SkillConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSpecError('skill 必须是对象。');
  }
  // List/preview responses carry source metadata; accept them back without storing it.
  const { source: _source, overrides: _overrides, ...skill } = raw as Record<string, unknown>;
  const parsed = parseSkillDefinition(skill, 'skill');
  if (parsed.name.length > SKILL_PROMPT_LIMITS.maxNameChars) {
    throw new InvalidSpecError(`skill ${parsed.id} 名称最多 ${SKILL_PROMPT_LIMITS.maxNameChars} 字符。`);
  }
  if (parsed.instructions.length > SKILL_PROMPT_LIMITS.maxInstructionsChars) {
    throw new InvalidSpecError(`skill ${parsed.id} 说明正文最多 ${SKILL_PROMPT_LIMITS.maxInstructionsChars} 字符。`);
  }
  if (parsed.tools.length > SKILL_PROMPT_LIMITS.maxTools) {
    throw new InvalidSpecError(`skill ${parsed.id} 最多引用 ${SKILL_PROMPT_LIMITS.maxTools} 个工具。`);
  }
  return structuredClone(parsed);
}

function definitionView(skill: SkillConfig, source: 'public' | 'private', publicIds: ReadonlySet<string>): SkillDefinitionView {
  return {
    ...structuredClone(skill),
    source,
    ...(source === 'private' && publicIds.has(skill.id) ? { overrides: 'public' as const } : {})
  };
}

function limitsView(): SkillLimitsView {
  return {
    maxInstructionsChars: SKILL_PROMPT_LIMITS.maxInstructionsChars,
    maxTools: SKILL_PROMPT_LIMITS.maxTools,
    maxSkills: SKILL_PROMPT_LIMITS.maxSkills,
    maxTotalInstructionsChars: SKILL_PROMPT_LIMITS.maxTotalInstructionsChars
  };
}

function publicSkillsRevision(skills: readonly SkillConfig[]): string {
  return revisionOf({ kind: 'public-skills', skills });
}

function privateSkillsRevision(definitions: readonly SkillConfig[]): string {
  return revisionOf({ kind: 'private-skills', definitions });
}

function revisionOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function skillImpact(
  publicSkills: readonly SkillConfig[],
  accountPolicies: Record<string, AccountPolicy>,
  id: string
): SkillImpact {
  const definition = publicSkills.find((skill) => skill.id === id);
  const accounts: SkillImpactAccount[] = [];
  for (const accountId of Object.keys(accountPolicies).sort()) {
    const policy = accountPolicies[accountId]!;
    const privateOverride = policy.skills?.definitions?.some((skill) => skill.id === id) ?? false;
    const switches = collectSkillSwitches(policy, id);
    if (!privateOverride && switches.length === 0) continue;
    accounts.push({ accountId, privateOverride, switches });
  }
  const defaultEnabled = definition ? definition.enabled !== false : false;
  return {
    skillId: id,
    exists: definition !== undefined,
    defaultEnabled,
    defaultScopesAffected: defaultEnabled,
    accounts
  };
}

function collectSkillSwitches(policy: AccountPolicy, id: string): SkillSwitchReference[] {
  const references: SkillSwitchReference[] = [];
  const append = (
    scope: SkillSwitchReference['scope'],
    run: { skills?: Record<string, 'inherit' | 'on' | 'off'> } | undefined,
    scopeKey?: { kind: SkillSwitchReference['kind']; peerId?: string }
  ): void => {
    const value = run?.skills?.[id];
    if (value !== 'on' && value !== 'off') return;
    references.push({
      scope,
      ...(scopeKey?.kind ? { kind: scopeKey.kind } : {}),
      ...(scopeKey?.peerId ? { peerId: scopeKey.peerId } : {}),
      value
    });
  };
  const extensions = policy.extensions;
  append('defaults', extensions?.defaults);
  for (const [kind, run] of Object.entries(extensions?.byKind ?? {})) {
    append('kind', run, { kind: kind as SkillSwitchReference['kind'] });
  }
  for (const [key, run] of Object.entries(extensions?.byConversation ?? {})) {
    const [kind, peerId] = key.split('/');
    append('conversation', run, { kind: kind as SkillSwitchReference['kind'], ...(peerId ? { peerId } : {}) });
  }
  return references;
}
