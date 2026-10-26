import { expect, it } from 'vitest';
import { buildChatContext, type ContextBuildInput } from '../src/agent/context.js';
import { MEMORY_SECTION_TITLE } from '../src/memory/selector.js';
import { DEFAULT_MEMORY_SETTINGS, type MemoryRecord, type MemorySettings, type MemorySnapshot } from '../src/memory/types.js';
import type { StoredMessage } from '../src/storage/contract.js';
import { parseWorldbook } from '../src/worldbook/schema.js';

function record(index: number, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `r-${index}`,
    revision: `rr-${index}`,
    type: 'fact',
    content: `记忆${index}`,
    keys: [`键${index}`],
    pinned: false,
    origin: 'user',
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    ...overrides
  };
}

function snapshot(records: MemoryRecord[], overrides: Partial<MemorySettings> = {}, state: 'ready' | 'unavailable' = 'ready'): MemorySnapshot {
  return {
    scopeToken: 'scope',
    revision: 'r1',
    generation: 1,
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, budgetChars: 500, maxSelected: 5, ...overrides },
    records,
    state,
    guard: 'guard',
    ...(state === 'unavailable' ? { error: 'unavailable' } : {})
  };
}

function stored(index: number, text: string, overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: `m-${index}`,
    at: 1_700_000_000_000 + index,
    direction: index % 2 === 0 ? 'in' : 'out',
    segments: [{ type: 'text', data: { text } }],
    seq: index,
    ...overrides
  };
}

function plain(built: ReturnType<typeof buildChatContext>): number {
  return built.messages[0]!.content.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0);
}

function systemText(built: ReturnType<typeof buildChatContext>): string {
  return built.messages[0]!.content.map(part => part.type === 'text' ? part.text : '').join('');
}

const worldbook = parseWorldbook({ version: 1, entries: [
  { id: 'w', keys: ['go'], content: 'WORLD_CONTENT', position: 'after-role' }
] });
const worldbookOptions = { enabled: true, scanDepth: 4, budgetChars: 500 };

function baseInput(overrides: Partial<ContextBuildInput> = {}): ContextBuildInput {
  return {
    roleCard: 'ROLE_CONTENT',
    skills: [],
    history: [],
    currentText: 'go',
    kind: 'private',
    observations: [],
    maxHistoryMessages: 10,
    maxHistoryChars: 3000,
    worldbook,
    worldbookOptions,
    ...overrides
  };
}

it('C04 injects memory after the worldbook, charges its exact increment and shrinks the remaining history budget', () => {
  const history = Array.from({ length: 5 }, (_, index) => stored(index, `history-${index}-${'h'.repeat(30)}`));
  const memory = snapshot([record(1, { keys: ['go'], content: 'MEM_CONTENT' })], { budgetChars: 200 });
  const baseline = buildChatContext(baseInput({ history, maxHistoryChars: 3000 }));
  const built = buildChatContext(baseInput({ history, maxHistoryChars: 3000, memory }));

  const system = systemText(built);
  expect(system.indexOf('ROLE_CONTENT')).toBeLessThan(system.indexOf('WORLD_CONTENT'));
  expect(system.indexOf('WORLD_CONTENT')).toBeLessThan(system.indexOf(MEMORY_SECTION_TITLE));
  expect(system).toContain('MEM_CONTENT');
  expect(plain(built) - plain(baseline)).toBe(built.memory!.usedChars);
  expect(built.memory!.selectedIds).toEqual(['r-1']);

  const noMemory = buildChatContext(baseInput({ maxHistoryChars: 300 }));
  const currentChars = noMemory.currentContent.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 0), 0);
  const slack = 300 - currentChars - plain(noMemory);
  const tightHistory = [stored(99, 'T'.repeat(Math.max(1, slack - 1)))];
  const baselineTight = buildChatContext(baseInput({ history: tightHistory, maxHistoryChars: 300 }));
  expect(baselineTight.historyCount).toBe(1);
  const withMemory = buildChatContext(baseInput({ history: tightHistory, maxHistoryChars: 300, memory }));
  expect(withMemory.historyCount).toBe(0);
  expect(withMemory.memory!.usedChars).toBeGreaterThan(1);
  expect(plain(withMemory) + withMemory.historyChars).toBeLessThan(300);
});

it('C05 yields zero memory increment when the base is over budget and preserves group/media/current-message rules', () => {
  const overBudget = buildChatContext(baseInput({
    roleCard: 'R'.repeat(300),
    currentText: 'go',
    maxHistoryChars: 50,
    memory: snapshot([record(1, { keys: ['go'], content: 'MUST_NOT_APPEAR' })])
  }));
  expect(overBudget.memory).toMatchObject({ content: '', usedChars: 0, selectedIds: [] });
  expect(systemText(overBudget)).not.toContain(MEMORY_SECTION_TITLE);
  expect(overBudget.historyCount).toBe(0);

  const group = buildChatContext(baseInput({
    kind: 'group',
    currentText: 'CURRENT_MARKER',
    currentMessageId: 'm-current',
    currentSenderId: 'alice',
    observations: [{ capability: 'image.understand', text: 'OBS_TEXT', providerId: 'p', modelId: 'm' }],
    history: [
      stored(1, 'CURRENT_MARKER', { direction: 'in', messageId: 'm-current', senderId: 'alice' }),
      stored(2, 'HISTORY_BOB', { direction: 'in', senderId: 'bob' })
    ],
    memory: snapshot([record(1, { keys: ['CURRENT_MARKER'], content: 'GROUP_MEMORY' })])
  }));
  const current = group.messages.at(-1)!;
  expect(current.content).toContainEqual({ type: 'text', text: '[alice] CURRENT_MARKER' });
  expect(current.content).toContainEqual({ type: 'text', text: expect.stringContaining('OBS_TEXT') });
  expect(JSON.stringify(group.messages.slice(1, -1))).not.toContain('CURRENT_MARKER');
  expect(JSON.stringify(group.messages.slice(1, -1))).toContain('[bob] HISTORY_BOB');
  expect(group.memory!.usedChars).toBeGreaterThan(0);
});

it('C06 leaves the original system text and history selection untouched when memory is disabled, unmatched or unavailable', () => {
  const history = Array.from({ length: 4 }, (_, index) => stored(index, `history-${index}-${'x'.repeat(40)}`));
  const baseline = buildChatContext(baseInput({ history, maxHistoryChars: 500 }));
  const inputs = [
    snapshot([record(1, { keys: ['go'], content: 'DISABLED' })], { enabled: false }),
    snapshot([record(2, { keys: ['absent'], content: 'UNMATCHED' })]),
    snapshot([record(3, { keys: [], content: 'NO_KEYS' })]),
    snapshot([record(4, { keys: ['go'], content: 'UNAVAILABLE' })], {}, 'unavailable')
  ];
  for (const memory of inputs) {
    const built = buildChatContext(baseInput({ history, maxHistoryChars: 500, memory }));
    expect(systemText(built)).toBe(systemText(baseline));
    expect(built.historyCount).toBe(baseline.historyCount);
    expect(built.historyChars).toBe(baseline.historyChars);
    expect(systemText(built)).not.toContain(MEMORY_SECTION_TITLE);
  }
});
