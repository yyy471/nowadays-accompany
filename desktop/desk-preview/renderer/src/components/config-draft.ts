/** 草稿状态供角色配置页在切换角色时统一处理。 */
export type ConfigDraftState = {
  dirty: boolean;
  busy: boolean;
  discard: () => void;
};
