export interface StateVersionGate {
  activate(roleId: string): void;
  accept(roleId: string, stateVersion: number): boolean;
}

export function createStateVersionGate(): StateVersionGate {
  const versions = new Map<string, number>();
  let activeRole = '';
  return {
    activate(roleId) {
      activeRole = roleId;
    },
    accept(roleId, stateVersion) {
      if (roleId !== activeRole || !Number.isFinite(stateVersion)) return false;
      const seen = versions.get(roleId);
      if (seen !== undefined && stateVersion < seen) return false;
      versions.set(roleId, stateVersion);
      return true;
    }
  };
}
