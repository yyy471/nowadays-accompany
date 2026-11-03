import fs from "node:fs";
import path from "node:path";
import { p0Root } from "../config.js";

export interface ReadReportResult {
  report: Record<string, unknown> | null;
  path: string;
  runId: string | null;
  error?: string;
}

export function reportPath(caseName: string): string {
  return path.join(p0Root, "data", caseName, "report.json");
}

export function clearReport(caseName: string): string | null {
  try {
    fs.rmSync(reportPath(caseName), { force: true });
    return null;
  } catch (error) {
    return `REPORT_CLEANUP_FAILED:${caseName}:${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export function readReport(caseName: string, runId: string): ReadReportResult {
  const target = reportPath(caseName);
  if (!fs.existsSync(target)) {
    return {
      report: null,
      path: target,
      runId: null,
      error: `REPORT_MISSING:${caseName}`,
    };
  }
  try {
    const report = JSON.parse(fs.readFileSync(target, "utf8")) as Record<
      string,
      unknown
    >;
    const reportRunId =
      typeof report.runId === "string" ? report.runId : null;
    return {
      report,
      path: target,
      runId: reportRunId,
      ...(reportRunId === runId
        ? {}
        : { error: `REPORT_RUN_ID_MISMATCH:${caseName}:${reportRunId ?? "missing"}` }),
    };
  } catch (error) {
    return {
      report: null,
      path: target,
      runId: null,
      error: `REPORT_UNREADABLE:${caseName}:${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
