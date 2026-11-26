import type { RoleListItem } from '../types';

export interface CoplayAction { action: string; label: string }

export function coplayControls(actions: CoplayAction[] | undefined, roles: RoleListItem[], selected: string) {
  if (!actions?.length) return;
  const choices = roles.filter(role => role.status === 'ready');
  const target = choices.find(role => role.roleId === selected) ?? choices.find(role => role.isBuiltin);
  return { choices, target, buttons: actions.map(({ action, label }) => ({
    action, text: target ? label + ' · 让' + target.displayName + '回应' : label
  })) };
}
