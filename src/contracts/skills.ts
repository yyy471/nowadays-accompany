import type { CatalogSkillSource } from '../extensions/catalog.js';
import type { EffectiveIssue } from '../extensions/effective.js';
import type { SkillPromptExclusionReason } from '../extensions/skill-selection.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { ChatKind, ConversationRef } from '../routing/identity.js';

export interface SkillLimitsView {
  maxInstructionsChars: number;
  maxTools: number;
  maxSkills: number;
  maxTotalInstructionsChars: number;
}

/** A stored user definition with the source that actually serves it. */
export interface SkillDefinitionView {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  tools: string[];
  requires?: CapabilityId[];
  kinds?: ChatKind[];
  peers?: string[];
  enabled?: boolean;
  source: 'public' | 'private';
  /** Private definition carrying the same id as a public definition. */
  overrides?: 'public';
}

export interface PublicSkillList {
  revision: string;
  skills: SkillDefinitionView[];
  limits: SkillLimitsView;
}

export interface PrivateSkillList {
  accountId: string;
  revision: string;
  skills: SkillDefinitionView[];
  limits: SkillLimitsView;
}

export interface SkillSwitchReference {
  scope: 'defaults' | 'kind' | 'conversation';
  kind?: ChatKind;
  peerId?: string;
  value: 'on' | 'off';
}

export interface SkillImpactAccount {
  accountId: string;
  privateOverride: boolean;
  switches: SkillSwitchReference[];
}

/** Read-only reference analysis shown before editing or deleting a shared definition. */
export interface SkillImpact {
  skillId: string;
  exists: boolean;
  defaultEnabled: boolean;
  /** True when deleting/editing also affects every default-enabled scope, not just `accounts`. */
  defaultScopesAffected: boolean;
  accounts: SkillImpactAccount[];
}

export interface SkillDeleteResult {
  removed: boolean;
  impact: SkillImpact;
}

export interface PrivateSkillMutation {
  skills: PrivateSkillList;
  replaced: boolean;
  /** Present for delete: false keeps an already-absent definition idempotent. */
  removed?: boolean;
}

export interface SkillCopyResult {
  skills: PrivateSkillList;
  copied: boolean;
  replaced: boolean;
}

export interface SkillPreviewEntry {
  id: string;
  name: string;
  source: CatalogSkillSource;
  overrides?: 'public';
  enabled: boolean;
  issues: EffectiveIssue[];
  unavailableTools: string[];
  instructions: string;
  tools: string[];
  requires?: CapabilityId[];
  /** Where the effective switch value came from (account/kind/conversation/default). */
  switchSource: 'account' | 'kind' | 'conversation' | 'default';
  instructionsChars: number;
  toolCount: number;
  selected: boolean;
  selectionReason?: SkillPromptExclusionReason;
}

/** Read-only effective view; it never calls a model, executes a tool or writes configuration. */
export interface SkillPreview {
  accountId: string;
  conversation: ConversationRef;
  limits: SkillLimitsView;
  instructionsChars: number;
  /** Selection reflects the standard limits; a real turn may trim further by remaining context. */
  runtimeMayTrim: boolean;
  skills: SkillPreviewEntry[];
  included: string[];
  excluded: Array<{ id: string; reason: SkillPromptExclusionReason }>;
}
