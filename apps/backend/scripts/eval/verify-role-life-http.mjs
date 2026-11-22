// Node 24 --import tsx scripts/verify-role-life-http.mjs <run> <long|autonomy|scheduled|quiet> <deepseek|vertex> <凭据文件>
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBackendApp, listen } from "../../src/bootstrap/app.ts";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.ts";
import { configureProvider, delay, httpClient, nativeFetch, openEvents } from "./role-world-http-transport.mjs";
import { agingDialogue } from "./role-life-aging-dialogue.mjs";

const [run, scenario, tier, credentials] = process.argv.slice(2);
if (!/^[\w-]+$/.test(run ?? "") || !["long", "autonomy", "scheduled", "quiet"].includes(scenario) || !["deepseek", "vertex"].includes(tier) || !credentials) throw Error("INVALID_LIFE_ARGS");
const backend = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.join(backend, "../../test-results/backend-acceptance", run, scenario + "-" + tier);
fs.mkdirSync(directory, { recursive: true });
const filename = path.join(directory, "progress.json");
const progress = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : {
  scenario, tier, turns: [], offset: scenario === "scheduled" ? Date.parse("2026-11-20T02:00:00Z") - Date.now()
    : scenario === "quiet" ? Date.parse("2026-11-20T06:00:00Z") - Date.now() : 0,
};
const save = () => {
  fs.writeFileSync(filename + ".tmp", JSON.stringify(progress, null, 2));
  fs.renameSync(filename + ".tmp", filename);
};
if (progress.result === "incomplete") {
  (progress.previousAttempts ??= []).push({ error: progress.error, turns: progress.turns.length, reads: progress.reads?.length ?? 0 });
}
progress.result = "running";
delete progress.error;
save();
const modelName = tier === "deepseek" ? "deepseek-flash" : "gemini-4-hydrogen";
const shelf = [{ title: "用信鸽传送互联网数据", url: "https://www.rfc-editor.org/rfc/rfc1149.txt" },
  { title: "信鸽通信的服务质量", url: "https://www.rfc-editor.org/rfc/rfc2549.txt" }];
const reader = "你叫阿遥，是校刊的通信史专栏作者。你一直想从自己书架的奇趣通信文献里选一篇先读几段，找出一个原文里确实出现、值得写进专栏的细节。你喜欢把出处和自己的想法记在工作空间的 Markdown 笔记，碰上特别有意思的事也乐意分享给朋友。";
const cards = {
  autonomy: reader + "这个周末终于有空。是否现在读、选哪篇、是否或何时分享，都由你自己决定。",
  scheduled: reader + "你今天上午值班，直到当地中午十二点才交班，值班期间无法打开书架。今天下午有空。你平时会提前给自己选时间记下想做的事。是否安排、选几点、到时想做什么都由你决定。",
  quiet: "你叫阿栩，今天放假，已经和自己约好整天休息。你现在想在院子里晒太阳，合上书和电脑，不看资料、不写笔记、不联系别人。手边没有待办，也没打算给未来排日程。能安心什么都不做，是你喜欢这一天的原因。做什么由你自己决定。",
};
const config = parseBackendConfig(["--app-root", path.join(directory, "app"), "--port", "0"]);
const calls = [];
const provider = configureProvider(backend, tier, credentials, [], call => calls.push(call));
const providerFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  for (let attempt = 0; ; attempt++) {
    const responsePromise = providerFetch(url, options);
    const call = calls.at(-1);
    if (tier === "vertex" && call) {
      const contents = JSON.parse(options.body).contents ?? [];
      call.roles = contents.map(m => m.role);
    }
    try {
      const response = await responsePromise;
      if (!response.ok && call) {
        const failure = await response.clone().json().catch(() => ({}));
        const message = String(failure.error?.message ?? failure.message ?? "");
        call.reason = message.replaceAll(process.env.NOWADAYS_LIVE_ROLE_KEY, "[redacted]").replace(/https?:\/\/\S+/g, "[endpoint]").slice(0, 600);
      }
      return response;
    } catch (error) {
      // 仅联调驱动在连接未建立时重试，绝不重放可能已受理或已流出正文的请求。
      if (options.signal?.aborted || attempt >= 3 || !["UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(error.cause?.code)) throw error;
      await delay((attempt + 1) * 1000);
    }
  }
};
const app = createBackendApp(config, { disablePresetAssistant: true, timeZone: "Asia/Shanghai",
  now: () => new Date(Date.now() + progress.offset) });
let db;
const topics = ["校刊装订","活动海报","交换旧书","社团留影","校内播客","图书角","演出门票","春游路线","班级板报","运动会照片",
  "值日安排","礼堂座位","广播点歌","旧衣义卖","课间散步","美术展签","校庆摊位","合唱排练","手作集市","读书会"];
const questions = [
  topic => "正聊到" + topic + "，你想从哪儿开始？",
  topic => "刚收到两份有关" + topic + "的方案，你想自己挑还是一起看看？",
  topic => "昨天有人把" + topic + "的通知贴错地方了。这事你会当场说吗？",
  topic => "关于" + topic + "，我觉得今天可以歇一歇。你想怎么花这十分钟？",
  topic => "假如要给下届同学留一句关于" + topic + "的经验，你会写什么？",
];
const timeline = [
  "上次你说栀子花开了就告诉你。我姐姐把第一朵压在我们合做的书签里，留给你。我们那天坐的是靠窗第七把椅子。",
  "我来念模拟庭审的对方陈述，你来给我计时。刚才我把票夹落在桌上了，我记得是蓝色。",
  "刚看了实物，更正一下：票夹其实是墨绿色，蓝色的是伞。姐姐的名字我还没告诉过你。",
  ...questions.flatMap(question => topics.map(question)),
  "还记得我们当时怎么分工吗？上次是谁帮谁念模拟庭审的对方陈述？如果不确定，可以查我说过的原话。",
  "收拾抽屉看见了我们合做的书签。当时有什么是你到现在还记得的？",
  "对了，当时那把椅子具体是第几把？凭印象说就好，拿不准也行。",
  "我当时纠正过哪件东西的颜色？还有，我有没有告诉过你姐姐叫什么？",
];
async function until(read, timeout, code, checkpoint) {
  let end = Date.now() + timeout;
  const deadline = checkpoint ? Date.now() + timeout * 3 : end;
  let previous = checkpoint?.();
  do {
    const value = await read();
    if (value) return value;
    if (checkpoint) {
      const next = checkpoint();
      if (next !== previous) { previous = next; end = Math.min(deadline, Date.now() + timeout); }
    }
    await delay(250);
  } while (Date.now() < end);
  throw Error(code);
}
async function verifyReadings(paths) {
  const deliveries = db.prepare("SELECT url,page_version,start_offset,end_offset,original_text FROM web_reading_deliveries").all();
  const distinct = new Set();
  for (const url of new Set(deliveries.map(d => d.url))) {
    assert.ok(shelf.some(book => book.url === url));
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await nativeFetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        await delay((attempt + 1) * 1000);
      }
    }
    assert.equal(response.status, 200);
    const page = await response.text();
    const hash = createHash("sha256").update(page).digest("hex");
    for (const row of deliveries.filter(item => item.url === url)) {
      assert.equal(row.page_version, hash);
      assert.equal(page.slice(row.start_offset, row.end_offset), row.original_text);
      distinct.add([url,hash,row.start_offset,row.end_offset].join("|"));
    }
  }
  assert.ok(distinct.size >= 3, "THREE_DISTINCT_READ_FRAGMENTS_REQUIRED");
  progress.distinctReadRanges = distinct.size;
  progress.notes = fs.readdirSync(paths.workspaceDir, { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && /\.md$/i.test(file.name))
    .map(file => {
      const full = path.join(file.parentPath, file.name);
      const bytes = fs.readFileSync(full);
      return { path: path.relative(paths.workspaceDir, full), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  assert.ok(progress.notes.some(note => note.bytes > 0), "NO_SAVED_MARKDOWN_NOTE");
}
try {
  const port = await listen(app.server, 0, "127.0.0.1");
  const api = httpClient(port);
  if (!progress.roleId) {
    const card = scenario === "long" ? fs.readFileSync(process.env.NOWADAYS_ORIGINAL_CARD ?? path.join(backend, "examples/zhou-ye.md"), "utf8") : cards[scenario];
    const role = (await api.request("POST", "/v1/roles", { displayName: scenario === "long" ? "长期相处复验" : scenario === "quiet" ? "阿栩" : "阿遥", definition: { text: card } })).body;
    const roleRoute = "/v1/roles/" + role.roleId;
    const model = (await api.request("POST", "/v1/resources", { kind: "model", name: tier, config: provider })).body;
    const bindings = ["chat_model", "memory_model"].map(capability => ({ capability, resourceId: model.resourceId, modelName, enabled: true }));
    if (scenario !== "long") {
      const loader = pathToFileURL(path.join(backend, "node_modules/tsx/dist/loader.mjs")).href;
      for (const [name, args, env] of [
        ["文献书架", [path.join(backend, "examples/reading-shelf.mjs")], { NOWADAYS_READING_SHELF: JSON.stringify(shelf) }],
        ["角色笔记", ["--import", loader, path.join(backend, "src/mcp/local-server.ts")], {}],
      ]) {
        const tool = (await api.request("POST", "/v1/resources", { kind: "mcp", name,
          config: { command: process.execPath, args, env: { ...env, NOWADAYS_LIVE_ROLE_KEY: "" } } })).body;
        bindings.push({ capability: "mcp", resourceId: tool.resourceId, enabled: true });
      }
    }
    await api.request("PUT", roleRoute + "/bindings", { bindings });
    progress.roleId = role.roleId; progress.windowId = role.defaultWindowId; save();
  }
  const role = "/v1/roles/" + progress.roleId;
  const paths = rolePaths(config.dataRoot, progress.roleId);
  db = new DatabaseSync(paths.businessDatabasePath, { readOnly: true });
  db.exec("PRAGMA busy_timeout=10000");
  if ((await api.get(role + "/activity")).activity.state === "stopped") {
    await api.request("POST", role + "/activity/resume");
  }
  async function speak(input, index) {
    if (progress.turns[index]) return;
    if (!progress.pending) {
      if ([2,103,155,192].includes(index) || (scenario !== "long" && index === 0)) {
        progress.windowId = (await api.request("POST", role + "/windows", { kind: "custom", source: "nowadays" })).body.windowId;
      }
      progress.pending = { submissionId: randomUUID(), input, index }; save();
    }
    assert.equal(input, progress.pending.input);
    const route = role + "/windows/" + progress.windowId;
    const stream = await openEvents(api.origin, route, 0, "life-" + randomUUID());
    try {
      const { body, status } = await api.request("POST", route + "/messages", { content: input, submissionId: progress.pending.submissionId, source: "nowadays" });
      const userId = body.message.messageId;
      const link = db.prepare("SELECT execution_id AS id FROM executions WHERE trigger_message_id=? ORDER BY rowid DESC LIMIT 1");
      const terminal = await until(() => {
        const id = link.get(userId)?.id;
        return id && stream.events.find(event => event.executionId === id && ["message_completed", "execution_failed", "execution_superseded"].includes(event.type));
      }, 240_000, "MISSING_TERMINAL_EVENT");
      if (terminal.type !== "message_completed") throw Error("LIVE_" + terminal.type);
      const history = await api.get(route + "/messages/" + terminal.messageId);
      const deltas = stream.events.filter(event => event.executionId === terminal.executionId && event.type === "message_delta").map(event => event.delta).join("");
      assert.ok(deltas && deltas === history.message.content);
      progress.turns.push({ index, input, http: status, userId, executionId: terminal.executionId,
        messageId: terminal.messageId, reply: deltas, windowId: progress.windowId });
      delete progress.pending; save();
    } finally { await stream.close(); }
  }
  if (scenario === "long") {
    const inputs = process.env.NOWADAYS_LIFE_AGING === "1" ? [...timeline, ...agingDialogue] : timeline;
    for (let index = progress.turns.length; index < inputs.length; index++) {
      const day = index < timeline.length ? Math.floor(index * 90 / (timeline.length - 1)) : 91 + Math.floor((index - timeline.length) / 2);
      progress.offset = day * 86_400_000;
      for (let attempt = 0; ; attempt++) {
        try { await speak(inputs[index], index); break; }
        catch (error) { if (attempt >= 3) throw error; await delay((attempt + 1) * 2000); }
      }
    }
    await until(() => !db.prepare("SELECT 1 FROM memory_batches WHERE status='running'").get(), 210_000, "MEMORY_BATCH_STILL_RUNNING");
  } else if (scenario === "quiet") {
    await until(() => db.prepare("SELECT 1 FROM autonomy_activities WHERE status IN ('completed','failed')").get(), 150_000, "NO_FIRST_DECISION");
    assert.ok(db.prepare("SELECT 1 FROM autonomy_activities WHERE status='completed' AND shared_message_id IS NULL").get(), "NO_QUIET_COMPLETION");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM autonomy_wakes WHERE source_execution_id IS NOT NULL").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE status='success'").get().n, 0);
  } else {
    // 仅推进角色自己登记的安排。首次思考、阅读与首次分享之前不向角色投递用户指令。
    const shared = await until(async () => {
      const shared = db.prepare(`SELECT a.shared_message_id FROM autonomy_activities a JOIN autonomy_wakes w USING(wake_id)
        WHERE a.status='completed' AND a.shared_message_id IS NOT NULL AND (? = 0 OR w.source_execution_id IS NOT NULL)
          AND EXISTS (SELECT 1 FROM web_reading_deliveries d WHERE d.task_id=a.task_id
            AND d.accepted_at BETWEEN a.started_at AND a.finished_at)`).get(scenario === "scheduled" ? 1 : 0);
      if (shared) return shared;
      const wakes = (await api.get(role + "/autonomy/wakes")).items;
      const failed = db.prepare("SELECT 1 FROM autonomy_activities WHERE status = 'failed'").get();
      if (failed && wakes.every(w => w.status === "completed" || w.status === "cancelled")) throw Error("AUTONOMOUS_EXECUTION_FAILED");
      if (wakes.length && wakes.every(w => w.status === "completed" || w.status === "cancelled")) throw Error("NO_VOLUNTARY_READING_SHARE");
      const due = wakes.filter(w => w.sourceExecutionId && w.status === "pending").sort((a,b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
      if (due && !db.prepare("SELECT 1 FROM executions WHERE status='running'").get()) {
        const next = Date.parse(due.scheduledAt) - Date.now() + 1000;
        if (next > progress.offset) {
          progress.offset = next; save();
          app.conversation.refreshWakeTimer(progress.roleId);
        }
      }
      return false;
    }, 360_000, "AUTONOMY_TIMEOUT_BEFORE_SHARE", () => {
      const ranges = db.prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT url,page_version,start_offset,end_offset FROM web_reading_deliveries)").get().n;
      const tools = db.prepare("SELECT COUNT(DISTINCT tool_name) AS n FROM tool_calls WHERE status='success'").get().n;
      const activities = db.prepare("SELECT COUNT(*) AS n FROM autonomy_activities WHERE status='completed'").get().n;
      return ranges + "/" + tools + "/" + activities;
    });
    const main = (await api.get(role)).defaultWindowId;
    const mainRoute = role + "/windows/" + main;
    const shareMessage = (await api.get(mainRoute + "/messages/" + shared.shared_message_id)).message;
    assert.equal(shareMessage.sender, "assistant");
    const replay = await openEvents(api.origin, mainRoute, 0, "life-share-" + randomUUID());
    try {
      await until(() => replay.events.find(e => e.type === "message_completed" && e.messageId === shareMessage.messageId), 30_000, "SHARE_MISSING_IN_MAIN_STREAM");
    } finally { await replay.close(); }
    progress.share = { messageId: shareMessage.messageId, content: shareMessage.content, windowId: main };
    await until(() => db.prepare("SELECT 1 FROM memory_event_sources s JOIN evidence_records e USING (evidence_id) WHERE e.source_id LIKE 'web-reading:%' LIMIT 1").get(), 210_000, "READING_MEMORY_NOT_FORMED");
    await verifyReadings(paths);
    await speak("你前些时候自己读的那篇文章，哪一点让你想记下来？如果方便，把出处也告诉我。", 0);
  }
  progress.result = "completed"; delete progress.error;
} catch (error) {
  progress.result = "incomplete";
  progress.error = String(error.message).replace(/https?:\/\/\S+/g, "[endpoint]").slice(0,220);
  process.exitCode = 1;
} finally {
  await app.close();
  progress.calls = [...(progress.calls ?? []), ...calls];
  if (db) {
    progress.maxDecisionRound = db.prepare("SELECT MAX(decision_round) AS n FROM executions").get().n;
    progress.batches = db.prepare("SELECT status,COUNT(*) AS n FROM memory_batches GROUP BY status").all();
    progress.reads = db.prepare("SELECT url,page_version,start_offset,end_offset,original_text,tool_call_id,model_call_id FROM web_reading_deliveries ORDER BY rowid").all();
    progress.events = db.prepare("SELECT event_id,title,summary,lifecycle_status FROM memory_events ORDER BY rowid").all();
    progress.activities = db.prepare("SELECT status,summary,shared_message_id FROM autonomy_activities ORDER BY rowid").all();
    progress.wakes = db.prepare("SELECT wake_id,kind,intent,scheduled_at,claimed_at,status,source_execution_id,task_id,last_error_code FROM autonomy_wakes ORDER BY rowid").all();
    progress.tools = db.prepare("SELECT tool_name,status,COUNT(*) AS n FROM tool_calls GROUP BY tool_name,status").all();
    if (scenario === "quiet") progress.restDecision = {
      shared: progress.activities.some(activity => activity.shared_message_id),
      acted: progress.tools.some(tool => tool.status === "success"),
      planned: progress.wakes.some(wake => wake.source_execution_id),
    };
    db.close();
  }
  save();
  console.log(JSON.stringify({ scenario, tier, result: progress.result, turns: progress.turns.length, error: progress.error }));
}
