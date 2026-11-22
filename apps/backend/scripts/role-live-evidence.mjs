import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// 只读提取持久化状态；不导出思维链、鉴权、完整提示、原始请求或内部工具参数。
const [store, output] = process.argv.slice(2);
const db = new DatabaseSync(store, { readOnly: true });
db.exec("PRAGMA busy_timeout=10000");
try {
  const rows = sql => db.prepare(sql).all();
  const calls = rows("SELECT purpose,model_name,protocol,status,error_code,raw_response_json FROM model_calls ORDER BY started_at,rowid").map(row => {
    const { raw_response_json, ...call } = row;
    const frames = JSON.parse(raw_response_json || "{}")?.rawResponse ?? [];
    const versions = new Set();
    const endings = new Set();
    const toolNames = new Set();
    for (const frame of Array.isArray(frames) ? frames : []) {
      const version = frame?.modelVersion ?? frame?.model ?? frame?.message?.model;
      if (typeof version === "string") versions.add(version);
      const ending = frame?.candidates?.[0]?.finishReason ?? frame?.choices?.[0]?.finish_reason ?? frame?.delta?.stop_reason;
      if (typeof ending === "string") endings.add(ending);
      const google = frame?.candidates?.flatMap(c => c.content?.parts ?? []) ?? [];
      const openai = frame?.choices?.flatMap(c => c.delta?.tool_calls ?? []) ?? [];
      for (const tool of [...google.map(p => p.functionCall?.name), ...openai.map(p => p.function?.name), frame?.content_block?.type === "tool_use" ? frame.content_block.name : null]) {
        if (typeof tool === "string" && tool) toolNames.add(tool);
      }
    }
    return { ...call, frameCount: frames.length, reportedVersions: [...versions], finishReasons: [...endings], requestedTools: [...toolNames] };
  });
  const evidence = {
    calls,
    messages: rows("SELECT sender,content,status,window_id FROM messages ORDER BY rowid"),
    verifiedTurns: rows(`SELECT u.content AS input,u.window_id AS windowId,e.status AS executionStatus,
        a.status AS replyStatus,a.content AS reply
      FROM messages u LEFT JOIN executions e ON e.execution_id=COALESCE(u.processed_by_execution_id,u.claimed_by_execution_id,
        (SELECT execution_id FROM executions WHERE trigger_message_id=u.message_id ORDER BY rowid DESC LIMIT 1))
      LEFT JOIN messages a ON a.execution_id=e.execution_id AND a.sender='assistant'
      WHERE u.sender='user' ORDER BY u.rowid,a.rowid`),
    executions: rows("SELECT trigger_type,status FROM executions ORDER BY created_at,rowid"),
    tools: rows("SELECT tool_name,status FROM tool_calls ORDER BY rowid"),
    batches: rows("SELECT status,last_error_code,attempt_count FROM memory_batches ORDER BY created_at,rowid"),
    memories: rows("SELECT title,summary FROM memory_events ORDER BY rowid"),
    recalls: rows("SELECT record_type,COUNT(*) AS hits FROM memory_recalls GROUP BY record_type"),
    timeline: rows(`WITH ordered AS (
      SELECT window_id,ROW_NUMBER() OVER(ORDER BY MIN(rowid)) AS windowNumber FROM messages GROUP BY window_id
    ) SELECT w.windowNumber,m.sender,COUNT(*) AS messages,MIN(date(m.created_at)) AS firstMessageDay,
       MAX(date(m.created_at)) AS lastMessageDay,MIN(e.local_date) AS firstEvidenceDay,MAX(e.local_date) AS lastEvidenceDay
       FROM messages m JOIN ordered w USING(window_id)
       LEFT JOIN evidence_records e ON e.source_kind='message' AND e.source_id=m.message_id
       GROUP BY w.windowNumber,m.sender ORDER BY w.windowNumber,m.sender`),
    memoryDays: rows("SELECT experience_date AS day,COUNT(*) AS events FROM memory_events GROUP BY experience_date"),
    batchDays: rows("SELECT date(started_at) AS day,status,COUNT(*) AS batches FROM memory_batches GROUP BY day,status"),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
} finally { db.close(); }
