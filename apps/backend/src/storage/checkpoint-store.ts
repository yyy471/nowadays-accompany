import type Database from "better-sqlite3";
import { openExecutionDatabase } from "./schema.js";

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

  close(): void {
    this.db.close();
  }
}
