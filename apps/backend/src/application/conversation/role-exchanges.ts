import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import { isAdminSeat } from "../../domain/admin-seat.js";
import { memoryQueryTokens } from "../../domain/memory-query-tokens.js";
import type { AppStore } from "../../storage/core/app-store.js";
import { AutonomyStore } from "../../storage/conversation/autonomy-store.js";
import { localDateFromIso, SPOKEN_REPLY_SQL, upsertEvidence } from "../../storage/memory/evidence.js";
import { MemoryStore } from "../../storage/memory/memory-store.js";
import type { RoleAccess } from "../role/role-access.js";

export interface ExchangeSession {
  sessionId: string; initiatorRoleId: string; targetRoleId: string;
  initiatorName: string; targetName: string; topic: string;
  status: "active" | "completed" | "failed" | "cancelled";
  maxTurns: number; turnCount: number; startedAt: string; endedAt: string | null; reason: string | null;
}
interface ExchangeTurn {
  sessionId: string; turnIndex: number; exchangeId: string; speakerRoleId: string;
  speakerName: string; content: string; createdAt: string;
}
const columns = "sessionId, initiatorRoleId, targetRoleId, initiatorName, targetName, topic, status, maxTurns, turnCount, startedAt, endedAt, reason";
const wakePrefix = "role-exchange:";
export function exchangeWake(wakeId?: string | null) {
  if (!wakeId?.startsWith(wakePrefix)) return null;
  const [, sessionId, index] = wakeId.split(":");
  return sessionId && index ? { sessionId, after: Number(index) } : null;
}

function nextSpeaker(s: ExchangeSession) {
  return s.turnCount % 2 ? s.targetRoleId : s.initiatorRoleId;
}
function turns(db: Database.Database, id: string) {
  return db.prepare("SELECT * FROM role_exchange_turns WHERE sessionId=? ORDER BY turnIndex").all(id) as ExchangeTurn[];
}
function summary(db: Database.Database, id: string) {
  const s = db.prepare(`SELECT ${columns} FROM role_exchange_sessions WHERE sessionId=?`).get(id) as ExchangeSession | undefined;
  if (!s) throw new AppError(404, "ROLE_EXCHANGE_NOT_FOUND", "会话不存在");
  return s;
}

export class RoleExchangeService {
  private feedChange: ((roleId: string) => void) | null;

  constructor(private readonly app: AppStore, private readonly access: RoleAccess,
    private readonly now: () => Date, private readonly canStart: (id: string) => boolean,
    private readonly wakeChanged: (id: string) => void, private readonly memoryChanged: (id: string) => void,
    private readonly timeZone?: string, private readonly onExchange?: (session: ExchangeSession) => void,
    onFeedChange?: (roleId: string) => void) {
    this.feedChange = onFeedChange ?? null;
  }

  /** 应用装配完成后再注入状态流广播；扩展宿主等构造期依赖无需传入此回调。 */
  setFeedChangeListener(listener: ((roleId: string) => void) | null): void {
    this.feedChange = listener;
  }

  private notifyFeed(roleId: string): void {
    try {
      this.feedChange?.(roleId);
    } catch {
      // 广播失败不得影响会话落库与镜像。
    }
  }

  private withDb<T>(roleId: string, fn: (db: Database.Database) => T) {
    return this.access.withStore(roleId, s => fn(s.business.db));
  }

  start(initiatorRoleId: string, targetRoleId: string, topic: string, opening: string, maxTurns = 6) {
    if (!isAdminSeat(this.access.requireReady(initiatorRoleId).builtinKey)) throw new AppError(403, "ROLE_EXCHANGE_INITIATOR", "仅主角色可以发起会话");
    if (initiatorRoleId === targetRoleId || !topic.trim() || !opening.trim() || !Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 12)
      throw new AppError(400, "ROLE_EXCHANGE_ARGUMENTS", "请指定另一角色、话题、开场白及 2 至 12 的整数轮数");
    const name = (id: string) => this.access.withStore(id, s => s.business.getRole(id).displayName);
    const startedAt = this.now().toISOString();
    const s: ExchangeSession = { sessionId: randomUUID(), initiatorRoleId, targetRoleId, initiatorName: name(initiatorRoleId),
      targetName: name(targetRoleId), topic: topic.trim(), status: "active", maxTurns, turnCount: 1, startedAt, endedAt: null, reason: null };
    return this.commit(s, this.turn(s, initiatorRoleId, opening, startedAt));
  }

  reply(roleId: string, sessionId: string, after: number, content: string, endConversation: boolean) {
    const s = this.current(roleId, sessionId);
    if (after !== s.turnCount || s.status !== "active" || nextSpeaker(s) !== roleId)
      throw new AppError(409, "ROLE_EXCHANGE_TURN_CLOSED", "该发言轮次已结束");
    if (!content.trim()) throw new AppError(400, "ROLE_EXCHANGE_EMPTY", "发言不能为空");
    s.turnCount++;
    const now = this.now().toISOString();
    if (endConversation || s.turnCount === s.maxTurns) {
      s.status = "completed";
      s.endedAt = now;
    }
    return this.commit(s, this.turn(s, roleId, content, now));
  }

  private current(roleId: string, sessionId: string) {
    const local = this.withDb(roleId, db => summary(db, sessionId));
    return local.initiatorRoleId === roleId ? local : this.withDb(local.initiatorRoleId, db => summary(db, sessionId));
  }

  recallContext(roleId: string, sessionId: string) {
    return this.withDb(roleId, db => {
      const session = summary(db, sessionId);
      const last = db.prepare("SELECT content FROM role_exchange_turns WHERE sessionId=? ORDER BY turnIndex DESC LIMIT 1")
        .get(sessionId) as {content: string};
      const topic = session.topic.slice(0, 180) + " " + last.content.slice(0, 240);
      const peer = roleId === session.initiatorRoleId ? session.targetName : session.initiatorName;
      const terms = memoryQueryTokens(topic, "auto").filter(term => term.length >= 2);
      // 仅检索自己在本机直接窗口实际发表的回复，避免把用户私下原话带进互聊。
      const recent = db.prepare(`SELECT m.created_at AS at, substr(m.content,1,2000) AS text FROM messages m
        JOIN windows w USING(window_id) WHERE w.role_id=? AND w.source='nowadays' AND ${SPOKEN_REPLY_SQL}
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT 32`).all(roleId) as {at: string; text: string}[];
      const spoken = recent.flatMap(row => {
        const text = row.text.toLowerCase();
        const hits = terms.filter(term => text.includes(term));
        if (!hits.length) return [];
        const start = Math.max(0, text.indexOf(hits[0]!) - 80);
        return [{at: row.at, excerpt: row.text.slice(start, start + 400), score: hits.length}];
      }).sort((a,b) => b.score - a.score).slice(0,3).map(({at,excerpt}) => ({at,excerpt}));
      return { query: peer + " " + topic, spoken };
    });
  }

  private turn(s: ExchangeSession, id: string, content: string, createdAt: string): ExchangeTurn {
    return { sessionId: s.sessionId, turnIndex: s.turnCount, exchangeId: randomUUID(), speakerRoleId: id,
      speakerName: id === s.initiatorRoleId ? s.initiatorName : s.targetName, content: content.trim(), createdAt };
  }

  private commit(s: ExchangeSession, turn?: ExchangeTurn) {
    if (s.status === "active") {
      const id = nextSpeaker(s);
      const budget = this.withDb(id, db => new AutonomyStore(db, id, this.timeZone).getBudget(this.now().toISOString()));
      const reason = !this.canStart(id) ? "ROLE_STOPPED" : !budget.unlimited && budget.usedPoints >= budget.dailyLimit ? "AUTONOMY_BUDGET_EXHAUSTED" : null;
      if (reason) Object.assign(s, { status: "cancelled", reason, endedAt: this.now().toISOString() });
    }
    // 发起方保存决策及待同步标志。另一侧、证据和轮次唤醒可按相同编号安全重放。
    this.withDb(s.initiatorRoleId, db => db.transaction(() => {
      this.persist(db, s.initiatorRoleId, s, turn ? [turn] : []);
      db.prepare("UPDATE role_exchange_sessions SET mirrorPending=1 WHERE sessionId=?").run(s.sessionId);
    }).immediate());
    this.mirror(s);
    return s;
  }

  private mirror(s: ExchangeSession) {
    this.withDb(s.initiatorRoleId, db => {
      const history = turns(db, s.sessionId);
      this.withDb(s.targetRoleId, peer => peer.transaction(() => this.persist(peer, s.targetRoleId, s, history)).immediate());
      db.prepare("UPDATE role_exchange_sessions SET mirrorPending=0 WHERE sessionId=?").run(s.sessionId);
    });
    this.onExchange?.(s);
    // 每次提交都广播：会话开始时、每轮发言入库后，以及 completed/failed/cancelled 收尾。
    this.notifyFeed(s.initiatorRoleId);
    this.notifyFeed(s.targetRoleId);
    if (s.status === "active") this.wakeChanged(nextSpeaker(s));
    if (s.status === "completed") {
      this.memoryChanged(s.initiatorRoleId);
      this.memoryChanged(s.targetRoleId);
    }
  }

  private persist(db: Database.Database, id: string, s: ExchangeSession, incoming: ExchangeTurn[]) {
    const now = this.now().toISOString();
    const previous = db.prepare("SELECT status FROM role_exchange_sessions WHERE sessionId=?").get(s.sessionId) as {status: string} | undefined;
    db.prepare(`INSERT INTO role_exchange_sessions (${columns})
      VALUES (@sessionId,@initiatorRoleId,@targetRoleId,@initiatorName,@targetName,@topic,@status,@maxTurns,@turnCount,@startedAt,@endedAt,@reason)
      ON CONFLICT(sessionId) DO UPDATE SET status=excluded.status, turnCount=excluded.turnCount, endedAt=excluded.endedAt, reason=excluded.reason`).run(s);
    for (const t of incoming) {
      db.prepare(`INSERT INTO role_exchange_turns(sessionId,turnIndex,exchangeId,speakerRoleId,speakerName,content,createdAt)
        VALUES (@sessionId,@turnIndex,@exchangeId,@speakerRoleId,@speakerName,@content,@createdAt) ON CONFLICT(sessionId,turnIndex) DO NOTHING`).run(t);
      upsertEvidence(db, { roleId: id, sourceKind: "role_exchange", sourceId: t.exchangeId, sourceStatus: "completed",
        occurredAt: t.createdAt, localDate: localDateFromIso(t.createdAt, this.timeZone), windowId: null, taskId: null, executionId: null }, now);
    }
    if (s.status === "active" && nextSpeaker(s) === id) {
      const wakeId = `${wakePrefix}${s.sessionId}:${s.turnCount}`;
      if (!db.prepare("SELECT 1 FROM autonomy_wakes WHERE wake_id=?").get(wakeId)) {
        const history = turns(db, s.sessionId);
        new AutonomyStore(db, id, this.timeZone).createWake({ wakeId, kind: "scheduled", scheduledAt: now, now,
          intent: `角色间对话。话题：${s.topic}。参与者：${s.initiatorName}、${s.targetName}。最多 ${s.maxTurns} 轮。使用 role_chat_reply 发言，可设置 endConversation 提前结束。以下是按轮次存证的发言：\n${JSON.stringify(history)}` });
      }
    } else if (s.status !== "active") {
      db.prepare(`UPDATE autonomy_wakes SET status='cancelled', completed_at=?, updated_at=?, last_error_code=?
        WHERE wake_id GLOB ? AND status='pending'`).run(now, now, s.reason, `${wakePrefix}${s.sessionId}:*`);
      if (s.status === "completed" && previous?.status !== "completed")
        new MemoryStore(db).enqueueTrigger({ roleId: id, kind: "idle", now });
    }
  }

  finishUnanswered(roleId: string, wakeId: string | null, reason: string) {
    const bound = exchangeWake(wakeId);
    if (!bound) return false;
    const s = this.current(roleId, bound.sessionId);
    if (s.status === "active" && s.turnCount === bound.after && nextSpeaker(s) === roleId) {
      s.status = reason === "ROLE_STOPPED" || reason === "AUTONOMY_BUDGET_EXHAUSTED" ? "cancelled" : "failed";
      s.reason = reason;
      s.endedAt = this.now().toISOString();
      this.commit(s);
      return true;
    }
    return false;
  }

  stop(roleId: string) {
    const active = this.withDb(roleId, db => db.prepare(`SELECT ${columns} FROM role_exchange_sessions WHERE status='active'`).all() as ExchangeSession[]);
    for (const local of active) {
      const s = this.current(roleId, local.sessionId);
      if (s.status === "active") this.commit({ ...s, status: "cancelled", reason: "ROLE_STOPPED", endedAt: this.now().toISOString() });
      else this.mirror(s);
    }
  }

  recover(roleId: string) {
    const pending = this.withDb(roleId, db => db.prepare(`SELECT ${columns} FROM role_exchange_sessions WHERE mirrorPending=1`).all() as ExchangeSession[]);
    for (const s of pending) this.mirror(s);
  }

  list(limit: number, offset: number, from: string | null = null, to: string | null = null) {
    const items = new Map<string, ExchangeSession>();
    for (const role of this.app.listRoleIndexes().filter(r => r.initStatus === "ready")) {
      const rows = this.withDb(role.roleId, db => db.prepare(`SELECT ${columns} FROM role_exchange_sessions WHERE
        (@from IS NULL OR startedAt >= @from) AND (@to IS NULL OR startedAt <= @to)
        ORDER BY startedAt DESC, sessionId DESC LIMIT @count`).all({ from, to, count: limit + offset }) as ExchangeSession[]);
      for (const s of rows) if (s.initiatorRoleId === role.roleId || !items.has(s.sessionId)) items.set(s.sessionId, s);
    }
    return [...items.values()].sort((a,b) => b.startedAt.localeCompare(a.startedAt) || b.sessionId.localeCompare(a.sessionId)).slice(offset, offset + limit);
  }

  detail(sessionId: string) {
    for (const role of this.app.listRoleIndexes().filter(r => r.initStatus === "ready")) {
      const detail = this.withDb(role.roleId, db => db.prepare("SELECT 1 FROM role_exchange_sessions WHERE sessionId=?").get(sessionId)
        ? { ...summary(db, sessionId), turns: turns(db, sessionId) } : null);
      if (detail) return detail;
    }
    throw new AppError(404, "ROLE_EXCHANGE_NOT_FOUND", "会话不存在");
  }
}
