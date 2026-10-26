import type { AccountPluginEntry } from '../types.js';

/**
 * 只更新资源库中仍存在的公用插件启用状态；私有、缺失和配置条目原样保留。
 * 返回新数组，不修改传入的条目。
 */
export function mergeAccountPlugins(
  existing: AccountPluginEntry[],
  availablePublicIds: Iterable<string>,
  selectedPublicIds: Iterable<string>
): AccountPluginEntry[] {
  const available = new Set(availablePublicIds);
  const selected = new Set(selectedPublicIds);
  const next = existing.map((plugin) => plugin.source === 'public' && available.has(plugin.id)
    ? { ...plugin, enabled: selected.has(plugin.id) }
    : plugin);
  for (const id of selected) {
    if (!next.some((plugin) => plugin.source === 'public' && plugin.id === id)) {
      next.push({ source: 'public', id, enabled: true });
    }
  }
  return next;
}
