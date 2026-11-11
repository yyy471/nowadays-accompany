import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  AppError,
  FtsUnavailableError,
  SchemaMigrationError,
} from "../domain/errors.js";
import { backfillEvidence } from "./evidence.js";

export const APP_SCHEMA_VERSION = 4;
export const BUSINESS_SCHEMA_VERSION = 16;
export const EXECUTION_SCHEMA_VERSION = 1;

export const APP_TABLES = [
  "roles",
  "resources",
  "model_test_calls",
  "resource_secrets",
  "image_services",
] as const;
export const BUSINESS_TABLES = [
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
] as const;

const APP_V2_SQL = `
CREATE TABLE IF NOT EXISTS model_test_calls (
  test_call_id TEXT PRIMARY KEY,
  resource_id TEXT,
  model_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN (
    'openai-chat', 'openai-responses', 'anthropic-messages'
  )),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  usage_json TEXT
);
`;

/**
 * v3：模型服务密钥只写存储，以及连接测试的配置指纹。
 * 密钥密文独立于资源配置，读接口只暴露状态，不回明文。
 */
const APP_V3_SQL = `
CREATE TABLE IF NOT EXISTS resource_secrets (
  resource_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE model_test_calls ADD COLUMN config_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_model_test_calls_resource
  ON model_test_calls (resource_id, finished_at);
`;

const APP_V4_SQL = `
-- v4：ComfyUI 生图服务连接。ComfyUI 本身不规定模型，模型差异落在
-- 角色生图配置的工作流模板上（DL-150）。密钥仍走 resource_secrets，
-- 读接口只暴露状态，不回明文。
CREATE TABLE IF NOT EXISTS image_services (
  service_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_services_enabled
  ON image_services (enabled, created_at);
`;

const APP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roles (
  role_id TEXT PRIMARY KEY,
  relative_dir TEXT NOT NULL UNIQUE,
  init_status TEXT NOT NULL CHECK (init_status IN ('initializing', 'ready', 'failed')),
  init_error TEXT,
  init_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  resource_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'mcp', 'skill')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const BUSINESS_SCHEMA_SQL = `
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

const BUSINESS_V2_SQL = `
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

CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('event', 'daily_summary')),
  target_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  change_source TEXT NOT NULL CHECK (change_source IN ('memory_batch', 'agent_correction')),
  content_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (target_type, target_id, revision_number)
);

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

export interface OpenedDatabase {
  db: Database.Database;
  path: string;
  schemaVersion: number;
}

export interface DatabaseOpenOptions {
  create?: boolean;
  timeZone?: string;
}

interface RequiredIndex {
  name: string;
  table: string;
  columns: readonly string[];
  unique: boolean;
  partial: boolean;
  predicate?: string;
}

interface RequiredColumns {
  table: string;
  columns: readonly string[];
}

const BUSINESS_COLUMNS: readonly RequiredColumns[] = [
  {
    table: "messages",
    columns: [
      "execution_id",
      "claimed_by_execution_id",
      "processed_by_execution_id",
    ],
  },
  {
    table: "executions",
    columns: ["decision_round", "superseded_by_execution_id", "task_decision_json"],
  },
  {
    table: "tasks",
    columns: ["origin", "initiator_execution_id"],
  },
  {
    table: "evidence_records",
    columns: [
      "evidence_id",
      "role_id",
      "source_kind",
      "source_id",
      "source_status",
      "occurred_at",
      "local_date",
      "role_sequence",
    ],
  },
  {
    table: "role_voice_settings",
    columns: [
      "protocol",
      "voice_source",
      "reference_mode",
      "reference_text",
      "preset_voice_id",
      "capabilities_json",
      "reference_mode_confirmed",
      "enabled",
    ],
  },
  {
    table: "role_scene_image_settings",
    columns: [
      "service_id",
      "model_type",
      "model_path",
      "base_prompt",
      "negative_prompt",
      "outfit_prompts_json",
      "width",
      "height",
      "steps",
      "cfg",
      "sampler",
      "scheduler",
      "seed",
      "workflow_json",
      "output_node_id",
    ],
  },
  {
    table: "memory_batches",
    columns: [
      "batch_id",
      "role_id",
      "status",
      "input_from_sequence",
      "input_to_sequence",
      "context_budget_chars",
      "output_reserve_chars",
    ],
  },
  {
    table: "memory_events",
    columns: [
      "event_id",
      "role_id",
      "title",
      "summary",
      "subjective_experience",
      "experience_date",
      "lifecycle_status",
      "version",
      "last_supplemented_round",
    ],
  },
  {
    table: "diaries",
    columns: ["diary_id", "role_id", "relative_path", "content", "content_hash"],
  },
  {
    table: "memory_recalls",
    columns: ["execution_id", "record_type", "record_id"],
  },
  {
    table: "tool_results",
    columns: [
      "tool_call_id",
      "status",
      "raw_response_json",
      "adapted_result_json",
      "diagnostic_code",
      "error_json",
      "saved_at",
      "previous_status",
      "previous_diagnostic_code",
      "previous_raw_response_json",
      "previous_adapted_result_json",
      "previous_error_json",
      "reconciled_at",
    ],
  },
  {
    table: "autonomy_tool_reservations",
    columns: [
      "tool_call_id",
      "role_id",
      "local_date",
      "counted",
      "status",
    ],
  },
  {
    table: "outfits",
    columns: ["outfit_id", "role_id", "name", "description"],
  },
  {
    table: "outfit_assets",
    columns: [
      "asset_id",
      "outfit_id",
      "role_id",
      "usage",
      "file_name",
      "display_name",
      "media_type",
      "relative_path",
    ],
  },
  {
    table: "message_segments",
    columns: [
      "segment_id",
      "message_id",
      "window_id",
      "ordinal",
      "kind",
      "text",
      "start_offset",
      "end_offset",
      "outfit_id",
      "sprite_asset_id",
      "annotated_at",
    ],
  },
  {
    table: "scene_image_tasks",
    columns: [
      "task_id",
      "role_id",
      "window_id",
      "message_id",
      "execution_id",
      "trigger_source",
      "layer_mode",
      "start_segment_id",
      "end_segment_id",
      "status",
      "idempotency_key",
      "attempt_no",
      "plan_json",
      "error_code",
      "error_summary",
      "config_json",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "scene_image_assets",
    columns: [
      "asset_id",
      "task_id",
      "role_id",
      "window_id",
      "message_id",
      "media_type",
      "relative_path",
      "width",
      "height",
      "byte_size",
      "created_at",
    ],
  },
];

const BUSINESS_INDEXES: readonly RequiredIndex[] = [
  {
    name: "idx_messages_window_submission",
    table: "messages",
    columns: ["window_id", "submission_id"],
    unique: true,
    partial: true,
    predicate: "submission_id IS NOT NULL",
  },
  {
    name: "idx_role_single_chat_model",
    table: "role_bindings",
    columns: ["role_id"],
    unique: true,
    partial: true,
    predicate: "capability = 'chat_model'",
  },
  {
    name: "idx_role_single_memory_model",
    table: "role_bindings",
    columns: ["role_id"],
    unique: true,
    partial: true,
    predicate: "capability = 'memory_model'",
  },
  {
    name: "idx_executions_role_round",
    table: "executions",
    columns: ["role_id", "decision_round"],
    unique: true,
    partial: true,
    predicate: "decision_round IS NOT NULL",
  },
  {
    name: "idx_messages_pending_decision",
    table: "messages",
    columns: ["window_id", "sequence"],
    unique: false,
    partial: true,
    predicate:
      "sender = 'user' AND processed_by_execution_id IS NULL AND claimed_by_execution_id IS NULL",
  },
  {
    name: "idx_memory_batch_single_running",
    table: "memory_batches",
    columns: ["role_id"],
    unique: true,
    partial: true,
    predicate: "status = 'running'",
  },
  {
    name: "idx_memory_triggers_pending",
    table: "memory_triggers",
    columns: ["role_id", "created_at"],
    unique: false,
    partial: true,
    predicate: "consumed_at IS NULL",
  },
  {
    name: "idx_memory_recalls_execution_record",
    table: "memory_recalls",
    columns: ["execution_id", "record_type", "record_id"],
    unique: true,
    partial: false,
  },
  {
    name: "idx_execution_stream_window",
    table: "execution_stream_events",
    columns: ["window_id", "stream_event_id"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_voice_assets_role",
    table: "voice_assets",
    columns: ["role_id", "created_at"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_autonomy_wakes_due",
    table: "autonomy_wakes",
    columns: ["role_id", "status", "scheduled_at"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_autonomy_wakes_task",
    table: "autonomy_wakes",
    columns: ["task_id"],
    unique: false,
    partial: true,
    predicate: "task_id IS NOT NULL",
  },
  {
    name: "idx_autonomy_activity_wake",
    table: "autonomy_activities",
    columns: ["wake_id"],
    unique: true,
    partial: false,
  },
  {
    name: "idx_autonomy_activity_role_time",
    table: "autonomy_activities",
    columns: ["role_id", "created_at"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_autonomy_activity_task",
    table: "autonomy_activities",
    columns: ["task_id"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_autonomy_tool_reservations_status",
    table: "autonomy_tool_reservations",
    columns: ["role_id", "status"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_outfits_role_name",
    table: "outfits",
    columns: ["role_id", "name"],
    unique: true,
    partial: false,
  },
  {
    name: "idx_outfit_assets_single_home",
    table: "outfit_assets",
    columns: ["outfit_id"],
    unique: true,
    partial: true,
    predicate: "usage = 'home'",
  },
  {
    name: "idx_outfit_assets_outfit",
    table: "outfit_assets",
    columns: ["outfit_id", "usage", "created_at"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_message_segments_window",
    table: "message_segments",
    columns: ["window_id", "message_id", "ordinal"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_scene_image_manual_key",
    table: "scene_image_tasks",
    columns: ["role_id", "window_id", "message_id", "idempotency_key"],
    unique: true,
    partial: true,
    predicate: "trigger_source = 'manual' AND idempotency_key IS NOT NULL",
  },
  {
    name: "idx_scene_image_auto_attempt",
    table: "scene_image_tasks",
    columns: ["message_id", "attempt_no"],
    unique: true,
    partial: true,
    predicate: "trigger_source = 'auto'",
  },
  {
    name: "idx_scene_image_window",
    table: "scene_image_tasks",
    columns: ["window_id", "message_id", "created_at"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_scene_image_status",
    table: "scene_image_tasks",
    columns: ["status", "updated_at"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_scene_image_assets_task",
    table: "scene_image_assets",
    columns: ["task_id"],
    unique: true,
    partial: false,
  },
  {
    name: "idx_scene_image_assets_role",
    table: "scene_image_assets",
    columns: ["role_id", "created_at"],
    unique: false,
    partial: false,
  },
];

const BUSINESS_V3_SQL = `
CREATE TABLE IF NOT EXISTS autonomy_budget (
  role_id TEXT PRIMARY KEY REFERENCES roles(role_id),
  local_date TEXT NOT NULL,
  used_points INTEGER NOT NULL CHECK (used_points >= 0),
  daily_limit INTEGER NOT NULL CHECK (daily_limit > 0),
  unlimited INTEGER NOT NULL CHECK (unlimited IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS autonomy_wakes (
  wake_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'budget_resume')),
  scheduled_at TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'cancelled')),
  source_execution_id TEXT REFERENCES executions(execution_id),
  task_id TEXT REFERENCES tasks(task_id),
  activity_id TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autonomy_wakes_due
  ON autonomy_wakes (role_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_autonomy_wakes_task
  ON autonomy_wakes (task_id)
  WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS autonomy_activities (
  activity_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  wake_id TEXT NOT NULL REFERENCES autonomy_wakes(wake_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'paused')),
  summary TEXT,
  shared_message_id TEXT REFERENCES messages(message_id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_activity_wake
  ON autonomy_activities (wake_id);

CREATE INDEX IF NOT EXISTS idx_autonomy_activity_role_time
  ON autonomy_activities (role_id, created_at);

CREATE INDEX IF NOT EXISTS idx_autonomy_activity_task
  ON autonomy_activities (task_id);

ALTER TABLE execution_stream_events RENAME TO execution_stream_events_v2_old;
DROP INDEX IF EXISTS idx_execution_stream_window;
DROP INDEX IF EXISTS idx_execution_stream_execution;

CREATE TABLE execution_stream_events (
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

INSERT INTO execution_stream_events
  (stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at)
SELECT stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at
  FROM execution_stream_events_v2_old;

DROP TABLE execution_stream_events_v2_old;
CREATE INDEX idx_execution_stream_window
  ON execution_stream_events (window_id, stream_event_id);
CREATE INDEX idx_execution_stream_execution
  ON execution_stream_events (execution_id, stream_event_id);
`;

const BUSINESS_V4_SQL = `
CREATE TABLE IF NOT EXISTS autonomy_tool_reservations (
  tool_call_id TEXT PRIMARY KEY REFERENCES tool_calls(tool_call_id),
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  local_date TEXT NOT NULL,
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autonomy_tool_reservations_status
  ON autonomy_tool_reservations (role_id, status);
`;

const BUSINESS_V5_SQL = `
-- V5：流事件增加 tool_backgrounded（慢工具转后台）、任务进度笔记、补录证据关联。
ALTER TABLE execution_stream_events RENAME TO execution_stream_events_v5_old;
DROP INDEX IF EXISTS idx_execution_stream_window;
DROP INDEX IF EXISTS idx_execution_stream_execution;

CREATE TABLE execution_stream_events (
  stream_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution_started', 'message_delta', 'tool_started', 'tool_result_saved',
    'tool_backgrounded', 'message_completed', 'message_interrupted',
    'execution_superseded', 'execution_paused', 'execution_failed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO execution_stream_events
  (stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at)
SELECT stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at
  FROM execution_stream_events_v5_old;

DROP TABLE execution_stream_events_v5_old;
CREATE INDEX idx_execution_stream_window
  ON execution_stream_events (window_id, stream_event_id);
CREATE INDEX idx_execution_stream_execution
  ON execution_stream_events (execution_id, stream_event_id);

CREATE TABLE IF NOT EXISTS task_notes (
  note_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task
  ON task_notes (task_id, created_at);

ALTER TABLE tool_results ADD COLUMN reconciled_by_call_id TEXT REFERENCES tool_calls(tool_call_id);
`;

const BUSINESS_V6_SQL = `
-- V6：任务决定与回复在同一事务提交，供启动收尾按原决定恢复。
ALTER TABLE executions ADD COLUMN task_decision_json TEXT;
`;

const BUSINESS_V7_SQL = `
-- V7：角色衣柜与外观素材。目录名即服饰名，主页图每套最多一张，差分可同名。
CREATE TABLE IF NOT EXISTS outfits (
  outfit_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outfits_role_name
  ON outfits (role_id, name);

CREATE TABLE IF NOT EXISTS outfit_assets (
  asset_id TEXT PRIMARY KEY,
  outfit_id TEXT NOT NULL REFERENCES outfits(outfit_id),
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  usage TEXT NOT NULL CHECK (usage IN ('home', 'sprite')),
  file_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outfit_assets_single_home
  ON outfit_assets (outfit_id)
  WHERE usage = 'home';

CREATE INDEX IF NOT EXISTS idx_outfit_assets_outfit
  ON outfit_assets (outfit_id, usage, created_at);
`;

const BUSINESS_V8_SQL = `
-- V8：回复句段与表情标注。正文仍整条保存，句段按自然段提供稳定标识。
CREATE TABLE IF NOT EXISTS message_segments (
  segment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('speech', 'narration')),
  text TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  outfit_id TEXT REFERENCES outfits(outfit_id),
  sprite_asset_id TEXT REFERENCES outfit_assets(asset_id),
  annotated_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_message_segments_window
  ON message_segments (window_id, message_id, ordinal);

ALTER TABLE execution_stream_events RENAME TO execution_stream_events_v8_old;
DROP INDEX IF EXISTS idx_execution_stream_window;
DROP INDEX IF EXISTS idx_execution_stream_execution;

CREATE TABLE execution_stream_events (
  stream_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution_started', 'message_delta', 'tool_started', 'tool_result_saved',
    'tool_backgrounded', 'message_segments', 'segment_annotations',
    'message_completed', 'message_interrupted', 'execution_superseded',
    'execution_paused', 'execution_failed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO execution_stream_events
  (stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at)
SELECT stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at
  FROM execution_stream_events_v8_old;

DROP TABLE execution_stream_events_v8_old;
CREATE INDEX idx_execution_stream_window
  ON execution_stream_events (window_id, stream_event_id);
CREATE INDEX idx_execution_stream_execution
  ON execution_stream_events (execution_id, stream_event_id);
`;

const BUSINESS_V9_SQL = `
-- V9：角色音色与参考音频。参考音频按受管文件保存，试听与按句合成共用同一服务。
CREATE TABLE IF NOT EXISTS voice_assets (
  asset_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_assets_role
  ON voice_assets (role_id, created_at);

CREATE TABLE IF NOT EXISTS role_voice_settings (
  role_id TEXT PRIMARY KEY REFERENCES roles(role_id),
  engine TEXT NOT NULL,
  base_url TEXT NOT NULL,
  reference_asset_id TEXT REFERENCES voice_assets(asset_id),
  language TEXT NOT NULL,
  speed REAL NOT NULL,
  emo_alpha REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const BUSINESS_V10_SQL = `
-- V10：TTS 统一接入。旧行保持 indextts 协议和参考音色来源。
ALTER TABLE role_voice_settings
  ADD COLUMN protocol TEXT NOT NULL DEFAULT 'indextts';
ALTER TABLE role_voice_settings
  ADD COLUMN voice_source TEXT NOT NULL DEFAULT 'reference';
ALTER TABLE role_voice_settings
  ADD COLUMN reference_mode TEXT;
ALTER TABLE role_voice_settings
  ADD COLUMN reference_text TEXT;
ALTER TABLE role_voice_settings
  ADD COLUMN preset_voice_id TEXT;
ALTER TABLE role_voice_settings
  ADD COLUMN capabilities_json TEXT;
`;

const BUSINESS_V11_SQL = `
-- V11：参考模式是否已由用户确认。旧行默认已确认。
ALTER TABLE role_voice_settings
  ADD COLUMN reference_mode_confirmed INTEGER NOT NULL DEFAULT 1;
`;

const BUSINESS_V12_SQL = `
-- V12：上一版 V11 曾把统一协议下缺少模式的旧行标为已确认。
-- 这类行无法证明用户确认过模式，修正为待确认；已绑定模式的行不受影响。
UPDATE role_voice_settings
SET reference_mode_confirmed = 0
WHERE protocol = 'nowadays-tts-v1'
  AND voice_source = 'reference'
  AND reference_mode IS NULL;
`;

const BUSINESS_V13_SQL = `
-- V13：生成过场图任务。任务锚定一条已保存的角色回复和同轮句段区间，
-- 结果素材与任务同事务提交，状态更新写入既有窗口流事件供重连补齐。
CREATE TABLE IF NOT EXISTS scene_image_tasks (
  task_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('manual', 'auto')),
  layer_mode TEXT NOT NULL CHECK (layer_mode IN ('background', 'full_scene')),
  start_segment_id TEXT NOT NULL REFERENCES message_segments(segment_id),
  end_segment_id TEXT NOT NULL REFERENCES message_segments(segment_id),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'planning', 'generating', 'succeeded', 'skipped', 'failed'
  )),
  idempotency_key TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  plan_json TEXT,
  error_code TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_image_manual_key
  ON scene_image_tasks (role_id, window_id, message_id, idempotency_key)
  WHERE trigger_source = 'manual' AND idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_image_auto_attempt
  ON scene_image_tasks (message_id, attempt_no)
  WHERE trigger_source = 'auto';

CREATE INDEX IF NOT EXISTS idx_scene_image_window
  ON scene_image_tasks (window_id, message_id, created_at);

CREATE INDEX IF NOT EXISTS idx_scene_image_status
  ON scene_image_tasks (status, updated_at);

CREATE TABLE IF NOT EXISTS scene_image_assets (
  asset_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scene_image_tasks(task_id),
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_image_assets_task
  ON scene_image_assets (task_id);

CREATE INDEX IF NOT EXISTS idx_scene_image_assets_role
  ON scene_image_assets (role_id, created_at);

ALTER TABLE execution_stream_events RENAME TO execution_stream_events_v13_old;
DROP INDEX IF EXISTS idx_execution_stream_window;
DROP INDEX IF EXISTS idx_execution_stream_execution;

CREATE TABLE execution_stream_events (
  stream_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution_started', 'message_delta', 'tool_started', 'tool_result_saved',
    'tool_backgrounded', 'message_segments', 'segment_annotations',
    'scene_image_task', 'message_completed', 'message_interrupted',
    'execution_superseded', 'execution_paused', 'execution_failed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO execution_stream_events
  (stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at)
SELECT stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at
  FROM execution_stream_events_v13_old;

DROP TABLE execution_stream_events_v13_old;
CREATE INDEX idx_execution_stream_window
  ON execution_stream_events (window_id, stream_event_id);
CREATE INDEX idx_execution_stream_execution
  ON execution_stream_events (execution_id, stream_event_id);
`;

const BUSINESS_V14_SQL = `
-- V14：角色语音启用／停用。停用保留当前这份配置，只阻止新的对话语音合成；
-- 保存新配置不改变启用状态（DL-149）。
ALTER TABLE role_voice_settings
  ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
`;

const BUSINESS_V15_SQL = `
-- V15：角色生图配置。首版只做文生图（MOSS-Image），服务连接存 app 库的
-- image_services，本表只记角色选择的模型、锚点提示词与采样参数（DL-150）。
CREATE TABLE IF NOT EXISTS role_scene_image_settings (
  role_id TEXT PRIMARY KEY REFERENCES roles(role_id),
  service_id TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('text2img')),
  model_path TEXT NOT NULL,
  base_prompt TEXT NOT NULL,
  negative_prompt TEXT NOT NULL,
  outfit_prompts_json TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  steps INTEGER NOT NULL,
  cfg REAL NOT NULL,
  sampler TEXT NOT NULL,
  scheduler TEXT NOT NULL,
  seed INTEGER,
  workflow_json TEXT,
  output_node_id TEXT,
  updated_at TEXT NOT NULL
);
`;

const BUSINESS_V16_SQL = `
-- V16：过场图任务在接收时固定服务、模型与锚点版本，
-- 规划或排队期间修改配置不影响已接收任务的生成结果。
ALTER TABLE scene_image_tasks
  ADD COLUMN config_json TEXT;
`;

export function openAppDatabase(dbPath: string): OpenedDatabase {
  return openVersionedDatabase(
    dbPath,
    APP_SCHEMA_VERSION,
    APP_SCHEMA_SQL + APP_V2_SQL + APP_V3_SQL + APP_V4_SQL,
    {
      1: (db) => db.exec(APP_V2_SQL),
      2: (db) => db.exec(APP_V3_SQL),
      3: (db) => db.exec(APP_V4_SQL),
    },
    APP_TABLES,
    [],
    [],
    { create: true },
  );
}

export function openBusinessDatabase(
  dbPath: string,
  options: DatabaseOpenOptions = {},
): OpenedDatabase {
  return openVersionedDatabase(
    dbPath,
    BUSINESS_SCHEMA_VERSION,
    BUSINESS_SCHEMA_SQL +
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
      BUSINESS_V16_SQL,
    {
      1: (db) => {
        db.exec(BUSINESS_V2_SQL);
        backfillEvidence(db, options.timeZone);
      },
      2: (db) => db.exec(BUSINESS_V3_SQL),
      3: (db) => db.exec(BUSINESS_V4_SQL),
      4: (db) => db.exec(BUSINESS_V5_SQL),
      5: (db) => db.exec(BUSINESS_V6_SQL),
      6: (db) => db.exec(BUSINESS_V7_SQL),
      7: (db) => db.exec(BUSINESS_V8_SQL),
      8: (db) => db.exec(BUSINESS_V9_SQL),
      9: (db) => db.exec(BUSINESS_V10_SQL),
      10: (db) => db.exec(BUSINESS_V11_SQL),
      11: (db) => db.exec(BUSINESS_V12_SQL),
      12: (db) => db.exec(BUSINESS_V13_SQL),
      13: (db) => db.exec(BUSINESS_V14_SQL),
      14: (db) => db.exec(BUSINESS_V15_SQL),
      15: (db) => db.exec(BUSINESS_V16_SQL),
    },
    BUSINESS_TABLES,
    BUSINESS_INDEXES,
    BUSINESS_COLUMNS,
    options,
  );
}

export function openExecutionDatabase(
  dbPath: string,
  options: DatabaseOpenOptions = {},
): OpenedDatabase {
  const create = options.create !== false;
  const db = openRawDatabase(dbPath, create);
  try {
    ensureVersionOnly(db, EXECUTION_SCHEMA_VERSION, create);
    return { db, path: dbPath, schemaVersion: EXECUTION_SCHEMA_VERSION };
  } catch (error) {
    db.close();
    throw error;
  }
}

function openVersionedDatabase(
  dbPath: string,
  version: number,
  schemaSql: string,
  migrations: Record<number, (db: Database.Database) => void>,
  requiredTables: readonly string[],
  requiredIndexes: readonly RequiredIndex[],
  requiredColumns: readonly RequiredColumns[],
  options: DatabaseOpenOptions,
): OpenedDatabase {
  const create = options.create !== false;
  const db = openRawDatabase(dbPath, create);
  const currentVersion = readUserVersion(db);
  try {
    db.transaction(() => {
      ensureSchema(db, version, schemaSql, migrations, create);
      assertTables(db, requiredTables);
      assertIndexes(db, requiredIndexes);
      assertColumns(db, requiredColumns);
      if (requiredTables.includes("memory_search_fts")) {
        assertFtsIndex(db);
      }
    })();
    return { db, path: dbPath, schemaVersion: version };
  } catch (error) {
    db.close();
    if (error instanceof AppError) {
      throw error;
    }
    if (isFtsUnavailable(error)) {
      throw new FtsUnavailableError();
    }
    if (currentVersion > 0 && currentVersion < version) {
      throw new SchemaMigrationError(error);
    }
    throw error;
  }
}

function isFtsUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("no such module: fts5") ||
    message.includes("no such tokenizer: trigram") ||
    message.includes("unknown tokenizer: trigram")
  );
}

function openRawDatabase(dbPath: string, create: boolean): Database.Database {
  if (!create && !fs.existsSync(dbPath)) {
    throw new Error(`STORAGE_FILE_MISSING:${path.basename(dbPath)}`);
  }
  if (create) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = create
    ? new Database(dbPath)
    : new Database(dbPath, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function ensureSchema(
  db: Database.Database,
  version: number,
  schemaSql: string,
  migrations: Record<number, (db: Database.Database) => void>,
  create: boolean,
): void {
  const current = readUserVersion(db);
  if (current === version) {
    return;
  }
  if (current === 0) {
    if (!create) {
      throw new Error(`SCHEMA_INITIALIZATION_REQUIRED:${version}`);
    }
    db.exec(schemaSql);
    db.pragma(`user_version = ${version}`);
    return;
  }
  if (current > version) {
    throw new Error(`SCHEMA_VERSION_UNSUPPORTED:${version}:${current}`);
  }
  for (let next = current; next < version; next += 1) {
    const migrate = migrations[next];
    if (!migrate) {
      throw new Error(`SCHEMA_MIGRATION_REQUIRED:${version}:${next}`);
    }
    migrate(db);
  }
  db.pragma(`user_version = ${version}`);
}

function ensureVersionOnly(
  db: Database.Database,
  version: number,
  create: boolean,
): void {
  const current = readUserVersion(db);
  if (current === version) {
    return;
  }
  if (current !== 0) {
    throw new Error(`SCHEMA_VERSION_UNSUPPORTED:${version}:${current}`);
  }
  if (!create) {
    throw new Error(`SCHEMA_INITIALIZATION_REQUIRED:${version}`);
  }
  db.pragma(`user_version = ${version}`);
}

function readUserVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function assertTables(
  db: Database.Database,
  requiredTables: readonly string[],
): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => row.name));
  for (const table of requiredTables) {
    if (!existing.has(table)) {
      throw new Error(`SCHEMA_TABLE_MISSING:${table}`);
    }
  }
}

function assertIndexes(
  db: Database.Database,
  requiredIndexes: readonly RequiredIndex[],
): void {
  for (const spec of requiredIndexes) {
    const indexList = db.pragma(`index_list("${spec.table}")`) as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const found = indexList.find((row) => row.name === spec.name);
    if (!found) {
      throw new Error(`SCHEMA_INDEX_MISSING:${spec.name}`);
    }
    if (
      (found.unique === 1) !== spec.unique ||
      (found.partial === 1) !== spec.partial
    ) {
      throw new Error(`SCHEMA_INDEX_INVALID:${spec.name}`);
    }
    const info = db.pragma(`index_info("${spec.name}")`) as Array<{
      seqno: number;
      name: string;
    }>;
    const columns = info
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (columns.join(",") !== spec.columns.join(",")) {
      throw new Error(`SCHEMA_INDEX_INVALID:${spec.name}`);
    }
    if (!spec.partial) {
      continue;
    }
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(spec.name) as { sql: string | null } | undefined;
    const predicate = row?.sql ? extractWhereClause(row.sql) : null;
    if (
      predicate === null ||
      normalizeSql(predicate) !== normalizeSql(spec.predicate ?? "")
    ) {
      throw new Error(`SCHEMA_INDEX_INVALID:${spec.name}`);
    }
  }
}

function assertFtsIndex(db: Database.Database): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_search_fts'",
    )
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) {
    throw new Error("SCHEMA_TABLE_MISSING:memory_search_fts");
  }
  if (
    !/using\s+fts5/i.test(row.sql) ||
    !/tokenize\s*=\s*'trigram'/i.test(row.sql)
  ) {
    throw new Error("SCHEMA_TABLE_INVALID:memory_search_fts");
  }
}

function assertColumns(
  db: Database.Database,
  requiredColumns: readonly RequiredColumns[],
): void {
  for (const spec of requiredColumns) {
    const rows = db.pragma(`table_info("${spec.table}")`) as Array<{
      name: string;
    }>;
    const existing = new Set(rows.map((row) => row.name));
    for (const column of spec.columns) {
      if (!existing.has(column)) {
        throw new Error(`SCHEMA_COLUMN_MISSING:${spec.table}.${column}`);
      }
    }
  }
}

function extractWhereClause(sql: string): string | null {
  const match = /\bwhere\b([\s\S]*)$/i.exec(sql);
  return match?.[1] ?? null;
}

function normalizeSql(sql: string): string {
  let normalized = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'" || char === '"' || char === "`") {
      normalized += char;
      index += 1;
      while (index < sql.length) {
        const quoted = sql[index] ?? "";
        normalized += quoted;
        index += 1;
        if (quoted !== char) {
          continue;
        }
        if (sql[index] === char) {
          normalized += char;
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (char === ";" || /\s/.test(char) || char === "(" || char === ")") {
      index += 1;
      continue;
    }
    normalized += char.toLowerCase();
    index += 1;
  }
  return normalized;
}
