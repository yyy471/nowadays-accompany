export const ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Side-effect-free test shared by artifact manifest ids and worldbook source references. */
export function isSafeArtifactSegment(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_SEGMENT.test(value) && !value.endsWith('.') && !RESERVED.test(value);
}
