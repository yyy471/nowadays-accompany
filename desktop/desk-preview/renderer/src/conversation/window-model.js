/**
 * 真实窗口数据的视图映射：消息/句段 → 演出行，过场图任务 → 舞台区间。
 * 纯函数，不访问网络与 DOM，供接入层和 Node 测试共用。
 */

export function sceneAssetUrl(roleId, assetId) {
  return `/v1/roles/${encodeURIComponent(roleId)}/scene-images/assets/${encodeURIComponent(assetId)}`;
}

/** 视图行需要稳定的数字标识；锚点取真实消息或句段编号。 */
export function createRowIdRegistry() {
  let next = 0;
  const map = new Map();
  return {
    id(anchor) {
      let value = map.get(anchor);
      if (value === undefined) {
        value = ++next;
        map.set(anchor, value);
      }
      return value;
    }
  };
}

export function messageStatusOf(terminal) {
  return terminal === 'completed' ? 'completed' : 'interrupted';
}

/**
 * 一条消息展开为演出行。用户消息只有一行；角色回复按句段顺序展开，
 * 中断消息只把最后一段标为「未说完」。
 */
export function rowsForMessage(message, segments, idFor) {
  if (message.sender === 'user') {
    return [{
      id: idFor(`message:${message.messageId}`),
      messageId: message.messageId,
      segmentId: message.messageId,
      ordinal: 0,
      role: 'user',
      text: message.content,
      action: '',
      actionVisible: false,
      sprite: null,
      status: message.status === 'interrupted' ? 'interrupted' : 'completed',
      createdAt: parseTime(message.createdAt)
    }];
  }
  const ordered = [...segments].sort((left, right) => left.ordinal - right.ordinal);
  // 早期保存的消息可能没有句段：保留原文，但不能伪造可供语音或生图使用的句段 ID。
  if (ordered.length === 0 && message.status !== 'generating' && message.content) {
    return [{
      id: idFor(`message:${message.messageId}`), messageId: message.messageId,
      segmentId: '', ordinal: 0, role: 'assistant', text: message.content,
      action: '', actionVisible: false, sprite: null, outfitId: null,
      status: message.status === 'interrupted' ? 'interrupted' : 'completed',
      createdAt: parseTime(message.createdAt)
    }];
  }
  return ordered.map((segment, index) => ({
    id: idFor(`segment:${segment.segmentId}`),
    messageId: message.messageId,
    segmentId: segment.segmentId,
    ordinal: segment.ordinal,
    role: 'assistant',
    text: segment.kind === 'speech' ? segment.text : '',
    action: segment.kind === 'narration' ? segment.text : '',
    actionVisible: segment.kind === 'narration',
    sprite: segment.spriteAssetId ?? null,
    outfitId: segment.outfitId ?? null,
    homeAssetId: segment.homeAssetId ?? null,
    status: message.status === 'interrupted' && index === ordered.length - 1 ? 'interrupted' : 'completed',
    createdAt: parseTime(message.createdAt)
  }));
}

/** 按 segmentId 合并（终态列表沿用原 ID），按 ordinal 排序。 */
export function mergeSegments(existing, incoming) {
  const map = new Map(existing.map(segment => [segment.segmentId, segment]));
  for (const segment of incoming) {
    const previous = map.get(segment.segmentId);
    map.set(segment.segmentId, previous === undefined ? { ...segment } : { ...previous, ...segment });
  }
  return [...map.values()].sort((left, right) => left.ordinal - right.ordinal);
}

/** 终态列表是完整快照，已阅读进度按位置保留，不保留被替换的临时句段。 */
export function reconcileFinalSegments(existing, incoming, shown) {
  const previous = new Map(existing.map(segment => [segment.segmentId, segment]));
  const segments = incoming.map(segment => ({ ...previous.get(segment.segmentId), ...segment }))
    .sort((left, right) => left.ordinal - right.ordinal);
  return { segments, shown: Math.min(shown, segments.length) };
}

/** 分页与事件可能乱序抵达，同次尝试不能用旧快照回退终态。 */
export function newerSceneTask(previous, incoming) {
  if (!previous) return incoming;
  if (incoming.attempt !== previous.attempt) return incoming.attempt > previous.attempt ? incoming : previous;
  const terminal = status => status === 'succeeded' || status === 'failed' || status === 'skipped';
  if (terminal(previous.status) && !terminal(incoming.status)) return previous;
  return parseTime(incoming.updatedAt) < parseTime(previous.updatedAt) ? previous : incoming;
}

/** 晚到表情标注按句段定位更新；不引入未提供的字段。 */
export function applySegmentAnnotations(segments, items, now = new Date().toISOString()) {
  if (!Array.isArray(items) || items.length === 0) return segments;
  const byId = new Map(items.map(item => [item.segmentId, item]));
  return segments.map(segment => {
    const item = byId.get(segment.segmentId);
    if (!item) return segment;
    return {
      ...segment,
      outfitId: item.outfitId ?? segment.outfitId,
      homeAssetId: item.homeAssetId ?? segment.homeAssetId,
      spriteAssetId: item.spriteAssetId ?? segment.spriteAssetId,
      annotatedAt: now
    };
  });
}

/** 把过场图任务映射为舞台区间；起止句段取同轮已读句段的首尾序号。 */
export function sceneView(task, segmentsByMessage, roleId) {
  const segments = segmentsByMessage.get(task.messageId) ?? [];
  const start = segments.find(segment => segment.segmentId === task.startSegmentId);
  const end = segments.find(segment => segment.segmentId === task.endSegmentId);
  const validRange = start && end && end.ordinal >= start.ordinal;
  const startOrdinal = validRange ? start.ordinal : -1;
  const endOrdinal = validRange ? end.ordinal : -1;
  return {
    id: task.taskId,
    messageId: task.messageId,
    mode: task.layerMode,
    start: startOrdinal,
    end: endOrdinal,
    startSegmentId: task.startSegmentId,
    endSegmentId: task.endSegmentId,
    status: task.status === 'succeeded' ? 'succeeded' : task.status === 'failed' || task.status === 'skipped' ? 'failed' : 'generating',
    source: task.trigger,
    taskStatus: task.status,
    errorCode: task.errorCode,
    errorSummary: task.errorSummary,
    assetId: task.result?.assetId ?? null,
    assetUrl: task.result === null ? null : sceneAssetUrl(roleId, task.result.assetId)
  };
}

/**
 * 页面快照里已有同一提交标识的消息，说明原提交已经被确认。
 * 窗口快照或补放事件据此收敛重试记录（283 §7 R02）。
 */
export function isSubmissionConfirmed(record, messages) {
  if (!record || typeof record.submissionId !== "string") return false;
  return (messages ?? []).some(
    (message) => message?.submissionId === record.submissionId
  );
}

/**
 * 快照确认原提交时，是否应清空当前恢复草稿。
 * 只清理由那次恢复带来且未被用户编辑过的内容；用户手动改成相同文本
 * 也算编辑过，不能被清空（283 §9 R02）。
 */
export function shouldClearRecoveredDraft(record, confirmedContent) {
  if (!record || record.edited === true) return false;
  return String(record.value ?? "").trim() === String(confirmedContent ?? "").trim();
}

/** 把页面快照里的句段按消息分组。 */
export function groupSegments(segments) {  const map = new Map();
  for (const segment of segments) {
    const list = map.get(segment.messageId) ?? [];
    list.push(segment);
    map.set(segment.messageId, list);
  }
  for (const list of map.values()) list.sort((left, right) => left.ordinal - right.ordinal);
  return map;
}

export function parseTime(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function lastRowOf(rows) {
  return rows.length ? rows[rows.length - 1] : null;
}

/** 差分仅从当前句段及其之前的同轮句段回退，不能提前采用后续句段的姿态。 */
export function spriteForRow(rows, current) {
  if (!current) return null;
  return [...rows].reverse().find(row =>
    row.messageId === current.messageId && row.ordinal <= current.ordinal && row.outfitId === current.outfitId && row.sprite
  )?.sprite ?? null;
}
