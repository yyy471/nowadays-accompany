import crypto from 'node:crypto';
import { InvalidSpecError } from '../core/errors.js';
import { EXTENSION_CONFIG_LIMITS } from './config-limits.js';

/** Plain account configuration: an object, no schema inference, bounded by the Worker config cap. */
export function parseExtensionConfigValue(raw: unknown, label = 'config'): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSpecError(`${label} 必须是合法 JSON 对象。`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(raw);
  } catch {
    throw new InvalidSpecError(`${label} 必须可序列化为 JSON。`);
  }
  if (Buffer.byteLength(encoded, 'utf8') > EXTENSION_CONFIG_LIMITS.maxConfigBytes) {
    throw new InvalidSpecError(`${label} 不能超过 ${EXTENSION_CONFIG_LIMITS.maxConfigBytes} 字节。`);
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

export function contentRevision(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}
