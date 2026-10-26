import { useEffect, type RefObject } from 'react';
import { planAccountEntry } from './account-entry.js';

interface ScrollAnchor {
  scrollIntoView: (options: ScrollIntoViewOptions) => void;
}

export function useAccountEntryFocus(options: {
  accountIds?: string[];
  selectedAccount: string;
  focusAccountId?: string;
  entryWarning?: string;
  displayRef: RefObject<ScrollAnchor | null>;
  selectAccount: (accountId: string) => void;
  setEntryWarning: (warning: string | undefined) => void;
  onHandled: () => void;
}): void {
  const { accountIds, selectedAccount, focusAccountId, entryWarning, displayRef, selectAccount, setEntryWarning, onHandled } = options;
  const focusTargetMissing = Boolean(focusAccountId && accountIds && !accountIds.includes(focusAccountId));

  useEffect(() => {
    if (!accountIds) return;
    const plan = planAccountEntry({ accountIds, selectedAccount, focusAccountId, entryWarning });
    if (plan) {
      if (plan.selectAccount !== undefined && plan.selectAccount !== selectedAccount) selectAccount(plan.selectAccount);
      if (plan.warning === null) setEntryWarning(undefined);
      else if (plan.warning !== undefined) setEntryWarning(plan.warning);
    }
    if (focusTargetMissing) onHandled();
  }, [accountIds, selectedAccount, focusAccountId, entryWarning, focusTargetMissing]);

  useEffect(() => {
    if (!accountIds || !focusAccountId || !accountIds.includes(focusAccountId) || selectedAccount !== focusAccountId) return;
    const anchor = displayRef.current;
    if (!anchor) return;
    anchor.scrollIntoView({ block: 'start' });
    onHandled();
  }, [accountIds, displayRef, focusAccountId, selectedAccount]);
}
