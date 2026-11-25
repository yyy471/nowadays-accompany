import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFeed, loadTranscript } from '../src/feed/data';

test('往来按会话编号保留同一对角色的两次动态，各自读取发言', async () => {
  const original = globalThis.fetch;
  const sessions = ['旧书', '观星'].map((topic, i) => ({ sessionId: 's' + i, topic, initiatorRoleId: 'a', targetRoleId: 'b' }));
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'http://fixture').pathname;
    const session = sessions.find(s => path.endsWith('/' + s.sessionId));
    return Response.json(session ? { ...session, turns: [{content: session.topic}] } : {items: path === '/v1/role-exchanges' ? sessions : []});
  };
  try {
    const signal = new AbortController().signal;
    const { exchanges } = await loadFeed([], signal);
    assert.deepEqual(exchanges, sessions);
    for (const s of exchanges) assert.equal((await loadTranscript(s.sessionId, signal)).turns[0]?.content, s.topic);
  } finally {
    globalThis.fetch = original;
  }
});
