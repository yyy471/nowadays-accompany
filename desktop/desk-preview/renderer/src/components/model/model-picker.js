/**
 * 模型名称选择控件的纯逻辑：候选过滤与测试结果文案。
 *
 * 手填始终可用；列表只用来提供候选，不限制最终提交的模型标识。
 */

const MAX_CANDIDATES = 50;

/**
 * @param {readonly string[] | undefined} models
 * @param {string} query
 * @returns {string[]}
 */
export function filterModelNames(models, query) {
  const keyword = String(query ?? "").trim().toLowerCase();
  const seen = new Set();
  const result = [];
  for (const name of models ?? []) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    if (keyword.length === 0 || name.toLowerCase().includes(keyword)) result.push(name);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

/**
 * @param {{ ok?: boolean, elapsedMs?: number, error?: { message?: string } } | null | undefined} result
 * @returns {string}
 */
export function modelTestNote(result) {
  if (result === null || result === undefined) return "";
  if (result.ok === true) {
    const ms = Math.max(0, Math.round(Number(result.elapsedMs ?? 0)));
    return `测试通过 · ${ms} ms`;
  }
  return `测试失败：${result.error?.message ?? "模型请求失败"}`;
}
