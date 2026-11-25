export const XIA_CHENG_BUILTIN_KEY = "xiacheng";

/** 管理权限只认持久化席位标识。 */
export function isAdminSeat(builtinKey: string | null): builtinKey is typeof XIA_CHENG_BUILTIN_KEY {
  return builtinKey === XIA_CHENG_BUILTIN_KEY;
}
