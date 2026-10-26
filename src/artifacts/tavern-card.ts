import { createHash } from 'node:crypto';
import { InvalidSpecError } from '../core/errors.js';
import type { ArtifactManifest } from './types.js';
import { convertTavernWorldbook } from '../worldbook/tavern.js';

export interface ParsedTavernCard {
  manifest: ArtifactManifest;
  format: 'tavern-v1' | 'tavern-v2';
  warnings: string[];
  contentLength: number;
}
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS = 4096;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXT_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'creator', 'character_version'] as const;
const CONTENT_SECTIONS = [
  ['description', '角色描述'], ['personality', '性格'], ['scenario', '场景'], ['mes_example', '对话示例'],
  ['system_prompt', '系统提示补充'], ['post_history_instructions', '历史后置指令']
] as const;

/** Pure bounded conversion; preserves unsupported metadata only through the caller's original file. */
export function parseTavernCard(bytes: Buffer, format: 'json' | 'png'): ParsedTavernCard {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw new InvalidSpecError('角色卡原文件不能超过8MiB。');
  if (format !== 'json' && format !== 'png') throw new InvalidSpecError('只支持酒馆角色卡JSON或PNG。');
  const warnings: string[] = [];
  const metadata = format === 'png' ? readPngMetadata(bytes, warnings) : bytes;
  if (metadata.length > MAX_METADATA_BYTES) throw new InvalidSpecError('角色卡JSON元数据不能超过2MiB。');
  let raw: unknown;
  try { raw = JSON.parse(decodeUtf8(metadata)); }
  catch (error) {
    if (error instanceof InvalidSpecError) throw error;
    throw new InvalidSpecError('角色卡元数据不是有效JSON。');
  }
  const root = object(raw, '角色卡');
  let card: Record<string, unknown>, version: ParsedTavernCard['format'];
  if (root.spec !== undefined || root.spec_version !== undefined) {
    if (root.spec === 'chara_card_v3') throw new InvalidSpecError('暂不支持酒馆V3角色卡，请导出V2兼容格式。');
    if (root.spec !== 'chara_card_v2' || root.spec_version !== '2.0') throw new InvalidSpecError('不支持此角色卡spec或spec_version；仅支持V1及chara_card_v2 / 2.0。');
    card = object(root.data, 'V2 data'); version = 'tavern-v2';
  } else {
    if (Array.isArray(root.entries)) throw new InvalidSpecError('检测到独立世界书entries，暂不支持作为角色卡导入。');
    card = root; version = 'tavern-v1';
  }
  if (typeof card.name !== 'string' || !card.name.trim()) throw new InvalidSpecError('角色卡name必须是非空文本。');
  if (card.name.length > 16384) throw new InvalidSpecError('角色卡name不能超过16384字符。');
  const name = card.name.trim();
  for (const field of TEXT_FIELDS) {
    if (card[field] !== undefined && typeof card[field] !== 'string') throw new InvalidSpecError(`角色卡${field}必须是文本。`);
  }
  for (const field of ['alternate_greetings', 'tags']) {
    const value = card[field];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new InvalidSpecError(`角色卡${field}必须是文本数组。`);
  }
  for (const field of ['character_book', 'extensions']) {
    if (card[field] !== undefined) object(card[field], `角色卡${field}`);
  }
  const knownFields = new Set(['name', ...TEXT_FIELDS, 'alternate_greetings', 'tags', 'character_book', 'extensions']);
  if (Object.keys(card).some(key => !knownFields.has(key))
    || (version === 'tavern-v2' && Object.keys(root).some(key => !['spec', 'spec_version', 'data'].includes(key)))) {
    warnings.push('其他未识别字段只保留于原始角色卡文件归档，未生效。');
  }
  const sections = [`【角色】\n你是${name}。`];
  for (const [field, heading] of CONTENT_SECTIONS) {
    const value = card[field] as string | undefined;
    if (value?.trim()) sections.push(`【${heading}】\n${value.trim().replace(/\{\{char\}\}/gi, () => name)}`);
  }
  const content = sections.join('\n\n');
  if (/\{\{[^{}]*\}\}/.test(content)) warnings.push('保留了{{user}}或其他宏的原文；当前引擎不会展开这些宏，也不会执行其中的内容。');
  const ignored: Array<[string, string]> = [
    ['first_mes', '开场白first_mes'], ['alternate_greetings', '备选开场白alternate_greetings'], ['creator_notes', '作者说明creator_notes'],
    ['extensions', '扩展配置extensions'], ['tags', '标签tags'], ['creator', '作者creator'], ['character_version', '角色版本character_version']
  ];
  for (const [field, label] of ignored) {
    if (card[field] !== undefined) warnings.push(`${label}未注入角色设定，也不会自动生效；仅保留于原始角色卡文件。`);
  }
  if ((card.system_prompt as string | undefined)?.trim() || (card.post_history_instructions as string | undefined)?.trim()) warnings.push('system_prompt及post_history_instructions作为角色设定分节保留，不替代应用系统指令或执行酒馆的注入位置规则。');
  if (content.length > 12000) warnings.push('转换后的角色设定超过12000字符，当前引擎默认角色上下文限制可能截断后半部分。');
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  const converted = card.character_book !== undefined ? convertTavernWorldbook(card.character_book) : { warnings: [] };
  warnings.push(...converted.warnings);
  if (converted.worldbook) warnings.push('角色世界书character_book已转换，默认关闭；部署并绑定角色卡后，须在该会话的世界书设置中单独开启。');
  return { manifest: { id: `tavern-${digest(name)}`, kind: 'role-card', revision: `r-${digest(bytes)}`, name, content,
    ...(converted.worldbook ? { worldbook: converted.worldbook } : {}) }, format: version, warnings, contentLength: content.length };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidSpecError(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}
function decodeUtf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new InvalidSpecError('角色卡JSON元数据必须使用有效UTF-8编码。'); }
}

function readPngMetadata(bytes: Buffer, warnings: string[]): Buffer {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new InvalidSpecError('PNG文件签名无效。');
  let offset = 8, count = 0, seenHeader = false, seenImage = false, imageEnded = false, seenEnd = false;
  let palette = false, colorType = -1, imageBytes = 0;
  let chara: Buffer | undefined, hasV3 = false;
  while (offset < bytes.length) {
    if (++count > MAX_CHUNKS) throw new InvalidSpecError('PNG数据块数量超过限制。');
    if (bytes.length - offset < 12) throw new InvalidSpecError('PNG数据块头或CRC不完整。');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new InvalidSpecError('PNG数据块长度越界。');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (!typeBytes.every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) || (typeBytes[2]! & 32) !== 0) throw new InvalidSpecError('PNG数据块类型无效。');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw new InvalidSpecError(`PNG ${type}数据块CRC校验失败。`);
    if ((typeBytes[0]! & 32) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) throw new InvalidSpecError('PNG包含无法识别的关键数据块，不能安全解析。');
    if (!seenHeader && type !== 'IHDR') throw new InvalidSpecError('PNG必须以IHDR数据块开始。');
    if (type === 'IHDR') {
      if (seenHeader || length !== 13) throw new InvalidSpecError('PNG IHDR必须是唯一的13字节数据块。');
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8]!; colorType = data[9]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[colorType]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) throw new InvalidSpecError('PNG IHDR图像参数无效。');
      seenHeader = true;
    } else if (type === 'PLTE') {
      if (palette || seenImage || colorType === 0 || colorType === 4 || !length || length > 768 || length % 3) throw new InvalidSpecError('PNG PLTE调色板结构无效。');
      palette = true;
    } else if (type === 'IDAT') {
      if (imageEnded || (colorType === 3 && !palette)) throw new InvalidSpecError('PNG IDAT顺序或调色板结构无效。');
      seenImage = true; imageBytes += length;
    } else if (type === 'IEND') {
      if (length !== 0 || !seenImage || !imageBytes) throw new InvalidSpecError('PNG IEND或IDAT结构无效。');
      seenEnd = true;
    }
    if (seenImage && type !== 'IDAT') imageEnded = true;
    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator < 1 || separator > 79) throw new InvalidSpecError('PNG tEXt关键字结构无效。');
      const keyword = data.toString('latin1', 0, separator).toLowerCase();
      if (keyword === 'chara') {
        if (chara !== undefined) throw new InvalidSpecError('PNG包含重复chara元数据，无法确定角色卡内容。');
        const encoded = data.subarray(separator + 1);
        if (!encoded.length || encoded.length > Math.ceil(MAX_METADATA_BYTES / 3) * 4) throw new InvalidSpecError('PNG chara元数据为空、编码无效或超过2MiB限制。');
        if (!validBase64Bytes(encoded)) throw new InvalidSpecError('PNG chara不是有效base64编码。');
        const text = encoded.toString('ascii');
        chara = Buffer.from(text, 'base64');
        if (chara.length > MAX_METADATA_BYTES || chara.toString('base64') !== text) throw new InvalidSpecError('PNG chara不是规范base64编码或超过2MiB限制。');
      } else if (keyword === 'ccv3') hasV3 = true;
    }
    offset += length + 12;
    if (seenEnd) {
      if (offset !== bytes.length) throw new InvalidSpecError('PNG IEND之后存在额外数据。');
      break;
    }
  }
  if (!seenEnd) throw new InvalidSpecError('PNG缺少完整IHDR、IDAT或IEND结构。');
  if (!chara) {
    if (hasV3) throw new InvalidSpecError('此PNG只有ccv3元数据，暂不支持V3，请导出带chara的V2兼容角色卡。');
    throw new InvalidSpecError('PNG未包含chara角色卡元数据。');
  }
  if (hasV3) warnings.push('PNG同时含chara和ccv3；本次优先使用chara兼容字段，V3元数据未生效。');
  return chara;
}

/** Linear byte validation avoids regex backtracking/stack limits for multi-megabyte metadata. */
function validBase64Bytes(bytes: Buffer): boolean {
  if (bytes.length % 4 !== 0) return false;
  let padding = 0;
  for (const byte of bytes) {
    if (byte === 61) { if (++padding > 2) return false; }
    else if (padding || !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 43 || byte === 47)) return false;
  }
  return true;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let index = 0; index < 8; index++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
