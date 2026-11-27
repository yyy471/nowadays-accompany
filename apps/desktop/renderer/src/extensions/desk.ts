import type { Extension, Slot } from './ExtensionSlotFrame';
import type { RoleListItem } from '../types';
import { hasExtensionFault } from './repair-request';

export type DeskView = 'desk' | 'catalog';
export interface DeskPosition { view: DeskView; extId?: string; file?: string }
export function entries(items: Extension[], kind: string) {
  return items.filter(item => item.status === 'enabled').flatMap(extension =>
    extension.ui.filter(entry => entry.slot === kind).map(entry => ({
      extension, entry, key: JSON.stringify([extension.extId, extension.version, entry.slot, entry.file])
    })));
}
export function slotId(extension: Extension, entry: Slot) { return extension.extId + '/' + entry.file; }

export function resolveDesk(items: Extension[], position?: DeskPosition, returning = false) {
  const pages = entries(items, 'page');
  const widgets = entries(items, 'widget');
  const slots = [...pages, ...widgets];
  const sameExtension = slots.filter(slot => slot.extension.extId === position?.extId);
  const target = sameExtension.find(slot => slot.entry.file === position?.file) ?? sameExtension[0];
  const page = target?.entry.slot === 'page' ? target : pages[0];
  const view = !slots.length || (returning && position?.extId && !target) ? 'catalog' : position?.view ?? 'desk';
  return { pages, widgets, page, view, target: target ?? page ?? widgets[0] };
}

export function catalogForRole(items: Extension[], role?: RoleListItem) {
  if (!role) return items;
  return items.flatMap(item => {
    const tools = item.status !== 'enabled' ? [] : item.tools.filter(tool => role.isBuiltin ||
      tool.scope === 'all_roles' || (tool.scope === 'selected_roles' && tool.roleIds.includes(role.roleId)));
    return tools.length || !item.tools.length || hasExtensionFault(item) ? [{ ...item, tools }] : [];
  });
}

export function catalogStatus(connection: 'loading' | 'ready' | 'reconnecting', count: number) {
  if (connection !== 'ready') return connection;
  return count ? 'installed' : 'empty';
}
