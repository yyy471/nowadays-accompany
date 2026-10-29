/**
 * Shared prompt rendering for user and plugin Skills. Keep the heading outside this function's body
 * so the caller can reuse the same block for prompt injection, preview and tests.
 */
export function skillInstructionsWithConfig(
  instructions: string,
  config: Record<string, unknown> | undefined
): string {
  if (!config || Object.keys(config).length === 0) return instructions;
  return `${instructions}\n\n用户配置（JSON）：\n${JSON.stringify(config)}`;
}

export function renderSkillBlock(
  name: string,
  instructions: string,
  config: Record<string, unknown> | undefined
): string {
  return `### ${name}\n${skillInstructionsWithConfig(instructions, config)}`;
}
