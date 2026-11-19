/** v6 保留文字总表（规范 §4）。文案集中在同一模块，纸笺脚 / 页脚 / #live / aria 多处共用防漂移。 */

export const T1: string;
export const T2: { value: string; hint: string };
export const T3: string;
export const T4: { testing: string; ok: (ms: number) => string; fail: (reason: string) => string };
export const T5: (count: number) => string;
export const T6: { state: (count: number) => string; discard: string; save: (count: number) => string; pauseAndSave: (count: number) => string };
export const T7: (names: string[]) => string;
export const T8: { dirty: (count: number) => string; filled: (count: number) => string };
export const T9: { text: (count: number) => string; keep: string; drop: string };
export const T10: { name: string; url: string; command: string; env: string; source: string };
export const T11: string;
export const T12: string;
export const T13: (names: string[]) => string;
export const T14: (names: string[]) => string;
export const T15: string;
export const T16: {
  needUrl: string; testing: string; probing: string; reading: string;
  readOk: (count: number) => string; probeOk: (count: number) => string; testOk: (ms: number) => string;
  needModel: string; testFail: (reason: string) => string; readFail: (reason: string) => string; probeFail: (reason: string) => string;
};
export const T17: (names: string[]) => string;
export const T19: { active: string; stopping: string; stopped: string; resuming: string };
export const T20: {
  state: { active: string; stopping: string; stopped: string; resuming: string };
  stop: string; stopping: string; resume: string; resuming: string; configure: string;
};
export const T21: (reason: string) => string;
export const T22: string;
export const T23: { none: string; unset: string; unselected: string; auto: string };
export const T24: { show: string; hide: string };
export const T25: { viewModel: string; manage: string; image: string; add: string };
export const T26: { connected: string; failed: string; version: string };
export const T27: string;
export const T28: string;
export const T29: {
  pauseAndSave: (count: number) => string; save: (count: number) => string; add: string;
  pausing: string; saving: string; deleting: string;
  pausingRoles: (names: string[]) => string; retry: (verb: string) => string;
};
export const T30: { text: (names: string[]) => string; resume: string; resuming: string };
export const T31: {
  service: {
    title: (kind: string) => string; ask: (name: string) => string;
    inUse: (roles: string) => string; unused: string;
    voiceCopies: (names: string, count: number) => string;
  };
  outfit: { title: string; ask: (name: string) => string; current: string };
  role: { title: string; ask: (name: string) => string; keep: string; remove: string; keepLegend: string };
  delete: string; pauseAndDelete: string; cancel: string;
};
export const T32: {
  pauseFail: (names: string[]) => string;
  saveFailPaused: (verb: string, reason: string, names: string[]) => string;
  saveFail: (verb: string, reason: string) => string;
  toggleFail: (verb: string, reason: string) => string;
};
export const T33: { optionSuffix: string; switchNote: string; selectedNote: string };
export const T34: { option: string; value: string };
export const T35: (reason: string) => string;
export const T35_RETRY: string;
export const T36: { kind: (kind: string) => string; settingsKind: (kind: string) => string };
export const T37: { text: (count: number, from: string, to: string) => string; confirm: string; cancel: string };
export const T38: string;
export function foldNames(names: string[]): string;
export const ARIA: {
  editItem: (item: string) => string;
  editGroup: (item: string, group: string) => string;
  saveCount: (count: number) => string;
  saveIdle: string;
  saveInvalid: string;
  addNeedRequired: string;
  enableService: (name: string) => string;
  refreshStatus: string;
  switchRole: string;
  openRoleConfig: (name: string) => string;
  enableForRole: (name: string) => string;
};
export const PLACEHOLDER: {
  roleModelName: string; settingsModelName: string; imageModel: string; negativePrompt: string;
  seed: string; referenceText: string; trialText: string; trialEmotion: string;
  modelUrl: string; voiceUrl: string; imageUrl: string;
  secretKeep: string; secretOptional: string; imageDefaultModel: string;
  mcpCommand: string; mcpArgs: string; mcpEnv: string;
  skillSource: string; newName: string;
};
