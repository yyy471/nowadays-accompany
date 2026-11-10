/**
 * 对话历史纯逻辑：按日统计、字面关键词检索、命中片段与上下文。
 * 不读写 DOM，也不产生展示用之外的虚构内容。
 */

export function dayKey(value) {
  const date = new Date(value);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function keyToDate(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function dateLabel(key) {
  const [year, month, day] = key.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

/** 字面、不区分大小写、空格分隔的 AND 检索；从不使用正则或 HTML。 */
export function termsFor(query) {
  return [...new Set(String(query || '').trim().split(/\s+/u).filter(Boolean).map(term => term.toLocaleLowerCase('zh-CN')))];
}

export function textFor(row) {
  return `${row.actionVisible && row.action ? `${row.action}\n` : ''}${row.text || ''}`;
}

function matches(row, terms) {
  const text = textFor(row).toLocaleLowerCase('zh-CN');
  return terms.length > 0 && terms.every(term => text.includes(term));
}

export function rangesFor(text, query) {
  const lower = text.toLocaleLowerCase('zh-CN');
  const ranges = [];
  for (const term of termsFor(query)) {
    let at = lower.indexOf(term);
    while (at !== -1) {
      ranges.push([at, at + term.length]);
      at = lower.indexOf(term, at + Math.max(1, term.length));
    }
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

export function snippet(text, query, max = 120) {
  if (text.length <= max) return text;
  const terms = termsFor(query);
  const lower = text.toLocaleLowerCase('zh-CN');
  let at = Infinity;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0) at = Math.min(at, index);
  }
  const start = Number.isFinite(at) ? Math.max(0, at - 30) : 0;
  return `${start ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`;
}

export function findHits(rows, query) {
  const terms = termsFor(query);
  return terms.length ? rows.filter(row => matches(row, terms)) : [];
}

export function buildDays(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    let day = map.get(key);
    if (!day) {
      day = { key, count: 0, ids: [], rounds: new Set() };
      map.set(key, day);
    }
    day.rounds.add(row.messageId ?? row.id);
    day.count = day.rounds.size;
    day.ids.push(row.id);
  }
  return [...map.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export function calendarDays(first, last) {
  const days = [];
  for (let date = keyToDate(first); dayKey(date) <= last; date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)) {
    days.push(dayKey(date));
  }
  return days;
}

export function dotTier(count) {
  return count >= 10 ? 3 : count >= 5 ? 2 : 1;
}

/** 一张片段卡对应一处命中（或一段连续对话），取命中所在一行前后各一条。 */
export function daySnippets(rows, key, query) {
  const day = rows.filter(row => dayKey(row.createdAt) === key);
  if (!day.length) return [];
  const terms = termsFor(query);
  let targets;
  if (terms.length) {
    targets = day.filter(row => matches(row, terms));
  } else {
    const sessions = [];
    let current = [];
    for (const row of day) {
      if (current.length && row.createdAt - current.at(-1).createdAt > 45 * 60000) {
        sessions.push(current);
        current = [];
      }
      current.push(row);
    }
    if (current.length) sessions.push(current);
    targets = sessions.map(session => session.find(row => row.role === 'assistant' && (row.text || row.actionVisible)) || session[0]);
  }
  return targets.map(target => {
    const index = day.indexOf(target);
    return {
      targetId: target.id,
      key,
      lines: [day[index - 1], target, day[index + 1]]
        .map((row, offset) => (row ? { ...row, main: offset === 1 } : null))
        .filter(Boolean)
    };
  });
}
