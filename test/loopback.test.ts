import { describe, expect, it } from 'vitest';
import { LoopbackGuard } from '../src/routing/loopback.js';

describe('LoopbackGuard', () => {
  it('drops self echoes and own messages', () => {
    const guard = new LoopbackGuard(['10001']);
    expect(guard.classify({ postType: 'message_sent', selfId: '10001', senderId: '10001' })).toBe('self');
    expect(guard.classify({ postType: 'message', selfId: '10001', senderId: '10001' })).toBe('self');
  });

  it('accepts a message from another account (cross-account is normal traffic)', () => {
    const guard = new LoopbackGuard(['10002']);
    expect(guard.classify({ postType: 'message', selfId: '10002', senderId: '10001' })).toBe('accept');
  });

  it('rejects events addressed to a different account once identity is known', () => {
    const guard = new LoopbackGuard(['10002']);
    expect(guard.classify({ postType: 'message', selfId: '10001', senderId: '55555' })).toBe('misattributed');
  });

  it('accepts before identity is known, then learns it', () => {
    const guard = new LoopbackGuard();
    expect(guard.classify({ postType: 'message', selfId: '10003', senderId: '5' })).toBe('accept');
    guard.add('10003');
    expect(guard.classify({ postType: 'message', selfId: '10003', senderId: '5' })).toBe('accept');
    expect(guard.primary()).toBe('10003');
  });
});
