import type Database from "better-sqlite3";
import type { ModelMessage } from "../domain/model.js";
import {
  extractMcpWebFragments,
  mergeWebFragments,
  pageWebFragments,
  parseWebJson,
  webReadingCandidates,
  webReadingRequest,
  type WebReadingFragment,
} from "../domain/web-reading.js";
import { registerWebReadingEvidence, sha256 } from "./evidence.js";

export const WEB_READING_SCHEMA_SQL = `
CREATE TABLE web_reading_deliveries (
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  url TEXT NOT NULL,
  page_version TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  original_text TEXT NOT NULL,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(tool_call_id),
  model_call_id TEXT NOT NULL REFERENCES model_calls(model_call_id),
  window_id TEXT REFERENCES windows(window_id),
  task_id TEXT REFERENCES tasks(task_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (model_call_id, tool_call_id, url, page_version, start_offset, end_offset)
) STRICT;

CREATE INDEX idx_web_reading_role_page
  ON web_reading_deliveries (role_id, url, page_version, start_offset);

CREATE INDEX idx_web_reading_role_tool
  ON web_reading_deliveries (role_id, tool_call_id, url, page_version, start_offset);
`;

const deliveryColumns = `url, page_version AS pageVersion, start_offset AS startOffset,
  end_offset AS endOffset, original_text AS text`;
const webEvidencePrefix = "web-reading:";
type EvidenceSpan = [pageKey: string, startOffset: number, endOffset: number];

interface ReadScope {
  roleId: string;
  windowId: string | null;
  taskId: string | null;
  executionId: string;
  modelCallId: string;
  messages: readonly ModelMessage[];
  timeZone?: string;
  now?: string;
}

function rawWebToolFragments(db: Database.Database, roleId: string, toolCallId: string): WebReadingFragment[] {
  const row = db.prepare(`
    SELECT r.raw_response_json FROM tool_results r
      JOIN tool_calls c USING (tool_call_id)
      JOIN tasks t ON t.task_id = c.task_id
      JOIN executions x ON x.execution_id = c.execution_id AND x.role_id = t.role_id
     WHERE r.tool_call_id = ? AND t.role_id = ? AND r.status = 'success'
       AND substr(c.tool_name, 1, 4) = 'mcp_'
  `).get(toolCallId, roleId) as { raw_response_json: string | null } | undefined;
  return row ? extractMcpWebFragments(parseWebJson(row.raw_response_json)) : [];
}

function samePage(a: WebReadingFragment, b: WebReadingFragment): boolean {
  return a.url === b.url && a.pageVersion === b.pageVersion;
}

function pageKey(fragment: WebReadingFragment): string {
  return sha256(JSON.stringify([fragment.url, fragment.pageVersion]));
}

function wrappedProjection(toolCallId: string, fragments: WebReadingFragment[]): string {
  return JSON.stringify({
    status: "success",
    result: { kind: "web_reading", sourceToolCallId: toolCallId, fragments },
  });
}

/** 回查只返回可确认送达的部分，零送达时也不得回退到原始工具事实。 */
export function readWebToolProjection(db: Database.Database, roleId: string, toolCallId: string): string | undefined {
  const fragments = db.prepare(`
    SELECT ${deliveryColumns} FROM web_reading_deliveries WHERE role_id = ? AND tool_call_id = ?
  `).all(roleId, toolCallId) as WebReadingFragment[];
  if (fragments.length === 0 && rawWebToolFragments(db, roleId, toolCallId).length === 0) return undefined;
  return wrappedProjection(toolCallId, mergeWebFragments(fragments));
}

export function readWebEvidenceProjection(db: Database.Database, roleId: string, sourceId: string): string | undefined {
  if (sourceId.startsWith(webEvidencePrefix)) {
    const ids = parseWebJson(sourceId.slice(webEvidencePrefix.length));
    if (!Array.isArray(ids) || ids.length !== 3) return "";
    const [modelCallId, toolCallId, spans] = ids;
    if (typeof modelCallId !== "string" || typeof toolCallId !== "string" || !Array.isArray(spans) ||
      spans.some((span: unknown) => !Array.isArray(span) || span.length !== 3 ||
        typeof span[0] !== "string" || !Number.isSafeInteger(span[1]) || !Number.isSafeInteger(span[2]))) return "";
    const fragments = db.prepare(`
      SELECT ${deliveryColumns} FROM web_reading_deliveries
       WHERE role_id = ? AND model_call_id = ? AND tool_call_id = ?
    `).all(roleId, modelCallId, toolCallId) as WebReadingFragment[];
    const selected = fragments.flatMap((fragment) => {
      const key = pageKey(fragment);
      return (spans as EvidenceSpan[]).flatMap(([page, start, end]) => {
        const startOffset = Math.max(start, fragment.startOffset);
        const endOffset = Math.min(end, fragment.endOffset);
        return page === key && endOffset > startOffset ? [{
          ...fragment, startOffset, endOffset,
          text: fragment.text.slice(startOffset - fragment.startOffset, endOffset - fragment.startOffset),
        }] : [];
      });
    });
    return wrappedProjection(toolCallId, mergeWebFragments(selected));
  }
  // 升级前登记的证据保留其关联；后来送达的正文属于各自独立的送达批次。
  return rawWebToolFragments(db, roleId, sourceId).length === 0 ? undefined : wrappedProjection(sourceId, []);
}

export function readWebHistoryProjection(db: Database.Database, roleId: string, sourceId: string): string | undefined {
  return sourceId.startsWith(webEvidencePrefix)
    ? readWebEvidenceProjection(db, roleId, sourceId)
    : readWebToolProjection(db, roleId, sourceId);
}

export function retireLegacyWebPrefetchEvidence(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT e.evidence_id, r.raw_response_json
      FROM evidence_records e JOIN tool_results r ON r.tool_call_id = e.source_id
      JOIN tool_calls c ON c.tool_call_id = r.tool_call_id
      JOIN evidence_processing p USING (evidence_id)
     WHERE e.source_kind = 'tool_result' AND r.status = 'success' AND p.status <> 'processed'
       AND substr(c.tool_name, 1, 4) = 'mcp_'
  `).all() as Array<{ evidence_id: string; raw_response_json: string | null }>;
  const retire = db.prepare(`
    UPDATE evidence_processing SET status = 'processed', next_retry_at = NULL,
      deferred_after_sequence = NULL, last_error_code = NULL WHERE evidence_id = ?
  `);
  for (const row of rows) {
    if (extractMcpWebFragments(parseWebJson(row.raw_response_json)).length > 0) retire.run(row.evidence_id);
  }
}

/** 在模型请求边界才从工具事实载入候选文，旧历史仍采用只读投影。 */
export function prepareModelWebReadings(
  db: Database.Database,
  roleId: string,
  messages: readonly ModelMessage[],
): ModelMessage[] {
  let activeStart = messages.length;
  while (activeStart > 0 && messages[activeStart - 1]?.role === "tool" &&
    messages[activeStart - 1]?.source?.historical !== true) activeStart -= 1;
  const caller = messages[activeStart - 1];
  const active = caller?.role === "assistant" && Boolean(caller.toolCalls?.length);
  return messages.map((message, index) => {
    if (message.role !== "tool") return message;
    const reference = webReadingRequest(message.content);
    const toolCallId = reference?.sourceToolCallId ?? message.source?.toolCallId;
    if (reference === undefined || toolCallId === undefined) return message;
    if (!(active && index >= activeStart) && message.source?.webPrefetch !== true) {
      const content = readWebToolProjection(db, roleId, toolCallId);
      return content === undefined ? message : { ...message, content };
    }
    const { offset, url, pageVersion, maxChars } = reference.request;
    const source = rawWebToolFragments(db, roleId, toolCallId)
      .filter((fragment) => (url === undefined || fragment.url === url) &&
        (pageVersion === undefined || fragment.pageVersion === pageVersion));
    const result = pageWebFragments(source, offset, maxChars, toolCallId);
    return { ...message, content: JSON.stringify({ status: "success", result }) };
  });
}

function uncoveredParts(fragment: WebReadingFragment, prior: readonly WebReadingFragment[]): WebReadingFragment[] {
  let start = fragment.startOffset;
  const parts: WebReadingFragment[] = [];
  const append = (end: number): void => {
    parts.push({
      ...fragment,
      startOffset: start,
      endOffset: end,
      text: fragment.text.slice(start - fragment.startOffset, end - fragment.startOffset),
    });
  };
  for (const stored of prior) {
    if (stored.startOffset > start) append(stored.startOffset);
    start = Math.max(start, stored.endOffset);
  }
  if (start < fragment.endOffset) append(fragment.endOffset);
  return parts;
}

/** 仅在模型提供方确认接收后调用；不以工具完成或请求开始推定阅读。 */
export function recordAcceptedWebReadings(db: Database.Database, input: ReadScope): void {
  const candidates = new Map<string, WebReadingFragment[]>();
  for (const message of input.messages) {
    if (message.role !== "tool" || message.source?.summary === true) continue;
    const projection = webReadingCandidates(message.content);
    if (projection === undefined || projection.fragments.length === 0) continue;
    const directId = message.source?.toolCallId;
    const toolCallId = directId ?? (message.source?.internalStepKey ? projection.sourceToolCallId : undefined);
    if (toolCallId === undefined || (projection.sourceToolCallId && projection.sourceToolCallId !== toolCallId)) continue;
    candidates.set(toolCallId, [...(candidates.get(toolCallId) ?? []), ...projection.fragments]);
  }
  if (candidates.size === 0) return;
  const at = input.now ?? new Date().toISOString();
  db.transaction(() => {
    const scope = db.prepare(`
      SELECT e.window_id FROM model_calls m JOIN executions e USING (execution_id)
       WHERE m.model_call_id = ? AND m.role_id = ? AND e.role_id = m.role_id AND e.execution_id = ?
    `).get(input.modelCallId, input.roleId, input.executionId) as { window_id: string | null } | undefined;
    if (!scope || scope.window_id !== input.windowId) return;
    const prior = db.prepare(`
      SELECT ${deliveryColumns} FROM web_reading_deliveries
       WHERE role_id = @roleId AND (@toolCallId IS NULL OR tool_call_id = @toolCallId)
         AND url = @url AND page_version = @pageVersion
         AND start_offset < @endOffset AND end_offset > @startOffset
       ORDER BY start_offset, end_offset
    `);
    const insert = db.prepare(`
      INSERT INTO web_reading_deliveries (role_id, url, page_version, start_offset, end_offset,
        original_text, tool_call_id, model_call_id, window_id, task_id, execution_id, accepted_at)
      VALUES (@roleId, @url, @pageVersion, @startOffset, @endOffset,
        @text, @toolCallId, @modelCallId, @windowId, @taskId, @executionId, @at)
    `);
    for (const [toolCallId, fragments] of candidates) {
      const source = rawWebToolFragments(db, input.roleId, toolCallId);
      // 比对原始事实后，再登记已送达的正文位置。重试或交叠续读只加入新范围。
      const valid = fragments.filter((fragment) => source.some((original) =>
        samePage(original, fragment) &&
        original.startOffset <= fragment.startOffset && original.endOffset >= fragment.endOffset &&
        original.text.slice(fragment.startOffset - original.startOffset, fragment.endOffset - original.startOffset) === fragment.text));
      const newEvidence: WebReadingFragment[] = [];
      for (const fragment of mergeWebFragments(valid)) {
        const stored = prior.all({ ...fragment, roleId: input.roleId, toolCallId }) as WebReadingFragment[];
        for (const part of uncoveredParts(fragment, stored)) {
          const alreadyRead = prior.all({ ...part, roleId: input.roleId, toolCallId: null }) as WebReadingFragment[];
          newEvidence.push(...uncoveredParts(part, alreadyRead));
          insert.run({ ...input, ...part, toolCallId, at });
        }
      }
      if (newEvidence.length > 0) {
        const spans = mergeWebFragments(newEvidence).map((fragment): EvidenceSpan =>
          [pageKey(fragment), fragment.startOffset, fragment.endOffset]);
        registerWebReadingEvidence(db, {
          roleId: input.roleId,
          sourceId: `${webEvidencePrefix}${JSON.stringify([input.modelCallId, toolCallId, spans])}`,
          windowId: input.windowId,
          taskId: input.taskId,
          executionId: input.executionId,
          now: at,
          ...(input.timeZone !== undefined && { timeZone: input.timeZone }),
        });
      }
    }
  })();
}

/** 列出角色看过的页面版本与合并区间。查询位置时不返回预取正文。 */
export function listWebReadingPositions(db: Database.Database, input: {
  roleId: string;
  url?: string;
  pageVersion?: string;
  toolCallId?: string;
  offset: number;
  limit: number;
}) {
  const params = {
    ...input, url: input.url ?? null, pageVersion: input.pageVersion ?? null, toolCallId: input.toolCallId ?? null,
  };
  const versions = db.prepare(`
    SELECT url, page_version AS pageVersion, max(accepted_at) AS lastAcceptedAt
      FROM web_reading_deliveries
     WHERE role_id = @roleId AND (@url IS NULL OR url = @url)
       AND (@pageVersion IS NULL OR page_version = @pageVersion)
       AND (@toolCallId IS NULL OR tool_call_id = @toolCallId)
     GROUP BY url, page_version ORDER BY lastAcceptedAt DESC, url, page_version
     LIMIT @limit + 1 OFFSET @offset
  `).all(params) as Array<{ url: string; pageVersion: string; lastAcceptedAt: string }>;
  const pages = versions.slice(0, input.limit).map((version) => {
    const source = db.prepare(`
      SELECT ${deliveryColumns}, tool_call_id AS toolCallId
        FROM web_reading_deliveries
       WHERE role_id = @roleId AND url = @url AND page_version = @pageVersion
         AND (@toolCallId IS NULL OR tool_call_id = @toolCallId)
       ORDER BY accepted_at DESC, tool_call_id
    `).all({ ...params, ...version }) as Array<WebReadingFragment & { toolCallId: string }>;
    const ranges = mergeWebFragments(source).map(({ startOffset, endOffset }) => ({ startOffset, endOffset }));
    const resumeOffset = ranges.at(-1)?.endOffset ?? 0;
    return { ...version, ranges, resumeOffset, toolCallId: source.find((item) => item.endOffset === resumeOffset)?.toolCallId };
  });
  return { pages, nextOffset: versions.length > input.limit ? input.offset + input.limit : null };
}

export function webSourceLocations(db: Database.Database, roleId: string, toolCallId: string) {
  return rawWebToolFragments(db, roleId, toolCallId).map(({ url, pageVersion, startOffset, endOffset }) =>
    ({ url, pageVersion, startOffset, endOffset }));
}
