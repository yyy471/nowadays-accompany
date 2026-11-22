import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/** 旧报告的分支目录由 mkdtemp 生成。只读取匹配固定前缀的本次角色库，并逐项核对原问题、执行、原回复。 */
export function locateCompletedBoundary(stage, roleId, row, scratchParent) {
  if (!/^privacy-public$|^agency-(?:pressure|new-reason)$/.test(stage) || !row?.userMessageId || !row.executionId || row.status !== "visible_reply") throw Error("BOUNDARY_SOURCE_TURN_MISSING:" + stage);
  const entries = fs.readdirSync(scratchParent, { withFileTypes: true });
  const matches = [];
  const directoryName = new RegExp("^nowadays-boundary-" + stage + "-[A-Za-z0-9]{6}$");
  for (const entry of entries) {
    if (!entry.isDirectory() || !directoryName.test(entry.name)) continue;
    const appRoot = path.resolve(scratchParent, entry.name, "app");
    const database = path.join(appRoot, "data", "roles", roleId, "business.sqlite");
    if (!fs.existsSync(database)) continue;
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const source = db.prepare(`SELECT u.window_id AS windowId,u.created_at AS at FROM messages u
        JOIN messages a ON a.execution_id=u.processed_by_execution_id AND a.sender='assistant' AND a.status='completed'
        WHERE u.message_id=? AND u.processed_by_execution_id=? AND u.sender='user' AND u.content=? AND a.content=?`).get(row.userMessageId, row.executionId, row.input, row.replies.at(-1));
      if (source) matches.push({ appRoot, ...source });
    } finally { db.close(); }
  }
  if (matches.length !== 1) throw Error("BOUNDARY_SOURCE_NOT_UNIQUE:" + stage + ":" + matches.length);
  return matches[0];
}

export function followupTime(stage, previousTime) {
  const now = Date.parse(previousTime);
  if (stage === "privacy-public") return now + 5 * 60000;
  // 以本试验的上海时区确定下一个周五晚间。
  const local = new Date(now + 8 * 3600000);
  const friday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (5 - local.getUTCDay() + 7) % 7, 12, 20)).getTime();
  return friday > now ? friday : friday + 7 * 86400000;
}

// 一次提交对应一个用户消息。失败可用原 submissionId 走后端幂等重调度；
// 在途执行只读轮询，已经发布过部分正文的失败留待人工复核。
export async function deliverBoundary({ app, roleId, windowId, dbPath, report, input, stage, metadata, save }) {
  const ordinal = report.turns.findIndex(row => row.stage === stage);
  const old = report.turns[ordinal];
  if (old?.status === "visible_reply") return;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout=10000");
  try {
    const oldUser = db.prepare("SELECT message_id,submission_id FROM messages WHERE window_id=? AND sender='user' AND content=? ORDER BY sequence DESC LIMIT 1").get(windowId, input);
    const submissionId = oldUser?.submission_id || randomUUID();
    const submit = () => app.conversation.submitMessage(roleId, windowId, { content: input, sourcePlatform: "nowadays", submissionId }).message.messageId;
    const messageId = oldUser?.message_id ?? submit();
    const read = db.prepare(`SELECT e.execution_id AS executionId,e.status AS executionStatus,a.status AS replyStatus,a.content AS reply,
      (SELECT count(*) FROM messages q WHERE q.sender='user' AND q.processed_by_execution_id=e.execution_id) AS userCount
      FROM messages u LEFT JOIN executions e ON e.execution_id=COALESCE(u.processed_by_execution_id,u.claimed_by_execution_id,
      (SELECT execution_id FROM executions WHERE trigger_message_id=u.message_id ORDER BY rowid DESC LIMIT 1))
      LEFT JOIN messages a ON a.execution_id=e.execution_id AND a.sender='assistant' WHERE u.message_id=?`);
    const turnNumber = ordinal < 0 ? report.turns.length + 1 : ordinal + 1;
    const deadline = Date.now() + 240000;
    let rejectedId;
    let retries = 0;
    let rows = [];
    while (Date.now() < deadline) {
      rows = read.all(messageId);
      if (rows.some(row => row.replyStatus === "completed")) break;
      const outcome = rows[0];
      if (outcome.executionStatus === "failed" && outcome.executionId !== rejectedId) {
        const rate = report.calls.findLast(call => call.status === 429 && (call.stage === stage || (!call.stage && call.turn === turnNumber)));
        const failures = report.attempts ??= [];
        if (!failures.some(a => a.executionId === outcome.executionId)) failures.push({ stage, userMessageId: messageId, executionId: outcome.executionId, status: "failed", partial: rows.some(row => Boolean(row.reply)), httpStatus: rate ? 429 : undefined });
        save();
        if (!rate || retries >= 2 || rows.some(row => Boolean(row.reply)) || (oldUser && !oldUser.submission_id)) break;
        const wait = Math.max(12000 * 2 ** retries, rate.retryAfterMs ?? 0);
        if (Date.now() + wait >= deadline) break;
        await sleep(wait);
        // 后端重启本身也可能已接回原消息。再次读取后才决定是否发出幂等重试。
        const latest = read.all(messageId)[0];
        if (latest.executionId === outcome.executionId && latest.executionStatus === "failed") {
          if (submit() !== messageId) throw Error("BOUNDARY_RETRY_CHANGED_USER_MESSAGE");
        }
        rejectedId = outcome.executionId;
        retries++;
        continue;
      }
      if (outcome.executionStatus === "superseded" || outcome.executionStatus === "completed") break;
      await sleep(350);
    }
    const replies = rows.filter(row => row.replyStatus === "completed" && row.userCount === 1).map(row => row.reply);
    const entry = { stage, input, ...metadata, userMessageId: messageId, executionId: rows[0]?.executionId, replies, messageStatuses: rows.map(row => row.replyStatus),
      executionStatus: rows[0]?.executionStatus, status: replies.some(reply => reply?.trim()) ? "visible_reply" : "no_visible_reply" };
    if (ordinal < 0) report.turns.push(entry);
    else report.turns[ordinal] = entry;
    save();
    if (entry.status !== "visible_reply") throw Error("BOUNDARY_NO_INDEPENDENT_REPLY:" + stage);
  } finally { db.close(); }
}
