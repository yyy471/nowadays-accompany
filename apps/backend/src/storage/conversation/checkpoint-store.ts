import type Database from "better-sqlite3";
import type { AgentExecutionState } from "../../domain/conversation.js";
import { openExecutionDatabase } from "../core/schema.js";

export type ExecutionNode = "model" | "tools" | "closing" | "done";

export class CheckpointStore {
  readonly db: Database.Database;
  readonly path: string;
  readonly schemaVersion: number;

  constructor(dbPath: string, options: { create?: boolean } = {}) {
    const opened = openExecutionDatabase(dbPath, options);
    this.db = opened.db;
    this.path = opened.path;
    this.schemaVersion = opened.schemaVersion;
  }

  saveCheckpoint(step: number, nextNode: ExecutionNode, state: AgentExecutionState, createdAt: string): void {
    this.db.prepare(`INSERT INTO execution_checkpoints (execution_id, step, next_node, state_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(state.executionId, step, nextNode, JSON.stringify(state), createdAt);
  }

  loadLatestCheckpoint(executionId: string) {
    const row = this.db.prepare(`SELECT step, next_node, state_json FROM execution_checkpoints
      WHERE execution_id = ? ORDER BY step DESC LIMIT 1`).get(executionId) as
      { step: number; next_node: ExecutionNode; state_json: string } | undefined;
    if (!row) return null;
    return { step: row.step, nextNode: row.next_node, state: JSON.parse(row.state_json) as AgentExecutionState };
  }

  hasCompletedCheckpoint(executionId: string): boolean {
    return this.db.prepare("SELECT 1 FROM execution_checkpoints WHERE execution_id = ? LIMIT 1")
      .get(executionId) !== undefined;
  }

  countCheckpoints(executionId: string): number {
    return this.db.prepare("SELECT COUNT(*) FROM execution_checkpoints WHERE execution_id = ?")
      .pluck().get(executionId) as number;
  }

  close(): void {
    this.db.close();
  }
}
