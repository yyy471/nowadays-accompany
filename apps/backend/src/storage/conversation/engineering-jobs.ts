import type Database from "better-sqlite3";
import type { TaskStatus } from "../role/role-store.js";

export const engineeringWait = "AWAITING_ENGINEERING_JOB";
export type EngineeringTerminal = "completed" | "failed" | "cancelled" | "timed_out" | "interrupted_unknown";
export interface EngineeringJob {
  jobId: string; roleId: string; taskId: string; windowId: string; origin: "user" | "autonomous";
  extId: string; title: string; workDir: string; startedAt: string; finishedAt: string | null;
  status: "running" | EngineeringTerminal; summary: string;
  modelResourceId: string | null; modelName: string | null;
}
const projection = `job_id AS jobId, role_id AS roleId, task_id AS taskId, window_id AS windowId,
  origin, ext_id AS extId, title, work_dir AS workDir, started_at AS startedAt, finished_at AS finishedAt, status, summary,
  model_resource_id AS modelResourceId, model_name AS modelName`;

// 本机派发总会登记工作目录；角色包从不携带该目录，导入后的空值只代表历史记录。
const localAssignment = "j.work_dir <> ''";

export class EngineeringJobs {
  constructor(private db: Database.Database) {}
  register(job: Omit<EngineeringJob, "status" | "finishedAt" | "summary">) {
    this.db.prepare(`INSERT INTO engineering_jobs(job_id,role_id,task_id,window_id,origin,ext_id,title,work_dir,started_at,status,model_resource_id,model_name)
      VALUES (@jobId,@roleId,@taskId,@windowId,@origin,@extId,@title,@workDir,@startedAt,'running',@modelResourceId,@modelName)`).run(job);
  }

  chainModels(taskId: string) {
    return this.db.prepare(`SELECT j.model_resource_id AS resourceId, j.model_name AS modelName
      FROM engineering_jobs j JOIN tasks t USING(task_id)
      WHERE j.task_id=? AND ${localAssignment} AND t.status IN ('active','paused') AND j.model_resource_id IS NOT NULL AND j.model_name IS NOT NULL
      GROUP BY j.model_resource_id, j.model_name ORDER BY MIN(j.rowid)`).all(taskId) as Array<{ resourceId: string; modelName: string }>;
  }

  modelReferences(resourceId: string) {
    return this.db.prepare(`SELECT DISTINCT j.task_id AS taskId, t.status AS taskStatus
      FROM engineering_jobs j JOIN tasks t USING(task_id) WHERE j.model_resource_id=? AND ${localAssignment}
      AND (t.status IN ('active','paused') OR j.status='running') ORDER BY j.task_id`)
      .all(resourceId) as Array<{ taskId: string; taskStatus: TaskStatus }>;
  }
  find(id: string) {
    return this.db.prepare("SELECT " + projection + " FROM engineering_jobs WHERE job_id=?").get(id) as EngineeringJob | undefined;
  }
  listRunning() {
    return this.db.prepare("SELECT " + projection + " FROM engineering_jobs WHERE status='running' ORDER BY started_at, job_id").all() as EngineeringJob[];
  }
  settle(id: string, state: EngineeringTerminal, summary: string, finishedAt: string) {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE engineering_jobs SET status=?, summary=?, finished_at=?
        WHERE job_id=? AND status='running'`).run(state, summary.slice(0, 1200), finishedAt, id).changes;
      if (changed) this.db.prepare("INSERT INTO engineering_wakes(wake_id,job_id) VALUES (?,?)").run("pi:" + id, id);
      return changed > 0;
    })();
  }
  awaiting(taskId: string) {
    return !!this.db.prepare(`SELECT 1 FROM engineering_jobs j LEFT JOIN engineering_wakes w USING(job_id)
      WHERE task_id=? AND (j.status='running' OR (w.wake_id IS NOT NULL AND w.execution_id IS NULL)) LIMIT 1`).get(taskId);
  }
  nextDelivery() {
    return this.db.prepare(`SELECT j.task_id AS taskId, j.window_id AS windowId
      FROM engineering_wakes w JOIN engineering_jobs j USING(job_id) JOIN tasks t ON t.task_id=j.task_id
      WHERE w.execution_id IS NULL AND t.status='paused' AND t.wait_reason=?
      ORDER BY j.finished_at, w.rowid LIMIT 1`).get(engineeringWait) as { taskId: string; windowId: string } | undefined;
  }
  claim(taskId: string, executionId: string) {
    return this.db.prepare(`UPDATE engineering_wakes SET execution_id=? WHERE execution_id IS NULL
      AND job_id IN (SELECT job_id FROM engineering_jobs WHERE task_id=?)`).run(executionId, taskId).changes;
  }
  receipts(taskId: string, executionId: string) {
    return this.db.prepare(`SELECT job_id AS jobId, ext_id AS extId, title, j.status, summary
      FROM engineering_jobs j JOIN engineering_wakes w USING(job_id) JOIN executions e ON e.execution_id=w.execution_id
      WHERE j.task_id=? AND (w.execution_id=? OR e.status IN ('paused','superseded','failed'))
      ORDER BY finished_at, job_id`).all(taskId, executionId);
  }
}
