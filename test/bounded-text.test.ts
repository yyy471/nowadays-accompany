import { describe, expect, it } from 'vitest';
import { truncateTextToFit } from '../src/platform/text/truncate.js';

describe('bounded supplemental text', () => {
  it('keeps content unchanged when it fits exactly', () => {
    expect(truncateTextToFit('中文😀', value => Buffer.byteLength(value, 'utf8') <= 10)).toBe('中文😀');
  });

  it('does not return an oversized marker when the remaining budget is tiny', () => {
    expect(truncateTextToFit('a'.repeat(100), value => Buffer.byteLength(value, 'utf8') <= 3)).toBeUndefined();
  });

  it('reserves the marker and keeps Unicode intact under a byte budget', () => {
    const result = truncateTextToFit('中文😀'.repeat(100), value => Buffer.byteLength(value, 'utf8') <= 50)!;
    expect(result).toContain('[结果已截断]');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(50);
    expect(result).not.toContain('\uFFFD');
    expect(JSON.parse(JSON.stringify(result))).toBe(result);
  });

  it('accounts for JSON escaping and the complete message envelope', () => {
    const encode = (text: string) => JSON.stringify({ messages: [{ role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text }] }] });
    const result = truncateTextToFit('"\\\n😀'.repeat(100), text => encode(text).length <= 180)!;
    expect(encode(result).length).toBeLessThanOrEqual(180);
    expect(result).toContain('[结果已截断]');
  });
});
