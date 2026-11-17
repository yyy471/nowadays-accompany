import type { RoleListItem } from '../types';

export function entryRoles(roles: RoleListItem[] | undefined): RoleListItem[];
export function entryBadge(role: RoleListItem | undefined): string | null;
export function entrySubtitle(role: RoleListItem | undefined): string;
export function needsEntryPick(input: { loading: boolean; roles: RoleListItem[] | undefined; entered: boolean }): boolean;
export function resolveEntryChoice(roles: RoleListItem[] | undefined, roleId: string): string;
export function defaultEntryChoice(roles: RoleListItem[] | undefined): string;
