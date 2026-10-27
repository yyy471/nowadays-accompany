import type { CatalogSkillSource } from './catalog.js';

/**
 * First-round prompt limits. Definitions are validated against the per-Skill caps on save; the
 * scope caps are applied here so preview and the runtime use one stable selection.
 */
export const SKILL_PROMPT_LIMITS = Object.freeze({
  maxNameChars: 200,
  maxInstructionsChars: 8_000,
  maxTools: 8,
  maxSkills: 8,
  maxTotalInstructionsChars: 16_000
});

export interface SkillPromptCandidate {
  id: string;
  name: string;
  source: CatalogSkillSource;
  instructions: string;
  tools: readonly string[];
}

export type SkillPromptExclusionReason =
  | 'name_too_long'
  | 'instructions_too_long'
  | 'too_many_tools'
  | 'skill_limit'
  | 'instructions_budget';

export interface SkillPromptEntry {
  id: string;
  name: string;
  source: CatalogSkillSource;
  instructions: string;
  tools: string[];
}

export interface SkillPromptExclusion {
  id: string;
  name: string;
  source: CatalogSkillSource;
  reason: SkillPromptExclusionReason;
}

export interface SkillPromptSelection {
  included: SkillPromptEntry[];
  excluded: SkillPromptExclusion[];
  instructionsChars: number;
}

export interface SkillPromptLimits {
  maxNameChars?: number;
  maxInstructionsChars?: number;
  maxTools?: number;
  maxSkills?: number;
  maxTotalInstructionsChars?: number;
}

const SOURCE_ORDER: Record<CatalogSkillSource, number> = { private: 0, public: 1, plugin: 2 };
const HEADING_CHARS = 5;

/**
 * Selects the effective Skills that may enter one prompt. Ordering is private → public → plugin and
 * by full id inside each source, so a tighter context budget only ever drops a suffix of the same
 * order. Over-long blocks are reported, never truncated; once the cumulative budget is exhausted the
 * remaining candidates stay omitted instead of letting a later short Skill jump the queue.
 */
export function selectSkillsForPrompt(
  candidates: readonly SkillPromptCandidate[],
  limits: SkillPromptLimits = {}
): SkillPromptSelection {
  const maxNameChars = limits.maxNameChars ?? SKILL_PROMPT_LIMITS.maxNameChars;
  const maxInstructionsChars = limits.maxInstructionsChars ?? SKILL_PROMPT_LIMITS.maxInstructionsChars;
  const maxTools = limits.maxTools ?? SKILL_PROMPT_LIMITS.maxTools;
  const maxSkills = limits.maxSkills ?? SKILL_PROMPT_LIMITS.maxSkills;
  const maxTotalInstructionsChars = limits.maxTotalInstructionsChars ?? SKILL_PROMPT_LIMITS.maxTotalInstructionsChars;
  const ordered = [...candidates].sort((left, right) => {
    const bySource = SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source];
    if (bySource !== 0) return bySource;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const included: SkillPromptEntry[] = [];
  const excluded: SkillPromptExclusion[] = [];
  let instructionsChars = 0;
  let contentChars = 0;
  let budgetExhausted = false;
  for (const candidate of ordered) {
    const identity = { id: candidate.id, name: candidate.name, source: candidate.source };
    if (candidate.name.length > maxNameChars) {
      excluded.push({ ...identity, reason: 'name_too_long' });
      continue;
    }
    if (candidate.instructions.length > maxInstructionsChars) {
      excluded.push({ ...identity, reason: 'instructions_too_long' });
      continue;
    }
    if (candidate.tools.length > maxTools) {
      excluded.push({ ...identity, reason: 'too_many_tools' });
      continue;
    }
    if (included.length >= maxSkills) {
      excluded.push({ ...identity, reason: 'skill_limit' });
      continue;
    }
    // The heading and name are rendered into the prompt too; counting only the body lets an
    // oversized name bypass both the per-Skill and the cumulative limits.
    const renderedChars = candidate.name.length + candidate.instructions.length + HEADING_CHARS;
    if (budgetExhausted || contentChars + renderedChars > maxTotalInstructionsChars) {
      budgetExhausted = true;
      excluded.push({ ...identity, reason: 'instructions_budget' });
      continue;
    }
    included.push({ ...identity, instructions: candidate.instructions, tools: [...candidate.tools] });
    instructionsChars += candidate.instructions.length;
    contentChars += renderedChars;
  }
  return { included, excluded, instructionsChars };
}
