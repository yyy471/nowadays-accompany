import { describe, expect, it } from 'vitest';
import { InstanceStateMachine, canTransition } from '../src/core/state.js';
import { InvalidStateTransitionError } from '../src/core/errors.js';

describe('InstanceStateMachine', () => {
  it('walks the login path and records transitions', () => {
    const seen: string[] = [];
    const machine = new InstanceStateMachine('stopped', (from, to) => seen.push(`${from}->${to}`));
    machine.transition('provisioning');
    machine.transition('starting');
    machine.transition('awaiting_login');
    machine.transition('online');
    machine.transition('degraded');
    machine.transition('online');
    machine.transition('stopping');
    machine.transition('stopped');

    expect(machine.state).toBe('stopped');
    expect(seen).toEqual([
      'stopped->provisioning',
      'provisioning->starting',
      'starting->awaiting_login',
      'awaiting_login->online',
      'online->degraded',
      'degraded->online',
      'online->stopping',
      'stopping->stopped'
    ]);
  });

  it('stops at awaiting_profile until the mandatory role card resolves', () => {
    const machine = new InstanceStateMachine('stopped');
    machine.transition('provisioning');
    machine.transition('starting');
    machine.transition('awaiting_login');
    machine.transition('awaiting_profile');
    expect(machine.state).toBe('awaiting_profile');
    machine.transition('online');
    expect(machine.state).toBe('online');
    expect(canTransition('online', 'awaiting_profile')).toBe(true);
  });

  it('rejects illegal jumps', () => {
    const machine = new InstanceStateMachine('stopped');
    expect(() => machine.transition('online')).toThrow(InvalidStateTransitionError);
    machine.transition('provisioning');
    machine.transition('starting');
    expect(() => machine.transition('stopped')).toThrow(InvalidStateTransitionError);
  });

  it('treats self-transition as illegal', () => {
    expect(canTransition('online', 'online')).toBe(false);
    expect(canTransition('failed', 'provisioning')).toBe(true);
    expect(canTransition('stopped', 'failed')).toBe(false);
  });

  it('fail() short-circuits to failed from any active state', () => {
    const machine = new InstanceStateMachine('stopped');
    machine.fail();
    expect(machine.state).toBe('stopped');

    const online = new InstanceStateMachine('online');
    online.fail();
    expect(online.state).toBe('failed');

    const stopping = new InstanceStateMachine('stopping');
    stopping.fail();
    expect(stopping.state).toBe('stopping');
  });

  it('failFinal lets a failed stop leave stopping', () => {
    const stopping = new InstanceStateMachine('stopping');
    stopping.failFinal();
    expect(stopping.state).toBe('failed');
  });
});
