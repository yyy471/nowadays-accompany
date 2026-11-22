// 在 backend/ 运行：Node 24 --import tsx ../apps/desktop/tests/memory-correction-real.mjs
// 用正式存储方法准备一份可重放的关系藏页，随后使用正式 HTTP、SQLite 与 Electron，不需要模型或密钥。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createBackendApp, listen } from "../../../backend/src/bootstrap/app.ts";
import { parseBackendConfig, rolePaths } from "../../../backend/src/bootstrap/config.ts";
import { registerMessageEvidence } from "../../../backend/src/storage/memory/evidence.ts";
import { MemoryStore } from "../../../backend/src/storage/memory/memory-store.ts";
import { RoleStorage } from "../../../backend/src/storage/core/role-storage.ts";
import { delay, httpClient } from "../../../backend/scripts/role-world-http-transport.mjs";
import { resolveElectronExecutable } from "../helpers/electron-executable.cjs";
import { desktopDir, repoRoot as root, testResultsDir } from "../helpers/paths.cjs";

const resultRoot = path.join(testResultsDir, "memory-correction");
fs.mkdirSync(resultRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(resultRoot, "desktop-"));
const config = parseBackendConfig(["--app-root", path.join(output, "app"), "--port", "0"]);
const original = "周四我把琥珀票夹交到图书馆失物台。";
const corrected = "票夹交给图书馆失物台，接收人是当班老师。";
const latestTitle = "登记遗失票夹";
const revisedSummary = "午间把归还的抄本送到阅览室。";
const oldClue = "票夹系着紫色缎带。";
const newClue = "票夹系着苔青棉带。";
const retiredClue = "票夹附有鹭羽吊牌。";
const competingClue = "票夹边缘有玄铜包角。";
const retainedClue = "票夹外层有云杉压纹。";
const patches = [], checks = {}, errors = [];
let app, db, proc, socket, browserLog = "", sequence = 0;
const jobs = new Map();

function prepare(role) {
  const paths = rolePaths(config.dataRoot, role.roleId);
  const storage = RoleStorage.openExisting(paths);
  try {
    const store = new MemoryStore(storage.business.db);
    function seed(day, title, summary, content = summary, clues = []) {
      const at = "2026-10-" + String(day).padStart(2, "0") + "T08:00:00.000Z";
      const { message } = storage.business.submitMessage(role.roleId, role.defaultWindowId,
        { content, sourcePlatform: "nowadays", submissionId: randomUUID() }, at);
      registerMessageEvidence(storage.business.db, { roleId: role.roleId, messageIds: [message.messageId],
        executionId: null, timeZone: "Asia/Shanghai", now: at });
      const evidence = store.listEvidence(role.roleId).find(item => item.sourceId === message.messageId);
      const event = store.createEvent({ roleId: role.roleId, title, summary, subjectiveExperience: "安心了。",
        occurredAtStart: at, occurredAtEnd: null, experienceDate: at.slice(0, 10), tags: {},
        evidenceIds: [evidence.evidenceId], currentRound: 0, now: at,
        claims: clues.map(text => ({ kind: "cherished_detail", text, evidenceId: evidence.evidenceId,
          sourceKind: "message", sourceSender: "user", learnedAt: at, sourceAt: at, recordedAt: at })) });
      return { eventId: event.eventId, evidenceId: evidence.evidenceId, messageId: message.messageId };
    }
    const historical = seed(1, "旧日的风铃", "那天帮同学找回风铃。");
    for (let day = 2; day <= 9; day++) seed(day, "校刊编辑会 " + day, "这周修改了标题。");
    const detail = seed(10, "票夹交接", "交给了值日学生。", original, [oldClue, retiredClue, competingClue, retainedClue]);
    const source = seed(11, "午间还书", "午间一同送还抄本。");
    const { summary } = store.refineEvent({ roleId: role.roleId, events: [{ eventId: source.eventId, expectedVersion: 1 }],
      topic: "抄本归还", summary: "把抄本留在走道。", now: "2026-10-11T09:00:00.000Z" });
    return { paths, detail, historical, summaryId: summary.summaryId };
  } finally { storage.close(); }
}

async function until(label, read) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await delay(80);
  }
  throw Error("等待超时：" + label);
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    jobs.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}
async function launch(origin) {
  const env = { ...process.env, NOWADAYS_APP_ROOT: config.appRoot, NOWADAYS_SKIP_ROLE_PICKER: "1", NOWADAYS_BACKEND_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  browserLog = "";
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ["--no-sandbox", "--remote-debugging-port=0",
    "--user-data-dir=" + path.join(output, "profile"), desktopDir], { env, windowsHide: true });
  proc.stderr.on("data", chunk => { browserLog += chunk; });
  const port = await until("Electron", () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(browserLog)?.[1]);
  const target = await until("桌面渲染器", async () => (await (await fetch("http://127.0.0.1:" + port + "/json/list")).json())
    .find(item => item.url.startsWith("desk://bundle/")));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const job = jobs.get(message.id);
    if (job) {
      jobs.delete(message.id);
      if (message.error) job.reject(Error(message.error.message)); else job.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evaluate(`window.testMouseClicks = []; document.addEventListener('click', event => {
    const target = event.target.closest('button,input,summary');
    if (target) window.testMouseClicks.push((target.innerText || target.value || target.tagName).slice(0, 100));
  }, true)`);
}
async function closeDesktop() {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: ++sequence, method: "Browser.close" })); socket.close();
  }
  if (proc?.exitCode === null) {
    const closed = new Promise(resolve => proc.once("exit", resolve));
    await Promise.race([closed, delay(1500)]);
    if (proc.exitCode === null) { proc.kill(); await closed; }
  }
  socket = undefined;
}
const element = selector => `document.querySelector(${JSON.stringify(selector)})`;
const items = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})]`;
const hasText = (selector, text) => `${items(selector)}.find(el=>el.textContent.includes(${JSON.stringify(text)}))`;
const field = label => `${hasText('[role="dialog"] label', label)}?.control`;
const waitFor = (label, expression) => until(label, () => evaluate(expression));
async function click(label, expression) {
  await waitFor(label, `!!(${expression}) && !(${expression}).disabled`);
  await evaluate(`(${expression}).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })`);
  const position = await waitFor(label + "可点击", `(() => {
    const el = (${expression});
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  })()`);
  await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...position });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...position });
}
const modalButton = name => hasText('[role="dialog"] button', name);
const clickModal = name => click(name, modalButton(name));
const clueControl = clue => `(${hasText('[role="dialog"] fieldset label', clue)})?.control`;
async function enter(label, text) {
  await waitFor(label, `!!(${field(label)})`);
  await evaluate(`(${field(label)}).focus(); (${field(label)}).select()`);
  await command("Input.insertText", { text });
  await waitFor(label, `(${field(label)}).value === ${JSON.stringify(text)}`);
}
async function snapshot(name) {
  await evaluate("Promise.allSettled(document.querySelector('[role=dialog]')?.getAnimations().map(animation => animation.finished) ?? [])");
  const { data } = await command("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(data, "base64"));
}
async function experiences() {
  await click("关系", hasText(".ui-dock-item", "关系"));
  await click("经历", element(".tab-experiences"));
  await waitFor("近期事件和摘要", `!!${hasText(".moment-title", "抄本归还")} && ${items("button.moment-open")}.length === 8`);
}
async function openEvent(title) {
  const opener = hasText("button.moment-open", title);
  await waitFor(title, `!!${opener}`);
  if (!await evaluate(`(${opener}).getAttribute("aria-expanded")==="true"`)) await click(title, opener);
}
async function waitClosed() {
  await waitFor("编辑器关闭", `!${element('[role="dialog"]')}`);
}
async function startBackend() {
  app = createBackendApp(config, { disablePresetAssistant: true });
  app.server.on("request", (req, res) => {
    if (req.method === "PATCH") res.once("finish", () => patches.push({ path: req.url, status: res.statusCode }));
  });
  return httpClient(await listen(app.server, 0, "127.0.0.1"));
}
async function main() {
  let api = await startBackend();
  const { body: role } = await api.request("POST", "/v1/roles", { displayName: "关系藏页测试角色", definition: { text: "喜欢校刊的同学。" } });
  await api.request("POST", "/v1/roles/" + role.roleId + "/activity/stop");
  const { paths, detail, historical, summaryId } = prepare(role);
  const memory = "/v1/roles/" + role.roleId + "/memory/";
  const eventPath = memory + "events/" + detail.eventId;
  const summaryPath = memory + "summaries/" + summaryId;
  const evidencePath = memory + "evidence/" + detail.evidenceId;
  db = new DatabaseSync(paths.businessDatabasePath, { readOnly: true });
  const evidenceBefore = await api.get(evidencePath);
  assert.equal(evidenceBefore.content, original);
  await launch(api.origin);
  await experiences();
  assert.equal(await evaluate(`!!${hasText(".moment-title", "旧日的风铃")}`), false);
  await openEvent("票夹交接");
  await click("看依据", element(".moment-detail .evidence-button"));
  await waitFor("更正前的原文", `!!${hasText(".evidence blockquote", original)}`);
  await click("更正经历", hasText(".moment-detail button", "更正经历"));
  await enter("事情经过", corrected);
  const before = await api.get(eventPath);
  await click("展开线索", element('[role="dialog"] details summary'));
  await click("选择待替换线索", clueControl(oldClue));
  await enter("替换为", newClue);
  await click("选择另一条线索", clueControl(competingClue));
  const concurrentlyRetired = before.claims.find(claim => claim.text === competingClue).claimId;
  await api.request("PATCH", eventPath, { expectedVersion: 1, patch: { title: latestTitle, summary: before.summary },
    supersedeClaimIds: [concurrentlyRetired] });
  await clickModal("保存更正");
  await waitFor("冲突并显示并发标题", `!!${hasText('section[aria-label="版本冲突"]', latestTitle)}`);
  assert.equal(await evaluate(`(${field("事情经过")}).value`), corrected);
  assert.equal(await evaluate(`(${modalButton("保存更正")}).disabled`), true);
  await evaluate(`${element('section[aria-label="版本冲突"]')}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await snapshot("conflict");
  await clickModal("保留我的修改，合并其余字段");
  assert.equal(await evaluate(`(${field("经历标题")}).value`), latestTitle);
  assert.equal(await evaluate(`(${field("事情经过")}).value`), corrected);
  assert.equal(await evaluate(`(${field("替换为")}).value`), newClue);
  assert.equal(await evaluate(`!!${clueControl(competingClue)}`), false);
  await clickModal("保存更正");
  await waitClosed();
  const updated = await api.get(eventPath);
  assert.deepEqual([updated.title, updated.summary, updated.subjectiveExperience, updated.version], [latestTitle, corrected, "安心了。", 3]);
  assert.deepEqual(updated.claims.map(c => c.text).sort(), [newClue, retiredClue, retainedClue].sort());
  assert.equal(updated.claims.find(c => c.text === newClue).correctionSource, "user_correction");
  await waitFor("保存后已展开的依据仍可读", `!!${hasText(".evidence blockquote", original)}`);
  await click("更正经历", hasText(".moment-detail button", "更正经历"));
  await click("展开线索", element('[role="dialog"] details summary'));
  await click("仅撤下线索", clueControl(retiredClue));
  await clickModal("保存更正"); await waitClosed();
  const after = await api.get(eventPath);
  assert.deepEqual([after.version, after.title, after.summary], [4, latestTitle, corrected]);
  assert.deepEqual(after.claims.map(c => c.text).sort(), [newClue, retainedClue].sort());
  for (const [query, included] of [["紫色缎带", false], ["鹭羽吊牌", false], ["玄铜包角", false], ["苔青棉带", true], ["云杉压纹", true]]) {
    const { body } = await api.request("POST", memory + "search", { types: ["event"], query });
    assert.equal(body.items.some(item => item.id === detail.eventId), included, query);
  }
  checks.event = { id: detail.eventId, version: after.version, title: after.title, summary: after.summary,
    currentClues: after.claims.map(c => c.text), originalClues: before.claims.map(c => c.text) };
  await click("更正摘要", hasText(".moment button", "更正摘要"));
  await enter("日常摘要", revisedSummary);
  await clickModal("保存更正");
  await waitClosed();
  const summary = await api.get(summaryPath);
  assert.equal(summary.summary, revisedSummary); assert.equal(summary.version, 2);
  checks.summary = { id: summaryId, version: summary.version, summary: summary.summary };
  await click("查找并更正记忆", hasText("#reading-content button", "查找并更正记忆"));
  await enter("记忆关键词", "风铃");
  await clickModal("查找");
  await clickModal("旧日的风铃");
  await enter("当时的感受", "下次还想帮忙。");
  await clickModal("保存更正");
  await waitClosed();
  const oldEvent = await api.get(memory + "events/" + historical.eventId);
  assert.equal(oldEvent.subjectiveExperience, "下次还想帮忙。");
  checks.historical = { id: historical.eventId, version: oldEvent.version, previouslyOutsidePreview: true };

  await closeDesktop();
  db.close(); db = undefined;
  await app.close(); app = undefined;
  api = await startBackend();
  db = new DatabaseSync(paths.businessDatabasePath, { readOnly: true });
  await launch(api.origin);
  await experiences();
  await openEvent(latestTitle);
  await click("看依据", element(".moment-detail .evidence-button"));
  await waitFor("重开后原文仍可读", `!!${hasText(".evidence blockquote", original)}`);
  await waitFor("重开后经历摘要与日常摘要", `!!${hasText(".moment-summary", corrected)} && !!${hasText(".moment-summary", revisedSummary)}`);
  await snapshot("reopened");
  await click("更正经历", hasText(".moment-detail button", "更正经历"));
  await waitFor("重开更正编辑器", `(${field("事情经过")})?.value === ${JSON.stringify(corrected)}`);
  assert.equal(await evaluate(`(${field("经历标题")}).value`), latestTitle);
  await click("重开线索", element('[role="dialog"] details summary'));
  assert.ok(await evaluate(`!!${clueControl(newClue)} && !!${clueControl(retainedClue)} && !${clueControl(oldClue)} && !${clueControl(retiredClue)}`));
  assert.ok(await evaluate(`!!${hasText('[role="dialog"] label', '用户更正 · ' + newClue)}`));
  await clickModal("取消"); await waitClosed();
  checks.reopenedDesktopAndBackend = true;
  assert.deepEqual(await api.get(evidencePath), evidenceBefore);
  const originalMessage = (await api.get("/v1/roles/" + role.roleId + "/windows/" + role.defaultWindowId + "/messages/" + detail.messageId)).message;
  assert.equal(originalMessage.content, original);
  checks.evidence = { evidenceId: detail.evidenceId, messageId: detail.messageId, content: evidenceBefore.content };
  const revisions = db.prepare("SELECT target_id, revision_number, base_revision, change_source FROM memory_revisions WHERE role_id=? AND change_source='user_correction' ORDER BY rowid").all(role.roleId);
  assert.deepEqual(revisions.map(r => [r.target_id, r.base_revision, r.revision_number]), [[detail.eventId,1,2], [detail.eventId,2,3], [detail.eventId,3,4], [summaryId,1,2], [historical.eventId,1,2]]);
  assert.ok(db.prepare("SELECT content_json FROM memory_revisions WHERE target_id=? AND revision_number=1").get(detail.eventId).content_json.includes(oldClue));
  checks.revisions = revisions;
  assert.deepEqual(patches.filter(r => r.path === eventPath).map(r => r.status), [200, 409, 200, 200]);
  assert.deepEqual(errors, []);
}
try {
  await main();
  checks.completed = true;
} catch (error) {
  checks.error = String(error.stack ?? error); process.exitCode = 1;
  if (socket?.readyState === WebSocket.OPEN) {
    checks.visibleOnFailure = await evaluate("document.body.innerText.slice(-3000)").catch(() => null);
    checks.clicksOnFailure = await evaluate("window.testMouseClicks").catch(() => null);
    await snapshot("failure").catch(() => undefined);
  }
} finally {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ...checks, patches, errors }, null, 2));
  console.log(JSON.stringify({ completed: !!checks.completed, output, error: checks.error }));
  await closeDesktop(); db?.close(); await app?.close();
}
