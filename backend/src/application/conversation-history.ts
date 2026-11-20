import type Database from "better-sqlite3";
import { z } from "zod";
import type { ConversationTool } from "../domain/conversation.js";
import type { ModelMessage } from "../domain/model.js";
import { contextTerms } from "./agent-context.js";
import type { RoleAccess } from "./role-access.js";

const lookupSchema = z.object({
  kind: z.enum(["message", "tool", "internal", "evidence"]).optional(),
  id: z.string().min(1).max(512).optional(),
  query: z.string().trim().max(500).optional(),
  scope: z.enum(["window", "task"]).default("window"),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

interface HistoryScope {
  roleId: string;
  windowId: string;
  taskId: string | null;
  scope: "window" | "task";
}

export type WebToolProjection = (db: Database.Database, roleId: string, toolCallId: string) => string | undefined;

interface HistoryRow {
  kind: "message" | "tool" | "internal" | "evidence";
  id: string;
  evidenceId: string | null;
  label: string;
  status: string;
  content: string;
  occurredAt: string;
  background: 0 | 1;
}

// 可直接追溯业务主键；窗口与任务范围均以执行／消息归属关联表验证。
const historyRowsSql = `
  WITH matches AS (
    SELECT 'message' AS kind, m.message_id AS id, ev.evidence_id AS evidenceId,
           m.sender AS label, m.status, m.content, m.created_at AS occurredAt, 0 AS background
      FROM messages m JOIN windows w ON w.window_id = m.window_id
      LEFT JOIN evidence_records ev ON ev.role_id = w.role_id AND ev.source_kind = 'message'
        AND ev.source_id = m.message_id
     WHERE w.role_id = @roleId AND m.status <> 'generating'
       AND ((@scope = 'window' AND m.window_id = @windowId)
         OR (@scope = 'task' AND ev.task_id = @taskId)
         OR (@scope = 'task' AND EXISTS (
           SELECT 1 FROM executions x JOIN execution_tasks xt USING (execution_id)
            WHERE x.role_id = @roleId AND xt.task_id = @taskId AND x.trigger_message_id = m.message_id
         )))
    UNION ALL
    SELECT 'tool', t.tool_call_id, ev.evidence_id, t.tool_name, r.status,
           json_object('status',r.status, 'diagnosticCode',r.diagnostic_code,
             'result',json(r.adapted_result_json)), r.saved_at,
           EXISTS(SELECT 1 FROM tool_call_mode_events mode
             WHERE mode.tool_call_id = t.tool_call_id AND mode.mode = 'background')
      FROM tool_calls t JOIN executions x USING (execution_id) JOIN tool_results r USING (tool_call_id)
      LEFT JOIN evidence_records ev ON ev.role_id = x.role_id AND ev.source_kind = 'tool_result'
        AND ev.source_id = t.tool_call_id
     WHERE x.role_id = @roleId
       AND ((@scope = 'window' AND x.window_id = @windowId)
         OR (@scope = 'task' AND t.task_id = @taskId))
    UNION ALL
    SELECT 'evidence', ev.source_id, ev.evidence_id, '网页已读原文',
           ev.source_status, '', ev.occurred_at, 0
      FROM evidence_records ev
     WHERE ev.role_id = @roleId AND ev.source_kind = 'tool_result'
       AND ev.source_id LIKE 'web-reading:%'
       AND ((@scope = 'window' AND ev.window_id = @windowId)
         OR (@scope = 'task' AND ev.task_id = @taskId))
    UNION ALL
    SELECT 'internal', json_extract(s.payload_json, '$.internalStepKey'), NULL,
           json_extract(s.payload_json, '$.toolName'),
           json_extract(s.payload_json, '$.outcome.status'),
           json_extract(s.payload_json, '$.outcome'), s.created_at, 0
      FROM execution_stream_events s
     WHERE s.role_id = @roleId AND s.event_type = 'tool_result_saved'
       AND json_type(s.payload_json, '$.internalStepKey') = 'text'
       AND json_type(s.payload_json, '$.outcome') = 'object'
       AND ((@scope = 'window' AND s.window_id = @windowId)
         OR (@scope = 'task' AND json_extract(s.payload_json, '$.taskId') = @taskId))
       AND s.stream_event_id = (
         SELECT max(newer.stream_event_id) FROM execution_stream_events newer
          WHERE newer.execution_id = s.execution_id AND newer.event_type = 'tool_result_saved'
            AND json_extract(newer.payload_json, '$.internalStepKey') =
                json_extract(s.payload_json, '$.internalStepKey')
       )
  )
`;

export function historyLookupTool(roleId: string, access: RoleAccess, webProjection?: WebToolProjection): ConversationTool {
  return {
    name: "history_lookup",
    source: "memory",
    description: "分页查找本窗口或当前任务的旧消息、已保存工具回执及内部操作。无需知道编号即可按文字搜索；按编号分页读原文。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { enum: ["message", "tool", "internal", "evidence"] },
        id: { type: "string", description: "原消息、工具回执、内部操作或证据编号。省略则列举或搜索。" },
        query: { type: "string", description: "搜索词。省略则按时间逆序列举。" },
        scope: { enum: ["window", "task"], description: "默认本窗口；可改查当前任务。" },
        offset: { type: "integer", minimum: 0, description: "使用上次返回的 nextOffset。" },
      },
      additionalProperties: false,
    },
    async execute(args, context) {
      const parsed = lookupSchema.safeParse(args);
      if (!parsed.success) {
        return { status: "failed", diagnosticCode: "HISTORY_LOOKUP_INVALID" };
      }
      const { scope, kind, id, query, offset } = parsed.data;
      if (scope === "task" && context.taskId === null) {
        return { status: "failed", diagnosticCode: "HISTORY_TASK_REQUIRED" };
      }
      const result = access.withStore(roleId, ({ business }) => {
        const params = { roleId, windowId: context.windowId, taskId: context.taskId, scope };
        if (id !== undefined) {
          const row = business.db.prepare(`${historyRowsSql}
            SELECT * FROM matches WHERE (id = @id OR evidenceId = @id)
              AND (@kind IS NULL OR @kind = 'evidence' AND evidenceId = @id OR kind = @kind)
            LIMIT 1`).get({ ...params, id, kind: kind ?? null }) as HistoryRow | undefined;
          if (row === undefined) return { entry: null, nextOffset: null };
          const { content, background: _background, ...entry } = projectRow(business.db, roleId, row, webProjection);
          let end = Math.min(offset + 2_000, content.length);
          const finalUnit = content.charCodeAt(end - 1);
          if (end < content.length && finalUnit >= 0xd800 && finalUnit <= 0xdbff) end -= 1;
          return {
            entry: { ...entry, content: content.slice(offset, end), offset },
            nextOffset: end < content.length ? end : null,
          };
        }
        const pageSize = 10;
        const rows = business.db.prepare(`${historyRowsSql}
          SELECT * FROM matches
           WHERE (@kind IS NULL OR kind = @kind OR @kind = 'evidence' AND evidenceId IS NOT NULL)
             AND (kind <> 'internal' OR label <> 'history_lookup')
           ORDER BY occurredAt DESC, id DESC`).iterate({ ...params, kind: kind ?? null });
        const entries = [];
        const search = query?.toLowerCase() ?? "";
        let matched = 0;
        for (const candidate of rows) {
          const { content, background: _background, ...row } = projectRow(business.db, roleId, candidate as HistoryRow, webProjection);
          if (search && !row.label.toLowerCase().includes(search) && !content.toLowerCase().includes(search)) continue;
          if (matched++ < offset) continue;
          entries.push({ ...row, snippet: content.slice(0, 120) });
          if (entries.length > pageSize) break;
        }
        return {
          entries: entries.slice(0, pageSize),
          nextOffset: entries.length > pageSize ? offset + pageSize : null,
        };
      });
      return { status: "success", adaptedResult: result };
    },
  };
}

/** 取回显式引用与匹配的原文，即使原文已早于运行时的近期窗口。 */
export function findAgentEvidence(
  db: Database.Database,
  scope: HistoryScope,
  query: string,
  existing: readonly ModelMessage[],
  seedTaskHistory: boolean,
  webProjection?: WebToolProjection,
): ModelMessage[] {
  const terms = contextTerms(query);
  const identifiers = new Set(query.match(/[a-z0-9][a-z0-9:_-]{7,511}/gi) ?? []);
  if (!terms.length && identifiers.size === 0 && !seedTaskHistory) return [];
  const ids = new Set(existing.flatMap(({ source }) =>
    [source?.messageId, source?.toolCallId, source?.internalStepKey, source?.evidenceId],
  ));
  const scopes: HistoryScope[] = scope.taskId === null ? [scope] : [scope, { ...scope, scope: "task" }];
  const selected = new Map<string, { row: HistoryRow; scope: HistoryScope["scope"] }>();
  for (const searchScope of scopes) {
    const isContinuation = seedTaskHistory && searchScope.scope === "task";
    const ranked: Array<{ row: HistoryRow; relevance: number }> = [];
    const rows = db.prepare(`${historyRowsSql}
      SELECT * FROM matches ORDER BY occurredAt DESC, id DESC`).iterate(searchScope);
    let taskFacts = 0;
    for (const candidate of rows) {
      const raw = candidate as HistoryRow;
      if (ids.has(raw.id)) continue;
      const isSeed = isContinuation && (
        raw.kind === "tool" || (raw.kind === "internal" && raw.label !== "history_lookup")
      ) && taskFacts++ < 40;
      // 后台完成的调用在原任务第一次带回模型时可送达候选片段；一般回查以已读范围为准。
      const mayDeliver = isContinuation && raw.background === 1 && raw.status === "success";
      const row = mayDeliver ? raw : projectRow(db, scope.roleId, raw, webProjection);
      const exact = identifiers.has(row.id) || (row.evidenceId !== null && identifiers.has(row.evidenceId));
      if (!exact && (row.kind === "evidence" || (row.kind === "internal" && row.label === "history_lookup"))) continue;
      const haystack = `${row.label}\n${row.content}`.toLowerCase();
      const relevance = exact ? 1000 : terms.filter((term) => haystack.includes(term)).length;
      if (isSeed || exact) selected.set(row.id, { row, scope: searchScope.scope });
      if (relevance > 0 && !exact && !isSeed) {
        ranked.push({ row, relevance });
        ranked.sort((a, b) => b.relevance - a.relevance);
        if (ranked.length > 16) ranked.pop();
      }
    }
    for (const { row } of ranked) {
      selected.set(row.id, { row, scope: searchScope.scope });
    }
  }
  return [...selected.values()]
    .sort((a, b) => a.row.occurredAt.localeCompare(b.row.occurredAt))
    .map(({ row, scope }) => historyMessage(row, scope, seedTaskHistory && scope === "task"));
}

function projectRow(db: Database.Database, roleId: string, row: HistoryRow, webProjection?: WebToolProjection): HistoryRow {
  if (row.kind !== "tool" && row.kind !== "evidence") return row;
  const content = webProjection?.(db, roleId, row.id);
  return content === undefined ? row : { ...row, content };
}

function historyMessage(row: HistoryRow, scope: HistoryScope["scope"], continuing: boolean): ModelMessage {
  const source = { scope, ...(row.evidenceId === null ? {} : { evidenceId: row.evidenceId }) };
  if (row.kind === "message") {
    return {
      role: row.label === "user" ? "user" : "assistant",
      content: row.status === "interrupted" ? `${row.content}\n[以上回复中断，未完成]` : row.content,
      source: { ...source, messageId: row.id },
    };
  }
  return {
    role: "tool",
    toolCallId: row.id,
    toolName: row.label,
    content: row.content,
    source: {
      ...source,
      historical: true,
      ...(continuing && row.background === 1 && row.status === "success" ? { webPrefetch: true } : {}),
      ...(row.kind === "tool" ? { toolCallId: row.id } : row.kind === "internal" ? { internalStepKey: row.id } : {}),
    },
  };
}
