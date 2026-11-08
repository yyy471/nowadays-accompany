export function createStateVersionGate() {
  const versions = new Map();
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
