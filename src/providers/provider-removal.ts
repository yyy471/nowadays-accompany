import type { RuntimeConfigV2 } from './types.js';

/** Apply to a working copy only. Preview and commit share exactly the same reference cleanup. */
export function removeProviderFromConfig(config: RuntimeConfigV2, id: string): { removed: boolean; affectedAccounts: string[] } {
  const index = config.providers.findIndex(provider => provider.id === id);
  if (index < 0) return { removed: false, affectedAccounts: [] };
  config.providers.splice(index, 1);
  const affectedAccounts: string[] = [];
  for (const [accountId, policy] of Object.entries(config.accountPolicies)) {
    let changed = false;
    const before = policy.allowedProviders.length;
    policy.allowedProviders = policy.allowedProviders.filter(providerId => providerId !== id);
    if (before !== policy.allowedProviders.length) changed = true;
    for (const scope of [policy, ...Object.values(policy.byKind), ...Object.values(policy.byConversation)]) {
      if (!scope) continue;
      for (const capability of Object.keys(scope.bindings ?? {})) {
        const binding = scope.bindings?.[capability as keyof typeof scope.bindings];
        if (!binding) continue;
        if (binding.providerId === id) {
          delete scope.bindings?.[capability as keyof typeof scope.bindings];
          changed = true;
        } else if (binding.fallback?.some(target => target.providerId === id)) {
          binding.fallback = binding.fallback.filter(target => target.providerId !== id);
          if (binding.fallback.length === 0) delete binding.fallback;
          changed = true;
        }
      }
    }
    if (changed) affectedAccounts.push(accountId);
  }
  return { removed: true, affectedAccounts };
}
