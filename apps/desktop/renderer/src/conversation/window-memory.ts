// 按角色记忆最近停留的对话窗口（UX-06）。
// 工厂返回实例级闭包，避免模块级可变状态在测试与多页面间串扰。

export type RoleWindowMemory = {
  /** 记录角色最近活跃的子窗口；空角色或空窗口不覆盖已有记忆。 */
  remember: (roleId: string, windowId: string | null | undefined) => void;
  /** 角色删除时清理记忆。 */
  forget: (roleId: string) => void;
  /** 读取角色最近记忆的窗口；未记忆时返回 null。 */
  get: (roleId: string) => string | null;
  /** 解析返回对话页时应优先打开的窗口：显式目标 > 已记忆窗口 > 角色默认主窗口。 */
  resolvePreferredWindow: (
    roleId: string,
    options: {
      initialTarget?: { roleId: string; windowId: string } | null;
      defaultWindowId?: string | null;
    }
  ) => string | null;
};

export function createRoleWindowMemory(): RoleWindowMemory {
  const remembered = new Map<string, string>();
  return {
    remember(roleId, windowId) {
      if (roleId && windowId) remembered.set(roleId, windowId);
    },
    forget(roleId) {
      remembered.delete(roleId);
    },
    get(roleId) {
      return remembered.get(roleId) ?? null;
    },
    resolvePreferredWindow(roleId, { initialTarget, defaultWindowId }) {
      if (initialTarget && initialTarget.roleId === roleId) return initialTarget.windowId;
      return remembered.get(roleId) ?? defaultWindowId ?? null;
    }
  };
}
