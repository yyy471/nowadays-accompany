import { MemoryStore } from "../memory/memory-store.js";
import { backfillEvidence } from "../memory/evidence.js";
import { restoreAutonomyShareLinks } from "../conversation/autonomy-store.js";
import {
  retireLegacyWebPrefetchEvidence,
  WEB_READING_SCHEMA_SQL,
} from "../conversation/web-reading.js";
import {
  addColumnIfMissing,
  assertFtsIndex,
  openVersionedDatabase,
  type DatabaseOpenOptions,
  type OpenedDatabase,
} from "./schema-verify.js";
import {
  BUSINESS_SCHEMA_V22_SQL,
  BUSINESS_SCHEMA_VERSION,
  BUSINESS_TABLES,
  BUSINESS_V2_SQL,
  MEMORY_REVISIONS_SQL,
} from "./schema-business-base.js";
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
  migrateBusinessV21,
  migrateBusinessV22,
} from "./schema-business-migrations.js";
import {
  BUSINESS_COLUMNS,
  BUSINESS_INDEXES,
} from "./schema-business-verify.js";

const BUSINESS_V23_SQL = `
ALTER TABLE roles ADD COLUMN first_activation_pending INTEGER NOT NULL DEFAULT 0
  CHECK (first_activation_pending IN (0, 1));
` + WEB_READING_SCHEMA_SQL;

const BUSINESS_V24_SQL = `
CREATE TABLE IF NOT EXISTS role_worldbooks (
  role_id TEXT PRIMARY KEY REFERENCES roles(role_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  books_json TEXT NOT NULL CHECK (json_valid(books_json) AND json_type(books_json) = 'array')
);
CREATE TABLE IF NOT EXISTS worldbook_usage (
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  model_call_id TEXT NOT NULL REFERENCES model_calls(model_call_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  book_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('included','budget_omitted')),
  matched_message_ids_json TEXT NOT NULL CHECK (json_valid(matched_message_ids_json) AND json_type(matched_message_ids_json) = 'array'),
  PRIMARY KEY (model_call_id, book_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_worldbook_usage_execution ON worldbook_usage (role_id, execution_id);
`;

const BUSINESS_V27_SQL = `
CREATE TABLE IF NOT EXISTS role_scene_references (
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  outfit_id TEXT PRIMARY KEY REFERENCES outfits(outfit_id),
  asset_id TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL, updated_at TEXT NOT NULL
);`;

const BUSINESS_V26_SQL = `
CREATE TABLE role_scene_image_settings_v26 (
  role_id TEXT PRIMARY KEY REFERENCES roles(role_id), service_id TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('text2img','img2img')), model_path TEXT NOT NULL,
  base_prompt TEXT NOT NULL, negative_prompt TEXT NOT NULL, outfit_prompts_json TEXT NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, steps INTEGER NOT NULL, cfg REAL NOT NULL,
  sampler TEXT NOT NULL, scheduler TEXT NOT NULL, seed INTEGER, workflow_json TEXT, output_node_id TEXT,
  updated_at TEXT NOT NULL, auto_generate_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_generate_enabled IN (0,1)),
  auto_cooldown_minutes INTEGER NOT NULL DEFAULT 30 CHECK (auto_cooldown_minutes BETWEEN 0 AND 10080)
);
INSERT INTO role_scene_image_settings_v26
  (role_id,service_id,model_type,model_path,base_prompt,negative_prompt,outfit_prompts_json,width,height,
   steps,cfg,sampler,scheduler,seed,workflow_json,output_node_id,updated_at)
  SELECT role_id,service_id,model_type,model_path,base_prompt,negative_prompt,outfit_prompts_json,width,height,
   steps,cfg,sampler,scheduler,seed,workflow_json,output_node_id,updated_at FROM role_scene_image_settings;
DROP TABLE role_scene_image_settings;
ALTER TABLE role_scene_image_settings_v26 RENAME TO role_scene_image_settings;
`;

const BUSINESS_V28_SQL = `
CREATE TABLE IF NOT EXISTS observed_dialogue_batches (
  batch_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  after_seq INTEGER NOT NULL,
  up_to_seq INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS observed_batches_pending ON observed_dialogue_batches(due_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS observed_dialogue_members (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
  batch_id TEXT NOT NULL REFERENCES observed_dialogue_batches(batch_id)
);
CREATE INDEX IF NOT EXISTS observed_members_by_batch ON observed_dialogue_members(batch_id);
`;

const EXCHANGE_SOURCE_SQL = `
CREATE TABLE IF NOT EXISTS role_exchange_sessions (
  sessionId TEXT PRIMARY KEY, initiatorRoleId TEXT NOT NULL, targetRoleId TEXT NOT NULL,
  initiatorName TEXT NOT NULL, targetName TEXT NOT NULL, topic TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','completed','failed','cancelled')),
  maxTurns INTEGER NOT NULL CHECK(maxTurns BETWEEN 2 AND 12),
  turnCount INTEGER NOT NULL CHECK(turnCount BETWEEN 1 AND maxTurns),
  startedAt TEXT NOT NULL, endedAt TEXT, reason TEXT, mirrorPending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_role_exchange_time ON role_exchange_sessions(startedAt DESC, sessionId DESC);
CREATE TABLE IF NOT EXISTS role_exchange_turns (
  sessionId TEXT NOT NULL REFERENCES role_exchange_sessions(sessionId), turnIndex INTEGER NOT NULL,
  exchangeId TEXT NOT NULL UNIQUE, speakerRoleId TEXT NOT NULL, speakerName TEXT NOT NULL,
  content TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY(sessionId, turnIndex)
);
`;

// 保留证据主键及其所有外键引用，只替换带来源枚举约束的一列。
const BUSINESS_V29_SQL = `DROP INDEX idx_evidence_source;
    ALTER TABLE evidence_records RENAME COLUMN source_kind TO previous_kind;
    ALTER TABLE evidence_records ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'message'
      CHECK(source_kind IN ('message','tool_result','role_exchange'));
    UPDATE evidence_records SET source_kind = previous_kind;
    ALTER TABLE evidence_records DROP COLUMN previous_kind;
    CREATE UNIQUE INDEX idx_evidence_source ON evidence_records(role_id, source_kind, source_id);
    ${EXCHANGE_SOURCE_SQL}`;

const BUSINESS_V30_SQL = `
CREATE TABLE IF NOT EXISTS engineering_jobs (
  job_id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(role_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id), window_id TEXT NOT NULL REFERENCES windows(window_id),
  origin TEXT NOT NULL CHECK(origin IN ('user','autonomous')), ext_id TEXT NOT NULL,
  title TEXT NOT NULL, work_dir TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','timed_out','interrupted_unknown')),
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS engineering_jobs_task ON engineering_jobs(task_id, status);
CREATE TABLE IF NOT EXISTS engineering_wakes (
  wake_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES engineering_jobs(job_id),
  execution_id TEXT REFERENCES executions(execution_id)
);`;

const BUSINESS_V31_SQL = `
ALTER TABLE engineering_jobs ADD COLUMN model_resource_id TEXT;
ALTER TABLE engineering_jobs ADD COLUMN model_name TEXT;
`;

/**
 * V32：可选混合记忆检索的向量缓存（409 ARCH-03 / DL-51 方案 A）。
 * 本表是与 memory_search_fts 同类的本机派生缓存：不进入角色迁移数据，
 * 目标机按需重建；文档删除时向量随外键级联清理。
 */
const BUSINESS_V32_SQL = `
CREATE TABLE IF NOT EXISTS memory_search_embeddings (
  document_id INTEGER PRIMARY KEY REFERENCES memory_search_documents(document_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  model_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_search_embeddings_role_model
  ON memory_search_embeddings(role_id, model_key);
`;

/**
 * V33：主对话窗口级滚动摘要与 30+n 历史周期边界状态（410 R2-14 / DL-202）。
 * 按 window_id 独立维护，与跨窗口长期记忆整理职责解耦；属于本机可重建派生状态，
 * 不纳入角色迁移包必填表，窗口删除时随外键级联清理。
 */
const BUSINESS_V33_SQL = `
CREATE TABLE IF NOT EXISTS window_context_states (
  window_id TEXT PRIMARY KEY REFERENCES windows(window_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  summary_version INTEGER NOT NULL DEFAULT 0 CHECK (summary_version >= 0),
  summary_text TEXT NOT NULL DEFAULT '',
  covered_until_sequence INTEGER NOT NULL DEFAULT 0 CHECK (covered_until_sequence >= 0),
  history_left_sequence INTEGER NOT NULL DEFAULT 0 CHECK (history_left_sequence >= 0),
  cycle_start_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cycle_start_sequence >= 0),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_window_context_states_role
  ON window_context_states(role_id);
`;

export function openBusinessDatabase(
  dbPath: string,
  options: DatabaseOpenOptions = {},
): OpenedDatabase {
  return openVersionedDatabase(
    dbPath,
    BUSINESS_SCHEMA_VERSION,
    BUSINESS_SCHEMA_V22_SQL + BUSINESS_V23_SQL + BUSINESS_V24_SQL + BUSINESS_V26_SQL + BUSINESS_V27_SQL + BUSINESS_V28_SQL + BUSINESS_V29_SQL + BUSINESS_V30_SQL + BUSINESS_V31_SQL + BUSINESS_V32_SQL + BUSINESS_V33_SQL,
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
      16: (db) => db.exec(BUSINESS_V17_SQL),
      17: (db) => db.exec(BUSINESS_V18_SQL),
      18: (db) => db.exec(BUSINESS_V19_SQL),
      19: (db) => db.exec(BUSINESS_V20_SQL),
      20: migrateBusinessV21,
      21: migrateBusinessV22,
      22: (db) => {
        db.exec(BUSINESS_V23_SQL);
        retireLegacyWebPrefetchEvidence(db);
      },
      23: (db) => db.exec(BUSINESS_V24_SQL),
      24: (db) => {
        assertFtsIndex(db);
        db.exec(`ALTER TABLE memory_revisions RENAME TO memory_revisions_v24;
          ${MEMORY_REVISIONS_SQL}
          INSERT INTO memory_revisions SELECT * FROM memory_revisions_v24;
          DROP TABLE memory_revisions_v24;`);
        if (!(db.pragma("table_info(memory_search_documents)") as Array<{ name: string }>).some(column => column.name === "related_text")) {
          db.exec("ALTER TABLE memory_search_documents ADD COLUMN related_text TEXT NOT NULL DEFAULT ''");
        }
        const memory = new MemoryStore(db);
        memory.rebuildEventSearch();
        memory.rebuildSummarySearch();
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autonomy_activities'").get()) {
          restoreAutonomyShareLinks(db);
        }
      },
      25: (db) => db.exec(BUSINESS_V26_SQL),
      26: (db) => db.exec(BUSINESS_V27_SQL),
      27: (db) => db.exec(BUSINESS_V28_SQL),
      28: (db) => db.exec(BUSINESS_V29_SQL),
      29: (db) => db.exec(BUSINESS_V30_SQL),
      30: (db) => {
        addColumnIfMissing(db, "engineering_jobs", "model_resource_id", "TEXT");
        addColumnIfMissing(db, "engineering_jobs", "model_name", "TEXT");
      },
      31: (db) => db.exec(BUSINESS_V32_SQL),
      32: (db) => db.exec(BUSINESS_V33_SQL),
    },
    BUSINESS_TABLES,
    BUSINESS_INDEXES,
    BUSINESS_COLUMNS,
    options,
  );
}
