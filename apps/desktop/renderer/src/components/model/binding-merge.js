/**
 * 绑定字段级合并（278 §5、283 R06）。
 *
 * 对话与记忆各只能有一份绑定：按能力合并，同一能力被两边改到不同目标时
 * 报冲突并保留草稿。MCP／Skill 可以按用途与资源绑定多条，继续按
 * `能力:资源` 区分逐项合并。
 */

const MODEL_CAPS = ["chat_model", "memory_model"];
const EXT_CAPS = ["mcp", "skill"];

/**
 * @param {{
 *   base: Array<BindingLike>,
 *   draft: Array<BindingLike>,
 *   latest: Array<BindingLike>,
 *   scope: "models" | "ext",
 * }} input
 * @returns {{ items: Array<BindingLike>, conflicts: string[] }}
 */
export function mergeBindingDrafts({ base, draft, latest, scope }) {
  const scopedCaps = scope === "models" ? MODEL_CAPS : EXT_CAPS;
  const keyOf = (item) =>
    scope === "models" ? item.capability : `${item.capability}:${item.resourceId}`;
  const mapOf = (items) => {
    const map = new Map();
    for (const item of items ?? []) {
      if (!scopedCaps.includes(item.capability)) continue;
      map.set(keyOf(item), item);
    }
    return map;
  };
  const baseMap = mapOf(base);
  const draftMap = mapOf(draft);
  const latestMap = mapOf(latest);
  const merged = new Map(
    (latest ?? [])
      .filter((item) => !scopedCaps.includes(item.capability))
      .map((item) => [`${item.capability}:${item.resourceId}`, item]),
  );
  const conflicts = [];
  const keys = new Set([
    ...baseMap.keys(),
    ...draftMap.keys(),
    ...latestMap.keys(),
  ]);
  for (const key of keys) {
    const before = baseMap.get(key);
    const mine = draftMap.get(key);
    const server = latestMap.get(key);
    const userChanged = !sameBinding(before, mine);
    const serverChanged = !sameBinding(before, server);
    if (userChanged && serverChanged && !sameBinding(mine, server)) {
      conflicts.push(key);
      continue;
    }
    const chosen = userChanged ? mine : server ?? mine;
    if (chosen) merged.set(key, chosen);
  }
  return { items: [...merged.values()], conflicts };
}

/**
 * @typedef {Object} BindingLike
 * @property {string} capability
 * @property {string} resourceId
 * @property {string | null} [modelName]
 * @property {boolean} [enabled]
 */

function sameBinding(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.capability === right.capability &&
    left.resourceId === right.resourceId &&
    (left.modelName ?? null) === (right.modelName ?? null) &&
    !!left.enabled === !!right.enabled
  );
}
