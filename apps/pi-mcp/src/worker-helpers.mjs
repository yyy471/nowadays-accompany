import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** 归一化工具入参路径：去单个 @ 前缀、支持 file:// URL、非 URL 路径将 Unicode 空格转 ASCII 空格，再相对根目录解析。 */
export function normalizeWorkspacePath(rawPath, root) {
  if (typeof rawPath !== "string" || rawPath.length === 0) throw Error("PI_WORKSPACE_PATH_DENIED");
  const stripped = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  if (/^file:\/\//i.test(stripped)) {
    try {
      return path.resolve(fileURLToPath(stripped));
    } catch {
      throw Error("PI_WORKSPACE_PATH_DENIED");
    }
  }
  const normalized = stripped.replace(UNICODE_SPACES, " ");
  // 相对路径落在 root 下；绝对路径与 .. 路径原样解析，交由 checked() 的工作区围栏判定。
  return path.resolve(root, normalized);
}

/**
 * 合并式步骤日志写入器：同一时刻只允许一个落盘流程，期间的新快照合并为一次重写，
 * 避免并发 tool_execution_end 用旧快照覆盖新快照；临时文件 + rename 保证原子性。
 */
export function createStepWriter(stepLogPath, getPayload) {
  let writing = false;
  let dirty = false;
  let activePromise = null;
  let seq = 0;

  const drain = async () => {
    if (writing) return;
    writing = true;
    try {
      while (dirty) {
        dirty = false;
        const tmpPath = `${stepLogPath}.${process.pid}.${++seq}.tmp`;
        try {
          await fs.writeFile(tmpPath, getPayload());
          await fs.rename(tmpPath, stepLogPath);
        } catch {
          await fs.rm(tmpPath, { force: true }).catch(() => undefined);
          // 诊断日志失败绝不影响任务执行。
        }
      }
    } finally {
      writing = false;
    }
  };

  function schedule() {
    if (!stepLogPath) return;
    dirty = true;
    if (!writing) activePromise = drain();
  }

  async function flush() {
    if (stepLogPath) schedule();
    while (writing || dirty) {
      if (!writing) activePromise = drain();
      await activePromise;
    }
  }

  return { schedule, flush };
}
