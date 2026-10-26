import { InvalidSpecError } from '../core/errors.js';

/** Bounded subset shared by plugin declarations and runtime argument validation. */
export const TOOL_SCHEMA_LIMITS = {
  maxBytes: 16 * 1024,
  maxDepth: 8,
  maxNodes: 256,
  maxProperties: 64,
  maxRequired: 64,
  maxEnumValues: 64,
  maxDescription: 500,
  maxStringLength: 16_384,
  maxArrayItems: 1_000,
  maxArgumentNodes: 8_192
} as const;

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
export type ToolSchemaType = (typeof SCHEMA_TYPES)[number];

const TYPE_SET = new Set<string>(SCHEMA_TYPES);
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_PROPERTY_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const COMMON_KEYS = ['type', 'description', 'enum'] as const;

const TYPE_KEYS: Record<ToolSchemaType, readonly string[]> = {
  object: [...COMMON_KEYS, 'properties', 'required', 'additionalProperties'],
  array: [...COMMON_KEYS, 'items', 'minItems', 'maxItems'],
  string: [...COMMON_KEYS, 'minLength', 'maxLength'],
  number: [...COMMON_KEYS, 'minimum', 'maximum'],
  integer: [...COMMON_KEYS, 'minimum', 'maximum'],
  boolean: [...COMMON_KEYS],
  null: [...COMMON_KEYS]
};

interface WalkState {
  nodes: number;
  path: string;
}

/**
 * Validates the deliberately small JSON Schema subset accepted by the tool layer. It is not a
 * general JSON Schema implementation: unsupported keywords are rejected at registration time.
 */
export function validateToolInputSchema(raw: unknown, path = 'inputSchema'): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new InvalidSpecError(`${path} 必须是对象 schema。`);
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new InvalidSpecError(`${path} 必须是可序列化的 JSON schema。`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > TOOL_SCHEMA_LIMITS.maxBytes) {
    throw new InvalidSpecError(`${path} 超过 ${TOOL_SCHEMA_LIMITS.maxBytes} 字节上限。`);
  }
  const state: WalkState = { nodes: 0, path };
  walkNode(raw, path, 0, state);
  const type = (raw as { type?: unknown }).type;
  if (type !== 'object') throw new InvalidSpecError(`${path}.type 必须是 object（工具参数必须是对象）。`);
  return raw;
}

function walkNode(raw: Record<string, unknown>, path: string, depth: number, state: WalkState): void {
  if (depth > TOOL_SCHEMA_LIMITS.maxDepth) {
    throw new InvalidSpecError(`${path} 嵌套深度超过 ${TOOL_SCHEMA_LIMITS.maxDepth}。`);
  }
  state.nodes += 1;
  if (state.nodes > TOOL_SCHEMA_LIMITS.maxNodes) {
    throw new InvalidSpecError(`${state.path} 节点数超过 ${TOOL_SCHEMA_LIMITS.maxNodes}。`);
  }
  const type = raw.type;
  if (typeof type !== 'string' || !TYPE_SET.has(type)) {
    throw new InvalidSpecError(`${path}.type 必须是 ${SCHEMA_TYPES.join('、')} 之一。`);
  }
  const schemaType = type as ToolSchemaType;
  for (const key of Object.keys(raw)) {
    if (!TYPE_KEYS[schemaType].includes(key)) {
      throw new InvalidSpecError(`${path}.${key} 不是受支持的 schema 关键字（${schemaType}）。`);
    }
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > TOOL_SCHEMA_LIMITS.maxDescription) {
      throw new InvalidSpecError(`${path}.description 必须是不超过 ${TOOL_SCHEMA_LIMITS.maxDescription} 字符的文本。`);
    }
  }
  if (raw.enum !== undefined) validateEnum(raw.enum, schemaType, `${path}.enum`);

  if (schemaType === 'object') {
    validateObject(raw, path, depth, state);
  } else if (schemaType === 'array') {
    if (!isPlainObject(raw.items)) throw new InvalidSpecError(`${path}.items 必须是对象 schema。`);
    walkNode(raw.items, `${path}.items`, depth + 1, state);
    validateRange(raw.minItems, raw.maxItems, `${path}.minItems`, `${path}.maxItems`, TOOL_SCHEMA_LIMITS.maxArrayItems);
  } else if (schemaType === 'string') {
    validateRange(raw.minLength, raw.maxLength, `${path}.minLength`, `${path}.maxLength`, TOOL_SCHEMA_LIMITS.maxStringLength);
  } else if (schemaType === 'number' || schemaType === 'integer') {
    validateNumberBounds(raw, schemaType, path);
  }
}

function validateObject(raw: Record<string, unknown>, path: string, depth: number, state: WalkState): void {
  const propertiesRaw = raw.properties;
  if (!isPlainObject(propertiesRaw)) throw new InvalidSpecError(`${path}.properties 必须是对象。`);
  const names = Object.keys(propertiesRaw);
  if (names.length > TOOL_SCHEMA_LIMITS.maxProperties) {
    throw new InvalidSpecError(`${path}.properties 超过 ${TOOL_SCHEMA_LIMITS.maxProperties} 个字段。`);
  }
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    if (!PROPERTY_NAME.test(name) || RESERVED_PROPERTY_NAMES.has(name)) {
      throw new InvalidSpecError(`${path}.properties 包含无效字段名 ${JSON.stringify(name)}。`);
    }
    const value = propertiesRaw[name];
    if (!isPlainObject(value)) throw new InvalidSpecError(`${path}.properties.${name} 必须是对象 schema。`);
    walkNode(value, `${path}.properties.${name}`, depth + 1, state);
    properties[name] = value;
  }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required)) throw new InvalidSpecError(`${path}.required 必须是数组。`);
    if (raw.required.length > TOOL_SCHEMA_LIMITS.maxRequired) {
      throw new InvalidSpecError(`${path}.required 超过 ${TOOL_SCHEMA_LIMITS.maxRequired} 项。`);
    }
    const seen = new Set<string>();
    for (const name of raw.required) {
      if (typeof name !== 'string') throw new InvalidSpecError(`${path}.required 包含无效字段。`);
      if (seen.has(name)) throw new InvalidSpecError(`${path}.required 不能重复。`);
      seen.add(name);
      if (!Object.prototype.hasOwnProperty.call(properties, name)) {
        throw new InvalidSpecError(`${path}.required 引用了未声明字段 ${name}。`);
      }
    }
  }
  if (raw.additionalProperties !== undefined && typeof raw.additionalProperties !== 'boolean') {
    throw new InvalidSpecError(`${path}.additionalProperties 必须是布尔值。`);
  }
}

function validateEnum(value: unknown, type: ToolSchemaType, path: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new InvalidSpecError(`${path} 必须是非空数组。`);
  if (value.length > TOOL_SCHEMA_LIMITS.maxEnumValues) {
    throw new InvalidSpecError(`${path} 超过 ${TOOL_SCHEMA_LIMITS.maxEnumValues} 项。`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (type === 'string') {
      if (typeof entry !== 'string' || entry.length > TOOL_SCHEMA_LIMITS.maxStringLength) {
        throw new InvalidSpecError(`${path} 只允许不超过 ${TOOL_SCHEMA_LIMITS.maxStringLength} 字符的字符串。`);
      }
    } else if (type === 'integer') {
      if (!Number.isSafeInteger(entry)) throw new InvalidSpecError(`${path} 只允许安全整数。`);
    } else if (type === 'number') {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new InvalidSpecError(`${path} 只允许有限数字。`);
    } else if (type === 'boolean') {
      if (typeof entry !== 'boolean') throw new InvalidSpecError(`${path} 只允许布尔值。`);
    } else if (type === 'null') {
      if (entry !== null) throw new InvalidSpecError(`${path} 只允许 null。`);
    } else {
      throw new InvalidSpecError(`${path} 不支持 ${type} 枚举。`);
    }
    const key = JSON.stringify(entry);
    if (seen.has(key)) throw new InvalidSpecError(`${path} 不能包含重复项。`);
    seen.add(key);
  }
}

function validateRange(
  min: unknown,
  max: unknown,
  minPath: string,
  maxPath: string,
  limit: number
): void {
  const lower = min === undefined ? 0 : min;
  const upper = max === undefined ? limit : max;
  if (!Number.isSafeInteger(lower) || (lower as number) < 0 || (lower as number) > limit) {
    throw new InvalidSpecError(`${minPath} 必须是 0 到 ${limit} 的整数。`);
  }
  if (!Number.isSafeInteger(upper) || (upper as number) < 0 || (upper as number) > limit) {
    throw new InvalidSpecError(`${maxPath} 必须是 0 到 ${limit} 的整数。`);
  }
  if ((upper as number) < (lower as number)) throw new InvalidSpecError(`${maxPath} 不能小于 ${minPath}。`);
}

function validateNumberBounds(raw: Record<string, unknown>, type: ToolSchemaType, path: string): void {
  const minimum = raw.minimum;
  const maximum = raw.maximum;
  if (minimum !== undefined && (typeof minimum !== 'number' || !Number.isFinite(minimum))) {
    throw new InvalidSpecError(`${path}.minimum 必须是有限数字。`);
  }
  if (maximum !== undefined && (typeof maximum !== 'number' || !Number.isFinite(maximum))) {
    throw new InvalidSpecError(`${path}.maximum 必须是有限数字。`);
  }
  if (typeof minimum === 'number' && typeof maximum === 'number' && maximum < minimum) {
    throw new InvalidSpecError(`${path}.maximum 不能小于 minimum。`);
  }
  if (type === 'integer') {
    if (typeof minimum === 'number' && !Number.isSafeInteger(minimum)) {
      throw new InvalidSpecError(`${path}.minimum 必须是安全整数。`);
    }
    if (typeof maximum === 'number' && !Number.isSafeInteger(maximum)) {
      throw new InvalidSpecError(`${path}.maximum 必须是安全整数。`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface ArgumentWalkState {
  nodes: number;
}

/**
 * Validates parsed tool arguments against the same bounded subset. Error messages only contain
 * schema-declared paths and keywords; undeclared field names are not echoed back.
 */
export function validateToolArguments(schema: Record<string, unknown>, value: unknown, path = 'arguments'): void {
  if (!isPlainObject(value)) throw new InvalidSpecError(`${path} 必须是对象。`);
  const state: ArgumentWalkState = { nodes: 0 };
  assertValueShape(value, path, 0, state);
  validateValue(schema, value, path, 0);
}

function assertValueShape(value: unknown, path: string, depth: number, state: ArgumentWalkState): void {
  if (depth > TOOL_SCHEMA_LIMITS.maxDepth) {
    throw new InvalidSpecError(`${path} 嵌套深度超过 ${TOOL_SCHEMA_LIMITS.maxDepth}。`);
  }
  state.nodes += 1;
  if (state.nodes > TOOL_SCHEMA_LIMITS.maxArgumentNodes) {
    throw new InvalidSpecError(`${path} 参数节点数超过 ${TOOL_SCHEMA_LIMITS.maxArgumentNodes}。`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertValueShape(entry, `${path}[${index}]`, depth + 1, state);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (RESERVED_PROPERTY_NAMES.has(key)) throw new InvalidSpecError(`${path} 包含不允许的字段名。`);
    assertValueShape(value[key], `${path}.${key}`, depth + 1, state);
  }
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string, depth: number): void {
  if (depth > TOOL_SCHEMA_LIMITS.maxDepth) {
    throw new InvalidSpecError(`${path} 嵌套深度超过 ${TOOL_SCHEMA_LIMITS.maxDepth}。`);
  }
  const type = schema.type;
  if (typeof type !== 'string' || !TYPE_SET.has(type)) throw new InvalidSpecError(`${path} schema 类型无效。`);
  const schemaType = type as ToolSchemaType;
  if (schemaType === 'object') {
    if (!isPlainObject(value)) throw new InvalidSpecError(`${path} 必须是对象。`);
    validateObjectValue(schema, value, path, depth);
  } else if (schemaType === 'array') {
    validateArrayValue(schema, value, path, depth);
  } else if (schemaType === 'string') {
    if (typeof value !== 'string') throw new InvalidSpecError(`${path} 必须是字符串。`);
    validateStringValue(schema, value, path);
  } else if (schemaType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidSpecError(`${path} 必须是有限数字。`);
    validateNumericValue(schema, value, path);
  } else if (schemaType === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new InvalidSpecError(`${path} 必须是安全整数。`);
    validateNumericValue(schema, value, path);
  } else if (schemaType === 'boolean') {
    if (typeof value !== 'boolean') throw new InvalidSpecError(`${path} 必须是布尔值。`);
  } else if (value !== null) {
    throw new InvalidSpecError(`${path} 必须是 null。`);
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((entry) => entry === value)) {
    throw new InvalidSpecError(`${path} 不在允许的枚举值内。`);
  }
}

function validateObjectValue(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  depth: number
): void {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
      throw new InvalidSpecError(`${path}.${name} 是必填字段。`);
    }
  }
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) continue;
    validateValue(propertySchema as Record<string, unknown>, value[name], `${path}.${name}`, depth + 1);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw new InvalidSpecError(`${path} 包含未声明字段。`);
      }
    }
  }
}

function validateArrayValue(schema: Record<string, unknown>, value: unknown, path: string, depth: number): void {
  if (!Array.isArray(value)) throw new InvalidSpecError(`${path} 必须是数组。`);
  const max = typeof schema.maxItems === 'number' ? schema.maxItems : TOOL_SCHEMA_LIMITS.maxArrayItems;
  if (value.length > max) throw new InvalidSpecError(`${path} 超过 ${max} 项上限。`);
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    throw new InvalidSpecError(`${path} 少于 ${schema.minItems} 项下限。`);
  }
  const items = isPlainObject(schema.items) ? schema.items : undefined;
  if (!items) throw new InvalidSpecError(`${path} schema 缺少 items。`);
  for (const [index, entry] of value.entries()) {
    validateValue(items, entry, `${path}[${index}]`, depth + 1);
  }
}

function validateStringValue(schema: Record<string, unknown>, value: string, path: string): void {
  const max = typeof schema.maxLength === 'number' ? schema.maxLength : TOOL_SCHEMA_LIMITS.maxStringLength;
  if (value.length > max) throw new InvalidSpecError(`${path} 超过 ${max} 字符上限。`);
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    throw new InvalidSpecError(`${path} 少于 ${schema.minLength} 字符下限。`);
  }
}

function validateNumericValue(schema: Record<string, unknown>, value: number, path: string): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    throw new InvalidSpecError(`${path} 小于最小值。`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    throw new InvalidSpecError(`${path} 大于最大值。`);
  }
}
