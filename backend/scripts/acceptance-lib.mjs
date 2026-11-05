import fs from "node:fs";

export function readCases(file, expected, field, singleId) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const cases = singleId && data && !Array.isArray(data) ? [{ ...data, id: singleId }] : data;
  if (!Array.isArray(cases) || cases.length !== expected) throw new Error("ACCEPTANCE_CASE_COUNT");
  const ids = new Set();
  for (const item of cases) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)) throw new Error("ACCEPTANCE_CASE_ID");
    ids.add(item.id);
    if (item[field] !== true || item.error || item.probeError) throw new Error(`ACCEPTANCE_CASE_FAILED:${item.id}`);
  }
  return cases.map(({ id }) => id);
}

export function readTestTotals(log) {
  const result = {};
  for (const field of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...log.matchAll(new RegExp(`^# ${field} (\\d+)\\s*$`, "gm"))];
    if (matches.length !== 1) throw new Error(`ACCEPTANCE_TEST_TOTAL_MISSING:${field}`);
    result[field] = Number(matches[0][1]);
  }
  if (result.tests < 1 || result.pass !== result.tests || result.fail || result.cancelled || result.skipped || result.todo) {
    throw new Error("ACCEPTANCE_TESTS_NOT_PASSED");
  }
  return result;
}
