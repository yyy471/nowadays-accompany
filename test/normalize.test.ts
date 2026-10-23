import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../src/channels/onebot/normalize.js';

describe('normalizeEvent', () => {
  it('normalizes a group message', () => {
    const event = normalizeEvent(
      {
        post_type: 'message',
        message_type: 'group',
        self_id: 10002,
        user_id: 55555,
        group_id: 907906577,
        message_id: 42,
        time: 1700000000,
        message: [{ type: 'text', data: { text: 'hello' } }]
      },
      'main'
    );
    expect(event).toMatchObject({
      type: 'message',
      instanceId: 'main',
      selfId: '10002',
      kind: 'group',
      peerId: '907906577',
      senderId: '55555',
      messageId: '42',
      selfEcho: false
    });
    expect(event?.type === 'message' && event.at).toBe(1_700_000_000_000);
  });

  it('uses the sender as peer for private messages and marks self echoes', () => {
    const event = normalizeEvent(
      {
        post_type: 'message_sent',
        message_type: 'private',
        self_id: 10002,
        user_id: 2434944654,
        message_id: 7,
        message: 'plain text'
      },
      'main'
    );
    expect(event).toMatchObject({
      type: 'message',
      kind: 'private',
      peerId: '2434944654',
      senderId: '10002',
      selfEcho: true
    });
    expect(event?.type === 'message' && event.segments).toEqual([{ type: 'text', data: { text: 'plain text' } }]);
  });

  it('keeps at/image segments for downstream features', () => {
    const event = normalizeEvent(
      {
        post_type: 'message',
        message_type: 'group',
        self_id: 1,
        user_id: 2,
        group_id: 3,
        message: [
          { type: 'at', data: { qq: '10001' } },
          { type: 'image', data: { file: 'abc.image', url: 'https://example.invalid/x.png' } }
        ]
      },
      'main'
    );
    expect(event?.type === 'message' && event.segments).toEqual([
      { type: 'at', data: { qq: '10001' } },
      { type: 'image', data: { file: 'abc.image', url: 'https://example.invalid/x.png' } }
    ]);
  });

  it('maps notices and lifecycle events', () => {
    expect(
      normalizeEvent({ post_type: 'notice', notice_type: 'friend_recall', self_id: 1 }, 'main')
    ).toMatchObject({ type: 'notice', noticeType: 'friend_recall' });
    expect(
      normalizeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', sub_type: 'heartbeat', self_id: 1 }, 'main')
    ).toMatchObject({ type: 'lifecycle', subType: 'heartbeat' });
  });

  it('drops unknown shapes instead of guessing', () => {
    expect(normalizeEvent(null, 'main')).toBeNull();
    expect(normalizeEvent({ post_type: 'message', message_type: 'guild' }, 'main')).toBeNull();
    expect(normalizeEvent({ post_type: 'message', message_type: 'group', group_id: 1 }, 'main')).toBeNull();
    expect(normalizeEvent({ post_type: 'message', message: [] }, 'main')).toBeNull();
  });
});
