export interface StateVersionGate {
  activate(roleId: string): void;
  accept(roleId: string, stateVersion: number): boolean;
}

export function createStateVersionGate(): StateVersionGate;
