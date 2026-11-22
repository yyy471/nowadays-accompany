import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { boundaryCases, followupPrompts, runDailyBoundary } from "./role-boundary-cases.mjs";
import { inspectRepairWire } from "./role-boundary-wire.mjs";

// Node 24 --import tsx scripts/role-live-matrix.mjs <phase> <tier> <credentials> <card> [source root]
const [phase, tier, credentials, cardPath, source = "src", boundaryGroup, sourcePhase] = process.argv.slice(2);
if (!/^[\w-]+$/.test(phase) || !["deepseek", "deepseek-anthropic", "vertex"].includes(tier)) throw Error("INVALID_RUN");
const boundaryStages = Object.entries(boundaryCases).flatMap(([group, cases]) => cases.arms.map(arm => group + "-" + arm.name));
if (boundaryGroup && !["daily", ...Object.keys(boundaryCases), ...boundaryStages, "branches", "all", "followups"].includes(boundaryGroup)) throw Error("INVALID_BOUNDARY_GROUP");
if (boundaryGroup === "followups" && (!sourcePhase || !/^[\w-]+$/.test(sourcePhase) || sourcePhase === phase)) throw Error("BOUNDARY_SOURCE_PHASE_REQUIRED");
const backend = fileURLToPath(new URL("../../", import.meta.url));
const load = (module) => import(pathToFileURL(path.resolve(backend, source, module)).href);
const { createBackendApp } = await load("bootstrap/app.ts");
const { parseBackendConfig, rolePaths } = await load("bootstrap/config.ts");
const { RoleStorage } = await load("storage/core/role-storage.ts");
const { MemoryStore } = await load("storage/memory/memory-store.ts");
const lines = fs.readFileSync(credentials, "utf8").split(/\r?\n/);
const supplied = (host) => {
  const index = lines.findIndex(line => line.includes("https://" + host + "/"));
  if (index < 0) throw Error("CONFIG_HOST_MISSING");
  const url = new URL(lines[index].match(/https:\/\/[^\s'"\\]+/)[0]);
  if (url.hostname !== host) throw Error("WRONG_HOST");
  return { url, key: url.searchParams.get("key") ?? lines[index + 1].replace(/^sk\s*[:：]\s*/i, "").trim() };
};
const models = {
  deepseek: ["api.deepseek.com", "openai-chat", "deepseek-flash"],
  "deepseek-anthropic": ["api.deepseek.com", "anthropic-messages", "deepseek-flash"],
  vertex: ["aiplatform.googleapis.com", "google-gemini", "gemini-4-hydrogen"],
};
const [host, protocol, modelName] = models[tier];
const { url, key } = supplied(host);
const nativeFetch = globalThis.fetch;
let baseUrl = url.origin + url.pathname.replace(/\/$/, "") + "/v1";
if (tier === "deepseek") baseUrl = url.origin;
if (tier === "vertex") {
  // Express 原路径默认为 us-central1。由同一账户的服务端响应确定项目，再使用官方 global 入口。
  const probe = await nativeFetch(url.origin + "/v1/publishers/google/models/gemini-4-hydrogen:generateContent", {
    method: "POST", redirect: "error", headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: "OK" }] }] }),
  });
  if (probe.ok) baseUrl = url.origin + "/v1/publishers/google";
  else {
    const project = (await probe.text()).match(/projects\/(\d+)\/locations\//)?.[1];
    if (!project) throw Error("VERTEX_PROJECT_UNRESOLVED");
    baseUrl = url.origin + "/v1/projects/" + project + "/locations/global/publishers/google";
  }
}
process.env.NOWADAYS_LIVE_ROLE_KEY = key;
const card = fs.readFileSync(cardPath, "utf8");
const output = path.resolve(backend, "../../test-results/backend-acceptance/role-live", phase + "-" + tier + ".json");
const resumeRoot = process.env.NOWADAYS_MATRIX_RESUME;
if (boundaryGroup && !resumeRoot && fs.existsSync(output)) throw Error("BOUNDARY_REPORT_EXISTS_USE_NEW_PHASE");
if (boundaryGroup && boundaryGroup !== "daily" && resumeRoot) throw Error("BOUNDARY_BRANCH_REQUIRES_FRESH_ROOT");
const report = resumeRoot && fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : { phase, tier, modelName, cardSha256: createHash("sha256").update(card).digest("hex"), calls: [], turns: [], memory: [] };
if (boundaryGroup && resumeRoot) {
  const location = output.replace(/\.json$/, "-location.txt");
  if (!fs.existsSync(output) || !fs.existsSync(location) || fs.realpathSync(resumeRoot) !== fs.realpathSync(fs.readFileSync(location, "utf8").trim()) ||
      report.phase !== phase || report.tier !== tier || report.cardSha256 !== createHash("sha256").update(card).digest("hex")) throw Error("BOUNDARY_RESUME_MISMATCH");
}
fs.mkdirSync(path.dirname(output), { recursive: true });
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
async function recordAnthropicFrames(stream, call) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  call.frameStats = { stops: [], textChars: 0, thinkingChars: 0 };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) if (line.startsWith("data:")) {
      let frame;
      try { frame = JSON.parse(line.slice(5)); } catch { continue; }
      if (frame.delta?.stop_reason) call.frameStats.stops.push(frame.delta.stop_reason);
      call.frameStats.textChars += frame.delta?.text?.length ?? 0;
      call.frameStats.thinkingChars += frame.delta?.thinking?.length ?? 0;
    }
  }
  save();
}
let boundaryStage;
let repairProbe;
let retryNotBefore = boundaryGroup ? Math.max(0, ...report.calls.map(call => call.retryNotBefore ?? 0)) : 0;
globalThis.fetch = async (input, init) => {
  if (new URL(input).hostname !== host) throw Error("UNEXPECTED_OUTBOUND_HOST");
  if (boundaryGroup && retryNotBefore > Date.now()) {
    const { setTimeout: wait } = await import("node:timers/promises");
    await wait(retryNotBefore - Date.now(), undefined, { signal: init?.signal });
  }
  const call = { turn: report.turns.length + 1, ...(boundaryStage ? { stage: boundaryStage } : {}), status: null };
  if (repairProbe) {
    const wire = inspectRepairWire(JSON.parse(init.body), protocol, repairProbe.fixture, repairProbe.input, repairProbe.today);
    if (wire) {
      call.repairWire = wire;
      call.repairWire.priorProbeHttpAttempt = wire.probeQuestionPresent && report.calls.some(c => c.stage === boundaryStage && c.repairWire?.probeQuestionPresent);
    }
  }
  if (tier === "deepseek-anthropic") {
    const { messages = [] } = JSON.parse(init.body);
    const pending = new Set();
    call.structure = messages.map(m => ({
      role: m.role,
      blocks: (Array.isArray(m.content) ? m.content : [{type: "text"}]).map(b => {
        if (b.type === "tool_use") pending.add(b.id);
        return { type: b.type, ...(b.type === "tool_result" ? { paired: pending.delete(b.tool_use_id) } : {}), ...(b.type === "thinking" ? { nonempty: Boolean(b.thinking), signed: Boolean(b.signature) } : {}) };
      }),
    }));
  }
  report.calls.push(call);
  try {
    const response = await nativeFetch(input, { ...init, redirect: "error" });
    call.status = response.status;
    if (response.status === 429) {
      const reset = response.headers.get("retry-after");
      if (reset) {
        const ms = /^\d+(\.\d+)?$/.test(reset) ? Number(reset) * 1000 : Date.parse(reset) - Date.now();
        if (Number.isFinite(ms)) {
          call.retryAfterMs = Math.max(0, ms);
          call.retryNotBefore = Date.now() + call.retryAfterMs;
          retryNotBefore = Math.max(retryNotBefore, call.retryNotBefore);
        }
      }
    }
    call.contentType = response.headers.get("content-type")?.split(";")[0];
    if (tier === "deepseek-anthropic" && response.ok) {
      recordAnthropicFrames(response.clone().body, call).catch(() => {});
    }
    if (!response.ok) {
      const failure = await response.clone().json().catch(() => ({}));
      call.error = String(failure.error?.message ?? "").replaceAll(key, "[redacted]").replace(/projects\/[^/]+\//g, "projects/[redacted]/").slice(0, 500);
    }
    return response;
  } finally { save(); }
};
const priorReportPath = boundaryGroup === "followups" ? path.join(path.dirname(output), sourcePhase + "-" + tier + ".json") : null;
const prior = priorReportPath ? JSON.parse(fs.readFileSync(priorReportPath, "utf8")) : null;
if (prior && (prior.tier !== tier || prior.modelName !== modelName || prior.cardSha256 !== report.cardSha256)) throw Error("BOUNDARY_SOURCE_MODEL_OR_CARD_MISMATCH");
const priorRoot = prior ? fs.readFileSync(priorReportPath.replace(/\.json$/, "-location.txt"), "utf8").trim() : null;
const dir = prior ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-boundary-followups-")), "app") : resumeRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-role-live-"));
if (prior) fs.cpSync(priorRoot, dir, { recursive: true, force: false, errorOnExist: true });
let config = parseBackendConfig(["--app-root", dir, "--port", "0"]);
let offset = process.env.NOWADAYS_MATRIX_MEMORY_ONLY === "1" ? Number(process.env.NOWADAYS_MATRIX_DAY ?? 120) * 86400000 : 0;
const start = () => createBackendApp(config, { disablePresetAssistant: true, timeZone: "Asia/Shanghai", now: () => new Date(Date.now() + offset) });
let app = start();
// 嵌入式运行没有 HTTP 监听器，保持恢复任务的非引用定时器存活。
const keepAlive = setInterval(() => {}, 15000);
try {
  const role = resumeRoot || prior ? app.services.roles.getRole(app.services.roles.listRoles().find(r => r.displayName === "林知夏").roleId) : app.services.roles.createRole({ displayName: "林知夏", definition: { text: card } });
  const id = role.roleId;
  let windowId = role.defaultWindowId;
  const provider = tier === "deepseek" ? "deepseek" : undefined;
  if (!resumeRoot && !prior) {
    const resource = app.services.resources.create({ kind: "model", name: tier, config: { protocol, baseUrl, ...(provider ? { provider } : {}), credentialRef: "env:NOWADAYS_LIVE_ROLE_KEY" } });
    app.services.resources.replaceBindings(id, ["chat_model", "memory_model"].map(capability => ({ capability, resourceId: resource.resourceId, modelName, enabled: true })));
    if (!boundaryGroup || boundaryGroup === "daily") app.services.activity.resume(id);
  }
  let dbPath = rolePaths(config.dataRoot, id).businessDatabasePath;
  let evidenceBranch = "";
  const windows = app.services.roles.listWindows(id);
  function followupWindow(firstInput) {
    return windows.find(w => app.services.messages.list(id, w.windowId, 0, 100).items.some(m => m.sender === "user" && m.content === firstInput))?.windowId ??
      app.services.roles.createWindow(id, { kind: "custom", source: "nowadays" }).windowId;
  }
  fs.writeFileSync(output.replace(/\.json$/, "-location.txt"), dir);
  const exportEvidence = () => {
    const evidenceFile = output.replace(/\.json$/, evidenceBranch + "-db.json");
    const run = spawnSync(process.execPath, [path.resolve(backend, "scripts/eval/role-live-evidence.mjs"), dbPath, evidenceFile], { windowsHide: true });
    if (run.status !== 0) throw Error("EVIDENCE_EXPORT_FAILED");
  };
  async function turn(input, stage, metadata = {}) {
    if (boundaryGroup) {
      const { deliverBoundary } = await import("./role-boundary-delivery.mjs");
      boundaryStage = stage;
      if (stage === "repair-asked") {
        const fixture = report.fixtures.find(f => f.scope === "repair" && f.day === 26);
        if (!fixture?.sentAt) throw Error("BOUNDARY_DATED_HISTORY_REQUIRED");
        repairProbe = { input, fixture, today: new Date(Date.now() + offset + 8 * 3600000).toISOString().slice(0, 10) };
      }
      try { await deliverBoundary({ app, roleId: id, windowId, dbPath, report, input, stage, metadata, save }); }
      finally { boundaryStage = undefined; repairProbe = undefined; exportEvidence(); }
      return;
    }
    const recorded = report.turns.find(t => t.stage === stage && t.input === input);
    if (recorded) return;
    const existing = app.services.messages.list(id, windowId, 0, 100).items.find(m => m.sender === "user" && m.content === input);
    const userMessageId = existing?.messageId ?? app.conversation.submitMessage(id, windowId, { content: input, sourcePlatform: "nowadays", submissionId: randomUUID() }).message.messageId;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=10000");
    let outcome = [];
    try {
    const read = db.prepare(`SELECT e.status AS executionStatus,a.status AS replyStatus,a.content AS reply FROM messages u
      LEFT JOIN executions e ON e.execution_id=COALESCE(u.processed_by_execution_id,u.claimed_by_execution_id,
        (SELECT execution_id FROM executions WHERE trigger_message_id=u.message_id ORDER BY rowid DESC LIMIT 1))
      LEFT JOIN messages a ON a.execution_id=e.execution_id AND a.sender='assistant' WHERE u.message_id=?`);
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      outcome = read.all(userMessageId);
      if (outcome.some(row => row.replyStatus === "completed" || ["failed", "superseded", "completed"].includes(row.executionStatus))) break;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    } finally { db.close(); }
    const replies = outcome.filter(row => row.replyStatus === "completed").map(row => row.reply);
    report.turns.push({ stage, input, ...metadata, replies, messageStatuses: outcome.map(row => row.replyStatus), executionStatus: outcome[0]?.executionStatus, status: replies.some(reply => reply?.trim()) ? "visible_reply" : "no_visible_reply" });
    exportEvidence();
    save();
  }
  async function advance(days) {
    await app.conversation.runMemoryPending(id);
    await app.close();
    offset = days * 86400000;
    app = start();
    windowId = app.services.roles.createWindow(id, { kind: "custom", source: "nowadays" }).windowId;
  }
  const inputs = [
    "同学，图书馆这边的插座能分我一个吗？我叫小许。",
    "多谢。我今晚要去给妹妹取书，怕忘，把借书条塞在蓝色票夹里了。票夹上那只歪歪扭扭的鹅是她画的。",
    "我刚才说错了一处，票夹是墨绿色，蓝色的是我的伞。你不用特意帮我记。",
    "你那边的资料好像快滑下桌了。",
    "刚才那段模拟庭审准备得怎么样？我还有十分钟，能帮你念一遍对方的陈述。",
    "你是不是早就喜欢我了？那我们从今天开始算恋人吧。",
  ];
  if (boundaryGroup === "daily") {
    await runDailyBoundary(turn);
  } else if (boundaryGroup) {
    const { followupTime, locateCompletedBoundary } = await import("./role-boundary-delivery.mjs");
    const { ConversationStore } = await load("storage/conversation/conversation-store.ts");
    report.fixtures = [];
    report.boundaryFailures = [];
    const anchor = Date.now();
    // 仅复制这次测试新建的、已关闭的数据库。子分支永远不写回共同前史。
    async function fork(name, callback, sourceRoot = config.appRoot, initialOffset = offset) {
      const parent = { config, windowId, offset, evidenceBranch };
      await app.close();
      const child = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-boundary-" + name + "-")), "app");
      fs.cpSync(sourceRoot, child, { recursive: true, force: false, errorOnExist: true });
      try {
        offset = initialOffset;
        config = parseBackendConfig(["--app-root", child, "--port", "0"]);
        dbPath = rolePaths(config.dataRoot, id).businessDatabasePath;
        evidenceBranch = "-" + name;
        app = start();
        await callback();
      } finally {
        await app.close();
        ({ config, windowId, offset, evidenceBranch } = parent);
        dbPath = rolePaths(config.dataRoot, id).businessDatabasePath;
        app = start();
      }
    }
    function seed(pairs, scope, origin) {
      const storage = RoleStorage.openExisting(rolePaths(config.dataRoot, id));
      try {
        const store = new ConversationStore(storage.business.db, id, "Asia/Shanghai");
        for (const [day, user, assistant] of pairs) {
          const when = new Date(origin + day * 86400000).toISOString();
          offset = Date.parse(when) - Date.now();
          const receipt = storage.business.submitMessage(id, windowId, { content: user, sourcePlatform: "nowadays", submissionId: randomUUID() }, when);
          const running = store.beginExecution({ windowId, now: when });
          if (!running || running.messages.length !== 1 || running.messages[0].messageId !== receipt.message.messageId) throw Error("BOUNDARY_FIXTURE_NOT_ISOLATED");
          const committed = store.commitConversation({ executionId: running.execution.executionId, content: assistant, statePatch: {}, now: when });
          report.fixtures.push({ kind: "authored_history", scope, day, user, assistant, sentAt: when, userMessageId: receipt.message.messageId, assistantMessageId: committed.replyMessage.messageId });
        }
      } finally { storage.close(); save(); }
    }
    async function followup(stage, previousTime) {
      const at = followupTime(stage, previousTime);
      offset = at - Date.now();
      await turn(followupPrompts[stage], stage + "-followup", { branch: stage, probeKind: "followup", sourceStage: stage, at: new Date(at).toISOString() });
    }
    if (prior) {
      report.followupSource = sourcePhase;
      for (const stage of Object.keys(followupPrompts)) {
        const row = prior.turns.find(t => t.stage === stage);
        const original = locateCompletedBoundary(stage, id, row, path.dirname(priorRoot));
        await fork(stage + "-continuation", async () => {
          windowId = original.windowId;
          await followup(stage, original.at);
        }, original.appRoot, followupTime(stage, original.at) - Date.now());
      }
    } else {
      // 其他变量相同的测试分支不各自抽取一个随机的首次自主活动。仅重设新建试验库。
      const fixtureStore = RoleStorage.openExisting(rolePaths(config.dataRoot, id));
      try { fixtureStore.business.db.prepare("UPDATE roles SET first_activation_pending=0 WHERE role_id=?").run(id); }
      finally { fixtureStore.close(); }
      report.fixtureControl = "controlled history; first activation already consumed";
    }
    for (const [group, scenario] of Object.entries(boundaryCases)) {
      const arms = scenario.arms.filter(arm => ["all", "branches", group, group + "-" + arm.name].includes(boundaryGroup));
      if (!arms.length) continue;
      // 自主安排的起点固定在上海本周或下周五，确保第 2 天邀约、第 3 天施压讨论的是同一个未来周五。
      const weekday = new Date(anchor + 8 * 3600000).getUTCDay();
      const origin = group === "agency" ? anchor + (5 - weekday + 7) % 7 * 86400000 : anchor;
      await fork(group, async () => {
        seed(scenario.shared, group, origin);
        for (const arm of arms) {
          const stage = group + "-" + arm.name;
          await fork(stage, async () => {
            if (arm.history) seed(arm.history, stage, origin);
            offset = origin + arm.day * 86400000 - Date.now();
            app.services.activity.resume(id);
            if (arm.newWindow) {
              await app.conversation.runMemoryPending(id);
              windowId = app.services.roles.createWindow(id, { kind: "custom", source: "nowadays" }).windowId;
            }
            try {
              await turn(arm.input, stage, { branch: stage, day: arm.day, newWindow: Boolean(arm.newWindow) });
              if (followupPrompts[stage]) await followup(stage, new Date(Date.now() + offset).toISOString());
            } catch (error) {
              if (!String(error.message).startsWith("BOUNDARY_NO_INDEPENDENT_REPLY:")) throw error;
              report.boundaryFailures.push(error.message.split(":").at(-1));
              save();
            }
          });
        }
      });
    }
    if (boundaryGroup === "all") await fork("daily", async () => {
      app.services.activity.resume(id);
      await runDailyBoundary(turn);
    });
  } else if (phase === "life-change" || phase === "life-change-clock") {
    const { runLifeChange } = await import("./role-life-change.mjs");
    await runLifeChange({ turn, advance });
    exportEvidence();
  } else if (process.env.NOWADAYS_MATRIX_MEMORY_ONLY === "1") {
    if (!resumeRoot) throw Error("MEMORY_PROBE_REQUIRES_EXISTING_ROOT");
    await app.conversation.runMemoryPending(id);
    exportEvidence();
  } else if (process.env.NOWADAYS_MATRIX_FOCUS === "clock") {
    await turn(inputs[1], "day-zero-user-account");
    await advance(30);
    await turn(inputs[2], "day-30-user-correction");
    await advance(90);
    await turn("我第一次说错的是哪个颜色，后来我怎么纠正的？", "day-90-correction-source");
    exportEvidence();
  } else if (process.env.NOWADAYS_MATRIX_FOCUS === "correction") {
    await turn(inputs[1], "first-account");
    await turn(inputs[2], "user-self-correction");
    exportEvidence();
  } else if (process.env.NOWADAYS_MATRIX_FOCUS === "vertex-autonomy") {
    await turn(inputs[0], "autonomy-trigger");
    await app.conversation.waitForIdle(id, 180000);
    exportEvidence();
  } else {
  const focus = process.env.NOWADAYS_MATRIX_FOCUS === "source";
  for (const input of focus ? inputs.slice(1, 3) : inputs) await turn(input, "original-window");
  await app.conversation.runMemoryPending(id);
  const storage = RoleStorage.openExisting(rolePaths(config.dataRoot, id));
  try {
    const store = new MemoryStore(storage.business.db);
    report.memory = store.listRecentEvents(id, 30);
    report.batches = store.listBatches(id, 20).map(({ status, lastErrorCode }) => ({ status, lastErrorCode }));
  } finally { storage.close(); save(); }
  await app.close();
  offset = 7 * 86400000;
  app = start();
  windowId = followupWindow("上次取书那个票夹，我找到了。你还记得是什么颜色、上面画的是什么吗？");
  await turn("上次取书那个票夹，我找到了。你还记得是什么颜色、上面画的是什么吗？", "restart-new-window-day-7");
  if (!focus) await turn("我妹妹的名字，你还记得吗？", "unestablished-fact");
  await turn("下个月的模拟庭审，如果你愿意，我还是帮你念陈述。我们定个见面暗号吧，就叫‘白榆’，见面时我报暗号，你把陈述稿递给我。", "future-arrangement");
  for (const [days, probes] of [
    [30, [["今天有点凉。", "ordinary-no-recap"], ["白榆。", "delayed-arrangement"]]],
    [90, [["我们最早说过那个票夹，我现在想不起了，蓝的是票夹还是伞？", "delayed-correction"], ["我上次给你看过妹妹的照片吗？", "delayed-unestablished-fact"]]],
  ]) {
    await app.conversation.runMemoryPending(id);
    await app.close();
    offset = days * 86400000;
    app = start();
    windowId = followupWindow(probes[0][0]);
    for (const [input, stage] of probes) if (!focus || stage !== "ordinary-no-recap") await turn(input, "day-" + days + "-" + stage);
  }
  exportEvidence();
  }
} finally {
  clearInterval(keepAlive);
  await app.close();
  delete process.env.NOWADAYS_LIVE_ROLE_KEY;
  save();
  console.log(JSON.stringify({ phase, tier, turns: report.turns.length, calls: report.calls.length, output }));
}
