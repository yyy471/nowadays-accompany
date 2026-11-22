import {createHash} from "node:crypto";

const list = items => [...new Set(items ?? [])].sort();
const normalize = step => ({
  stage:step.stage, input:step.input, day:step.day ?? 0, newWindow:step.newWindow === true,
  group:step.group ?? null, expectWorld:list(step.expectWorld), avoidWorld:list(step.avoidWorld),
});

export function scenarioSignature(steps) {
  return createHash("sha256").update(JSON.stringify(steps.map(normalize))).digest("hex");
}

/** 筛选后的第一条也要采用其标注日期。只有真正走过前一轮才整理上一日。 */
export async function advanceTestDay(current, target, previousTurn, maintainPreviousDay) {
  if (target === undefined || target <= current) return current;
  if (previousTurn) await maintainPreviousDay(previousTurn);
  return target;
}

/** 老报告没有计划签名，用实际提交的消息和先后窗口反推出已经执行的步骤。 */
export function assertCompatibleReport(report, expected, steps) {
  const mismatch = () => { throw Error("SCENE_INPUTS_CHANGED_USE_FRESH_RUN"); };
  for (const k of ["tier","modelName","card","cardHash","scenario"]) {
    if (report[k] !== expected[k]) mismatch();
  }
  if (JSON.stringify(report.selectedStages ?? []) !== JSON.stringify(expected.selectedStages ?? [])) mismatch();
  // 旧采样器会把首题非零的相对日期写进报告，却实际按第 0 天发消息。
  if (!report.scenarioSignature && (steps[0]?.day ?? 0) > 0) mismatch();
  if (report.scenarioSignature && report.scenarioSignature !== scenarioSignature(steps)) mismatch();
  if (!Array.isArray(report.turns) || report.turns.length > steps.length ||
      (report.status === "completed" && report.turns.length !== steps.length)) mismatch();
  let previousWindow = report.defaultWindowId;
  for (const [index,turn] of report.turns.entries()) {
    const step = normalize(steps[index]);
    if (!turn.windowId || !previousWindow || turn.stage !== step.stage || turn.input !== step.input ||
        turn.day !== step.day || (turn.windowId !== previousWindow) !== step.newWindow) mismatch();
    if (report.status === "completed" && turn.status !== "completed") mismatch();
    if ((!report.scenarioSignature && step.group !== null) ||
        (turn.status === "completed" && (
          JSON.stringify(list(turn.expectedWorld)) !== JSON.stringify(step.expectWorld) ||
          JSON.stringify(list(turn.avoidWorld)) !== JSON.stringify(step.avoidWorld)
        ))) mismatch();
    previousWindow = turn.windowId;
  }
}
