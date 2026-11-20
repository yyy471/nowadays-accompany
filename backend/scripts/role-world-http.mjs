// Node 24 --import tsx scripts/role-world-http.mjs <run> <deepseek|vertex> <credential-file> <lin|zhou|all> <scenario|all>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createBackendApp, listen } from "../src/bootstrap/app.ts";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.ts";
import { cards, scenarios, worldEntries, originalTimeline } from "./role-world-scenarios.mjs";
import { advanceTestDay, assertCompatibleReport, scenarioSignature } from "./role-world-http-fixtures.mjs";
import { configureProvider, delay, httpClient, nativeFetch, openEvents } from "./role-world-http-transport.mjs";

const [run, tier, credentialFile, cardKey, sceneKey, stageFilter] = process.argv.slice(2);
const original = cardKey === "original" && Boolean(process.env.NOWADAYS_ORIGINAL_CARD);
const activeCards = original ? {original:{name:"林知夏",file:process.env.NOWADAYS_ORIGINAL_CARD}} : cards;
const activeScenarios = original ? {long:originalTimeline} : scenarios;
const selectedScenes = sceneKey === "all" ? Object.keys(activeScenarios) : sceneKey?.split(",") ?? [];
const selectedStages = stageFilter?.split(",");
if (!/^[\w-]+$/.test(run ?? "") || !["deepseek","vertex"].includes(tier) ||
    !(cardKey === "all" || Object.hasOwn(activeCards,cardKey)) || !selectedScenes.length ||
    !selectedScenes.every(key => key === "display" || Object.hasOwn(activeScenarios,key))) throw Error("INVALID_LIVE_ARGS");
if (selectedStages && (selectedScenes.length !== 1 || !selectedStages.every(stage =>
  activeScenarios[selectedScenes[0]]?.some(item => item.stage === stage)))) throw Error("INVALID_LIVE_STAGES");
const backend = fileURLToPath(new URL("../", import.meta.url));
const reportRoot = path.resolve(backend, "../test-results/role-world", run);
const modelName = tier === "vertex" ? "gemini-4-hydrogen" : "deepseek-flash";
const client = "desktop-http-" + randomUUID();
let currentCalls;
let activeDb;
const provider = configureProvider(backend, tier, credentialFile, worldEntries, call => {
  if (!currentCalls || !activeDb || !["chat","expression"].includes(call.purpose)) return;
  const kind = call.purpose === "chat" ? "primary_decision" : "segment_annotation";
  // 主模型/标注都先同步登记账本再出站，一个角色同一时间仅执行一条用户决策。
  // 有多个候选时不给证据归属。自主和记忆请求永远不以角色当前窗口推断归属。
  const ids = activeDb.prepare("SELECT model_call_id AS modelCallId,execution_id AS executionId FROM model_calls WHERE status='running' AND purpose='user_chat' AND call_kind=?").all(kind);
  if (ids.length === 1) Object.assign(call,ids[0]);
  currentCalls.push(call);
});
const sha = value => createHash("sha256").update(value).digest("hex");
const until = async (check, limit, error) => {
  const end = Date.now() + limit;
  do { const value = await check(); if (value) return value; await delay(160); } while (Date.now() < end);
  throw Error(error);
};

async function importOutfit(api, role) {
  const folder = path.join(backend, "assets/presets/xiacheng/outfits/default");
  const form = new FormData();
  form.append("name", "表情联调常服");
  for (const [key, filename, display] of [
    ["home","home","home"], ["sprites","sprites/calm","平静"], ["sprites","sprites/happy","开心"],
    ["sprites","sprites/worried","担心"], ["sprites","sprites/thinking","思考"],
  ]) {
    form.append(key, new Blob([fs.readFileSync(path.join(folder,filename + ".png"))], {type:"image/png"}), display + ".png");
  }
  const outfit = (await api.request("POST", role + "/appearance/outfits",form)).body;
  const state = await api.get(role + "/state");
  await api.request("PUT",role + "/state",{ state:{...state.state,outfitId:outfit.outfitId}, expectedVersion:state.version ?? state.stateVersion });
  return outfit;
}

async function maintain(api, role) {
  const before = await api.get(role + "/memory/status");
  await api.request("POST",role + "/memory/batches");
  const after = await until(async () => {
    const s = await api.get(role + "/memory/status");
    return !s.runningBatchId && !s.pendingTriggers && s;
  }, 240_000, "MEMORY_BATCH_TIMEOUT");
  return { before:before.pendingEvidence, after:after.pendingEvidence, deferred:after.deferredEvidence,
    failed:after.failedEvidence, batchId:after.lastBatch?.batchId, status:after.lastBatch?.status };
}

async function play({api, role, roleId, windowId, db, item, submissionId, outfit, assets, attempts, recovery}) {
  const route = role + "/windows/" + windowId;
  const snapshot = await api.get(route + "/messages");
  const stream = await openEvents(api.origin, route, recovery?.cursor ?? snapshot.cursor, client);
  const started = Date.now();
  const wire = recovery?.wire ?? [];
  currentCalls = wire;
  try {
    await api.request("POST",route + "/input-state",{clientId:client,typing:true});
    const posted = await api.request("POST",route + "/messages",{content:item.input,submissionId,source:"nowadays"});
    await api.request("DELETE",route + "/input-state?clientId=" + client);
    const userMessageId = posted.body.message.messageId;
    const accepted = await api.get(route + "/messages/" + userMessageId);
    if (accepted.message.content !== item.input || accepted.message.windowId !== windowId) throw Error("USER_READBACK_MISMATCH");
    const link = db.prepare(`SELECT e.execution_id AS id,e.status FROM executions e
        WHERE e.execution_id IN (SELECT COALESCE(processed_by_execution_id,claimed_by_execution_id) FROM messages WHERE message_id=?)
        OR e.trigger_message_id=? ORDER BY e.rowid DESC`);
    const outcome = await until(() => {
      const rows = link.all(userMessageId,userMessageId);
      for (const r of rows) {
        const event = stream.events.find(e => e.executionId === r.id && ["message_completed","execution_failed","execution_paused","execution_superseded"].includes(e.type));
        if (event) return {r,event};
      }
      return false;
    },240_000,"NO_TERMINAL_SSE");
    const executionId = outcome.r.id;
    const calls = () => db.prepare("SELECT model_call_id AS modelCallId,call_kind AS kind,status,error_code AS error FROM model_calls WHERE execution_id=? ORDER BY rowid").all(executionId);
    const records = () => stream.events.filter(e => e.executionId === executionId);
    const meta = {stage:item.stage, day:item.day ?? 0, input:item.input, roleId, windowId, submissionId, userMessageId, http:posted.status, executionId};
    if (outcome.event.type !== "message_completed") return { ...meta, status:outcome.event.type, eventTypes:records().map(e => e.type), calls:calls(), wire, attempts:[...attempts] };
    const messageId = outcome.event.messageId;
    // 标注异步启动，轮询正式服务已登记的调用，并等待读端赶上最后一帧。
    const annotation = await until(() => calls().find(c => c.kind === "segment_annotation" && c.status !== "running"),
      110_000,"ANNOTATION_TIMEOUT").catch(() => null);
    await delay(250);
    const detail = await api.get(route + "/messages/" + messageId);
    const history = await api.get(route + "/messages?limit=100");
    const events = records();
    const segments = detail.segments.map(({segmentId,ordinal,kind,text,homeAssetId,spriteAssetId,annotatedAt}) =>
      ({segmentId,ordinal,kind,text,homeAssetId,spriteAssetId,annotatedAt}));
    const fields = s => [s.segmentId,s.text,s.homeAssetId,s.spriteAssetId];
    const stableHistory = history.items.some(m => m.messageId === messageId && m.content === detail.message.content) &&
      JSON.stringify(history.segments.filter(s => s.messageId === messageId).map(fields)) === JSON.stringify(segments.map(fields));
    const eventSprites = events.filter(e => e.type === "segment_annotations" && e.messageId === messageId).flatMap(e => e.items ?? []);
    const assetIds = [...new Set(segments.flatMap(s => [s.homeAssetId,s.spriteAssetId]).filter(Boolean))];
    for (const id of assetIds) {
      if (assets[id]) continue;
      const resource = await nativeFetch(api.origin + role + "/appearance/assets/" + id);
      const data = Buffer.from(await resource.arrayBuffer());
      if (!resource.ok || resource.headers.get("content-type") !== "image/png" || data.subarray(1,4).toString() !== "PNG") throw Error("ASSET_BINARY_INVALID");
      assets[id] = {hash:sha(data),width:data.readUInt32BE(16),height:data.readUInt32BE(20),bytes:data.length};
    }
    const usage = (await api.get(role + "/worldbooks/usage?executionId=" + executionId)).items;
    const chatWire = wire.filter(c => c.purpose === "chat" && c.http === 200 && c.executionId === executionId);
    const expected = item.expectWorld ?? [], avoided = item.avoidWorld ?? [];
    const mainCalls = calls().filter(c => c.kind === "primary_decision" && c.status === "succeeded");
    const worldOk = mainCalls.length > 0 && mainCalls.every(c => {
      const matched = chatWire.find(w => w.modelCallId === c.modelCallId);
      const delivered = usage.filter(u => u.modelCallId === c.modelCallId && u.status === "included" && u.messageIds.includes(userMessageId))
        .map(u => worldEntries.find(e => e.id === u.entryId)?.title);
      return matched && expected.every(t => matched.world.includes(t) && delivered.includes(t)) &&
        avoided.every(t => !matched.world.includes(t) && !delivered.includes(t));
    });
    const processedUsers = db.prepare("SELECT message_id AS id FROM messages WHERE sender='user' AND processed_by_execution_id=? ORDER BY sequence").all(executionId).map(m => m.id);
    const replies = detail.message.content;
    const eventTypes = [...new Set(events.map(e => e.type))];
    const streamText = events.filter(e => e.type === "message_delta").map(e => e.delta).join("");
    const fromSse = segments.every(s => s.spriteAssetId === null || eventSprites.some(e => e.segmentId === s.segmentId && e.spriteAssetId === s.spriteAssetId));
    return {...meta, messageId, status:"completed", reply:replies, elapsedMs:Date.now()-started, attempts, calls:calls(), wire,
      eventTypes, deltaCount:events.filter(e => e.type === "message_delta").length,
      processedUsers, checks:{singleUser:processedUsers.length === 1 && processedUsers[0] === userMessageId,
        sseText:streamText === replies, sseCompleted:outcome.event.messageId === detail.message.messageId,
        history:stableHistory, segments:segments.length > 0 && eventTypes.includes("message_segments"),
        annotationCall:annotation?.status ?? "timeout", expressionSseMatches:fromSse, world:worldOk,
        home:segments.every(s => s.homeAssetId === outfit.home.assetId), expressionDistinct:segments.some(s =>
          s.spriteAssetId && outfit.sprites.some(a => a.assetId === s.spriteAssetId) && assets[s.spriteAssetId]?.hash !== assets[outfit.home.assetId]?.hash)},
      segments, worldUsage:usage, expectedWorld:expected, avoidWorld:avoided };
  } finally { await stream.close(); currentCalls = undefined; }
}

async function testScene(cardId, sceneId) {
  const folder = path.join(reportRoot,[tier,cardId,sceneId].join("-"));
  fs.mkdirSync(folder,{recursive:true});
  const reportFile = path.join(folder,"report.json");
  const prior = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile,"utf8")) : null;
  const card = activeCards[cardId];
  const cardText = fs.readFileSync(path.resolve(backend,card.file),"utf8");
  const identity = {tier,modelName,card:cardId,cardHash:sha(cardText),scenario:sceneId,selectedStages};
  const steps = (activeScenarios[sceneId] ?? []).filter(turn => !selectedStages || selectedStages.includes(turn.stage));
  if (prior) assertCompatibleReport(prior,identity,steps);
  if (prior?.status === "completed") return;
  const interrupted = prior?.turns?.at(-1);
  if (prior && (process.env.NOWADAYS_HTTP_RESUME !== "1" || prior.status !== "error" ||
      prior.error !== "UNRESOLVED_USER_TURN" || !interrupted?.submissionId || interrupted.status === "completed")) throw Error("INCOMPLETE_SCENE_USE_FRESH_RUN");
  const config = parseBackendConfig(["--app-root",path.join(folder,"app"),"--port","0"]);
  let day = interrupted?.day ?? 0;
  let db, recovery;
  if (prior) {
    db = activeDb = new DatabaseSync(rolePaths(config.dataRoot,prior.roleId).businessDatabasePath,{readOnly:true});
    recovery = {cursor:db.prepare("SELECT COALESCE(MAX(stream_event_id),0) AS id FROM execution_stream_events WHERE window_id=?").get(interrupted.windowId).id,wire:[]};
    currentCalls = recovery.wire;
  }
  const app = createBackendApp(config,{disablePresetAssistant:true,timeZone:"Asia/Shanghai",now:() => new Date(Date.now()+day*86400000)});
  const api = httpClient(await listen(app.server,0,"127.0.0.1"));
  const report = prior ?? {...identity,appRoot:config.appRoot,status:"running",turns:[],memory:[],assets:{}};
  report.scenarioSignature = scenarioSignature(steps);
  if (prior) {
    (report.interruptions ??= []).push(report.turns.pop());
    report.status = "running"; delete report.error;
  }
  const save = () => {
    fs.writeFileSync(reportFile + ".new",JSON.stringify(report,null,2));
    fs.renameSync(reportFile + ".new",reportFile);
  };
  try {
    if (!prior) {
      const {body:created} = await api.request("POST","/v1/roles",{displayName:card.name,definition:{text:cardText}});
      report.roleId = created.roleId;
      report.defaultWindowId = created.defaultWindowId;
    }
    const roleId = report.roleId;
    const role = "/v1/roles/" + roleId;
    let windowId = interrupted?.windowId ?? report.defaultWindowId;
    const book = {id: "test-canon",name:"校园世界书",enabled:true,entries:worldEntries};
    if (!prior) {
      await api.request("POST",role + "/activity/stop");
      const resource = (await api.request("POST","/v1/resources",{kind:"model",name:tier,config:provider})).body;
      await api.request("PUT",role + "/bindings",{ bindings:["chat_model","memory_model"].map(capability => ({capability,
        resourceId:resource.resourceId,modelName,enabled:true}))});
      const before = await api.get(role + "/worldbooks");
      const saved = await api.request("PUT",role + "/worldbooks",{expectedRevision:before.revision,books:[book]});
      report.worldRevision = saved.body.revision;
      const imported = await importOutfit(api,role);
      report.outfit = {outfitId:imported.outfitId,home:imported.home.assetId,sprites:imported.sprites.map(s => ({id:s.assetId,name:s.displayName}))};
      await api.request("POST",role + "/activity/resume");
    }
    const readback = await api.get(role + "/worldbooks");
    const actual = readback.books[0];
    if ((report.worldRevision !== undefined && readback.revision !== report.worldRevision) || readback.books.length !== 1 ||
        actual?.id !== book.id || actual.entries.length !== worldEntries.length || !worldEntries.every(entry => {
          const persisted = actual.entries.find(e => e.id === entry.id);
          return persisted && ["title","content","visibility","enabled"].every(k => persisted[k] === entry[k]) &&
            JSON.stringify(persisted.keywords) === JSON.stringify(entry.keywords);
        })) throw Error("WORLDBOOK_SAVE_FAILED");
    const outfit = (await api.get(role + "/appearance/outfits")).items.find(o => o.outfitId === report.outfit.outfitId);
    db ??= new DatabaseSync(rolePaths(config.dataRoot,roleId).businessDatabasePath,{readOnly:true});
    activeDb = db;
    db.exec("PRAGMA busy_timeout=10000");
    save();
    for (const item of steps) {
      if (report.turns.some(t => t.stage === item.stage && t.status === "completed")) continue;
      const resubmitting = interrupted?.stage === item.stage;
      day = await advanceTestDay(day,item.day,report.turns.at(-1),async previous => {
        report.memory.push({afterStage:previous.stage,...await maintain(api,role)});
      });
      if (item.newWindow && !resubmitting) windowId = (await api.request("POST",role + "/windows",{kind:"custom",source:"nowadays"})).body.windowId;
      const submissionId = resubmitting ? interrupted.submissionId : randomUUID();
      const attempts = [];
      let turn;
      for (let index = 0; index < 3; index++) {
        turn = await play({api,role,roleId,windowId,db,item,submissionId,outfit,assets:report.assets,attempts,recovery});
        recovery = undefined;
        if (turn.status === "completed" || index === 2) break;
        const errors = turn.wire.filter(c => c.http === 429 || c.http >= 500 || c.networkError);
        attempts.push({executionId:turn.executionId,status:turn.status,calls:turn.calls,wire:turn.wire});
        await delay(Math.max(1500 * (index + 1), ...errors.map(c => c.retryMs ?? 0)));
      }
      report.turns.push(turn);
      save();
      console.log([tier,cardId,sceneId,item.stage,turn.status].join(" "));
      if (turn.status !== "completed" || !turn.checks.singleUser) throw Error("UNRESOLVED_USER_TURN");
    }
    const after = await api.get(role + "/worldbooks");
    report.authorRevisionUnchanged = after.revision === readback.revision &&
      JSON.stringify(after.books) === JSON.stringify(readback.books);
    report.status = "completed";
  } catch (error) {
    report.status = "error"; report.error = String(error.message).replace(/[^\w/:-].*$/s,"").slice(0,140);
    throw error;
  } finally {
    save(); activeDb = undefined; db?.close(); await app.close();
  }
}

try {
  for (const sceneId of selectedScenes) {
    for (const cardId of cardKey === "all" ? Object.keys(activeCards) : [cardKey]) {
      try { await testScene(cardId,sceneId); }
      catch (error) { console.error(tier,cardId,sceneId,String(error.message).replace(/[^\w/:-].*$/s,"").slice(0,140)); process.exitCode = 1; }
    }
  }
} finally { globalThis.fetch = nativeFetch; delete process.env.NOWADAYS_LIVE_ROLE_KEY; }
