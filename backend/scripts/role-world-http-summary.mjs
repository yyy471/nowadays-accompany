// 仅读取 HTTP 驱动的脱敏报告。Node 24 scripts/role-world-http-summary.mjs <run>
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {cards,scenarios} from "./role-world-scenarios.mjs";

const run = process.argv[2];
if (!/^[\w-]+$/.test(run ?? "")) throw Error("INVALID_RUN");
const dir = fileURLToPath(new URL("../../test-results/role-world/" + run + "/",import.meta.url));
const matrix = [];
const flags = [];
const labels = ["singleUser","sseText","sseCompleted","history","segments","world","home","expressionSseMatches"];
for (const tier of ["deepseek","vertex"]) for (const card of Object.keys(cards)) {
  for (const [scene,steps] of Object.entries(scenarios)) {
    const reportPath = path.join(dir,[tier,card,scene].join("-"),"report.json");
    const r = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath,"utf8")) : null;
    const turns = r?.turns ?? [];
    const completed = turns.filter(t => t.status === "completed");
    const counts = Object.fromEntries(labels.map(label => [label,completed.filter(t => t.checks?.[label] === true).length]));
    const missing = steps.filter(step => !completed.some(t => t.stage === step.stage)).map(step => step.stage);
    const asDesigned = Object.fromEntries(completed.map(t => [t.stage,t.reply]));
    const repeatRequested = scene === "voice" && asDesigned.code && asDesigned.repeat ? asDesigned.code === asDesigned.repeat : null;
    const spritePass = completed.filter(t => t.checks?.expressionDistinct && t.checks?.expressionSseMatches).length;
    matrix.push({tier,card,scene,status:r?.status ?? "waiting",planned:steps.length,submitted:turns.length,completed:completed.length,
      counts,spritePass,annotationCallsOk:completed.filter(t => t.checks?.annotationCall === "succeeded").length,
      memoryBatches:r?.memory?.map(m => ({afterStage:m.afterStage,pending:m.after,status:m.status,deferred:m.deferred,failed:m.failed})) ?? [],
      missing,authorRevisionUnchanged:r?.authorRevisionUnchanged,repeatRequested,error:r?.error});
    for (const t of completed) {
      const hit = t.reply.match(/指尖泛白|耳根一红|耳尖泛红|喉结滚动|指节泛白|心尖一颤|指腹摩挲|眼底闪过|空气仿佛凝固|嘴角勾起一抹|乌梅铜铃|紫檀鸽钟/g);
      const failedChecks = labels.filter(label => t.checks?.[label] !== true);
      if (hit || failedChecks.length) flags.push({tier,card,scene,stage:t.stage,messageId:t.messageId,hit:hit ?? [],failedChecks});
    }
  }
}
const summary = {run,at:new Date().toISOString(),planned:matrix.reduce((sum,r)=>sum+r.planned,0),
  submitted:matrix.reduce((sum,r)=>sum+r.submitted,0),completed:matrix.reduce((sum,r)=>sum+r.completed,0),
  counts:Object.fromEntries(labels.map(k=>[k,matrix.reduce((sum,r)=>sum+r.counts[k],0)])),
  expression:matrix.reduce((sum,r)=>sum+r.spritePass,0),annotationCallsOk:matrix.reduce((sum,r)=>sum+r.annotationCallsOk,0),matrix,flags};
fs.writeFileSync(path.join(dir,"summary.json.new"),JSON.stringify(summary,null,2));
fs.renameSync(path.join(dir,"summary.json.new"),path.join(dir,"summary.json"));
console.log(JSON.stringify({planned:summary.planned,submitted:summary.submitted,completed:summary.completed,counts:summary.counts,
  expression:summary.expression,annotationCallsOk:summary.annotationCallsOk,flags:flags.length}));
