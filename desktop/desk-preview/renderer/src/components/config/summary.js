/**
 * 摘要行纯派生（v6 规范 §3 状态矩阵 + §二.2 值/第二行）：
 * 输入一份数据快照，输出行状态（值文案在组件层拼装）。
 * 不含 React，便于单测钉死每个状态的条件。
 */

/**
 * @typedef {"ok"|"follow"|"off"|"dirty"|"error"|"none"} RowStatus
 */

/**
 * @typedef {{ status: RowStatus, label: string }} Statused
 */

/**
 * @typedef {{ service: { name: string, enabled: boolean } | null }} ServiceRef
 * service 为 null 表示所选服务已被删除（T34）。
 */

/**
 * 绑定异常：已删除 → error；已停用 → off；正常返回 null。
 * @param {ServiceRef | null} ref
 * @returns {Statused | null}
 */
export function bindingIssue(ref) {
  if (!ref || ref.service === null) return { status: "error", label: "原服务已删除" };
  if (!ref.service.enabled) return { status: "off", label: "服务已停用" };
  return null;
}

/** @type {Statused} */
export const CHAT_UNSET = { status: "off", label: "未设置" };
/** @type {Statused} */
export const FOLLOW_CHAT = { status: "follow", label: "跟随对话" };

/**
 * 对话行：未选 off「未设置」；停用 off「服务已停用」；删除 error；正常 ok「生效中」。
 * @param {ServiceRef | null} ref
 * @returns {Statused}
 */
export function chatRowStatus(ref) {
  if (!ref) return CHAT_UNSET;
  return bindingIssue(ref) ?? { status: "ok", label: "生效中" };
}

/**
 * 记忆整理行：跟随 follow；选了服务同对话异常规则。
 * @param {ServiceRef | null} ref
 * @param {boolean} follow
 * @returns {Statused}
 */
export function memoryRowStatus(ref, follow) {
  if (follow) return FOLLOW_CHAT;
  return bindingIssue(ref) ?? { status: "ok", label: "生效中" };
}

/**
 * 生图行：未选 off「未设置」。
 * @param {ServiceRef | null} ref
 * @returns {Statused}
 */
export function imageRowStatus(ref) {
  if (!ref) return CHAT_UNSET;
  return bindingIssue(ref) ?? { status: "ok", label: "生效中" };
}

/**
 * 语音行：没选音色/参考音频时 off「未选音色」。
 * @param {ServiceRef | null} ref
 * @param {boolean} toneReady
 * @returns {Statused}
 */
export function voiceRowStatus(ref, toneReady) {
  if (!ref) return { status: "off", label: "未选音色" };
  return bindingIssue(ref) ?? (toneReady
    ? { status: "ok", label: "生效中" }
    : { status: "off", label: "未选音色" });
}

/**
 * MCP / Skill 行：无可选项 none；全关 off「全部关闭」；有停用 off「有服务已停用」；正常 ok。
 * @param {Array<{ enabled: boolean, roleEnabled: boolean }>} items
 * @returns {Statused}
 */
export function extensionRowStatus(items) {
  if (items.length === 0) return { status: "none", label: "无可选项" };
  const on = items.filter((item) => item.roleEnabled && item.enabled);
  const onButDisabled = items.filter((item) => item.roleEnabled && !item.enabled);
  if (onButDisabled.length > 0) return { status: "off", label: "有服务已停用" };
  if (on.length === 0) return { status: "off", label: "全部关闭" };
  return { status: "ok", label: "生效中" };
}

/** @type {Statused} 自主额度行恒 ok。 */
export const QUOTA_OK = { status: "ok", label: "生效中" };

/**
 * 生图第二行：只写值，值间由 CSS 伪元素「·」分隔。
 * @param {{ width: number, height: number, steps: number, cfg: number, sampler: string, scheduler: string }} input
 * @returns {string[]}
 */
export function imageKeys(input) {
  return [`${input.width}×${input.height}`, `${input.steps} 步`, `CFG ${input.cfg}`, `${input.sampler} / ${input.scheduler}`];
}

/**
 * 语音第二行：{音色} · {语速}× · 情感 {强度}。
 * @param {{ tone: string, speed: number, emotion: number }} input
 * @returns {string[]}
 */
export function voiceKeys(input) {
  return [input.tone, `${input.speed.toFixed(1)}×`, `情感 ${input.emotion.toFixed(1)}`];
}

/**
 * 额度第二行：每日 N 点 / 不限额 · 本机日期 · 本机 00:00 重置。
 * @param {{ dailyLimit: number, unlimited: boolean, localDate: string }} input
 * @returns {string[]}
 */
export function quotaKeys(input) {
  return [input.unlimited ? "不限额" : `每日 ${input.dailyLimit} 点`, input.localDate, "本机 00:00 重置"];
}

/**
 * MCP / Skill 值：已为角色开启 {n} / {总数}（只算全局启用的）。
 * @param {Array<{ enabled: boolean, roleEnabled: boolean }>} items
 * @returns {string}
 */
export function extensionValue(items) {
  const count = items.filter((item) => item.enabled && item.roleEnabled).length;
  return `已为角色开启 ${count} / ${items.length}`;
}

/**
 * MCP / Skill 第二行：开启名单 + 停用名单（含「（已全局停用）」）。
 * @param {Array<{ name: string, enabled: boolean, roleEnabled: boolean }>} items
 * @returns {{ on: string[], disabled: string[] }}
 */
export function extensionKeys(items) {
  return {
    on: items.filter((item) => item.enabled && item.roleEnabled).map((item) => item.name),
    disabled: items.filter((item) => !item.enabled && item.roleEnabled).map((item) => `${item.name}（已全局停用）`),
  };
}

/**
 * rowDot 规则（§3）：ok/follow/none → bare 淡点；off/dirty/error → 圆点加文字。
 * @param {RowStatus} status
 * @returns {boolean}
 */
export function rowDotVisible(status) {
  return status === "off" || status === "dirty" || status === "error";
}

/**
 * 本机日期（本地时区，§二.2「今日」口径）。
 * @param {Date} [date]
 * @returns {string}
 */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * T28 额度校验：留空、≤0、小数、>1000000 都算错；不限制时不校验。
 * @param {{ dailyLimit: number, unlimited: boolean }} draft
 * @returns {boolean}
 */
export function quotaLimitBad(draft) {
  return !draft.unlimited && !(Number.isInteger(draft.dailyLimit) && draft.dailyLimit >= 1 && draft.dailyLimit <= 1000000);
}
