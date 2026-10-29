/** Bounds shared by plugin and Skill account configuration; the Worker protocol uses the same byte cap. */
export const EXTENSION_CONFIG_LIMITS = {
  maxConfigBytes: 8 * 1024,
  maxSkillConfigs: 128
} as const;
