import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTavernCard } from '../src/artifacts/tavern-card.js';
import { parseArtifactManifest } from '../src/artifacts/manifest.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let index = 0; index < 8; index++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data = Buffer.alloc(0)) {
  const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length, 0); output.write(type, 4, 4, 'ascii'); data.copy(output, 8);
  output.writeUInt32BE(crc(output.subarray(4, output.length - 4)), output.length - 4); return output;
}
function header(overrides: { width?: number; height?: number; depth?: number; color?: number; compression?: number; filter?: number; interlace?: number } = {}) {
  const output = Buffer.alloc(13); output.writeUInt32BE(overrides.width ?? 1, 0); output.writeUInt32BE(overrides.height ?? 1, 4);
  output[8] = overrides.depth ?? 8; output[9] = overrides.color ?? 6; output[10] = overrides.compression ?? 0; output[11] = overrides.filter ?? 0; output[12] = overrides.interlace ?? 0;
  return chunk('IHDR', output);
}
const image = () => chunk('IDAT', Buffer.from('789c636000020000050001', 'hex'));
const text = (keyword: string, value: string | Buffer) => chunk('tEXt', Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), typeof value === 'string' ? Buffer.from(value, 'ascii') : value]));
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const chara = (value: unknown, keyword = 'chara') => text(keyword, json(value).toString('base64'));
const png = (metadata: Buffer[] = [chara({ name: '角色' })]) => Buffer.concat([signature, header(), image(), ...metadata, chunk('IEND')]);
const v2 = (data: unknown) => ({ spec: 'chara_card_v2', spec_version: '2.0', data });

describe('JSON role conversion', () => {
  it('maps V1 fields into explicit sections and creates stable ids/revisions', () => {
    const bytes = json({ name: '林', description: '{{char}}是一名向导。', personality: '耐心', scenario: '在山中', mes_example: '{{char}}：你好。', first_mes: 'IGNORED_GREETING' });
    const result = parseTavernCard(bytes, 'json');
    expect(result.format).toBe('tavern-v1');
    expect(result.manifest).toEqual({ id: `tavern-${createHash('sha256').update('林').digest('hex').slice(0, 16)}`, revision: `r-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`, kind: 'role-card', name: '林',
      content: '【角色】\n你是林。\n\n【角色描述】\n林是一名向导。\n\n【性格】\n耐心\n\n【场景】\n在山中\n\n【对话示例】\n林：你好。' });
    expect(result.contentLength).toBe(result.manifest.content!.length); expect(result.manifest.content).not.toContain('IGNORED');
    expect(result.warnings.join(' ')).toContain('first_mes'); expect(parseTavernCard(bytes, 'json')).toEqual(result);
    expect(() => parseArtifactManifest(result.manifest, { strict: true })).not.toThrow();
    const changed = parseTavernCard(Buffer.from(`${bytes.toString()} `), 'json');
    expect(changed.manifest.id).toBe(result.manifest.id); expect(changed.manifest.revision).not.toBe(result.manifest.revision);
  });
  it('accepts name-only V1/V2 with a nonempty basic template', () => {
    for (const raw of [{ name: '  A  ' }, v2({ name: 'A' })]) {
      const result = parseTavernCard(json(raw), 'json');
      expect(result.manifest.name).toBe('A'); expect(result.manifest.content).toBe('【角色】\n你是A。'); expect(result.warnings).toEqual([]);
    }
  });
  it('maps V2 system text, substitutes char safely, preserves other macros and never injects metadata', () => {
    const result = parseTavernCard(json(v2({ name: '$&', description: '{{char}} {{CHAR}} {{user}} {{getvar::remote}}', system_prompt: 'SYS {{original}}', post_history_instructions: 'POST',
      first_mes: 'FIRST_SENTINEL', alternate_greetings: ['GREETING_SENTINEL'], creator_notes: 'NOTES_SENTINEL',
      character_book: { entries: [{ content: 'BOOK_SENTINEL', enabled: true }] }, extensions: { script: 'SCRIPT_SENTINEL', remote: 'https://invalid.example' }, tags: ['TAG_SENTINEL'], creator: 'AUTHOR_SENTINEL', character_version: 'VERSION_SENTINEL' })), 'json');
    expect(result.format).toBe('tavern-v2'); expect(result.manifest.content).toContain('$& $& {{user}} {{getvar::remote}}');
    expect(result.manifest.content).toContain('【系统提示补充】\nSYS {{original}}'); expect(result.manifest.content).toContain('【历史后置指令】\nPOST');
    expect(result.manifest.content).not.toContain('SENTINEL'); expect(result.manifest.content).not.toContain('https://');
    for (const field of ['{{user}}', 'first_mes', 'alternate_greetings', 'creator_notes', 'character_book', 'extensions', 'tags', 'creator', 'character_version', 'system_prompt']) expect(result.warnings.join(' ')).toContain(field);
  });
  it('does not traverse or evaluate nested worldbook/extension objects', () => {
    const nested = `${'{"a":'.repeat(2000)}"NEVER_INJECT"${'}'.repeat(2000)}`;
    const result = parseTavernCard(Buffer.from(`{"name":"A","extensions":${nested},"character_book":${nested}}`), 'json');
    expect(result.manifest.content).toBe('【角色】\n你是A。'); expect(result.warnings.join(' ')).toContain('未注入');
  });
  it('warns about engine truncation without truncating the imported content', () => {
    const result = parseTavernCard(json({ name: 'A', description: 'x'.repeat(12001) }), 'json');
    expect(result.contentLength).toBeGreaterThan(12000); expect(result.manifest.content).toContain('x'.repeat(12001)); expect(result.warnings.join(' ')).toContain('12000');
  });
  it.each([null, [], 'text', {}, { name: '' }, { name: '   ' }, { name: 123 }, { name: 'x'.repeat(16385) },
    { name: 'A', spec: 'chara_card_v3', spec_version: '3.0' }, { name: 'A', spec: 'unknown' }, { name: 'A', spec_version: '2.0' },
    { spec: 'chara_card_v2', spec_version: 2, data: { name: 'A' } }, v2(null), v2([]), v2({})
  ])('rejects invalid root/name/spec: %j', value => { expect(() => parseTavernCard(json(value), 'json')).toThrow(); });
  it.each(['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'creator', 'character_version'])('requires strict text for %s', field => {
    for (const value of [123, false, null, [], {}]) {
      expect(() => parseTavernCard(json({ name: 'A', [field]: value }), 'json')).toThrow(field);
      expect(() => parseTavernCard(json(v2({ name: 'A', [field]: value })), 'json')).toThrow(field);
    }
  });
  it.each([{ alternate_greetings: 'bad' }, { alternate_greetings: [1] }, { tags: [null] }, { extensions: [] }, { character_book: null }])('rejects malformed metadata shapes %j', value => {
    expect(() => parseTavernCard(json(v2({ name: 'A', ...value })), 'json')).toThrow();
  });
  it('rejects oversized files, JSON metadata and invalid UTF8/JSON', () => {
    expect(() => parseTavernCard(Buffer.alloc(8 * 1024 * 1024 + 1), 'png')).toThrow('8MiB');
    expect(() => parseTavernCard(json({ name: 'A', description: 'x'.repeat(2 * 1024 * 1024) }), 'json')).toThrow('2MiB');
    expect(() => parseTavernCard(Buffer.from('{bad'), 'json')).toThrow('JSON');
    expect(() => parseTavernCard(Buffer.from([0xc3, 0x28]), 'json')).toThrow('UTF-8');
  });
  it('rejects standalone worldbooks and warns about unknown archived fields', () => {
    expect(() => parseTavernCard(json({ name: 'World book', entries: [] }), 'json')).toThrow('独立世界书');
    expect(() => parseTavernCard(json({ name: 'World book', entries: [{ content: 'entry' }] }), 'json')).toThrow('独立世界书');
    for (const raw of [{ name: 'A', custom: 'NEVER_INJECT' }, v2({ name: 'A', custom: { nested: 'NEVER_INJECT' } }), { ...v2({ name: 'A' }), legacy_extra: true }]) {
      const result = parseTavernCard(json(raw), 'json');
      expect(result.manifest.content).not.toContain('NEVER_INJECT'); expect(result.warnings.join(' ')).toContain('未识别字段');
    }
  });
});

describe('PNG bounded structural metadata reader', () => {
  it('reads valid chara before or after image data and ignores unknown chunks', () => {
    for (const bytes of [png([text('Comment', 'note'), chunk('vpAg', Buffer.from('unused')), chara(v2({ name: '图像角色' }), 'ChArA')]),
      Buffer.concat([signature, header(), chara({ name: '图像角色' }), image(), chunk('IEND')])]) {
      const result = parseTavernCard(bytes, 'png'); expect(result.manifest.name).toBe('图像角色'); expect(result.manifest.kind).toBe('role-card');
    }
  });
  it('prefers chara with an explicit V3 warning and rejects V3-only or V3 in chara', () => {
    const result = parseTavernCard(png([chara(v2({ name: 'V2' })), text('ccv3', 'ignored-v3-data')]), 'png');
    expect(result.format).toBe('tavern-v2'); expect(result.manifest.name).toBe('V2'); expect(result.warnings.join(' ')).toContain('优先使用chara');
    expect(() => parseTavernCard(png([chara({ spec: 'chara_card_v3' }, 'ccv3')]), 'png')).toThrow('V3');
    expect(() => parseTavernCard(png([chara({ spec: 'chara_card_v3' })]), 'png')).toThrow('V3');
  });
  it('rejects duplicate chara even with matching contents or mixed case keywords', () => {
    expect(() => parseTavernCard(png([chara({ name: 'A' }), chara({ name: 'A' }, 'CHARA')]), 'png')).toThrow('重复chara');
  });
  it('rejects unknown critical PNG chunks while preserving ancillary compatibility', () => {
    expect(() => parseTavernCard(png([chunk('ABCD'), chara({ name: 'A' })]), 'png')).toThrow('关键数据块');
    expect(() => parseTavernCard(png([chunk('abCd'), chara({ name: 'A' })]), 'png')).not.toThrow();
  });
  it('checks every CRC and detects out of bounds or truncated chunks', () => {
    const corrupt = png(); corrupt[corrupt.length - 1]! ^= 1;
    expect(() => parseTavernCard(corrupt, 'png')).toThrow('CRC');
    const badLength = png(); badLength.writeUInt32BE(0xffffffff, 8);
    expect(() => parseTavernCard(badLength, 'png')).toThrow('越界');
    expect(() => parseTavernCard(png().subarray(0, png().length - 3), 'png')).toThrow();
    expect(() => parseTavernCard(Buffer.concat([signature, Buffer.alloc(3)]), 'png')).toThrow('不完整');
    expect(() => parseTavernCard(Buffer.alloc(8), 'png')).toThrow('签名');
  });
  it.each([
    [image(), header(), chunk('IEND')], [header(), header(), image(), chunk('IEND')], [header(), chunk('IEND')],
    [header(), image()], [header(), chunk('IDAT'), chunk('IEND')], [header(), image(), chunk('IEND', Buffer.from('x'))],
    [header(), image(), chara({ name: 'A' }), image(), chunk('IEND')], [header(), image(), chunk('IEND'), chara({ name: 'A' })],
    [header(), image(), chunk('IEND'), chunk('IEND')], [header(), image(), chunk('vpbg'), chunk('IEND')]
  ])('rejects invalid PNG chunk order/shape %#', (...chunks) => {
    expect(() => parseTavernCard(Buffer.concat([signature, ...chunks]), 'png')).toThrow();
  });
  it.each([{ width: 0 }, { height: 0x80000000 }, { depth: 3 }, { color: 5 }, { compression: 1 }, { filter: 1 }, { interlace: 2 }])('validates IHDR %j', value => {
    expect(() => parseTavernCard(Buffer.concat([signature, header(value), image(), chara({ name: 'A' }), chunk('IEND')]), 'png')).toThrow('IHDR');
  });
  it('requires a valid palette for indexed color and limits chunk counts', () => {
    expect(() => parseTavernCard(Buffer.concat([signature, header({ color: 3 }), image(), chara({ name: 'A' }), chunk('IEND')]), 'png')).toThrow('调色板');
    expect(parseTavernCard(Buffer.concat([signature, header({ color: 3 }), chunk('PLTE', Buffer.from([0, 0, 0])), image(), chara({ name: 'A' }), chunk('IEND')]), 'png').manifest.name).toBe('A');
    expect(() => parseTavernCard(png(Array.from({ length: 4096 }, () => chunk('vpAg'))), 'png')).toThrow('数量');
  });
  it.each(['', '@@bad', 'e30', 'e30===', 'e3\n0=', 'YR==', '===='])('rejects invalid base64 %j', encoded => {
    expect(() => parseTavernCard(png([text('chara', encoded)]), 'png')).toThrow();
  });
  it('rejects missing chara, invalid text boundaries, invalid decoded UTF8 and decoded payload limits', () => {
    expect(() => parseTavernCard(png([]), 'png')).toThrow('chara');
    expect(() => parseTavernCard(png([chunk('tEXt', Buffer.from('no-null'))]), 'png')).toThrow('tEXt');
    expect(() => parseTavernCard(png([text('chara', Buffer.from([0xc3, 0x28]).toString('base64'))]), 'png')).toThrow('UTF-8');
    expect(() => parseTavernCard(png([text('chara', Buffer.alloc(2 * 1024 * 1024 + 1, 65).toString('base64'))]), 'png')).toThrow('2MiB');
    expect(() => parseTavernCard(png([text('chara', json({ name: 'A' }).toString('base64')), chunk('vpAg', Buffer.from('unknown'))]), 'png')).not.toThrow();
  });
  it('parses large valid metadata near the decoded limit without overflowing the regex stack', () => {
    const description = 'x'.repeat(2 * 1024 * 1024 - 128);
    const result = parseTavernCard(png([chara({ name: 'Large', description })]), 'png');
    expect(result.manifest.name).toBe('Large');
    expect(result.manifest.content).toContain(description);
    expect(result.warnings.join(' ')).toContain('12000');
  });
});
