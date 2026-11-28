import type Database from "better-sqlite3";
import { addColumnIfMissing } from "./schema-verify.js";

export const BUSINESS_V3_SQL = `
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

export const BUSINESS_V4_SQL = `
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

export const BUSINESS_V5_SQL = `
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

export const BUSINESS_V6_SQL = `
-- V6：任务决定与回复在同一事务提交，供启动收尾按原决定恢复。
ALTER TABLE executions ADD COLUMN task_decision_json TEXT;
`;

export const BUSINESS_V7_SQL = `
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

export const BUSINESS_V8_SQL = `
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

export const BUSINESS_V9_SQL = `
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

export const BUSINESS_V10_SQL = `
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

export const BUSINESS_V11_SQL = `
-- V11：参考模式是否已由用户确认。旧行默认已确认。
ALTER TABLE role_voice_settings
  ADD COLUMN reference_mode_confirmed INTEGER NOT NULL DEFAULT 1;
`;

export const BUSINESS_V12_SQL = `
-- V12：上一版 V11 曾把统一协议下缺少模式的旧行标为已确认。
-- 这类行无法证明用户确认过模式，修正为待确认；已绑定模式的行不受影响。
UPDATE role_voice_settings
SET reference_mode_confirmed = 0
WHERE protocol = 'nowadays-tts-v1'
  AND voice_source = 'reference'
  AND reference_mode IS NULL;
`;

export const BUSINESS_V13_SQL = `
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

export const BUSINESS_V14_SQL = `
-- V14：角色语音启用／停用。停用保留当前这份配置，只阻止新的对话语音合成；
-- 保存新配置不改变启用状态（DL-149）。
ALTER TABLE role_voice_settings
  ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
`;

export const BUSINESS_V15_SQL = `
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

export const BUSINESS_V16_SQL = `
-- V16：过场图任务在接收时固定服务、模型与锚点版本，
-- 规划或排队期间修改配置不影响已接收任务的生成结果。
ALTER TABLE scene_image_tasks
  ADD COLUMN config_json TEXT;
`;

export const BUSINESS_V17_SQL = `
-- V17：服饰与素材支持软删除，句段保存主页立绘（standee）素材快照（DL-151）。
-- 删除后的服饰从衣柜、管理列表和 Agent 候选移除，但历史句段仍按素材标识读图。
ALTER TABLE outfits ADD COLUMN deleted_at TEXT;
ALTER TABLE outfit_assets ADD COLUMN deleted_at TEXT;
ALTER TABLE message_segments
  ADD COLUMN home_asset_id TEXT REFERENCES outfit_assets(asset_id);
DROP INDEX IF EXISTS idx_outfits_role_name;
CREATE UNIQUE INDEX idx_outfits_role_name
  ON outfits(role_id, name) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS idx_outfit_assets_single_home;
CREATE UNIQUE INDEX idx_outfit_assets_single_home
  ON outfit_assets(outfit_id)
  WHERE usage = 'home' AND deleted_at IS NULL;
-- 旧句段没有立绘标识：按升级时所属服饰的主页立绘回填，之后替换或删除不再影响。
UPDATE message_segments
   SET home_asset_id = (
     SELECT a.asset_id
       FROM outfit_assets a
      WHERE a.outfit_id = message_segments.outfit_id
        AND a.usage = 'home'
        AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC, a.rowid DESC
      LIMIT 1
   )
 WHERE home_asset_id IS NULL AND outfit_id IS NOT NULL;
`;

export const BUSINESS_V18_SQL = `
-- V18：model_calls 协议约束纳入 google-gemini（Google Gemini / Vertex AI 直连）。
ALTER TABLE model_calls RENAME TO model_calls_v18_old;
DROP INDEX IF EXISTS idx_model_calls_role_time;

CREATE TABLE model_calls (
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
    'openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'
  )),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  usage_json TEXT,
  raw_response_json TEXT
);

INSERT INTO model_calls
  (model_call_id, role_id, execution_id, batch_id, purpose, resource_id,
   model_name, protocol, status, error_code, started_at, finished_at,
   usage_json, raw_response_json)
SELECT model_call_id, role_id, execution_id, batch_id, purpose, resource_id,
       model_name, protocol, status, error_code, started_at, finished_at,
       usage_json, raw_response_json
  FROM model_calls_v18_old;

DROP TABLE model_calls_v18_old;
CREATE INDEX IF NOT EXISTS idx_model_calls_role_time
  ON model_calls (role_id, started_at);
`;

export const BUSINESS_V19_SQL = `
-- V19：语音设置记录所选底层引擎与多引擎能力快照，句段记录语音情绪指令。
ALTER TABLE role_voice_settings
  ADD COLUMN tts_engine TEXT;

ALTER TABLE role_voice_settings
  ADD COLUMN engines_json TEXT;

ALTER TABLE role_voice_settings
  ADD COLUMN default_engine TEXT;

ALTER TABLE message_segments
  ADD COLUMN voice_emotion TEXT;
`;

export const BUSINESS_V20_SQL = `
-- v20：角色语音配置支持关联全局 voice_services 服务（DL-152），同时保留旧直填兼容。
ALTER TABLE role_voice_settings
  ADD COLUMN service_id TEXT;
`;

const BUSINESS_V21_STREAM_SQL = `
ALTER TABLE execution_stream_events RENAME TO execution_stream_events_v21_old;
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
    'execution_superseded', 'execution_paused', 'execution_failed',
    'task_cancelled'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO execution_stream_events
  (stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at)
SELECT stream_event_id, role_id, window_id, execution_id, event_type, payload_json, created_at
  FROM execution_stream_events_v21_old;

DROP TABLE execution_stream_events_v21_old;

CREATE INDEX idx_execution_stream_window
  ON execution_stream_events (window_id, stream_event_id);
CREATE INDEX idx_execution_stream_execution
  ON execution_stream_events (execution_id, stream_event_id);
`;

export const BUSINESS_V21_SQL = `
-- v21：默认预置角色标识与展示介绍、预置外观保护、任务续行/熔断字段、任务级模型用量归属及 task_cancelled 流事件（DL-147 / DL-153～158）。
ALTER TABLE roles ADD COLUMN builtin_key TEXT;
ALTER TABLE roles ADD COLUMN bio_text TEXT NOT NULL DEFAULT '';

ALTER TABLE outfits ADD COLUMN is_preset INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0, 1));
ALTER TABLE outfit_assets ADD COLUMN is_preset INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0, 1));

ALTER TABLE tasks ADD COLUMN continuable INTEGER NOT NULL DEFAULT 0 CHECK (continuable IN (0, 1));
ALTER TABLE tasks ADD COLUMN wait_reason TEXT;
ALTER TABLE tasks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0);
ALTER TABLE tasks ADD COLUMN consecutive_no_progress INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_no_progress >= 0);

ALTER TABLE model_calls ADD COLUMN task_id TEXT REFERENCES tasks(task_id);
ALTER TABLE model_calls ADD COLUMN call_kind TEXT NOT NULL DEFAULT 'other'
  CHECK (call_kind IN ('primary_decision', 'segment_annotation', 'scene_plan', 'memory_maintenance', 'other'));

CREATE INDEX IF NOT EXISTS idx_model_calls_task
  ON model_calls (role_id, task_id, call_kind);
${BUSINESS_V21_STREAM_SQL}
`;

export function migrateBusinessV21(db: Database.Database): void {
  addColumnIfMissing(db, "roles", "builtin_key", "TEXT");
  addColumnIfMissing(db, "roles", "bio_text", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(
    db,
    "outfits",
    "is_preset",
    "INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0, 1))",
  );
  addColumnIfMissing(
    db,
    "outfit_assets",
    "is_preset",
    "INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0, 1))",
  );
  addColumnIfMissing(
    db,
    "tasks",
    "continuable",
    "INTEGER NOT NULL DEFAULT 0 CHECK (continuable IN (0, 1))",
  );
  addColumnIfMissing(db, "tasks", "wait_reason", "TEXT");
  addColumnIfMissing(
    db,
    "tasks",
    "consecutive_failures",
    "INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)",
  );
  addColumnIfMissing(
    db,
    "tasks",
    "consecutive_no_progress",
    "INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_no_progress >= 0)",
  );
  addColumnIfMissing(
    db,
    "model_calls",
    "task_id",
    "TEXT REFERENCES tasks(task_id)",
  );
  addColumnIfMissing(
    db,
    "model_calls",
    "call_kind",
    "TEXT NOT NULL DEFAULT 'other' CHECK (call_kind IN ('primary_decision', 'segment_annotation', 'scene_plan', 'memory_maintenance', 'other'))",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_calls_task
      ON model_calls (role_id, task_id, call_kind);
  `);
  const tableRow = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_stream_events'",
    )
    .get() as { sql: string | null } | undefined;
  if (!(tableRow?.sql ?? "").includes("task_cancelled")) {
    db.exec(BUSINESS_V21_STREAM_SQL);
  }
}

export const BUSINESS_V22_SQL = `
-- v22：预置服饰稳定来源标识（preset_key），避免与同名自定义服饰冲突时重复导入（310 §8 R02）。
ALTER TABLE outfits ADD COLUMN preset_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outfits_role_preset_key
  ON outfits (role_id, preset_key)
  WHERE preset_key IS NOT NULL AND deleted_at IS NULL;
`;

export function migrateBusinessV22(db: Database.Database): void {
  addColumnIfMissing(db, "outfits", "preset_key", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outfits_role_preset_key
      ON outfits (role_id, preset_key)
      WHERE preset_key IS NOT NULL AND deleted_at IS NULL;
  `);
}
