import { MEMORY_LIMITS } from '../../../memory/types.js';
import { ExtractionAttemptError } from './errors.js';

export interface ExtractedFact {
  content: string;
  keys: string[];
  evidenceSeqs: number[];
}

/**
 * Strict single-object extraction output. Unknown fields, code fences, extra text and evidence
 * outside the selected batch are rejected; the server never trusts model-owned metadata.
 */
export function parseExtractionOutput(raw: unknown, allowedSeqs: readonly number[]): ExtractedFact[] {
  if (typeof raw !== 'string') throw invalid('模型输出不是字符串。');
  if (raw.length > MEMORY_LIMITS.maxExtractionOutputChars) {
    throw invalid(`模型输出超过${MEMORY_LIMITS.maxExtractionOutputChars}字符。`);
  }
  const text = raw.trim();
  if (!text) throw invalid('模型输出为空。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('模型输出不是单个严格 JSON 对象。');
  }
  if (!isObject(parsed)) throw invalid('模型输出必须是JSON对象。');
  const topKeys = Object.keys(parsed);
  if (topKeys.length !== 1 || topKeys[0] !== 'facts') throw invalid('模型输出包含未知字段。');
  const facts = (parsed as { facts: unknown }).facts;
  if (!Array.isArray(facts)) throw invalid('facts必须是数组。');
  if (facts.length > MEMORY_LIMITS.maxExtractionFacts) {
    throw invalid(`facts最多${MEMORY_LIMITS.maxExtractionFacts}条。`);
  }
  const allowed = new Set(allowedSeqs);
  return facts.map((value, index) => parseFact(value, index, allowed));
}

function parseFact(raw: unknown, index: number, allowed: Set<number>): ExtractedFact {
  if (!isObject(raw)) throw invalid(`facts[${index}]必须是对象。`);
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !keys.every(key => key === 'content' || key === 'keys' || key === 'evidenceSeqs')) {
    throw invalid(`facts[${index}]包含未知字段。`);
  }
  if (typeof raw.content !== 'string') throw invalid(`facts[${index}].content必须是字符串。`);
  const content = raw.content.normalize('NFKC').trim();
  if (!content) throw invalid(`facts[${index}].content不能为空。`);
  if (content.length > MEMORY_LIMITS.maxExtractionContentChars) {
    throw invalid(`facts[${index}].content最多${MEMORY_LIMITS.maxExtractionContentChars}字符。`);
  }
  if (!Array.isArray(raw.keys) || raw.keys.length > MEMORY_LIMITS.maxExtractionKeys) {
    throw invalid(`facts[${index}].keys必须是不超过${MEMORY_LIMITS.maxExtractionKeys}项的数组。`);
  }
  const normalizedKeys: string[] = [];
  for (const value of raw.keys) {
    if (typeof value !== 'string') throw invalid(`facts[${index}].keys必须是字符串数组。`);
    const key = value.normalize('NFKC').trim();
    if (!key) continue;
    if (key.length > MEMORY_LIMITS.maxExtractionKeyChars) {
      throw invalid(`facts[${index}]的单个关键词最多${MEMORY_LIMITS.maxExtractionKeyChars}字符。`);
    }
    if (!normalizedKeys.includes(key)) normalizedKeys.push(key);
  }
  if (!Array.isArray(raw.evidenceSeqs) || raw.evidenceSeqs.length === 0) {
    throw invalid(`facts[${index}].evidenceSeqs必须是非空数组。`);
  }
  const evidenceSeqs: number[] = [];
  for (const value of raw.evidenceSeqs) {
    if (!Number.isSafeInteger(value) || !allowed.has(value as number)) {
      throw invalid(`facts[${index}]引用了本批之外的证据序号。`);
    }
    if (!evidenceSeqs.includes(value as number)) evidenceSeqs.push(value as number);
  }
  if (evidenceSeqs.length === 0) throw invalid(`facts[${index}].evidenceSeqs不能为空。`);
  return { content, keys: normalizedKeys, evidenceSeqs };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): ExtractionAttemptError {
  return new ExtractionAttemptError('extraction_output_invalid', message);
}
