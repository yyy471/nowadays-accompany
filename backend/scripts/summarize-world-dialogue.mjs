// 使用正式 HTTP 采样器的报告汇总。多个目录按传入次序选择整场复跑，保留被替换场次的路径。
// node scripts/summarize-world-dialogue.mjs <output-dir> <run-dir> [...]
import fs from "node:fs";
import path from "node:path";
import { scenarios } from "./role-world-scenarios.mjs";

const [destination, ...folders] = process.argv.slice(2);
if (!destination || !folders.length) throw Error("OUTPUT_AND_RUN_DIRECTORIES_REQUIRED");
const selected = new Map(), replaced = [];
for (const folder of folders) {
  for (const scene of fs.readdirSync(folder, {withFileTypes:true})) {
    const file = path.join(folder,scene.name,"report.json");
    if (!scene.isDirectory() || !fs.existsSync(file)) continue;
    const r = JSON.parse(fs.readFileSync(file,"utf8"));
    if (!Object.hasOwn(scenarios,r.scenario)) continue;
    const key = [r.tier,r.card,r.scenario].join("/");
    if (selected.has(key)) replaced.push({key,file:selected.get(key).file});
    selected.set(key,{file,r});
  }
}
const groups = [], clips = [], relevantChecks = ["singleUser","sseText","sseCompleted","history","segments","world"];
const softActions = /抬(?:起)?眼|垂(?:下)?眼|看了.{0,3}一眼|目光|视线|顿了顿|顿了一下|停了半拍/u;
const white = /(?:指尖|指节|指关节|骨节|手指)[^。！？\n]{0,12}(?:泛白|发白|失了血色)/u;
const red = /(?:耳尖|耳根|耳廓|耳朵)[^。！？\n]{0,12}(?:红|绯色)/u;
const secret = /乌梅铜铃|紫檀鸽钟/u;
function clauses(text) {
  return text.split(/[，。！？、；：\n]/u).map(s=>s.replace(/^[\s*“”「」]+|[\s*“”「」]+$/gu,"")).filter(s=>(s.match(/\p{Script=Han}/gu)??[]).length>=6);
}
function rowsOf(r) {
  return r.turns.filter(t=>t.status==="completed" && t.checks?.singleUser===true && t.checks.sseText && t.checks.history);
}
for (const tier of ["deepseek","vertex"]) for (const card of ["lin","zhou"]) {
  const group = {tier,card,expected:0,recorded:0,completed:0,linked:0,checks:{},annotations:0,withSprite:0,spriteDelivery:0,
    privateLeaks:0,white:0,red:0,softAction:0,actionOpening:0,exactCopy:[],withinReply:[],reusedLines:[],missing:[],failed:[],reports:[]};
  for (const [scenario,design] of Object.entries(scenarios)) {
    group.expected += design.length;
    const result = selected.get([tier,card,scenario].join("/"));
    const r = result?.r ?? {turns:[]};
    if (result) group.reports.push({scenario,file:result.file,status:r.status,authorRevisionUnchanged:r.authorRevisionUnchanged});
    group.recorded += r.turns.length;
    group.completed += r.turns.filter(t=>t.status==="completed").length;
    const eligible = rowsOf(r);
    group.linked += eligible.length;
    const seenClauses = new Map();
    for (const step of design) {
      if (!r.turns.some(t=>t.stage===step.stage)) group.missing.push(scenario+"/"+step.stage);
    }
    for (const t of r.turns) {
      for (const k of relevantChecks) if (t.checks?.[k]===true) group.checks[k]=(group.checks[k]??0)+1;
      if (!eligible.includes(t)) {group.failed.push({scenario,stage:t.stage,status:t.status});continue;}
      if (t.checks.annotationCall==="succeeded") group.annotations++;
      if (t.checks.expressionDistinct) group.withSprite++;
      if (t.checks.expressionDistinct && t.checks.expressionSseMatches) group.spriteDelivery++;
      const s=t.reply;
      if (secret.test(s)) group.privateLeaks++;
      if (white.test(s)) group.white++;
      if (red.test(s)) group.red++;
      if (softActions.test(s)) group.softAction++;
      if (/^\s*(?:\*[^*]|（)/u.test(s)) group.actionOpening++;
      const lines=clauses(s);
      const duplicate=lines.filter((v,index)=>lines.indexOf(v)!==index);
      if (duplicate.length) group.withinReply.push({scenario,stage:t.stage,duplicate:[...new Set(duplicate)]});
      if (t.stage==="repeat") {
        const origin=eligible.find(before=>before.stage==="code")?.reply;
        group.exactCopy.push({scenario,identical:s===origin});
      } else {
        for (const line of new Set(lines)) {
          if(seenClauses.has(line)) group.reusedLines.push({scenario,line,first:seenClauses.get(line),again:t.stage});
          else seenClauses.set(line,t.stage);
        }
      }
      clips.push({tier,card,scenario,stage:t.stage,day:t.day,input:t.input,reply:s,world:t.checks.world,executionId:t.executionId});
    }
  }
  groups.push(group);
}
fs.mkdirSync(destination,{recursive:true});
fs.writeFileSync(path.join(destination,"summary.json"),JSON.stringify({groups,replaced},null,2));
fs.writeFileSync(path.join(destination,"dialogue.json"),JSON.stringify(clips,null,2));
for(const g of groups) console.log(g.tier,g.card,g.recorded+"/"+g.expected,"linked",g.linked,"world",g.checks.world??0,"annotated",g.annotations,"visible-assets",g.withSprite);
