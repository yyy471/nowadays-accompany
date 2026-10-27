import type { SkillDefinitionView } from '../types';

export interface SkillForm {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools: string;
  kinds: Array<'private' | 'group'>;
  peers: string;
}

export function parseList(value: string): string[] {
  return [...new Set(value.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean))];
}

/** Existing definitions keep their enable flag; new user definitions start disabled. */
export function skillPayloadOf(form: SkillForm, initial?: SkillDefinitionView): Record<string, unknown> {
  const id = form.id.trim();
  const enabled = initial ? initial.enabled : false;
  return {
    id,
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    instructions: form.instructions,
    tools: parseList(form.tools),
    ...(initial?.requires?.length ? { requires: [...initial.requires] } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(form.kinds.length ? { kinds: [...form.kinds] } : {}),
    ...(parseList(form.peers).length ? { peers: parseList(form.peers) } : {})
  };
}
