import { expect, it } from 'vitest';
import { parseExtractionOutput } from '../src/application/memory/extraction/output.js';
import { MEMORY_LIMITS } from '../src/memory/types.js';

const seqs = [7, 8, 9];

function parse(raw: unknown, allowed = seqs) {
  return parseExtractionOutput(raw, allowed);
}

it('accepts one strict facts object and normalizes keys and duplicate evidence', () => {
  const facts = parse(JSON.stringify({
    facts: [
      { content: '  喜欢银杏 ', keys: ['银杏', ' 银杏 ', '', '植物'], evidenceSeqs: [7, 7] },
      { content: '住在杭州', keys: [], evidenceSeqs: [8, 9] }
    ]
  }));
  expect(facts).toEqual([
    { content: '喜欢银杏', keys: ['银杏', '植物'], evidenceSeqs: [7] },
    { content: '住在杭州', keys: [], evidenceSeqs: [8, 9] }
  ]);
});

it('treats empty facts as a valid completion', () => {
  expect(parse('{"facts":[]}')).toEqual([]);
  expect(parse('  {"facts" : [] }  ')).toEqual([]);
});

it('rejects Markdown, extra text, non-objects and unknown top-level fields', () => {
  for (const raw of [
    '```json\n{"facts":[]}\n```',
    'Result: {"facts":[]}',
    '{"facts":[]} trailing',
    '[]',
    'null',
    '{"facts":[],"note":"x"}',
    '{"facts":{},"note":"x"}',
    ''
  ]) {
    expect(() => parse(raw), raw).toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  }
});

it('rejects model-owned metadata and unknown fact fields', () => {
  for (const extra of [
    { id: 'r-forged' },
    { origin: 'user' },
    { type: 'summary' },
    { pinned: true },
    { source: { fromSeq: 1, throughSeq: 9 } },
    { createdAt: 1 }
  ]) {
    const raw = JSON.stringify({
      facts: [{ content: '事实', keys: [], evidenceSeqs: [7], ...extra }]
    });
    expect(() => parse(raw), JSON.stringify(extra)).toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  }
  expect(() => parse(JSON.stringify({ facts: [{ content: '事实', evidenceSeqs: [7] }] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
});

it('enforces output, fact, content, key and evidence limits deterministically', () => {
  const fact = (overrides: Record<string, unknown> = {}) => ({ content: '事实', keys: [], evidenceSeqs: [7], ...overrides });
  expect(() => parse(JSON.stringify({ facts: Array.from({ length: 9 }, () => fact()) })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse(JSON.stringify({ facts: [fact({ content: '' })] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse(JSON.stringify({ facts: [fact({ content: 'x'.repeat(MEMORY_LIMITS.maxExtractionContentChars + 1) })] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse(JSON.stringify({ facts: [fact({ keys: Array.from({ length: MEMORY_LIMITS.maxExtractionKeys + 1 }, (_, index) => `k${index}`) })] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse(JSON.stringify({ facts: [fact({ keys: ['k'.repeat(MEMORY_LIMITS.maxExtractionKeyChars + 1)] })] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse(JSON.stringify({ facts: [fact({ evidenceSeqs: [] })] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse(JSON.stringify({ facts: [fact({ evidenceSeqs: [10] })] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse(JSON.stringify({ facts: [fact({ evidenceSeqs: [1.5] })] })))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
  expect(() => parse('x'.repeat(MEMORY_LIMITS.maxExtractionOutputChars + 1)))
    .toThrow(expect.objectContaining({ code: 'extraction_output_invalid' }));
});

it('never includes the raw output or chat text in errors', () => {
  const secret = 'CHAT_SECRET_123';
  try {
    parse(JSON.stringify({ facts: [{ content: secret, keys: [], evidenceSeqs: [99] }] }));
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toMatchObject({ code: 'extraction_output_invalid' });
    expect((error as Error).message).not.toContain(secret);
  }
});
