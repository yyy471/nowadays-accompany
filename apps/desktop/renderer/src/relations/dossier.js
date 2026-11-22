/** 关系页纯逻辑：角色切换门闩、状态原文和记忆投影。不写界面，也不补虚构经历。 */

const SKIPPED_STATE_KEYS = new Set(["outfitId"]);

export function createRoleRequestGate() {
  let generation = 0;
  let roleId = "";
  return {
    begin(nextRoleId) {
      roleId = nextRoleId;
      generation += 1;
      return { token: generation, roleId };
    },
    accept(ticket) {
      return !!ticket && ticket.token === generation && ticket.roleId === roleId;
    },
    currentRoleId() {
      return roleId;
    }
  };
}

export function initialRelationUi(roleId = "") {
  return {
    roleId,
    view: "home",
    packet: null,
    openEventId: null,
    evidenceId: null,
    diaryIndex: 0,
    error: ""
  };
}

/** 换人时立刻丢掉上一份介绍、经历、日记和依据，视图层级保持不变。 */
export function reduceRelation(state, action) {
  if (action.type === "switch") {
    return {
      ...state,
      roleId: action.roleId,
      packet: null,
      openEventId: null,
      evidenceId: null,
      diaryIndex: 0,
      error: ""
    };
  }
  if (action.type === "loaded") {
    if (action.roleId !== state.roleId) return state;
    // 日记分批到达：补入排序靠前的日记会把后面的条目整体后移，
    // 按 id 重新定位，用户正在读的那一篇不会被换掉。
    const selected = state.packet?.diaries[state.diaryIndex];
    let diaryIndex = state.diaryIndex;
    if (selected) {
      const nextIndex = action.packet.diaries.findIndex(item => item.id === selected.id);
      diaryIndex = nextIndex >= 0
        ? nextIndex
        : Math.min(state.diaryIndex, Math.max(0, action.packet.diaries.length - 1));
    }
    return { ...state, packet: action.packet, error: "", diaryIndex };
  }
  if (action.type === "failed") {
    if (action.roleId !== state.roleId) return state;
    return { ...state, packet: null, error: action.error };
  }
  if (action.type === "view") {
    return { ...state, view: action.view, openEventId: null, evidenceId: null };
  }
  if (action.type === "diary") {
    return { ...state, diaryIndex: action.index };
  }
  if (action.type === "event") {
    const same = state.openEventId === action.eventId;
    return { ...state, openEventId: same ? null : action.eventId, evidenceId: null };
  }
  if (action.type === "evidence") {
    return { ...state, evidenceId: state.evidenceId === action.evidenceId ? null : action.evidenceId };
  }
  return state;
}

export function visiblePacket(state) {
  if (!state.packet || state.packet.roleId !== state.roleId) return null;
  return state.packet;
}

export function profileModel(state, listName = "") {
  const packet = visiblePacket(state);
  if (!packet) {
    return { name: listName, definition: "", lines: [], loading: state.roleId !== "" && state.error === "", missing: state.roleId === "" };
  }
  return {
    name: packet.displayName || listName,
    definition: packet.definitionText,
    lines: packet.stateLines,
    loading: false,
    missing: false
  };
}

export function stateLines(state) {
  if (!state || typeof state !== "object") return [];
  const lines = [];
  for (const [key, value] of Object.entries(state)) {
    if (SKIPPED_STATE_KEYS.has(key) || typeof value !== "string") continue;
    const text = value.trim();
    if (!text) continue;
    lines.push({ key, label: stateLabel(key), value: text });
    if (lines.length >= 6) break;
  }
  return lines;
}

export function stateSentence(state) {
  const preferred = ["moodSummary", "note", "mood", "心境", "关注事项", "关系感受", "目标"];
  for (const key of preferred) {
    const value = state?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return stateLines(state)[0]?.value ?? "";
}

function stateLabel(key) {
  const known = {
    mood: "近况",
    moodSummary: "近况",
    note: "近况",
    心境: "心境",
    关注: "关注",
    关注事项: "关注",
    关系感受: "关系感受",
    目标: "目标"
  };
  return known[key] ?? key;
}

export function splitDefinition(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { quote: "", body: "" };
  const parts = trimmed.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  if (parts.length > 1) return { quote: parts[0], body: parts.slice(1).join("\n\n") };
  return { quote: "", body: trimmed };
}

export function diaryTitle(content, date) {
  const lines = String(content ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const heading = lines.find(line => line.startsWith("#"));
  const source = heading ? heading.replace(/^#+\s*/, "") : lines.find(line => !line.startsWith("#"));
  const title = (source || date || "日记").replace(/^#+\s*/, "").trim();
  return [...title].slice(0, 40).join("");
}

export function diaryParagraphs(content) {
  const body = String(content ?? "")
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith("#"))
    .join("\n")
    .trim();
  if (!body) return [];
  return body.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
}

export function formatExperienceDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return String(value ?? "");
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function projectSearchItem(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title || "未命名记录",
    snippet: item.snippet || "",
    date: ""
  };
}
