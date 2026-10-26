import { createHash } from 'node:crypto';
import { InvalidSpecError } from '../core/errors.js';
import { assertIdentifier, assertKind } from '../routing/identity.js';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_DEFAULT_REVISION,
  MEMORY_LIMITS,
  type MemoryExtractionFailure,
  type MemoryExtractionPauseReason,
  type MemoryExtractionResult,
  type MemoryExtractionState,
  type MemoryReceipt,
  type MemoryRecord,
  type MemoryScope,
  type MemorySettings,
  type MemorySourceRange,
  type MemoryState
} from './types.js';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPE_TOKEN = /^[a-f0-9]{64}$/;
const EPOCH = /^[A-Za-z0-9._:-]{1,512}$/;

function object(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError(`${label}必须是对象。`);
  return raw as Record<string, unknown>;
}

function exact(raw: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new InvalidSpecError(`${label}含不支持的字段。`);
}

function canonical(raw: unknown): string {
  if (Array.isArray(raw)) return `[${raw.map(canonical).join(',')}]`;
  if (raw && typeof raw === 'object') {
    return `{${Object.entries(raw).filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
  }
  return JSON.stringify(raw);
}

export function memoryNamespace(scope: MemoryScope): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.accountId, scope.kind, scope.peerId, scope.contextEpoch]))
    .digest('hex');
}

export function isScopeToken(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_TOKEN.test(value);
}

export function parseMemoryScope(raw: unknown): MemoryScope {
  const input = object(raw, '记忆作用域');
  exact(input, ['accountId', 'kind', 'peerId', 'contextEpoch'], '记忆作用域');
  if (typeof input.contextEpoch !== 'string' || !EPOCH.test(input.contextEpoch) || input.contextEpoch.length > MEMORY_LIMITS.maxEpochChars) {
    throw new InvalidSpecError('记忆作用域的上下文版本无效。');
  }
  return {
    accountId: assertIdentifier(input.accountId as string, 'accountId'),
    kind: assertKind(input.kind as string),
    peerId: assertIdentifier(input.peerId as string, 'peerId'),
    contextEpoch: input.contextEpoch
  };
}

export function defaultMemoryState(scope: MemoryScope): MemoryState {
  return {
    version: 1,
    scope: { ...scope },
    revision: MEMORY_DEFAULT_REVISION,
    generation: 0,
    settings: { ...DEFAULT_MEMORY_SETTINGS },
    records: [],
    receipts: []
  };
}

export function parseMemorySettings(raw: unknown): MemorySettings {
  const input = object(raw, '记忆设置');
  exact(input, ['enabled', 'autoExtract', 'budgetChars', 'maxSelected'], '记忆设置');
  if (typeof input.enabled !== 'boolean' || typeof input.autoExtract !== 'boolean') {
    throw new InvalidSpecError('记忆开关必须是布尔值。');
  }
  if (!Number.isInteger(input.budgetChars) || (input.budgetChars as number) < 0 || (input.budgetChars as number) > MEMORY_LIMITS.maxBudgetChars) {
    throw new InvalidSpecError(`注入预算必须是0–${MEMORY_LIMITS.maxBudgetChars}的整数。`);
  }
  if (!Number.isInteger(input.maxSelected) || (input.maxSelected as number) < MEMORY_LIMITS.maxSelectedMin || (input.maxSelected as number) > MEMORY_LIMITS.maxSelectedMax) {
    throw new InvalidSpecError(`最多选用条数必须是${MEMORY_LIMITS.maxSelectedMin}–${MEMORY_LIMITS.maxSelectedMax}的整数。`);
  }
  return {
    enabled: input.enabled,
    autoExtract: input.autoExtract,
    budgetChars: input.budgetChars as number,
    maxSelected: input.maxSelected as number
  };
}

export function normalizeContent(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new InvalidSpecError('记忆正文不能为空。');
  if (raw.length > MEMORY_LIMITS.maxContentChars) throw new InvalidSpecError(`单条记忆正文最多${MEMORY_LIMITS.maxContentChars}字符。`);
  return raw;
}

export function normalizeKeys(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new InvalidSpecError('记忆关键词必须是字符串数组。');
  const keys: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') throw new InvalidSpecError('记忆关键词必须是字符串。');
    const key = value.trim();
    if (!key) continue;
    if (key.length > MEMORY_LIMITS.maxKeyChars) throw new InvalidSpecError(`单个关键词最多${MEMORY_LIMITS.maxKeyChars}字符。`);
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length > MEMORY_LIMITS.maxKeys) throw new InvalidSpecError(`单条记忆最多${MEMORY_LIMITS.maxKeys}个关键词。`);
  return keys;
}

export function parseMemoryState(raw: unknown): MemoryState {
  const input = object(raw, '记忆状态');
  exact(input, ['version', 'scope', 'revision', 'generation', 'settings', 'records', 'extraction', 'receipts'], '记忆状态');
  if (input.version !== 1) throw new InvalidSpecError('记忆状态版本不受支持。');
  const scope = parseMemoryScope(input.scope);
  const revision = parseRevision(input.revision, '记忆状态版本');
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) throw new InvalidSpecError('记忆状态代数无效。');
  const settings = parseMemorySettings(input.settings);
  if (!Array.isArray(input.records) || input.records.length > MEMORY_LIMITS.maxRecords) {
    throw new InvalidSpecError(`记忆记录必须是不超过${MEMORY_LIMITS.maxRecords}条的数组。`);
  }
  const records = input.records.map(value => parseStoredRecord(value));
  const ids = new Set<string>();
  let total = 0;
  for (const record of records) {
    if (ids.has(record.id)) throw new InvalidSpecError('记忆记录id重复。');
    ids.add(record.id);
    total += record.content.length;
  }
  if (total > MEMORY_LIMITS.maxTotalContentChars) throw new InvalidSpecError('记忆正文总长度超过上限。');
  const receipts = parseReceipts(input.receipts);
  return {
    version: 1,
    scope,
    revision,
    generation: input.generation as number,
    settings,
    records,
    receipts,
    ...(input.extraction !== undefined ? { extraction: parseExtraction(input.extraction) } : {})
  };
}

function parseStoredRecord(raw: unknown): MemoryRecord {
  const input = object(raw, '记忆记录');
  exact(input, ['id', 'revision', 'type', 'content', 'keys', 'pinned', 'origin', 'createdAt', 'updatedAt', 'source'], '记忆记录');
  if (typeof input.id !== 'string' || !SEGMENT.test(input.id)) throw new InvalidSpecError('记忆记录id无效。');
  const revision = parseRevision(input.revision, '记忆记录版本');
  if (input.type !== 'fact' && input.type !== 'summary') throw new InvalidSpecError('记忆记录类型无效。');
  const content = normalizeContent(input.content);
  if (!Array.isArray(input.keys)) throw new InvalidSpecError('记忆记录关键词必须是数组。');
  const keys = normalizeKeys(input.keys);
  if (typeof input.pinned !== 'boolean') throw new InvalidSpecError('记忆固定标记必须是布尔值。');
  if (input.origin !== 'user' && input.origin !== 'model') throw new InvalidSpecError('记忆来源无效。');
  const createdAt = parseTime(input.createdAt, '创建时间');
  const updatedAt = parseTime(input.updatedAt, '更新时间');
  if (updatedAt < createdAt) throw new InvalidSpecError('记忆更新时间早于创建时间。');
  return {
    id: input.id,
    revision,
    type: input.type,
    content,
    keys,
    pinned: input.pinned,
    origin: input.origin,
    createdAt,
    updatedAt,
    ...(input.source !== undefined ? { source: parseSource(input.source) } : {})
  };
}

function parseRevision(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !REVISION.test(raw) || raw.length > MEMORY_LIMITS.maxRevisionChars) throw new InvalidSpecError(`${label}无效。`);
  return raw;
}

function parseTime(raw: unknown, label: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw new InvalidSpecError(`${label}无效。`);
  return raw as number;
}

function parseSource(raw: unknown): MemorySourceRange {
  const input = object(raw, '记忆来源');
  exact(input, ['fromSeq', 'throughSeq'], '记忆来源');
  if (!Number.isSafeInteger(input.fromSeq) || (input.fromSeq as number) < 0
    || !Number.isSafeInteger(input.throughSeq) || (input.throughSeq as number) < (input.fromSeq as number)) {
    throw new InvalidSpecError('记忆来源区间无效。');
  }
  return { fromSeq: input.fromSeq as number, throughSeq: input.throughSeq as number };
}

function parseExtraction(raw: unknown): MemoryExtractionState {
  const input = object(raw, '提取水位');
  exact(input, [
    'throughSeq',
    'activationVersion',
    'activatedAfterSeq',
    'lastCompletedSourceKey',
    'recentResults',
    'lastAttemptAt',
    'lastSuccessAt',
    'cooldownUntil',
    'pausedReason',
    'lastFailure'
  ], '提取水位');
  const throughSeq = parseSeq(input.throughSeq, '提取水位');
  if (input.activationVersion !== undefined && input.activationVersion !== 1) throw new InvalidSpecError('提取激活版本无效。');
  const activatedAfterSeq = input.activatedAfterSeq === undefined ? undefined : parseSeq(input.activatedAfterSeq, '提取激活边界');
  if (activatedAfterSeq !== undefined && activatedAfterSeq > throughSeq) throw new InvalidSpecError('提取激活边界晚于当前水位。');
  const lastCompletedSourceKey = input.lastCompletedSourceKey === undefined
    ? undefined
    : parseSourceKey(input.lastCompletedSourceKey, '最近提取来源');
  const recentResults = input.recentResults === undefined ? undefined : parseExtractionResults(input.recentResults, throughSeq);
  const lastAttemptAt = input.lastAttemptAt === undefined ? undefined : parseTime(input.lastAttemptAt, '最近提取尝试时间');
  const lastSuccessAt = input.lastSuccessAt === undefined ? undefined : parseTime(input.lastSuccessAt, '最近提取成功时间');
  const cooldownUntil = input.cooldownUntil === undefined ? undefined : parseTime(input.cooldownUntil, '提取冷却截止时间');
  const pausedReason = input.pausedReason === undefined ? undefined : parsePauseReason(input.pausedReason);
  const lastFailure = input.lastFailure === undefined ? undefined : parseExtractionFailure(input.lastFailure);
  return {
    throughSeq,
    ...(input.activationVersion === 1 ? { activationVersion: 1 as const } : {}),
    ...(activatedAfterSeq !== undefined ? { activatedAfterSeq } : {}),
    ...(lastCompletedSourceKey !== undefined ? { lastCompletedSourceKey } : {}),
    ...(recentResults !== undefined ? { recentResults } : {}),
    ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
    ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
    ...(pausedReason !== undefined ? { pausedReason } : {}),
    ...(lastFailure !== undefined ? { lastFailure } : {})
  };
}

function parseExtractionResults(raw: unknown, throughSeq: number): MemoryExtractionResult[] {
  if (!Array.isArray(raw) || raw.length > MEMORY_LIMITS.recentExtractionResults) {
    throw new InvalidSpecError(`提取结果摘要必须是不超过${MEMORY_LIMITS.recentExtractionResults}项的数组。`);
  }
  const seen = new Set<string>();
  return raw.map(value => {
    const input = object(value, '提取结果摘要');
    exact(input, ['sourceKey', 'throughSeq', 'at'], '提取结果摘要');
    const sourceKey = parseSourceKey(input.sourceKey, '提取结果来源');
    if (seen.has(sourceKey)) throw new InvalidSpecError('提取结果来源重复。');
    seen.add(sourceKey);
    const seq = parseSeq(input.throughSeq, '提取结果水位');
    if (seq > throughSeq) throw new InvalidSpecError('提取结果水位晚于当前水位。');
    return { sourceKey, throughSeq: seq, at: parseTime(input.at, '提取结果时间') };
  });
}

function parseExtractionFailure(raw: unknown): MemoryExtractionFailure {
  const input = object(raw, '提取失败状态');
  exact(input, ['code', 'at', 'fatal'], '提取失败状态');
  if (typeof input.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(input.code)) throw new InvalidSpecError('提取失败代码无效。');
  if (input.fatal !== undefined && typeof input.fatal !== 'boolean') throw new InvalidSpecError('提取失败标记必须是布尔值。');
  return {
    code: input.code,
    at: parseTime(input.at, '提取失败时间'),
    ...(input.fatal === true ? { fatal: true } : {})
  };
}

function parsePauseReason(raw: unknown): MemoryExtractionPauseReason {
  if (raw !== 'user' && raw !== 'deleted' && raw !== 'cleared' && raw !== 'memory-disabled' && raw !== 'capacity') {
    throw new InvalidSpecError('提取暂停原因无效。');
  }
  return raw;
}

function parseSourceKey(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw new InvalidSpecError(`${label}无效。`);
  return raw;
}

function parseSeq(raw: unknown, label: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw new InvalidSpecError(`${label}无效。`);
  return raw as number;
}

function parseReceipts(raw: unknown): MemoryReceipt[] {
  if (!Array.isArray(raw) || raw.length > MEMORY_LIMITS.receiptLimit) throw new InvalidSpecError('记忆回执必须是有限数组。');
  const seen = new Set<string>();
  return raw.map(value => {
    const input = object(value, '记忆回执');
    exact(input, ['requestId', 'payload', 'recordId', 'at'], '记忆回执');
    if (typeof input.requestId !== 'string' || !SEGMENT.test(input.requestId)) throw new InvalidSpecError('记忆回执请求标识无效。');
    if (typeof input.payload !== 'string' || !/^[a-f0-9]{64}$/.test(input.payload)) throw new InvalidSpecError('记忆回执摘要无效。');
    if (typeof input.recordId !== 'string' || !SEGMENT.test(input.recordId)) throw new InvalidSpecError('记忆回执记录标识无效。');
    if (seen.has(input.requestId)) throw new InvalidSpecError('记忆回执请求标识重复。');
    seen.add(input.requestId);
    return { requestId: input.requestId, payload: input.payload, recordId: input.recordId, at: parseTime(input.at, '回执时间') };
  });
}

export interface SaveSettingsInput {
  settings: MemorySettings;
  expectedScope: string;
  expectedRevision: string;
}

export interface CreateRecordInput {
  requestId: string;
  expectedScope: string;
  expectedRevision: string;
  record: { type: 'fact'; content: string; keys: string[]; pinned: boolean };
}

export interface UpdateRecordInput {
  expectedScope: string;
  expectedRevision: string;
  recordRevision: string;
  content?: string;
  keys?: string[];
  pinned?: boolean;
}

export interface DeleteRecordInput {
  expectedScope: string;
  expectedRevision: string;
  recordRevision: string;
}

export interface ClearInput {
  expectedScope: string;
  expectedRevision: string;
}

export interface PreviewInput {
  text: string;
  expectedScope: string;
}

export interface ActivateExtractionInput {
  expectedScope: string;
  expectedRevision: string;
}

export interface PauseExtractionInput {
  expectedScope: string;
  expectedRevision: string;
}

export function parseActivateExtractionRequest(raw: unknown): ActivateExtractionInput {
  const input = object(raw, '激活提取请求');
  exact(input, ['expectedScope', 'expectedRevision', 'startFrom', 'confirmModelUse'], '激活提取请求');
  if (input.startFrom !== 'now') throw new InvalidSpecError('自动提取只能从当前时间开始，不能回溯旧聊天。');
  if (input.confirmModelUse !== true) throw new InvalidSpecError('激活自动提取必须明确确认会调用模型。');
  return {
    expectedScope: parseScopeToken(input.expectedScope),
    expectedRevision: parseRevision(input.expectedRevision, '记忆状态版本')
  };
}

export function parsePauseExtractionRequest(raw: unknown): PauseExtractionInput {
  const input = object(raw, '暂停提取请求');
  exact(input, ['expectedScope', 'expectedRevision'], '暂停提取请求');
  return {
    expectedScope: parseScopeToken(input.expectedScope),
    expectedRevision: parseRevision(input.expectedRevision, '记忆状态版本')
  };
}

export function parseMemoryPreviewRequest(raw: unknown): PreviewInput {
  const input = object(raw, '记忆预览请求');
  exact(input, ['text', 'expectedScope'], '记忆预览请求');
  if (typeof input.text !== 'string') throw new InvalidSpecError('预览文本必须是字符串。');
  if (input.text.length > MEMORY_LIMITS.scanTailChars) {
    throw new InvalidSpecError(`预览文本最多${MEMORY_LIMITS.scanTailChars}字符。`);
  }
  return { text: input.text.trim(), expectedScope: parseScopeToken(input.expectedScope) };
}

export function parseSaveSettingsRequest(raw: unknown): SaveSettingsInput {
  const input = object(raw, '记忆设置请求');
  exact(input, ['settings', 'expectedScope', 'expectedRevision'], '记忆设置请求');
  return {
    settings: parseMemorySettings(input.settings),
    expectedScope: parseScopeToken(input.expectedScope),
    expectedRevision: parseRevision(input.expectedRevision, '记忆状态版本')
  };
}

export function parseCreateRecordRequest(raw: unknown): CreateRecordInput {
  const input = object(raw, '新增记忆请求');
  exact(input, ['requestId', 'expectedScope', 'expectedRevision', 'record'], '新增记忆请求');
  if (typeof input.requestId !== 'string' || !SEGMENT.test(input.requestId)) throw new InvalidSpecError('requestId必须是1–64位字母、数字、点、下划线或短横线。');
  const record = object(input.record, '记忆记录');
  exact(record, ['type', 'content', 'keys', 'pinned'], '记忆记录');
  if (record.type !== undefined && record.type !== 'fact') throw new InvalidSpecError('手工新增只能创建fact记忆；摘要由提取流程生成。');
  if (record.pinned !== undefined && typeof record.pinned !== 'boolean') throw new InvalidSpecError('记忆固定标记必须是布尔值。');
  return {
    requestId: input.requestId,
    expectedScope: parseScopeToken(input.expectedScope),
    expectedRevision: parseRevision(input.expectedRevision, '记忆状态版本'),
    record: { type: 'fact', content: normalizeContent(record.content), keys: normalizeKeys(record.keys), pinned: record.pinned === true }
  };
}

export function parseUpdateRecordRequest(raw: unknown): UpdateRecordInput {
  const input = object(raw, '更新记忆请求');
  exact(input, ['expectedScope', 'expectedRevision', 'recordRevision', 'content', 'keys', 'pinned'], '更新记忆请求');
  if (input.content === undefined && input.keys === undefined && input.pinned === undefined) throw new InvalidSpecError('更新记忆至少需要提供正文、关键词或固定标记。');
  if (input.pinned !== undefined && typeof input.pinned !== 'boolean') throw new InvalidSpecError('记忆固定标记必须是布尔值。');
  return {
    expectedScope: parseScopeToken(input.expectedScope),
    expectedRevision: parseRevision(input.expectedRevision, '记忆状态版本'),
    recordRevision: parseRevision(input.recordRevision, '记忆记录版本'),
    ...(input.content !== undefined ? { content: normalizeContent(input.content) } : {}),
    ...(input.keys !== undefined ? { keys: normalizeKeys(input.keys) } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {})
  };
}

export function parseDeleteRecordRequest(raw: unknown): DeleteRecordInput {
  const input = object(raw, '删除记忆请求');
  exact(input, ['expectedScope', 'expectedRevision', 'recordRevision'], '删除记忆请求');
  return {
    expectedScope: parseScopeToken(input.expectedScope),
    expectedRevision: parseRevision(input.expectedRevision, '记忆状态版本'),
    recordRevision: parseRevision(input.recordRevision, '记忆记录版本')
  };
}

export function parseClearRequest(raw: unknown): ClearInput {
  const input = object(raw, '清空记忆请求');
  exact(input, ['expectedScope', 'expectedRevision'], '清空记忆请求');
  return {
    expectedScope: parseScopeToken(input.expectedScope),
    expectedRevision: parseRevision(input.expectedRevision, '记忆状态版本')
  };
}

function parseScopeToken(raw: unknown): string {
  if (!isScopeToken(raw)) throw new InvalidSpecError('expectedScope必须是当前记忆作用域标识。');
  return raw;
}

export function parseMemoryListQuery(raw: unknown = {}): { offset: number; limit: number } {
  const query = object(raw, '记忆列表查询');
  exact(query, ['offset', 'limit'], '记忆列表查询');
  const offset = query.offset ?? 0;
  const limit = query.limit ?? MEMORY_LIMITS.pageDefault;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new InvalidSpecError('offset必须是非负整数。');
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MEMORY_LIMITS.pageMax) {
    throw new InvalidSpecError(`limit必须是1–${MEMORY_LIMITS.pageMax}的整数。`);
  }
  return { offset: offset as number, limit: limit as number };
}

export function memoryPayloadDigest(record: CreateRecordInput['record']): string {
  return createHash('sha256').update(canonical({
    type: record.type,
    content: record.content,
    keys: [...record.keys].sort(),
    pinned: record.pinned
  })).digest('hex');
}

/** Exact-dedupe identity for record text; durable across restarts and independent of model formatting. */
export function memoryContentDigest(content: string): string {
  return createHash('sha256')
    .update(content.normalize('NFKC').trim().replace(/\s+/g, ' '))
    .digest('hex');
}
