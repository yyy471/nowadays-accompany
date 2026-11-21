import fs from "node:fs";

export const RUN_NAME_RE = /^p5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;

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

/**
 * 读取 TAP 汇总并校验通过。
 * minTests 必须由调用方按步骤显式给出：全量测试与 2 条交付测试不能共用同一阈值。
 */
export function readTestTotals(log, { minTests = 1 } = {}) {
  const result = {};
  for (const field of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...log.matchAll(new RegExp(`^# ${field} (\\d+)\\s*$`, "gm"))];
    if (matches.length !== 1) throw new Error(`ACCEPTANCE_TEST_TOTAL_MISSING:${field}`);
    result[field] = Number(matches[0][1]);
  }
  if (
    result.tests < minTests ||
    result.pass !== result.tests ||
    result.fail ||
    result.cancelled ||
    result.skipped ||
    result.todo
  ) {
    throw new Error("ACCEPTANCE_TESTS_NOT_PASSED");
  }
  return result;
}

/**
 * 只选择严格命名且未被文档引用的历史 run。
 * protectedNames 中的 run 永远保留；keep 表示额外保留最新 N 个未保护 run。
 */
export function selectRunsToRotate(runNames, { keep, protectedNames = new Set() } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error("ACCEPTANCE_KEEP_RUNS_INVALID");
  return [...runNames]
    .filter((name) => RUN_NAME_RE.test(name))
    .filter((name) => !protectedNames.has(name))
    .sort((left, right) => right.localeCompare(left))
    .slice(keep);
}
