import fs from "node:fs";
import path from "node:path";

export const RUN_NAME_RE = /^p5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
export const MIN_BACKEND_TEST_FILES = 69;

/** 递归收集正式测试文件（排除 fixtures/ 与 acceptance/），可附带最小文件数守卫与排序策略防止静默漏跑或长尾。 */
export function collectBackendTestFiles(
  testsDir,
  { baseDir = path.dirname(testsDir), minFiles = 0, order = "alpha" } = {},
) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["fixtures", "acceptance", "node_modules", "dist"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(path.relative(baseDir, full).replaceAll(path.sep, "/"));
      }
    }
  }
  walk(testsDir);
  if (order === "lpt") {
    const sizes = new Map(files.map((file) => [file, fs.statSync(path.join(baseDir, file)).size]));
    files.sort((left, right) => (sizes.get(right) - sizes.get(left)) || left.localeCompare(right));
  } else {
    files.sort();
  }
  if (files.length < minFiles) {
    throw new Error(`ACCEPTANCE_TEST_FILE_COUNT:${files.length}:${minFiles}`);
  }
  return files;
}

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
