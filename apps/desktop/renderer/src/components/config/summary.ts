/**
 * 摘要行纯派生（v6 规范 §3 状态矩阵 + §二.2 值/第二行）：
 * 输入一份数据快照，输出行状态（值文案在组件层拼装）。
 * 不含 React，便于单测钉死每个状态的条件。
 */

export type RowStatus = "ok" | "follow" | "off" | "dirty" | "error" | "none";
export type Statused = { status: RowStatus; label: string };
/** service 为 null 表示所选服务已被删除（T34）。 */
export type ServiceRef = { service: { name: string; enabled: boolean } | null };

/** 绑定异常：已删除 → error；已停用 → off；正常返回 null。 */
export function bindingIssue(ref: ServiceRef | null): Statused | null {
  if (!ref || ref.service === null) return { status: "error", label: "原服务已删除" };
  if (!ref.service.enabled) return { status: "off", label: "服务已停用" };
  return null;
}

export const CHAT_UNSET: Statused = { status: "off", label: "未设置" };
export const FOLLOW_CHAT: Statused = { status: "follow", label: "跟随对话" };

/** 对话行：未选 off「未设置」；停用 off「服务已停用」；删除 error；正常 ok「生效中」。 */
export function chatRowStatus(ref: ServiceRef | null): Statused {
  if (!ref) return CHAT_UNSET;
  return bindingIssue(ref) ?? { status: "ok", label: "生效中" };
}

/** 记忆整理行：跟随 follow；选了服务同对话异常规则。 */
export function memoryRowStatus(ref: ServiceRef | null, follow: boolean): Statused {
  if (follow) return FOLLOW_CHAT;
  return bindingIssue(ref) ?? { status: "ok", label: "生效中" };
}

/** 生图行：未选 off「未设置」。 */
export function imageRowStatus(ref: ServiceRef | null): Statused {
  if (!ref) return CHAT_UNSET;
  return bindingIssue(ref) ?? { status: "ok", label: "生效中" };
}

/** 语音行：没选音色/参考音频时 off「未选音色」。 */
export function voiceRowStatus(ref: ServiceRef | null, toneReady: boolean): Statused {
  if (!ref) return { status: "off", label: "未选音色" };
  return bindingIssue(ref) ?? (toneReady
    ? { status: "ok", label: "生效中" }
    : { status: "off", label: "未选音色" });
}

/** MCP / Skill 行：无可选项 none；全关 off「全部关闭」；有停用 off「有服务已停用」；正常 ok。 */
export function extensionRowStatus(items: Array<{ enabled: boolean; roleEnabled: boolean }>): Statused {
  if (items.length === 0) return { status: "none", label: "无可选项" };
  const on = items.filter((item) => item.roleEnabled && item.enabled);
  const onButDisabled = items.filter((item) => item.roleEnabled && !item.enabled);
  if (onButDisabled.length > 0) return { status: "off", label: "有服务已停用" };
  if (on.length === 0) return { status: "off", label: "全部关闭" };
  return { status: "ok", label: "生效中" };
}

/** 自主额度行恒 ok。 */
export const QUOTA_OK: Statused = { status: "ok", label: "生效中" };

/** 生图第二行：只写值，值间由 CSS 伪元素「·」分隔。 */
export function imageKeys(input: { width: number; height: number; steps: number; cfg: number; sampler: string; scheduler: string }): string[] {
  return [`${input.width}×${input.height}`, `${input.steps} 步`, `CFG ${input.cfg}`, `${input.sampler} / ${input.scheduler}`];
}

/** 语音第二行：{音色} · {语速}× · 情感 {强度}。 */
export function voiceKeys(input: { tone: string; speed: number; emotion: number }): string[] {
  return [input.tone, `${input.speed.toFixed(1)}×`, `情感 ${input.emotion.toFixed(1)}`];
}

/** 额度第二行：每日 N 点 / 不限额 · 本机日期 · 本机 00:00 重置。 */
export function quotaKeys(input: { dailyLimit: number; unlimited: boolean; localDate: string }): string[] {
  return [input.unlimited ? "不限额" : `每日 ${input.dailyLimit} 点`, input.localDate, "本机 00:00 重置"];
}

/** MCP / Skill 值：已为角色开启 {n} / {总数}（只算全局启用的）。 */
export function extensionValue(items: Array<{ enabled: boolean; roleEnabled: boolean }>): string {
  const count = items.filter((item) => item.enabled && item.roleEnabled).length;
  return `已为角色开启 ${count} / ${items.length}`;
}

/** MCP / Skill 第二行：开启名单 + 停用名单（含「（已全局停用）」）。 */
export function extensionKeys(items: Array<{ name: string; enabled: boolean; roleEnabled: boolean }>): { on: string[]; disabled: string[] } {
  return {
    on: items.filter((item) => item.enabled && item.roleEnabled).map((item) => item.name),
    disabled: items.filter((item) => !item.enabled && item.roleEnabled).map((item) => `${item.name}（已全局停用）`),
  };
}

/** rowDot 规则（§3）：ok/follow/none → bare 淡点；off/dirty/error → 圆点加文字。 */
export function rowDotVisible(status: RowStatus): boolean {
  return status === "off" || status === "dirty" || status === "error";
}

/** 本机日期（本地时区，§二.2「今日」口径）。 */
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** T28 额度校验：留空、≤0、小数、>1000000 都算错；不限制时不校验。 */
export function quotaLimitBad(draft: { dailyLimit: number; unlimited: boolean }): boolean {
  return !draft.unlimited && !(Number.isInteger(draft.dailyLimit) && draft.dailyLimit >= 1 && draft.dailyLimit <= 1000000);
}
