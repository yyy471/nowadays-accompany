import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { p0Root } from "../config.js";
import { versions } from "./harness.js";
import { clearReport, readReport, reportPath } from "./report.js";

interface CaseDefinition {
  name: string;
  script: string;
  reportCases: string[];
}

interface ReportResult {
  caseName: string;
  path: string;
  runId: string | null;
  ok: boolean;
  checks: number;
  failedChecks: number;
  error?: string;
}

interface CaseResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  reports: ReportResult[];
  error?: string;
  stdoutTail?: string;
  stderrTail?: string;
}

const cases: CaseDefinition[] = [
  { name: "P0-01", script: "src/smoke/p0-01.ts", reportCases: ["p0-01"] },
  { name: "P0-C01", script: "src/cases/c01.ts", reportCases: ["c01"] },
  { name: "P0-C02", script: "src/cases/c02.ts", reportCases: ["c02"] },
  { name: "P0-C03", script: "src/cases/c03.ts", reportCases: ["c03"] },
  { name: "P0-C04", script: "src/cases/c04.ts", reportCases: ["c04"] },
  { name: "P0-C05", script: "src/cases/c05.ts", reportCases: ["c05"] },
  {
    name: "P0-C06",
    script: "src/cases/c06.ts",
    reportCases: ["c06-verify", "c06-unverifiable"],
  },
  { name: "P0-C07", script: "src/cases/c07.ts", reportCases: ["c07"] },
  { name: "P0-C08", script: "src/cases/c08.ts", reportCases: ["c08"] },
  { name: "P0-C09", script: "src/cases/c09.ts", reportCases: ["c09"] },
  { name: "P0-C10", script: "src/cases/c10.ts", reportCases: ["c10"] },
];

function tail(value: string, length = 2000): string {
  return value.length <= length ? value : value.slice(value.length - length);
}

function runCase(
  definition: CaseDefinition,
  runId: string,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const tsxCli = path.join(p0Root, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = path.join(p0Root, definition.script);
    const child = spawn(process.execPath, [tsxCli, scriptPath], {
      cwd: p0Root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, P0_VERBOSE: "0", P0_RUN_ID: runId },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const runId = `run-${startedAt.toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const results: CaseResult[] = [];

  for (const definition of cases) {
    const caseStartedAt = Date.now();
    const cleanupErrors = definition.reportCases
      .map(clearReport)
      .filter((error): error is string => error !== null);
    if (cleanupErrors.length > 0) {
      const error = cleanupErrors.join("; ");
      const reports = definition.reportCases.map((caseName) => ({
        caseName,
        path: reportPath(caseName),
        runId: null,
        ok: false,
        checks: 0,
        failedChecks: 0,
        error,
      }));
      results.push({
        name: definition.name,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - caseStartedAt,
        reports,
        error,
      });
      console.log(
        `${definition.name} FAIL ${Date.now() - caseStartedAt}ms ${error}`,
      );
      continue;
    }

    const execution = await runCase(definition, runId);
    const reports: ReportResult[] = definition.reportCases.map((caseName) => {
      const read = readReport(caseName, runId);
      const checks = Array.isArray(read.report?.checks)
        ? (read.report.checks as Array<{ ok?: boolean }>)
        : [];
      return {
        caseName,
        path: read.path,
        runId: read.runId,
        ok: read.report?.ok === true && read.error === undefined,
        checks: checks.length,
        failedChecks: checks.filter((check) => check.ok !== true).length,
        ...(read.error ? { error: read.error } : {}),
      };
    });
    const ok =
      execution.exitCode === 0 && reports.every((report) => report.ok);
    results.push({
      name: definition.name,
      ok,
      exitCode: execution.exitCode,
      durationMs: Date.now() - caseStartedAt,
      reports,
      ...(ok ? {} : { stdoutTail: tail(execution.stdout) }),
      ...(ok ? {} : { stderrTail: tail(execution.stderr) }),
    });
    const checkSummary = reports
      .map(
        (report) =>
          `${report.caseName}:${report.ok ? "ok" : "fail"} ${report.checks - report.failedChecks}/${report.checks}${
            report.error ? ` ${report.error}` : ""
          }`,
      )
      .join(" ");
    console.log(
      `${definition.name} ${ok ? "PASS" : "FAIL"} ${Date.now() - caseStartedAt}ms ${checkSummary}`,
    );
  }

  const summary = {
    suite: "P0",
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    versions: versions(),
    results,
    ok: results.every((result) => result.ok),
  };
  const summaryPath = path.join(p0Root, "data", "p0-summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        ok: summary.ok,
        runId,
        summaryPath,
        cases: results.map((result) => ({
          name: result.name,
          ok: result.ok,
          durationMs: result.durationMs,
          reports: result.reports,
        })),
      },
      null,
      2,
    ),
  );
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

await main();
