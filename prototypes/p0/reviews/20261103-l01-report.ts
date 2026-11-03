import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { p0Root } from "../src/config.js";
import { clearReport, readReport, reportPath } from "../src/cases/report.js";

interface ProbeCheck {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

const caseName = `l01-probe-${process.pid}`;
const checks: ProbeCheck[] = [];

function check(name: string, fn: () => unknown): void {
  try {
    checks.push({ name, ok: true, detail: fn() });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeReport(payload: unknown): void {
  const target = reportPath(caseName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  );
}

try {
  check("missing report is reported as missing", () => {
    assert.equal(clearReport(caseName), null);
    const read = readReport(caseName, "run-A");
    assert.equal(read.report, null);
    assert.match(read.error ?? "", /REPORT_MISSING/);
    return read.error;
  });

  check("matching runId is accepted", () => {
    writeReport({
      runId: "run-A",
      ok: true,
      checks: [{ name: "sample", ok: true }],
    });
    const read = readReport(caseName, "run-A");
    assert.equal(read.error, undefined);
    assert.equal(read.runId, "run-A");
    assert.equal(read.report?.ok, true);
    return { runId: read.runId, error: read.error ?? null };
  });

  check("stale runId is rejected", () => {
    const read = readReport(caseName, "run-B");
    assert.match(read.error ?? "", /REPORT_RUN_ID_MISMATCH/);
    return read.error;
  });

  check("report without runId is rejected", () => {
    writeReport({ ok: true, checks: [] });
    const read = readReport(caseName, "run-A");
    assert.match(read.error ?? "", /REPORT_RUN_ID_MISMATCH:.*missing/);
    return read.error;
  });

  check("unreadable report is rejected", () => {
    writeReport("{");
    const read = readReport(caseName, "run-A");
    assert.match(read.error ?? "", /REPORT_UNREADABLE/);
    return read.error;
  });

  check("cleanup removes the report", () => {
    writeReport({ runId: "run-A", ok: true, checks: [] });
    assert.equal(clearReport(caseName), null);
    assert.equal(fs.existsSync(reportPath(caseName)), false);
    return { reportPath: reportPath(caseName) };
  });
} finally {
  clearReport(caseName);
  fs.rmSync(path.dirname(reportPath(caseName)), {
    recursive: true,
    force: true,
  });
}

const contractPassed = checks.every((item) => item.ok);
const outputPath = path.join(
  p0Root,
  "test-results",
  "l01-report-ownership",
  `report-${Date.now()}.json`,
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      probe: "l01-report-ownership",
      contractPassed,
      checks,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(
  JSON.stringify(
    {
      reportPath: outputPath,
      probe: "l01-report-ownership",
      contractPassed,
      checks,
    },
    null,
    2,
  ),
);
if (!contractPassed) {
  process.exitCode = 1;
}
