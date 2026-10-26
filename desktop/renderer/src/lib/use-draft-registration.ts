import { useEffect, useRef } from 'react';
import { useDraftProtection } from '../components/DraftProtectionProvider';
import type { DraftOwner } from './drafts/registry.js';

export interface DraftRegistrationInput {
  id: string;
  owner: DraftOwner;
  label: string;
  accountId?: string;
  dirty: boolean;
  busy: boolean;
  revision: number;
  discard: () => void;
  enabled?: boolean;
}

export function useDraftRegistration(input: DraftRegistrationInput): void {
  const { registry } = useDraftProtection();
  const latest = useRef(input);
  latest.current = input;
  const enabled = input.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    return registry.register({
      id: input.id,
      owner: input.owner,
      getSnapshot: () => {
        const current = latest.current;
        return {
          label: current.label,
          accountId: current.accountId,
          dirty: current.dirty,
          busy: current.busy,
          revision: current.revision,
          discard: current.discard
        };
      }
    });
  }, [registry, input.id, input.owner, enabled]);
}
