import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  SceneImageAssetRecord,
  SceneImageLayerMode,
  SceneImagePlanRecord,
  SceneImageResultRecord,
  SceneImageStatus,
  SceneImageTaskRecord,
  SceneImageTrigger,
} from "../domain/scene-image.js";
import { ConversationStore } from "./conversation-store.js";

interface TaskRow {
  task_id: string;
  role_id: string;
  window_id: string;
  message_id: string;
  execution_id: string;
  trigger_source: SceneImageTrigger;
  layer_mode: SceneImageLayerMode;
  start_segment_id: string;
  end_segment_id: string;
  status: SceneImageStatus;
  idempotency_key: string | null;
  attempt_no: number;
  plan_json: string | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
  result_asset_id: string | null;
  result_media_type: string | null;
  result_width: number | null;
  result_height: number | null;
  result_byte_size: number | null;
  result_created_at: string | null;
}

interface AnchorRow {
  message_id: string;
  window_id: string;
  sender: "user" | "assistant";
  status: string;
  content: string;
  sequence: number;
  execution_id: string | null;
}

interface AssetRow {
  asset_id: string;
  task_id: string;
  role_id: string;
  window_id: string;
  message_id: string;
  media_type: string;
  relative_path: string;
  width: number;
  height: number;
  byte_size: number;
  created_at: string;
}

export interface SceneImageAnchor {
  messageId: string;
  windowId: string;
  sender: "user" | "assistant";
  status: string;
  content: string;
  sequence: number;
  executionId: string | null;
}

/** 目标回复使用的服饰；描述用于提示词，参考图另行按需读取。 */
export interface SceneImageOutfitContext {
  outfitId: string;
  name: string;
  description: string | null;
}

/** 服饰参考图的受管引用，路径只在后端使用。 */
export interface SceneImageCharacterReference {
  assetId: string;
  relativePath: string;
  mediaType: string;
}

export interface NewSceneImageTaskInput {
  roleId: string;
  windowId: string;
  messageId: string;
  executionId: string;
  trigger: SceneImageTrigger;
  layerMode: SceneImageLayerMode;
  startSegmentId: string;
  endSegmentId: string;
  idempotencyKey: string | null;
  attempt?: number;
  now: string;
}

export interface NewSceneImageAssetInput {
  assetId?: string;
  mediaType: string;
  relativePath: string;
  width: number;
  height: number;
  byteSize: number;
  createdAt: string;
}

const TASK_SELECT = `
  SELECT t.*, a.asset_id AS result_asset_id, a.media_type AS result_media_type,
         a.width AS result_width, a.height AS result_height,
         a.byte_size AS result_byte_size, a.created_at AS result_created_at
    FROM scene_image_tasks t
    LEFT JOIN scene_image_assets a ON a.task_id = t.task_id`;

export class SceneImageStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleId: string,
  ) {}

  getAnchor(windowId: string, messageId: string): SceneImageAnchor | null {
    const row = this.db
      .prepare(
        `SELECT m.message_id, m.window_id, m.sender, m.status, m.content, m.sequence, m.execution_id
           FROM messages m JOIN windows w ON w.window_id = m.window_id
          WHERE m.message_id = ? AND m.window_id = ? AND w.role_id = ?`,
      )
      .get(messageId, windowId, this.roleId) as AnchorRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      messageId: row.message_id,
      windowId: row.window_id,
      sender: row.sender,
      status: row.status,
      content: row.content,
      sequence: row.sequence,
      executionId: row.execution_id,
    };
  }

  /**
   * 目标轮实际保存的服饰。只认句段记录的 outfitId，不回退角色当前服饰，
   * 避免后来换装被回填进旧场景；没有记录时按未知服饰处理。
   */
  outfitForMessage(
    windowId: string,
    messageId: string,
  ): SceneImageOutfitContext | null {
    const row = this.db
      .prepare(
        `SELECT o.outfit_id, o.name, o.description FROM message_segments s
           JOIN outfits o ON o.outfit_id = s.outfit_id
          WHERE s.message_id = ? AND s.window_id = ? AND s.outfit_id IS NOT NULL
          ORDER BY s.ordinal ASC LIMIT 1`,
      )
      .get(messageId, windowId) as
      | { outfit_id: string; name: string; description: string | null }
      | undefined;
    return row === undefined
      ? null
      : {
          outfitId: row.outfit_id,
          name: row.name,
          description: row.description,
        };
  }

  /** 服饰的主参考图（home）；没有登记时返回 null，由调用方降级为无参考图。 */
  characterReferenceForOutfit(
    outfitId: string,
  ): SceneImageCharacterReference | null {
    const row = this.db
      .prepare(
        `SELECT asset_id, relative_path, media_type FROM outfit_assets
          WHERE outfit_id = ? AND role_id = ? AND usage = 'home'
          ORDER BY created_at ASC LIMIT 1`,
      )
      .get(outfitId, this.roleId) as
      | { asset_id: string; relative_path: string; media_type: string }
      | undefined;
    return row === undefined
      ? null
      : {
          assetId: row.asset_id,
          relativePath: row.relative_path,
          mediaType: row.media_type,
        };
  }

  /** 目标轮之前的若干条消息，按时间升序返回，用于规划时的上下文。 */
  listContextMessages(
    windowId: string,
    sequence: number,
    limit: number,
  ): Array<{ sender: "user" | "assistant"; content: string }> {
    if (limit <= 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT sender, content FROM messages
          WHERE window_id = ? AND sequence < ? AND status <> 'generating'
          ORDER BY sequence DESC LIMIT ?`,
      )
      .all(windowId, sequence, limit) as Array<{
      sender: "user" | "assistant";
      content: string;
    }>;
    return rows.reverse();
  }

  createTask(input: NewSceneImageTaskInput): {
    task: SceneImageTaskRecord;
    duplicate: boolean;
  } {
    const taskId = randomUUID();
    try {
      return this.db.transaction(() => {
        const existing = this.findDuplicate(input, input.attempt ?? 1);
        if (existing !== null) {
          return { task: existing, duplicate: true };
        }
        const attempt =
          input.attempt ?? this.nextAttempt(input.messageId, input.trigger);
        this.db
          .prepare(
            `INSERT INTO scene_image_tasks
               (task_id, role_id, window_id, message_id, execution_id,
                trigger_source, layer_mode, start_segment_id, end_segment_id,
                status, idempotency_key, attempt_no, plan_json, error_code,
                error_summary, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL,
                     NULL, ?, ?)`,
          )
          .run(
            taskId,
            this.roleId,
            input.windowId,
            input.messageId,
            input.executionId,
            input.trigger,
            input.layerMode,
            input.startSegmentId,
            input.endSegmentId,
            input.idempotencyKey,
            attempt,
            input.now,
            input.now,
          );
        const task = this.requireTask(input.windowId, taskId);
        this.emit(task, input.now);
        return { task, duplicate: false };
      })();
    } catch (error) {
      if (!isUniqueConstraint(error)) {
        throw error;
      }
      // 多进程并发时由唯一索引兜底：命中同一逻辑请求就复用已建任务。
      const existing = this.findDuplicate(input, input.attempt ?? 1);
      if (existing === null) {
        throw error;
      }
      return { task: existing, duplicate: true };
    }
  }

  /** 显式重试按同消息同来源递增，失败与重试可区分。 */
  private nextAttempt(messageId: string, trigger: SceneImageTrigger): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM scene_image_tasks
          WHERE message_id = ? AND trigger_source = ?`,
      )
      .get(messageId, trigger) as { next: number };
    return row.next;
  }

  getTask(windowId: string, taskId: string): SceneImageTaskRecord | null {
    const row = this.db
      .prepare(
        `${TASK_SELECT}
          WHERE t.task_id = ? AND t.window_id = ? AND t.role_id = ?`,
      )
      .get(taskId, windowId, this.roleId) as TaskRow | undefined;
    return row === undefined ? null : mapTask(row);
  }

  getAsset(assetId: string): SceneImageAssetRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM scene_image_assets WHERE asset_id = ? AND role_id = ?",
      )
      .get(assetId, this.roleId) as AssetRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      assetId: row.asset_id,
      taskId: row.task_id,
      roleId: row.role_id,
      windowId: row.window_id,
      messageId: row.message_id,
      mediaType: row.media_type,
      relativePath: row.relative_path,
      width: row.width,
      height: row.height,
      byteSize: row.byte_size,
      createdAt: row.created_at,
    };
  }

  listForMessages(
    windowId: string,
    messageIds: readonly string[],
  ): SceneImageTaskRecord[] {
    if (messageIds.length === 0) {
      return [];
    }
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `${TASK_SELECT}
          WHERE t.window_id = ? AND t.role_id = ?
            AND t.message_id IN (${placeholders})
          ORDER BY t.created_at ASC, t.rowid ASC`,
      )
      .all(windowId, this.roleId, ...messageIds) as TaskRow[];
    return rows.map(mapTask);
  }

  listUnfinished(): SceneImageTaskRecord[] {
    const rows = this.db
      .prepare(
        `${TASK_SELECT}
          WHERE t.role_id = ?
            AND t.status IN ('queued', 'planning', 'generating')
          ORDER BY t.created_at ASC, t.rowid ASC`,
      )
      .all(this.roleId) as TaskRow[];
    return rows.map(mapTask);
  }

  markPlanning(taskId: string, now: string): SceneImageTaskRecord | null {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE scene_image_tasks
              SET status = 'planning', updated_at = ?
            WHERE task_id = ? AND role_id = ? AND status = 'queued'`,
        )
        .run(now, taskId, this.roleId);
      if (result.changes === 0) {
        return null;
      }
      const task = this.requireTaskByTaskId(taskId);
      this.emit(task, now);
      return task;
    })();
  }

  markGenerating(
    taskId: string,
    plan: SceneImagePlanRecord,
    now: string,
  ): SceneImageTaskRecord | null {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE scene_image_tasks
              SET status = 'generating', plan_json = ?, start_segment_id = ?,
                  end_segment_id = ?, updated_at = ?
            WHERE task_id = ? AND role_id = ? AND status = 'planning'`,
        )
        .run(
          JSON.stringify(plan),
          plan.startSegmentId,
          plan.endSegmentId,
          now,
          taskId,
          this.roleId,
        );
      if (result.changes === 0) {
        return null;
      }
      const task = this.requireTaskByTaskId(taskId);
      this.emit(task, now);
      return task;
    })();
  }

  completeTask(
    taskId: string,
    asset: NewSceneImageAssetInput,
    now: string,
  ): SceneImageTaskRecord {
    return this.db.transaction(() => {
      const task = this.requireTaskByTaskId(taskId);
      if (task.status !== "generating") {
        throw new Error(`SCENE_IMAGE_TASK_STATE_INVALID:${task.status}`);
      }
      this.db
        .prepare(
          `INSERT INTO scene_image_assets
             (asset_id, task_id, role_id, window_id, message_id, media_type,
              relative_path, width, height, byte_size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.assetId ?? randomUUID(),
          taskId,
          this.roleId,
          task.windowId,
          task.messageId,
          asset.mediaType,
          asset.relativePath,
          asset.width,
          asset.height,
          asset.byteSize,
          asset.createdAt,
        );
      this.db
        .prepare(
          `UPDATE scene_image_tasks
              SET status = 'succeeded', error_code = NULL, error_summary = NULL,
                  updated_at = ?
            WHERE task_id = ? AND role_id = ?`,
        )
        .run(now, taskId, this.roleId);
      const saved = this.requireTaskByTaskId(taskId);
      this.emit(saved, now);
      return saved;
    })();
  }

  failTask(
    taskId: string,
    errorCode: string,
    errorSummary: string,
    now: string,
  ): SceneImageTaskRecord | null {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE scene_image_tasks
              SET status = 'failed', error_code = ?, error_summary = ?,
                  updated_at = ?
            WHERE task_id = ? AND role_id = ?
              AND status IN ('queued', 'planning', 'generating')`,
        )
        .run(errorCode, errorSummary, now, taskId, this.roleId);
      if (result.changes === 0) {
        return null;
      }
      const task = this.requireTaskByTaskId(taskId);
      this.emit(task, now);
      return task;
    })();
  }

  /** 任务状态更新写入窗口流事件，重连按游标补齐。 */
  private emit(task: SceneImageTaskRecord, now: string): void {
    new ConversationStore(this.db, this.roleId).appendStreamEvent({
      windowId: task.windowId,
      executionId: task.executionId,
      type: "scene_image_task",
      payload: {
        taskId: task.taskId,
        messageId: task.messageId,
        trigger: task.trigger,
        layerMode: task.layerMode,
        status: task.status,
        startSegmentId: task.startSegmentId,
        endSegmentId: task.endSegmentId,
        attempt: task.attempt,
        plan: task.plan,
        result: task.result,
        errorCode: task.errorCode,
        errorSummary: task.errorSummary,
      },
      now,
    });
  }

  private findDuplicate(
    input: NewSceneImageTaskInput,
    attempt: number,
  ): SceneImageTaskRecord | null {
    const row =
      input.trigger === "manual"
        ? (this.db
            .prepare(
              `${TASK_SELECT}
                WHERE t.role_id = ? AND t.window_id = ? AND t.message_id = ?
                  AND t.trigger_source = 'manual' AND t.idempotency_key = ?`,
            )
            .get(
              this.roleId,
              input.windowId,
              input.messageId,
              input.idempotencyKey,
            ) as TaskRow | undefined)
        : (this.db
            .prepare(
              `${TASK_SELECT}
                WHERE t.role_id = ? AND t.message_id = ?
                  AND t.trigger_source = 'auto' AND t.attempt_no = ?`,
            )
            .get(this.roleId, input.messageId, attempt) as TaskRow | undefined);
    return row === undefined ? null : mapTask(row);
  }

  private requireTask(windowId: string, taskId: string): SceneImageTaskRecord {
    const task = this.getTask(windowId, taskId);
    if (task === null) {
      throw new Error(`SCENE_IMAGE_TASK_MISSING:${taskId}`);
    }
    return task;
  }

  private requireTaskByTaskId(taskId: string): SceneImageTaskRecord {
    const row = this.db
      .prepare(`${TASK_SELECT} WHERE t.task_id = ? AND t.role_id = ?`)
      .get(taskId, this.roleId) as TaskRow | undefined;
    if (row === undefined) {
      throw new Error(`SCENE_IMAGE_TASK_MISSING:${taskId}`);
    }
    return mapTask(row);
  }
}

function mapTask(row: TaskRow): SceneImageTaskRecord {
  return {
    taskId: row.task_id,
    roleId: row.role_id,
    windowId: row.window_id,
    messageId: row.message_id,
    executionId: row.execution_id,
    trigger: row.trigger_source,
    layerMode: row.layer_mode,
    startSegmentId: row.start_segment_id,
    endSegmentId: row.end_segment_id,
    status: row.status,
    attempt: row.attempt_no,
    plan: parsePlan(row.plan_json),
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    result: mapResult(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResult(row: TaskRow): SceneImageResultRecord | null {
  if (
    row.result_asset_id === null ||
    row.result_media_type === null ||
    row.result_width === null ||
    row.result_height === null ||
    row.result_byte_size === null ||
    row.result_created_at === null
  ) {
    return null;
  }
  return {
    assetId: row.result_asset_id,
    mediaType: row.result_media_type,
    width: row.result_width,
    height: row.result_height,
    byteSize: row.result_byte_size,
    createdAt: row.result_created_at,
  };
}

function parsePlan(raw: string | null): SceneImagePlanRecord | null {
  if (raw === null) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.description === "string" &&
      (value.layerMode === "background" || value.layerMode === "full_scene") &&
      typeof value.startSegmentId === "string" &&
      typeof value.endSegmentId === "string"
    ) {
      return {
        description: value.description,
        layerMode: value.layerMode,
        startSegmentId: value.startSegmentId,
        endSegmentId: value.endSegmentId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("UNIQUE constraint failed");
}
