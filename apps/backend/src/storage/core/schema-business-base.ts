import {
  BUSINESS_V3_SQL,
  BUSINESS_V4_SQL,
  BUSINESS_V5_SQL,
  BUSINESS_V6_SQL,
  BUSINESS_V7_SQL,
  BUSINESS_V8_SQL,
  BUSINESS_V9_SQL,
  BUSINESS_V10_SQL,
  BUSINESS_V11_SQL,
  BUSINESS_V12_SQL,
  BUSINESS_V13_SQL,
  BUSINESS_V14_SQL,
  BUSINESS_V15_SQL,
  BUSINESS_V16_SQL,
  BUSINESS_V17_SQL,
  BUSINESS_V18_SQL,
  BUSINESS_V19_SQL,
  BUSINESS_V20_SQL,
  BUSINESS_V21_SQL,
  BUSINESS_V22_SQL,
} from "./schema-business-migrations.js";

export const BUSINESS_SCHEMA_VERSION = 33;

export const BUSINESS_TABLES = [
  "engineering_jobs", "engineering_wakes",
  "window_context_states",
  "roles",
  "windows",
  "messages",
  "tasks",
  "executions",
  "execution_tasks",
  "tool_calls",
  "tool_call_mode_events",
  "tool_results",
  "role_bindings",
  "task_resource_continuations",
  "memory_batches",
  "memory_triggers",
  "evidence_records",
  "evidence_processing",
  "memory_evidence_segments",
  "daily_summaries",
  "daily_summary_sources",
  "memory_events",
  "memory_event_tags",
  "memory_event_sources",
  "diaries",
  "diary_events",
  "memory_revisions",
  "retrieval_queries",
  "retrieval_results",
  "memory_recalls",
  "execution_stream_events",
  "model_calls",
  "call_metering",
  "memory_search_documents",
  "memory_search_fts",
  "memory_search_embeddings",
  "autonomy_budget",
  "autonomy_wakes",
  "autonomy_activities",
  "autonomy_tool_reservations",
  "task_notes",
  "outfits",
  "outfit_assets",
  "message_segments",
  "voice_assets",
  "role_voice_settings",
  "scene_image_tasks",
  "scene_image_assets",
  "role_scene_image_settings",
  "role_scene_references",
  "web_reading_deliveries",
  "role_worldbooks",
  "worldbook_usage",
  "role_exchange_sessions",
  "role_exchange_turns",
  "observed_dialogue_batches",
  "observed_dialogue_members",
] as const;

export const BUSINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roles (
  role_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  definition_text TEXT NOT NULL,
  definition_payload_json TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS windows (
  window_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  kind TEXT NOT NULL CHECK (kind IN ('main', 'custom')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
  content TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  submission_id TEXT,
  submission_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (window_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_window_submission
  ON messages (window_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  end_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('user_message', 'autonomous', 'tool_result', 'recovery')),
  trigger_message_id TEXT REFERENCES messages(message_id),
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'superseded', 'failed')),
  state_version_loaded INTEGER,
  state_version_committed INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_tasks (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  relation TEXT NOT NULL CHECK (relation IN ('initiates', 'continues', 'references')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, task_id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  step_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'unknown')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (execution_id, step_key)
);

CREATE TABLE IF NOT EXISTS tool_call_mode_events (
  event_id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(tool_call_id),
  mode TEXT NOT NULL CHECK (mode IN ('foreground', 'background')),
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_results (
  tool_call_id TEXT PRIMARY KEY REFERENCES tool_calls(tool_call_id),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'unknown')),
  raw_response_json TEXT,
  adapted_result_json TEXT,
  diagnostic_code TEXT,
  error_json TEXT,
  saved_at TEXT NOT NULL,
  previous_status TEXT CHECK (previous_status IN ('unknown')),
  previous_diagnostic_code TEXT,
  previous_raw_response_json TEXT,
  previous_adapted_result_json TEXT,
  previous_error_json TEXT,
  reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS role_bindings (
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  capability TEXT NOT NULL CHECK (capability IN ('chat_model', 'memory_model', 'mcp', 'skill')),
  resource_id TEXT NOT NULL,
  model_name TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role_id, capability, resource_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_single_chat_model
  ON role_bindings (role_id)
  WHERE capability = 'chat_model';

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_single_memory_model
  ON role_bindings (role_id)
  WHERE capability = 'memory_model';

CREATE TABLE IF NOT EXISTS task_resource_continuations (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  resource_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (task_id, resource_id)
);
`;

export const BUSINESS_SCHEMA_V1_SQL = BUSINESS_SCHEMA_SQL;

export const MEMORY_REVISIONS_SQL = `CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('event', 'daily_summary')),
  target_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  change_source TEXT NOT NULL CHECK (change_source IN ('memory_batch', 'agent_correction', 'user_correction')),
  content_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (target_type, target_id, revision_number)
);`;

export const BUSINESS_V2_SQL = `
ALTER TABLE messages ADD COLUMN execution_id TEXT REFERENCES executions(execution_id);
ALTER TABLE messages ADD COLUMN claimed_by_execution_id TEXT REFERENCES executions(execution_id);
ALTER TABLE messages ADD COLUMN processed_by_execution_id TEXT REFERENCES executions(execution_id);

ALTER TABLE executions ADD COLUMN decision_round INTEGER;
ALTER TABLE executions ADD COLUMN superseded_by_execution_id TEXT REFERENCES executions(execution_id);

ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
  CHECK (origin IN ('user', 'autonomous', 'memory'));
ALTER TABLE tasks ADD COLUMN initiator_execution_id TEXT REFERENCES executions(execution_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_role_round
  ON executions (role_id, decision_round)
  WHERE decision_round IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_pending_decision
  ON messages (window_id, sequence)
  WHERE sender = 'user'
    AND processed_by_execution_id IS NULL
    AND claimed_by_execution_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_execution
  ON messages (execution_id)
  WHERE execution_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_batches (
  batch_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  input_from_sequence INTEGER NOT NULL,
  input_to_sequence INTEGER NOT NULL,
  context_budget_chars INTEGER NOT NULL,
  output_reserve_chars INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_batch_single_running
  ON memory_batches (role_id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS memory_triggers (
  trigger_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  kind TEXT NOT NULL CHECK (kind IN ('message_threshold', 'idle', 'task_end', 'manual', 'retry')),
  window_id TEXT REFERENCES windows(window_id),
  task_id TEXT REFERENCES tasks(task_id),
  consumed_at TEXT,
  batch_id TEXT REFERENCES memory_batches(batch_id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_triggers_pending
  ON memory_triggers (role_id, created_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS evidence_records (
  evidence_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'tool_result')),
  source_id TEXT NOT NULL,
  window_id TEXT REFERENCES windows(window_id),
  task_id TEXT REFERENCES tasks(task_id),
  execution_id TEXT REFERENCES executions(execution_id),
  source_status TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  role_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_role_sequence
  ON evidence_records (role_id, role_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_source
  ON evidence_records (role_id, source_kind, source_id);

CREATE INDEX IF NOT EXISTS idx_evidence_window_occurred
  ON evidence_records (window_id, occurred_at);

CREATE TABLE IF NOT EXISTS evidence_processing (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_records(evidence_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'deferred', 'failed')),
  last_batch_id TEXT REFERENCES memory_batches(batch_id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  deferred_after_sequence INTEGER,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_processing_ready
  ON evidence_processing (status, next_retry_at);

CREATE TABLE IF NOT EXISTS memory_evidence_segments (
  evidence_id TEXT NOT NULL REFERENCES evidence_records(evidence_id),
  segment_index INTEGER NOT NULL,
  from_char INTEGER NOT NULL,
  to_char INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
  batch_id TEXT REFERENCES memory_batches(batch_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (evidence_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_memory_segments_batch
  ON memory_evidence_segments (batch_id, status);

CREATE TABLE IF NOT EXISTS daily_summaries (
  summary_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  experience_date TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_summaries_role_date
  ON daily_summaries (role_id, experience_date);

CREATE TABLE IF NOT EXISTS daily_summary_sources (
  summary_source_id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL REFERENCES daily_summaries(summary_id),
  window_id TEXT REFERENCES windows(window_id),
  from_sequence INTEGER,
  to_sequence INTEGER,
  occurred_from TEXT NOT NULL,
  occurred_to TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_summary_sources_summary
  ON daily_summary_sources (summary_id);

CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  subjective_experience TEXT NOT NULL DEFAULT '',
  occurred_at_start TEXT NOT NULL,
  occurred_at_end TEXT,
  experience_date TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active', 'refined')),
  refined_summary_id TEXT REFERENCES daily_summaries(summary_id),
  version INTEGER NOT NULL,
  last_supplemented_round INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_role_date
  ON memory_events (role_id, experience_date);

CREATE INDEX IF NOT EXISTS idx_memory_events_refine_candidates
  ON memory_events (role_id, lifecycle_status, last_supplemented_round);

CREATE TABLE IF NOT EXISTS memory_event_tags (
  event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  dimension TEXT NOT NULL CHECK (dimension IN ('person', 'topic', 'place', 'emotion', 'source')),
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  PRIMARY KEY (event_id, dimension, normalized_value)
);

CREATE INDEX IF NOT EXISTS idx_memory_event_tags_lookup
  ON memory_event_tags (dimension, normalized_value);

CREATE TABLE IF NOT EXISTS memory_event_sources (
  event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  evidence_id TEXT NOT NULL REFERENCES evidence_records(evidence_id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (event_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_event_sources_evidence
  ON memory_event_sources (evidence_id);

CREATE TABLE IF NOT EXISTS diaries (
  diary_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  relative_path TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  experience_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diaries_role_date
  ON diaries (role_id, experience_date);

CREATE TABLE IF NOT EXISTS diary_events (
  diary_id TEXT NOT NULL REFERENCES diaries(diary_id),
  event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (diary_id, event_id)
);

${MEMORY_REVISIONS_SQL}

CREATE TABLE IF NOT EXISTS retrieval_queries (
  retrieval_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT REFERENCES executions(execution_id),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'agent', 'manual')),
  query_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_queries_role_time
  ON retrieval_queries (role_id, created_at);

CREATE TABLE IF NOT EXISTS retrieval_results (
  retrieval_id TEXT NOT NULL REFERENCES retrieval_queries(retrieval_id),
  rank INTEGER NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('event', 'daily_summary', 'diary')),
  record_id TEXT NOT NULL,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1)),
  PRIMARY KEY (retrieval_id, record_type, record_id)
);

CREATE TABLE IF NOT EXISTS memory_recalls (
  recall_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  record_type TEXT NOT NULL CHECK (record_type IN ('event', 'daily_summary', 'diary')),
  record_id TEXT NOT NULL,
  recalled_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_recalls_execution_record
  ON memory_recalls (execution_id, record_type, record_id);

CREATE INDEX IF NOT EXISTS idx_memory_recalls_record
  ON memory_recalls (record_type, record_id);

CREATE TABLE IF NOT EXISTS execution_stream_events (
  stream_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution_started', 'message_delta', 'tool_started', 'tool_result_saved',
    'message_completed', 'message_interrupted', 'execution_superseded',
    'execution_paused', 'execution_failed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_stream_window
  ON execution_stream_events (window_id, stream_event_id);

CREATE INDEX IF NOT EXISTS idx_execution_stream_execution
  ON execution_stream_events (execution_id, stream_event_id);

CREATE TABLE IF NOT EXISTS model_calls (
  model_call_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT REFERENCES executions(execution_id),
  batch_id TEXT REFERENCES memory_batches(batch_id),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'user_chat', 'user_task', 'memory_maintenance', 'autonomous', 'connection_test'
  )),
  resource_id TEXT,
  model_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN (
    'openai-chat', 'openai-responses', 'anthropic-messages'
  )),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  usage_json TEXT,
  raw_response_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_calls_role_time
  ON model_calls (role_id, started_at);

CREATE TABLE IF NOT EXISTS call_metering (
  metering_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT REFERENCES executions(execution_id),
  task_id TEXT REFERENCES tasks(task_id),
  batch_id TEXT REFERENCES memory_batches(batch_id),
  call_kind TEXT NOT NULL CHECK (call_kind IN ('model', 'tool')),
  call_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'user_chat', 'user_task', 'memory_maintenance', 'autonomous', 'connection_test'
  )),
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (call_kind, call_id)
);

CREATE TABLE IF NOT EXISTS memory_search_documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  record_type TEXT NOT NULL CHECK (record_type IN ('event', 'daily_summary', 'diary')),
  record_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  related_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (role_id, record_type, record_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
  title,
  body,
  content='memory_search_documents',
  content_rowid='document_id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_search_documents_ai AFTER INSERT ON memory_search_documents BEGIN
  INSERT INTO memory_search_fts(rowid, title, body)
  VALUES (new.document_id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_search_documents_ad AFTER DELETE ON memory_search_documents BEGIN
  INSERT INTO memory_search_fts(memory_search_fts, rowid, title, body)
  VALUES ('delete', old.document_id, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_search_documents_au AFTER UPDATE ON memory_search_documents BEGIN
  INSERT INTO memory_search_fts(memory_search_fts, rowid, title, body)
  VALUES ('delete', old.document_id, old.title, old.body);
  INSERT INTO memory_search_fts(rowid, title, body)
  VALUES (new.document_id, new.title, new.body);
END;
`;

export const BUSINESS_SCHEMA_V22_SQL = BUSINESS_SCHEMA_SQL +
      BUSINESS_V2_SQL +
      BUSINESS_V3_SQL +
      BUSINESS_V4_SQL +
      BUSINESS_V5_SQL +
      BUSINESS_V6_SQL +
      BUSINESS_V7_SQL +
      BUSINESS_V8_SQL +
      BUSINESS_V9_SQL +
      BUSINESS_V10_SQL +
      BUSINESS_V11_SQL +
      BUSINESS_V12_SQL +
      BUSINESS_V13_SQL +
      BUSINESS_V14_SQL +
      BUSINESS_V15_SQL +
      BUSINESS_V16_SQL +
      BUSINESS_V17_SQL +
      BUSINESS_V18_SQL +
      BUSINESS_V19_SQL +
      BUSINESS_V20_SQL +
      BUSINESS_V21_SQL +
      BUSINESS_V22_SQL;
