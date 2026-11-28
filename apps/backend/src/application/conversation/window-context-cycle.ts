import type Database from "better-sqlite3";
import type { ConversationMessageView } from "../../domain/conversation.js";

/** 30+n 周期默认参数（410 R2-14 / DL-202）。 */
export const DEFAULT_CYCLE_BASE_MESSAGES = 30;
export const DEFAULT_CYCLE_TRIGGER_NEW_MESSAGES = 20;
export const DEFAULT_CYCLE_TOKEN_PRESSURE_RATIO = 0.78;

export interface WindowContextStateRecord {
  windowId: string;
  roleId: string;
  summaryVersion: number;
  summaryText: string;
  coveredUntilSequence: number;
  historyLeftSequence: number;
  cycleStartSequence: number;
  updatedAt: string;
}

export interface WindowCyclePolicy {
  baseMessages?: number;
  triggerNewMessages?: number;
}

export interface ProposedWindowCompaction {
  windowId: string;
  roleId: string;
  previousSummaryVersion: number;
  previousSummaryText: string;
  previousCoveredUntilSequence: number;
  /** 本次建议移出并交由摘要覆盖的终点消息序号。 */
  targetCoveredUntilSequence: number;
  /** 切换后新周期的左边界消息序号（已对齐完整交互起点）。 */
  proposedLeftSequence: number;
  /** 待移出并纳入新摘要的公开消息列表。 */
  evictedMessages: ConversationMessageView[];
  /** 触发时的最新已提交序号。 */
  latestCommittedSequence: number;
}

export interface CycleHistorySelection {
  state: WindowContextStateRecord;
  /** 固定左边界向右追加的已提交公开历史消息（不含 pending 与 generating）。 */
  messages: ConversationMessageView[];
  /** 当前周期内自左边界/起算点后新增的公开消息数 n。 */
  newMessagesCount: number;
  /** 是否达到阈值应触发后台整理（或被显式提前触发）。 */
  shouldCompact: boolean;
  /** 达到整理条件且存在可安全移出的完整交互段时返回整理计划。 */
  compaction: ProposedWindowCompaction | null;
}

export interface CommitWindowSummaryInput {
  windowId: string;
  roleId: string;
  expectedSummaryVersion: number;
  summaryText: string;
  coveredUntilSequence: number;
  proposedLeftSequence: number;
  latestCommittedSequence: number;
  now: string;
}

export type CommitWindowSummaryResult =
  | { committed: true; state: WindowContextStateRecord }
  | {
      committed: false;
      reason:
        | "EMPTY_SUMMARY"
        | "INSUFFICIENT_COVERAGE"
        | "STALE_VERSION"
        | "NON_MONOTONIC"
        | "INVALID_BOUNDARY";
    };

export interface WindowSummaryCompactorInput {
  roleId: string;
  windowId: string;
  previousSummary: string;
  previousCoveredUntilSequence: number;
  evictedMessages: readonly ConversationMessageView[];
  targetCoveredUntilSequence: number;
  signal: AbortSignal;
}

export interface WindowSummaryCompactorResult {
  summaryText: string;
  coveredUntilSequence: number;
}

export type WindowSummaryCompactor = (
  input: WindowSummaryCompactorInput,
) => Promise<WindowSummaryCompactorResult>;

interface WindowContextStateRow {
  window_id: string;
  role_id: string;
  summary_version: number;
  summary_text: string;
  covered_until_sequence: number;
  history_left_sequence: number;
  cycle_start_sequence: number;
  updated_at: string;
}

interface CommittedMessageRow {
  message_id: string;
  window_id: string;
  sender: "user" | "assistant";
  content: string;
  status: string;
  sequence: number;
  created_at: string;
}

function mapStateRow(row: WindowContextStateRow): WindowContextStateRecord {
  return {
    windowId: row.window_id,
    roleId: row.role_id,
    summaryVersion: row.summary_version,
    summaryText: row.summary_text,
    coveredUntilSequence: row.covered_until_sequence,
    historyLeftSequence: row.history_left_sequence,
    cycleStartSequence: row.cycle_start_sequence,
    updatedAt: row.updated_at,
  };
}

export function getWindowContextState(
  db: Database.Database,
  windowId: string,
): WindowContextStateRecord | null {
  const row = db
    .prepare(
      `SELECT window_id, role_id, summary_version, summary_text,
              covered_until_sequence, history_left_sequence, cycle_start_sequence, updated_at
       FROM window_context_states
       WHERE window_id = ?`,
    )
    .get(windowId) as WindowContextStateRow | undefined;
  return row === undefined ? null : mapStateRow(row);
}

function listCommittedPublicMessages(
  db: Database.Database,
  windowId: string,
  fromSequence: number,
  pendingIds: ReadonlySet<string>,
): ConversationMessageView[] {
  const rows = db
    .prepare(
      `SELECT message_id, window_id, sender, content, status, sequence, created_at
       FROM messages
       WHERE window_id = ? AND status != 'generating' AND sequence >= ?
       ORDER BY sequence ASC`,
    )
    .all(windowId, fromSequence) as CommittedMessageRow[];
  return rows
    .filter((row) => !pendingIds.has(row.message_id))
    .map((row) => ({
      messageId: row.message_id,
      windowId: row.window_id,
      sender: row.sender,
      content: row.content,
      status: row.status,
      sequence: row.sequence,
      createdAt: row.created_at,
    }));
}

/**
 * 寻找保留最近约 targetKeep 条消息时的左边界索引，并对齐到完整交互起点（user 消息）。
 * 若向前对齐找不到 user 消息则向后寻找，确保不以悬空 assistant 回复开头。
 */
export function alignKeepStartIndex(
  messages: readonly ConversationMessageView[],
  targetKeep: number,
): number {
  if (messages.length <= targetKeep) return 0;
  let index = messages.length - targetKeep;
  // 优先向前微调到当前交互的 user 起点，保留完整问答对。
  let backward = index;
  while (backward > 0 && messages[backward]?.sender !== "user") {
    backward -= 1;
  }
  if (messages[backward]?.sender === "user") {
    return backward;
  }
  // 找不到前置 user 时向后找最近 user 起点，仍保留至少一条消息。
  while (index < messages.length - 1 && messages[index]?.sender !== "user") {
    index += 1;
  }
  return index;
}

/**
 * 按 30+n 策略读取本轮已提交历史并评估是否应触发周期整理（DL-202）：
 * - 周期内固定 history_left_sequence，只向右追加已提交公开消息；
 * - 达到新增阈值 T（或收到 token 压力提前整理请求）时，规划新左边界与待移出段，
 *   但绝不直接切换状态，直到摘要成功覆盖全部移出消息后经 tryCommitWindowSummary 原子切换。
 */
export function selectCycleHistory(
  db: Database.Database,
  roleId: string,
  windowId: string,
  pendingIds: ReadonlySet<string>,
  now: string,
  policy: WindowCyclePolicy = {},
  forceEarlyCompaction = false,
): CycleHistorySelection {
  const baseMessages = Math.max(2, policy.baseMessages ?? DEFAULT_CYCLE_BASE_MESSAGES);
  const triggerNewMessages = Math.max(
    1,
    policy.triggerNewMessages ?? DEFAULT_CYCLE_TRIGGER_NEW_MESSAGES,
  );

  let state = getWindowContextState(db, windowId);
  if (state === null) {
    const allCommitted = listCommittedPublicMessages(db, windowId, 1, pendingIds);
    const keepIndex = alignKeepStartIndex(allCommitted, baseMessages);
    const leftSequence = allCommitted[keepIndex]?.sequence ?? 1;
    const latestSeq = allCommitted.at(-1)?.sequence ?? 0;
    // 若首次建态时历史已超过 baseMessages，以当前对齐位置作为本周期起点；
    // 否则从 0 起算，让窗口自然成长到 baseMessages + triggerNewMessages 再首次整理。
    const cycleStartSequence =
      allCommitted.length >= baseMessages ? latestSeq : 0;
    db.prepare(
      `INSERT OR IGNORE INTO window_context_states
       (window_id, role_id, summary_version, summary_text, covered_until_sequence,
        history_left_sequence, cycle_start_sequence, updated_at)
       VALUES (?, ?, 0, '', 0, ?, ?, ?)`,
    ).run(windowId, roleId, leftSequence, cycleStartSequence, now);
    state = getWindowContextState(db, windowId) ?? {
      windowId,
      roleId,
      summaryVersion: 0,
      summaryText: "",
      coveredUntilSequence: 0,
      historyLeftSequence: leftSequence,
      cycleStartSequence,
      updatedAt: now,
    };
  }

  const messages = listCommittedPublicMessages(
    db,
    windowId,
    Math.max(1, state.historyLeftSequence),
    pendingIds,
  );
  const latestSeq = messages.at(-1)?.sequence ?? state.cycleStartSequence;
  // n：当已有明确 cycleStartSequence 时计算周期新增公开消息数；初始冷窗时计算超出基础 30 条的增量。
  const newMessagesCount =
    state.cycleStartSequence > 0
      ? messages.filter((item) => item.sequence > state!.cycleStartSequence).length
      : Math.max(0, messages.length - baseMessages);

  const shouldCompact =
    (newMessagesCount >= triggerNewMessages || forceEarlyCompaction) &&
    messages.length > baseMessages;

  let compaction: ProposedWindowCompaction | null = null;
  if (shouldCompact) {
    const keepIndex = alignKeepStartIndex(messages, baseMessages);
    if (keepIndex > 0) {
      const evicted = messages.slice(0, keepIndex);
      const proposedLeft = messages[keepIndex]!.sequence;
      const targetCoveredUntil = evicted.at(-1)!.sequence;
      if (
        proposedLeft > state.historyLeftSequence &&
        targetCoveredUntil > state.coveredUntilSequence
      ) {
        compaction = {
          windowId,
          roleId,
          previousSummaryVersion: state.summaryVersion,
          previousSummaryText: state.summaryText,
          previousCoveredUntilSequence: state.coveredUntilSequence,
          targetCoveredUntilSequence: targetCoveredUntil,
          proposedLeftSequence: proposedLeft,
          evictedMessages: evicted,
          latestCommittedSequence: latestSeq,
        };
      }
    }
  }

  return {
    state,
    messages,
    newMessagesCount,
    shouldCompact,
    compaction,
  };
}

/**
 * 原子切换窗口滚动摘要与新左边界（DL-202）：
 * 仅当摘要非空、覆盖终点覆盖全部准备移出的历史且版本号/序号单调推进时才提交；
 * 否则保持旧周期材料原样可用，避免丢失未覆盖历史。
 */
export function tryCommitWindowSummary(
  db: Database.Database,
  input: CommitWindowSummaryInput,
): CommitWindowSummaryResult {
  const summaryText = input.summaryText.trim();
  if (summaryText.length === 0) {
    return { committed: false, reason: "EMPTY_SUMMARY" };
  }
  if (input.proposedLeftSequence <= 1) {
    return { committed: false, reason: "INVALID_BOUNDARY" };
  }
  return db.transaction((): CommitWindowSummaryResult => {
    const current = getWindowContextState(db, input.windowId);
    if (current === null || current.summaryVersion !== input.expectedSummaryVersion) {
      return { committed: false, reason: "STALE_VERSION" };
    }
    if (
      input.proposedLeftSequence <= current.historyLeftSequence ||
      input.coveredUntilSequence <= current.coveredUntilSequence
    ) {
      return { committed: false, reason: "NON_MONOTONIC" };
    }
    // 核对即将移出区间内的最后一条已提交公开消息，确认新摘要确实覆盖了全部待移出历史。
    const lastEvicted = db
      .prepare(
        `SELECT MAX(sequence) AS max_seq
         FROM messages
         WHERE window_id = ? AND status != 'generating'
           AND sequence >= ? AND sequence < ?`,
      )
      .get(
        input.windowId,
        Math.max(1, current.historyLeftSequence),
        input.proposedLeftSequence,
      ) as { max_seq: number | null } | undefined;
    const requiredCoveredUntil = lastEvicted?.max_seq ?? input.proposedLeftSequence - 1;
    if (input.coveredUntilSequence < requiredCoveredUntil) {
      return { committed: false, reason: "INSUFFICIENT_COVERAGE" };
    }
    // 核对新左边界对应的消息是完整交互起点（若仍存在且为非 user，拒绝错切）。
    const boundaryRow = db
      .prepare(
        `SELECT sender FROM messages
         WHERE window_id = ? AND sequence = ? AND status != 'generating'`,
      )
      .get(input.windowId, input.proposedLeftSequence) as
      | { sender: "user" | "assistant" }
      | undefined;
    if (boundaryRow === undefined) {
      return { committed: false, reason: "INVALID_BOUNDARY" };
    }

    const nextVersion = current.summaryVersion + 1;
    const nextCycleStart = Math.max(
      input.latestCommittedSequence,
      input.proposedLeftSequence,
    );
    db.prepare(
      `UPDATE window_context_states
       SET summary_version = ?,
           summary_text = ?,
           covered_until_sequence = ?,
           history_left_sequence = ?,
           cycle_start_sequence = ?,
           updated_at = ?
       WHERE window_id = ? AND summary_version = ?`,
    ).run(
      nextVersion,
      summaryText,
      input.coveredUntilSequence,
      input.proposedLeftSequence,
      nextCycleStart,
      input.now,
      input.windowId,
      input.expectedSummaryVersion,
    );
    const updated = getWindowContextState(db, input.windowId)!;
    return { committed: true, state: updated };
  })();
}

/** 渲染周期稳定材料中的窗口滚动历史摘要块；未生成摘要时返回空串。 */
export function formatWindowRollingSummary(
  state: WindowContextStateRecord | null,
): string {
  if (state === null || state.summaryVersion <= 0 || state.summaryText.trim().length === 0) {
    return "";
  }
  return [
    `当前窗口早期历史滚动摘要（版本 v${state.summaryVersion}，覆盖至消息序号 #${state.coveredUntilSequence}；如需核对具体原话请用 history_lookup 回查）：`,
    state.summaryText.trim(),
  ].join("\n");
}
