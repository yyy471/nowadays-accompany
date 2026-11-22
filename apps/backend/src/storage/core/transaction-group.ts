import type Database from "better-sqlite3";

/**
 * 在多个 SQLite 连接上执行一组写入，并让「决策库」先于其余连接提交（RP-R05）。
 *
 * 角色业务库独立成库，SQLite 不支持跨库事务。调用方把资源删除与待清理记录
 * 放在决策库（app 库）的同一事务里，其余连接只做可以重做、读侧可过滤的清理：
 *
 * - 任一语句失败：回滚全部连接，原配置完整保留。
 * - 决策库提交失败：回滚全部连接，原配置完整保留。
 * - 决策库提交成功后再逐个提交其余连接。后续提交失败时删除已被接受，
 *   由调用方保留待清理记录，交由读侧过滤、启动恢复或重试继续清理。
 */
export function runWithDecisionCommit(
  decision: Database.Database,
  followers: readonly Database.Database[],
  action: () => void,
): { followersCommitted: boolean } {
  const databases = [...followers, decision];
  const open: Database.Database[] = [];
  try {
    for (const db of databases) {
      db.exec("BEGIN IMMEDIATE");
      open.push(db);
    }
    action();
    decision.exec("COMMIT");
    drop(open, decision);
  } catch (error) {
    rollbackAll(open);
    throw error;
  }

  const failed: Database.Database[] = [];
  for (const db of followers) {
    try {
      db.exec("COMMIT");
    } catch {
      failed.push(db);
    }
  }
  // 提交失败的连接仍留有未提交事务，回滚后保留库中原样。
  rollbackAll(failed);
  return { followersCommitted: failed.length === 0 };
}

function drop(
  databases: Database.Database[],
  target: Database.Database,
): void {
  const index = databases.indexOf(target);
  if (index >= 0) databases.splice(index, 1);
}

function rollbackAll(databases: readonly Database.Database[]): void {
  for (const db of [...databases].reverse()) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 已回滚或连接不可用时忽略，保留原始错误。
    }
  }
}
