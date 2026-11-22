import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { listen } from "../src/bootstrap/app.js";
import { HttpModelAdapter } from "../src/model/protocols.js";
import { MemoryStore } from "../src/storage/memory/memory-store.js";
import type {ModelEvent} from "../src/domain/model.js";
import { createFixture, createFixtureWithModel, seedEvent, updateResourceConfigDirect, withStorage } from "./p2-05-fixture.js";

test("旧查询回执在后续执行首次送达时补记原命中，只传模型可见的正文", async () => {
  let step = "";
  const fixture = createFixture([
    [{ type: "tool_call", name: "memory_search", callId: "old-search", arguments: { query: "AZURITE" } },
      { type: "completed", stopReason: "tool_calls" }],
    () => { throw Error("REJECTED_BEFORE_RESULT"); },
    request => {
      const replay = request.messages.find(m => m.source?.internalStepKey === step);
      assert.ok(replay && replay.content.includes("绿松石印章"));
      assert.doesNotMatch(replay.content, /rawResponse|adaptedResult|memoryReads/);
      return [{ type: "text_delta", text: "找到印章的记录了。" }, { type: "completed", stopReason: "stop" }];
    },
  ]);
  try {
    const event = seedEvent(fixture, { content: "印章档案", title: "AZURITE", summary: "绿松石印章",
      occurredAt: "2026-11-01T03:00:00Z" });
    const send = async (content: string) => {
      const {message} = fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
        content, submissionId: randomUUID(), sourcePlatform: "nowadays",
      });
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      return message.messageId;
    };
    await send("能翻一下吗？");
    const receipt = withStorage(fixture, ({business:{db}}) => {
      const saved = db.prepare(`SELECT stream_event_id AS id,
        json_extract(payload_json,'$.internalStepKey') AS step, json_extract(payload_json,'$.outcome.adaptedResult.retrievalId') AS retrieval
        FROM execution_stream_events WHERE event_type='tool_result_saved' AND json_extract(payload_json,'$.toolName')='memory_search'`).get() as {id:number;step:string;retrieval:string};
      // 模拟升级前已保存、尚未被模型接收的工具结果。
      db.prepare("UPDATE execution_stream_events SET payload_json=json_remove(payload_json,'$.outcome.memoryReads') WHERE stream_event_id=?").run(saved.id);
      assert.deepEqual(db.prepare("SELECT delivered FROM retrieval_results WHERE retrieval_id=?").get(saved.retrieval), {delivered:0});
      return saved;
    });
    step = receipt.step;
    const second = await send("核对这个已保存的操作 " + step);
    withStorage(fixture, ({business:{db}}) => {
      assert.deepEqual(db.prepare("SELECT delivered FROM retrieval_results WHERE retrieval_id=?").get(receipt.retrieval), {delivered:1});
      const { id } = db.prepare("SELECT processed_by_execution_id AS id FROM messages WHERE message_id=?").get(second) as {id:string};
      assert.ok(id);
      assert.deepEqual(db.prepare("SELECT execution_id AS id FROM memory_recalls WHERE record_id=?").all(event.eventId), [{id}]);
    });
  } finally { await fixture.close(); }
});

test("主动工具检索与深查在同一决策内只计一次，拒收工具结果的下一轮保持未送达", async () => {
  const search = (): ModelEvent[] => [{type:"tool_call",name:"memory_search",callId:"wire",arguments:{query:"SAPPHIRE"}},
    {type:"completed",stopReason:"tool_calls"}];
  let target = "";
  const fixture = createFixture([
    search,()=>{throw Error("REJECTED_BEFORE_ACCEPT");},search,
    request=>{
      assert.ok(request.messages.some(m=>m.role==="tool" && m.content.includes(target)));
      return [{type:"tool_call",name:"memory_event",callId:"details",arguments:{eventId:target}},
        {type:"completed",stopReason:"tool_calls"}];
    },
    request=>{
      assert.ok(request.messages.some(m=>m.role==="tool" && m.toolName==="memory_event" && m.content.includes("详细记录")));
      return [{type:"text_delta",text:"核对完了。"},{type:"completed",stopReason:"stop"}];
    },
  ]);
  try {
    target = seedEvent(fixture,{content:"SAPPHIRE 原始表格",title:"SAPPHIRE",summary:"详细记录",occurredAt:"2026-11-01T03:00:00Z"}).eventId;
    for(const accepted of [false,true]) {
      const w=fixture.app.services.roles.createWindow(fixture.roleId,{kind:"custom",source:"nowadays"});
      const {message}=fixture.app.conversation.submitMessage(fixture.roleId,w.windowId,{
        content:"请按办法查一下。",submissionId:randomUUID(),sourcePlatform:"nowadays"});
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      withStorage(fixture,({business:{db}})=>{
        const x=db.prepare("SELECT execution_id AS id,status FROM executions WHERE trigger_message_id=?")
          .get(message.messageId) as {id:string;status:string};
        assert.equal(x.status,accepted?"completed":"failed");
        const rows=db.prepare(`SELECT r.delivered FROM retrieval_queries q JOIN retrieval_results r USING(retrieval_id)
          WHERE q.execution_id=? AND q.mode='agent' AND r.record_id=?`).all(x.id,target);
        assert.deepEqual(rows,[{delivered:Number(accepted)}]);
        assert.deepEqual(db.prepare("SELECT count(*) AS n FROM memory_recalls WHERE record_id=? AND execution_id=?").get(target,x.id),{n:Number(accepted)});
      });
    }
  } finally {await fixture.close();}
});

test("自动召回只在最终 HTTP 请求保留完整概况且供应商接收后计数", async () => {
  let reject = false;
  const bodies: string[] = [];
  const vendor = createServer(async (req,res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    if (reject) { res.writeHead(403).end("refused"); return; }
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.end('data: {"choices":[{"delta":{"content":"收到。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listen(vendor,0,"127.0.0.1");
  const protocol = "openai-chat";
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const fixture = createFixtureWithModel(new HttpModelAdapter({protocol,baseUrl},undefined));
  try {
    const roleId = fixture.roleId;
    const endpoint = `http://127.0.0.1:${await listen(fixture.app.server,0,"127.0.0.1")}/v1/roles/${roleId}`;
    const event = seedEvent(fixture,{content:"AUDITPINE 是这次话题。", title:"AUDITPINE HiddenDetail"+"柏".repeat(330),
      summary:"AUDITPINE HiddenDetail"+"松".repeat(650),occurredAt:"2026-11-01T03:00:00Z"});
    const resource = fixture.app.services.resources.list("model")[0]!;
    const reserve = 1024;
    const setLimit = (maxInputChars: number) => updateResourceConfigDirect(fixture,resource.resourceId,{
      protocol,baseUrl,maxInputChars,maxOutputChars:reserve,
    });
    const turn = async (expectedStatus: string, delivered: number, recalls: number) => {
      const w = fixture.app.services.roles.createWindow(roleId,{kind:"custom",source:"nowadays"});
      const before = bodies.length;
      const submitted = await fetch(`${endpoint}/windows/${w.windowId}/messages`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({content:"AUDITPINE",source:"nowadays",submissionId:randomUUID()}),
      });
      assert.equal(submitted.status,201);
      const {message} = await submitted.json() as {message:{messageId:string}};
      await fixture.app.conversation.waitForIdle(roleId);
      assert.equal(bodies.length,before+1);
      const body = bodies[before]!;
      withStorage(fixture, ({business:{db}}) => {
        const execution = db.prepare("SELECT execution_id AS id,status FROM executions WHERE trigger_message_id=?").get(message.messageId) as {id:string;status:string};
        assert.equal(execution.status,expectedStatus);
        assert.deepEqual(db.prepare(`SELECT rr.delivered FROM retrieval_results rr JOIN retrieval_queries rq USING(retrieval_id)
          WHERE rq.execution_id=? AND rq.mode='auto' AND rr.record_id=?`).all(execution.id,event.eventId),[{delivered}]);
        assert.deepEqual(db.prepare("SELECT count(*) AS n FROM memory_recalls WHERE record_id=?").get(event.eventId),{n:recalls});
        assert.equal(new MemoryStore(db).listRefineCandidates(roleId,100).some(e=>e.eventId===event.eventId),recalls<=1);
      });
      return body;
    };
    setLimit(128000);
    const control = await turn("completed",1,1);
    const prompt = JSON.parse(control).messages[0].content as string;
    const recallLine = prompt.split("\n").find(line => line.includes("HiddenDetail"));
    assert.ok(recallLine);
    assert.ok(recallLine.includes(event.eventId));
    setLimit(control.length + reserve - recallLine.length + 40);
    for (let i=0;i<2;i++) assert.doesNotMatch(await turn("completed",0,1),/HiddenDetail/);
    setLimit(128000);
    reject = true;
    assert.match(await turn("failed",0,1),/HiddenDetail/);
    reject = false;
    assert.match(await turn("completed",1,2),/HiddenDetail/);
  } finally {
    await fixture.close();
    await new Promise<void>((resolve,reject) => vendor.close(err => err ? reject(err) : resolve()));
  }
});
