import type Database from "better-sqlite3";

export interface DialogueBatch {
  batchId: string;
  roleId: string;
  windowId: string;
  afterSeq: number;
  upToSeq: number;
  messageCount: number;
  completedAt: string;
}

// 调用方已在回复提交事务内。只把本轮实际领取的来信及其回复登记到批次。
export function observeDialogue(db: Database.Database, input: {
  roleId: string; windowId: string; executionId: string; replyId: string; replySeq: number;
  firstUserSeq: number; userCount: number; now: string; delayMs: number;
}): void {
  const {roleId, windowId, executionId, replySeq, firstUserSeq, now} = input;
  const open = db.prepare(`SELECT batch_id FROM observed_dialogue_batches
    WHERE role_id = ? AND window_id = ? AND delivered_at IS NULL AND due_at > ?
    ORDER BY completed_at DESC, rowid DESC LIMIT 1`).get(roleId, windowId, now) as {batch_id: string} | undefined;
  const batchId = open?.batch_id ?? `dialogue-${executionId}`;
  const dueAt = new Date(Date.parse(now) + input.delayMs).toISOString();
  db.prepare(`INSERT INTO observed_dialogue_batches
    (batch_id, role_id, window_id, after_seq, up_to_seq, message_count, completed_at, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(batch_id) DO UPDATE SET
    after_seq = MIN(after_seq, excluded.after_seq), up_to_seq = MAX(up_to_seq, excluded.up_to_seq),
    message_count = message_count + excluded.message_count, completed_at = excluded.completed_at,
    due_at = excluded.due_at`).run(batchId, roleId, windowId, firstUserSeq - 1, replySeq, input.userCount + 1, now, dueAt);
  db.prepare(`INSERT INTO observed_dialogue_members (message_id, batch_id)
    SELECT message_id, ? FROM messages WHERE window_id = ? AND
    ((sender = 'user' AND processed_by_execution_id = ?) OR message_id = ?)`).run(batchId, windowId, executionId, input.replyId);
}

export function pendingDialogueBatches(db: Database.Database, roleId: string, now: string): DialogueBatch[] {
  return db.prepare(`SELECT batch_id AS batchId, role_id AS roleId, window_id AS windowId,
    after_seq AS afterSeq, up_to_seq AS upToSeq, message_count AS messageCount, completed_at AS completedAt
    FROM observed_dialogue_batches WHERE role_id = ? AND delivered_at IS NULL AND due_at <= ?
    ORDER BY due_at, rowid`).all(roleId, now) as DialogueBatch[];
}
