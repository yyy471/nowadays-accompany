import assert from "node:assert/strict";
import test from "node:test";
import {advanceTestDay,assertCompatibleReport,scenarioSignature} from "./role-world-http-fixtures.mjs";

const steps = [
  {stage:"hello",input:"你好",day:0},
  {stage:"remember",input:"上次是什么？",day:12,newWindow:true,avoidWorld:["隔离条目"]},
];
const identity = {tier:"vertex",modelName:"gemini",card:"lin",cardHash:"fixture",scenario:"memory"};
const report = {...identity,status:"completed",defaultWindowId:"first",turns:[
  {stage:"hello",input:"你好",day:0,windowId:"first",status:"completed",expectedWorld:[],avoidWorld:[]},
  {stage:"remember",input:"上次是什么？",day:12,windowId:"second",status:"completed",expectedWorld:[],avoidWorld:["隔离条目"]},
]};

test("旧报告以已经提交的正文、日期、窗口和完整试题数确认能否复用", () => {
  assert.doesNotThrow(() => assertCompatibleReport(report,identity,steps));
  for (const changed of [{input:"新问题"},{day:11},{newWindow:false},{stage:"新阶段"},{avoidWorld:[]}]) {
    assert.throws(() => assertCompatibleReport(report,identity,[steps[0],{...steps[1],...changed}]),/USE_FRESH_RUN/);
  }
  assert.throws(() => assertCompatibleReport(report,{...identity,cardHash:"other"},steps),/USE_FRESH_RUN/);
  assert.throws(() => assertCompatibleReport(report,identity,[...steps,{...steps[0],stage:"extra"}]),/USE_FRESH_RUN/);
  const filtered = {...report,selectedStages:["remember"],turns:[{...report.turns[1],windowId:"first"}]};
  assert.throws(() => assertCompatibleReport(filtered,{...identity,selectedStages:["remember"]},
    [{...steps[1],newWindow:false}]),/USE_FRESH_RUN/);
});

test("保存全场景签名后，续跑前可以发现尚未执行的题目变更", () => {
  const partial = {...report,status:"error",turns:report.turns.slice(0,1),scenarioSignature:scenarioSignature(steps)};
  assert.doesNotThrow(() => assertCompatibleReport(partial,identity,steps));
  assert.throws(() => assertCompatibleReport(partial,identity,[steps[0],{...steps[1],input:"改变未来题目"}]),/USE_FRESH_RUN/);
});

test("首题筛选到第 3 天就先设置模拟日期，同天不整理，换日先整理上一天", async () => {
  let day = 0;
  const maintenance = [];
  const date = () => new Date(Date.UTC(2026,10,20) + day*86_400_000).toISOString().slice(0,10);
  const maintain = async previous => { maintenance.push([previous.stage,date()]); };
  day = await advanceTestDay(day,3,undefined,maintain);
  assert.equal(date(),"2026-11-23");
  day = await advanceTestDay(day,3,{stage:"plan"},maintain);
  assert.equal(date(),"2026-11-23");
  assert.deepEqual(maintenance,[]);
  day = await advanceTestDay(day,4,{stage:"pressure"},maintain);
  assert.deepEqual(maintenance,[["pressure","2026-11-23"]]);
  assert.equal(date(),"2026-11-24");
});
