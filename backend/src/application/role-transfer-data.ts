import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type TransferCell = string | number | null;
export type TransferRow = Record<string, TransferCell>;
export type TransferTables = Record<TransferTable, TransferRow[]>;

// 包 v1 的业务投影固定列名。授权、目标配置快照与派生搜索索引由目标重建。
const PROJECTION = {
  roles: "role_id display_name definition_text definition_payload_json definition_revision state_json state_version created_at updated_at builtin_key bio_text first_activation_pending",
  windows: "window_id role_id kind source created_at updated_at",
  messages: "message_id window_id sender content source_platform status sequence submission_id submission_hash created_at updated_at execution_id claimed_by_execution_id processed_by_execution_id",
  tasks: "task_id role_id goal status end_reason created_at updated_at origin initiator_execution_id continuable wait_reason consecutive_failures consecutive_no_progress",
  executions: "execution_id role_id window_id trigger_type trigger_message_id status state_version_loaded state_version_committed created_at updated_at decision_round superseded_by_execution_id task_decision_json",
  execution_tasks: "execution_id task_id relation created_at",
  tool_calls: "tool_call_id task_id execution_id step_key tool_name args_json status created_at started_at finished_at",
  tool_call_mode_events: "event_id tool_call_id mode changed_at",
  tool_results: "tool_call_id status raw_response_json adapted_result_json diagnostic_code error_json saved_at previous_status previous_diagnostic_code previous_raw_response_json previous_adapted_result_json previous_error_json reconciled_at reconciled_by_call_id",
  memory_batches: "batch_id role_id status input_from_sequence input_to_sequence context_budget_chars output_reserve_chars attempt_count last_error_code started_at finished_at created_at",
  memory_triggers: "trigger_id role_id kind window_id task_id consumed_at batch_id created_at",
  evidence_records: "evidence_id role_id source_kind source_id window_id task_id execution_id source_status occurred_at local_date role_sequence created_at",
  evidence_processing: "evidence_id status last_batch_id attempt_count next_retry_at deferred_after_sequence last_error_code updated_at",
  memory_evidence_segments: "evidence_id segment_index from_char to_char status batch_id updated_at",
  daily_summaries: "summary_id role_id experience_date topic summary version created_at updated_at",
  daily_summary_sources: "summary_source_id summary_id window_id from_sequence to_sequence occurred_from occurred_to",
  memory_events: "event_id role_id title summary subjective_experience occurred_at_start occurred_at_end experience_date lifecycle_status refined_summary_id version last_supplemented_round created_at updated_at",
  memory_event_tags: "event_id dimension value normalized_value",
  memory_event_sources: "event_id evidence_id linked_at",
  diaries: "diary_id role_id relative_path content content_hash occurred_at experience_date created_at updated_at",
  diary_events: "diary_id event_id linked_at",
  memory_revisions: "revision_id role_id target_type target_id revision_number base_revision change_source content_json evidence_ids_json created_at",
  retrieval_queries: "retrieval_id role_id execution_id mode query_json status error_code created_at",
  retrieval_results: "retrieval_id rank record_type record_id delivered",
  memory_recalls: "recall_id role_id execution_id record_type record_id recalled_at",
  execution_stream_events: "stream_event_id role_id window_id execution_id event_type payload_json created_at",
  model_calls: "model_call_id role_id execution_id batch_id purpose resource_id model_name protocol status error_code started_at finished_at usage_json raw_response_json task_id call_kind",
  web_reading_deliveries: "role_id url page_version start_offset end_offset original_text tool_call_id model_call_id window_id task_id execution_id accepted_at",
  call_metering: "metering_id role_id execution_id task_id batch_id call_kind call_id purpose counted created_at",
  autonomy_budget: "role_id local_date used_points daily_limit unlimited updated_at",
  autonomy_wakes: "wake_id role_id kind scheduled_at intent status source_execution_id task_id activity_id claimed_at completed_at last_error_code created_at updated_at",
  autonomy_activities: "activity_id role_id wake_id task_id execution_id window_id status summary shared_message_id started_at finished_at created_at updated_at",
  autonomy_tool_reservations: "tool_call_id role_id local_date counted status created_at updated_at",
  task_notes: "note_id task_id role_id note created_at",
  outfits: "outfit_id role_id name description created_at updated_at deleted_at is_preset preset_key",
  outfit_assets: "asset_id outfit_id role_id usage file_name display_name media_type relative_path created_at deleted_at is_preset",
  message_segments: "segment_id message_id window_id ordinal kind text start_offset end_offset outfit_id sprite_asset_id annotated_at created_at home_asset_id voice_emotion",
  voice_assets: "asset_id role_id file_name media_type relative_path created_at",
  role_voice_settings: "role_id reference_asset_id language speed emo_alpha created_at updated_at voice_source reference_mode reference_text preset_voice_id reference_mode_confirmed enabled tts_engine",
  scene_image_tasks: "task_id role_id window_id message_id execution_id trigger_source layer_mode start_segment_id end_segment_id status idempotency_key attempt_no plan_json error_code error_summary created_at updated_at",
  scene_image_assets: "asset_id task_id role_id window_id message_id media_type relative_path width height byte_size created_at",
  role_scene_image_settings: "role_id model_type base_prompt negative_prompt outfit_prompts_json width height steps cfg sampler scheduler seed updated_at",
} as const;

export type TransferTable = keyof typeof PROJECTION;
export const TRANSFER_TABLES = Object.keys(PROJECTION) as TransferTable[];
export function transferColumns(table: TransferTable): string[] {
  return PROJECTION[table].split(" ");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sortedRows(rows: TransferRow[]): TransferRow[] {
  return rows.map((row) => ({ row, key: canonicalJson(row) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(({ row }) => row);
}

const INTERRUPTED = "ROLE_TRANSFER_INTERRUPTED";
export const TRANSFER_INTERRUPTED_MESSAGE = "transfer_interrupted";

export function normalizeExecutionFacts(tables: TransferTables): void {
  for (const row of tables.tasks) {
    if (row.status === "active" || (row.status === "paused" && row.end_reason === "ROLE_STOPPED")) {
      row.status = "paused";
      row.end_reason = INTERRUPTED;
      row.wait_reason = INTERRUPTED;
      row.continuable = 0;
    }
  }
  for (const row of tables.executions) {
    if (row.status === "running") row.status = "failed";
  }
  for (const row of tables.messages) {
    if (row.sender === "user" && row.processed_by_execution_id === null) {
      row.status = TRANSFER_INTERRUPTED_MESSAGE;
      row.claimed_by_execution_id = null;
    }
    if (row.sender === "assistant" && row.status === "generating") row.status = "interrupted";
  }
  for (const row of tables.tool_calls) {
    if (row.status === "pending" || row.status === "running") row.status = "unknown";
  }
  for (const row of tables.model_calls) {
    if (row.status === "running") {
      row.status = "unknown";
      row.error_code = INTERRUPTED;
    }
  }
  for (const row of tables.autonomy_wakes) {
    if (row.status === "claimed" || (row.status === "pending" && row.kind === "budget_resume")) {
      row.status = "cancelled";
      row.last_error_code = INTERRUPTED;
    }
    if (row.status === "pending") row.task_id = null;
  }
  for (const row of tables.autonomy_activities) {
    if (row.status === "running") row.status = "paused";
  }
  for (const row of tables.autonomy_tool_reservations) {
    if (row.status === "reserved") row.status = "released";
  }
  for (const row of tables.scene_image_tasks) {
    if (row.status === "queued" || row.status === "planning" || row.status === "generating") {
      row.status = "failed";
      row.error_code = INTERRUPTED;
    }
  }
  // 保留已消费的首次资格和已有唤醒事实。普通安排不用图检查点即可重新进入调度。
  for (const row of tables.memory_batches) {
    if (row.status === "running") {
      row.status = "failed";
      row.last_error_code = INTERRUPTED;
    }
  }
  for (const row of tables.evidence_processing) {
    if (row.status === "processing") row.status = "pending";
  }
}

export function rebuildTransferMemorySearch(db: Database.Database): void {
  db.exec(`INSERT INTO memory_search_documents
      (role_id, record_type, record_id, title, body, updated_at)
    SELECT role_id, 'event', event_id, title,
           CASE WHEN subjective_experience = '' THEN summary
                WHEN summary = '' THEN subjective_experience
                ELSE summary || char(10) || subjective_experience END, updated_at
      FROM memory_events
    UNION ALL
    SELECT role_id, 'daily_summary', summary_id,
           CASE WHEN topic = '' THEN experience_date ELSE topic END, summary, updated_at
      FROM daily_summaries`);
  const insert = db.prepare(`INSERT INTO memory_search_documents
    (role_id, record_type, record_id, title, body, updated_at) VALUES (?, 'diary', ?, ?, ?, ?)`);
  for (const row of db.prepare("SELECT * FROM diaries").iterate() as Iterable<TransferRow>) {
    const content = String(row.content);
    const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    insert.run(row.role_id, row.diary_id, (firstLine ?? String(row.experience_date)).slice(0, 120), content, row.updated_at);
  }
}
