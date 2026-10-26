export interface AccountEntryPlan {
  selectAccount?: string;
  warning?: string | null;
}

export function planAccountEntry(input: {
  accountIds: string[];
  selectedAccount: string;
  focusAccountId?: string;
  entryWarning?: string;
}): AccountEntryPlan | undefined {
  const { accountIds, selectedAccount, focusAccountId, entryWarning } = input;
  if (focusAccountId) {
    if (accountIds.length === 0) return { warning: null };
    if (!accountIds.includes(focusAccountId)) {
      return {
        ...(selectedAccount ? { selectAccount: '' } : {}),
        warning: `请求编辑的账号 ${focusAccountId} 不在当前账号列表中，请重新选择账号。`
      };
    }
    return {
      ...(selectedAccount !== focusAccountId ? { selectAccount: focusAccountId } : {}),
      warning: null
    };
  }
  if (!accountIds.length || entryWarning) return undefined;
  if (!selectedAccount) return { selectAccount: accountIds[0] };
  if (!accountIds.includes(selectedAccount)) {
    return {
      selectAccount: '',
      warning: `账号 ${selectedAccount} 已不在当前账号列表中，请重新选择账号。`
    };
  }
  return undefined;
}
