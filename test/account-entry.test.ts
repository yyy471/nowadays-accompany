import { describe, expect, it } from 'vitest';
import { planAccountEntry } from '../desktop/renderer/src/lib/account-entry.js';

describe('account entry selection', () => {
  it('selects the account requested by the home edit entry', () => {
    expect(planAccountEntry({ accountIds: ['10001', '10002'], selectedAccount: '10001', focusAccountId: '10002' }))
      .toEqual({ selectAccount: '10002', warning: null });
  });

  it('keeps the requested account selected and clears an old warning', () => {
    expect(planAccountEntry({ accountIds: ['10001', '10002'], selectedAccount: '10002', focusAccountId: '10002', entryWarning: 'old' }))
      .toEqual({ warning: null });
  });

  it('clears selection and warns when the requested account is not in the list', () => {
    expect(planAccountEntry({ accountIds: ['10001'], selectedAccount: '10002', focusAccountId: '10002' }))
      .toEqual({
        selectAccount: '',
        warning: '请求编辑的账号 10002 不在当前账号列表中，请重新选择账号。'
      });
  });

  it('warns without clearing the selector when the requested account is missing and nothing is selected', () => {
    expect(planAccountEntry({ accountIds: ['10001'], selectedAccount: '', focusAccountId: '10002' }))
      .toEqual({ warning: '请求编辑的账号 10002 不在当前账号列表中，请重新选择账号。' });
  });

  it('does not warn when the requested account disappears and no accounts remain', () => {
    expect(planAccountEntry({ accountIds: [], selectedAccount: '10002', focusAccountId: '10002' }))
      .toEqual({ warning: null });
  });

  it('clears a selected account that disappears from the list instead of switching silently', () => {
    expect(planAccountEntry({ accountIds: ['10001'], selectedAccount: '10002' }))
      .toEqual({
        selectAccount: '',
        warning: '账号 10002 已不在当前账号列表中，请重新选择账号。'
      });
  });

  it('falls back to the first account only when no entry target is requested', () => {
    expect(planAccountEntry({ accountIds: ['10001', '10002'], selectedAccount: '' }))
      .toEqual({ selectAccount: '10001' });
  });

  it('waits for the user after a warning instead of auto-selecting', () => {
    expect(planAccountEntry({ accountIds: ['10001'], selectedAccount: '', entryWarning: 'pick one' })).toBeUndefined();
  });

  it('leaves a valid selection untouched', () => {
    expect(planAccountEntry({ accountIds: ['10001', '10002'], selectedAccount: '10002' })).toBeUndefined();
  });
});
