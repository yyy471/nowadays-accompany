import { describe, expect, it } from 'vitest';
import { buildChatContext, type ContextBuildInput } from '../src/agent/context.js';
import { formatCurrentTime, formatMessageTime, resolveTimeZone } from '../src/agent/clock.js';

const AT = Date.parse('2026-10-30T06:05:00Z');

function baseInput(overrides: Partial<ContextBuildInput> = {}): ContextBuildInput {
  return {
    roleCard: 'ROLE_CONTENT',
    skills: [],
    history: [],
    currentText: 'CURRENT',
    kind: 'private',
    observations: [],
    maxHistoryMessages: 10,
    maxHistoryChars: 3_000,
    ...overrides
  };
}

function systemText(built: ReturnType<typeof buildChatContext>): string {
  return built.messages[0]!.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('agent clock', () => {
  it('formats current and message times in the configured zone', () => {
    expect(formatCurrentTime(AT, 'Asia/Shanghai')).toBe('2026-10-30 周五 14:05（Asia/Shanghai）');
    expect(formatMessageTime(AT, 'Asia/Shanghai')).toBe('2026-10-30 14:05');
  });

  it('falls back to UTC when the zone is invalid and resolves a default otherwise', () => {
    expect(formatCurrentTime(AT, 'Not/AZone')).toBe('2026-10-30 06:05（UTC）');
    expect(resolveTimeZone('')).toBeTruthy();
    expect(resolveTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai');
  });

  it('injects the current time only when the host provides it', () => {
    expect(systemText(buildChatContext(baseInput()))).not.toContain('## 当前时间');
    const built = buildChatContext(baseInput({ currentTime: { at: AT, timeZone: 'Asia/Shanghai' } }));
    const system = systemText(built);
    expect(system).toContain('## 当前时间');
    expect(system).toContain('2026-10-30 周五 14:05（Asia/Shanghai）');
  });
});
