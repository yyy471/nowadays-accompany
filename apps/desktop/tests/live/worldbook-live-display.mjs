// 在 backend/ 下用 Node 24 --import tsx 运行。本测试复制已关闭的联调角色库，并启动正式后端与 Electron。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveElectronExecutable } from "../helpers/electron-executable.cjs";
import { backendDir, desktopDir, repoRoot as root, testResultsDir } from "../helpers/paths.cjs";
import { createBackendApp, listen } from "../../../backend/src/bootstrap/app.ts";
import { parseBackendConfig, rolePaths } from "../../../backend/src/bootstrap/config.ts";
import { configureProvider, delay, httpClient, nativeFetch, openEvents } from "../../../backend/scripts/eval/role-world-http-transport.mjs";
import { worldEntries } from "../../../backend/scripts/eval/role-world-scenarios.mjs";

const [source, credentials, roleName, tier = "deepseek"] = process.argv.slice(2);
if (!source || !credentials || !roleName || !["vertex", "deepseek"].includes(tier)) throw Error("FIXTURE_CREDENTIAL_PATH_ROLE_AND_TIER_REQUIRED");
const liveResults = path.join(testResultsDir, "role-world");
if (!fs.realpathSync(source).startsWith(fs.realpathSync(liveResults) + path.sep)) throw Error("EXPECTED_ISOLATED_LIVE_TEST_ROOT");
const out = fs.mkdtempSync(path.join(liveResults, "display-"));
const appRoot = path.join(out, "app");
fs.cpSync(source, appRoot, { recursive: true, errorOnExist: true });
const electronEnv = { ...process.env, NOWADAYS_SKIP_ROLE_PICKER: "1", NOWADAYS_APP_ROOT: appRoot };
delete electronEnv.ELECTRON_RUN_AS_NODE;
delete electronEnv.NOWADAYS_LIVE_ROLE_KEY;
const calls = [], samples = [], shots = new Map(), rounds = [], errors = [], pending = new Map();
let app, ledger, proc, socket, stream, seq = 0, childLog = "", lastScreen = "", failure = "", lastDisplayed;
async function until(label, fn, ms = 32000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(110);
  }
  throw Error("TIMEOUT_" + label);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function snap(file) {
  const {data} = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, file), Buffer.from(data, "base64"));
}
const currentView = `(() => {
  const row = [...document.querySelectorAll('.dialogue-message.assistant[data-segment-id]')].at(-1);
  const img = document.querySelector('.dialogue-character img.active');
  const bg = document.querySelector('.dialogue-background img.active');
  return { segment: row?.dataset.segmentId, text: row?.querySelector('.dialogue-bubble,.cue-text')?.textContent,
    src: img?.getAttribute('src'), width: img?.naturalWidth, height: img?.naturalHeight,
    visible: !!img?.complete && img.getBoundingClientRect().width > 0 && Number(getComputedStyle(img).opacity) >= 0.99
      && [...document.querySelectorAll('.dialogue-character img:not(.active)')].every(el=>Number(getComputedStyle(el).opacity)<=0.01),
    background: !!bg?.complete && bg.naturalWidth > 0, advance: !!document.querySelector('.dialogue-advance-primary'),
    compose: !!document.querySelector('#dialogue-draft') };
})()`;
async function run() {
  configureProvider(backendDir, tier, credentials, worldEntries, call => calls.push(call));
  app = createBackendApp(parseBackendConfig(["--app-root", appRoot, "--port", "0"]), {disablePresetAssistant:true});
  const port = await listen(app.server, 0, "127.0.0.1");
  const api = httpClient(port);
  const roles = (await api.get("/v1/roles")).items;
  const role = roles.find(item => item.displayName === roleName);
  assert.ok(role, "FIXTURE_ROLE_NOT_FOUND");
  const roleRoute = "/v1/roles/" + role.roleId;
  const route = roleRoute + "/windows/" + role.defaultWindowId;
  ledger = new DatabaseSync(rolePaths(path.join(appRoot,"data"),role.roleId).businessDatabasePath, {readOnly:true});
  const userExecution = ledger.prepare("SELECT e.execution_id AS id FROM messages m JOIN executions e ON e.execution_id=m.processed_by_execution_id OR e.trigger_message_id=m.message_id WHERE m.message_id=?");
  const outfits = (await api.get(roleRoute + "/appearance/outfits")).items;
  const assets = outfits.flatMap(outfit => outfit.sprites);
  assert.ok(assets.length >= 2, "TWO_SPRITE_ASSETS_REQUIRED");
  if ((await api.get(roleRoute + "/activity")).activity.state === "stopped") {
    await api.request("POST", roleRoute + "/activity/resume");
  }
  stream = await openEvents(api.origin, route, (await api.get(route + "/messages")).cursor, "desktop-display-observer");
  electronEnv.NOWADAYS_BACKEND_URL = api.origin;
  proc = spawn(resolveElectronExecutable({repoRoot:root}), ["--no-sandbox", "--remote-debugging-port=0",
    "--user-data-dir=" + path.join(out, "profile"), desktopDir], {
    env: electronEnv, windowsHide: true, stdio:["ignore","pipe","pipe"],
  });
  proc.stdout.on("data", data => { childLog += data; });
  proc.stderr.on("data", data => { childLog += data; });
  const debugPort = await until("ELECTRON", () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(childLog)?.[1]);
  const target = await until("RENDERER", async () => (await (await nativeFetch("http://127.0.0.1:" + debugPort + "/json/list")).json()).find(item => item.url.startsWith("desk://bundle/")));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {socket.onopen = resolve; socket.onerror = reject;});
  socket.onmessage = ({data}) => {
    const msg = JSON.parse(data);
    const job = pending.get(msg.id);
    if (job) { pending.delete(msg.id); msg.error ? job.reject(Error(msg.error.message)) : job.resolve(msg.result); }
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text);
  };
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await until("DOCK", () => evaluate("!!document.querySelector('.ui-page-dock')"));
  await evaluate("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('对话')).click()");
  const roleButton = ".dialogue-role-switch button";
  if (roles.length > 1) await until("ROLE_MENU", () => evaluate("!!document.querySelector('.dialogue-role-switch button')"));
  if (roles.length > 1 && !(await evaluate("document.querySelector('.dialogue-role-switch button').getAttribute('aria-label')")).includes(roleName)) {
    await evaluate("document.querySelector(" + JSON.stringify(roleButton) + ").click()");
    await evaluate("[...document.querySelectorAll('.dialogue-role-switch [role=menuitem]')].find(x=>x.textContent.includes(" + JSON.stringify(roleName) + ")).click()");
  }
  await until("SSE_CONNECTED", () => evaluate("document.querySelector('.dialogue-connection')?.dataset.state === 'open'"));
  const prompts = [
    "好消息！我在纸鹤书屋找回了外婆留给我的那本绝版画册，店员替我收了整整一周。我太开心了！对了，我想周三再去跟店员道谢，那天能去吗？",
    "刚出门我就找不到回家的钥匙了，包里每个夹层都翻遍了，我现在真有点慌。你陪我想想？",
    "钥匙找到了。顺便确认一件小事：纸鹤书屋虽然周三关店，但那盏鱼灯晚上到底亮不亮？你有准信吗？",
    "钥匙找到了！就在围巾的褶子里。我总算放下心了，给你看看我刚才笑得有多傻。",
    "我想不通，刚刚为什么明明摸到了围巾却没想到再翻一下？你觉得呢？",
  ];
  for (const input of prompts) {
    await until("INPUT", () => evaluate("!!document.querySelector('#dialogue-draft')"));
    const start = stream.events.length, wireStart = calls.length;
    const previous = new Set((await api.get(route + "/messages")).items.map(item => item.messageId));
    await evaluate("document.querySelector('#dialogue-draft').focus()");
    await cdp("Input.insertText", {text:input});
    await until("SEND_ENABLED", () => evaluate("!!document.querySelector('.dialogue-send:not(:disabled)')"));
    await evaluate("document.querySelector('.dialogue-send').click()");
    const accepted = await until("USER_PERSISTED", async () => (await api.get(route + "/messages")).items.find(
      m => !previous.has(m.messageId) && m.sender === "user" && m.content === input));
    const completed = await until("REPLY_VIA_SSE", () => {
      const matches = userExecution.all(accepted.messageId);
      const e = stream.events.slice(start).find(e=>["message_completed","execution_failed","execution_superseded"].includes(e.type) && matches.some(m=>m.id===e.executionId));
      if (e && e.type!=="message_completed") throw Error("NO_VISIBLE_REPLY_"+e.type+"_"+e.executionId);
      return e;
    }, 150000);
    const annotation = await until("ANNOTATION_FINISHED", () => ledger.prepare(
      "SELECT status,error_code AS error FROM model_calls WHERE execution_id=? AND call_kind='segment_annotation' AND status IN ('failed','succeeded')"
    ).get(completed.executionId), 75000);
    const page = await until("COMPLETED_SEGMENTS", async () => {
      const p = await api.get(route + "/messages");
      return p.segments.some(s => s.messageId === completed.messageId) ? p : false;
    }, 75000);
    const roundSegments = page.segments.filter(s => s.messageId === completed.messageId).sort((a,b) => a.ordinal-b.ordinal);
    assert.ok(page.items.some(m => !previous.has(m.messageId) && m.content === input && m.sender === "user"));
    const reply = page.items.find(m => m.messageId === completed.messageId);
    assert.equal(reply.status, "completed");
    const usage = await api.get(roleRoute + "/worldbooks/usage?executionId=" + completed.executionId);
    const frameStart = samples.length;
    for (let n=0; n<=roundSegments.length; n++) {
      const view = await until("SEGMENT_PAINT", async () => {
        const v = await evaluate(currentView);
        return roundSegments.some(s=>s.segmentId===v.segment) && (v.advance || v.compose) ? v : false;
      });
      const thisSegment = roundSegments.find(s=>s.segmentId===view.segment);
      const pose = roundSegments.filter(s=>s.ordinal <= thisSegment.ordinal && s.outfitId === thisSegment.outfitId && s.spriteAssetId).at(-1)?.spriteAssetId;
      assert.equal(view.text, thisSegment.text);
      if (pose) {
        const painted = await until("REAL_POSE_" + thisSegment.ordinal, async () => {
          const v = await evaluate(currentView);
          return v.src?.endsWith("/" + pose) && v.segment === thisSegment.segmentId && v.width && v.height && v.visible && v.background ? v : false;
        });
        const asset = assets.find(a => a.assetId === pose);
        assert.ok(asset, "UNKNOWN_DISPLAY_ASSET");
        const response = await nativeFetch(api.origin + painted.src);
        assert.equal(response.status,200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.deepEqual([...bytes.subarray(0,8)], [137,80,78,71,13,10,26,10]);
        const sha = createHash("sha256").update(bytes).digest("hex");
        samples.push({segmentId:view.segment,assetId:pose,name:asset.displayName,sha,width:painted.width,height:painted.height,text:view.text});
        if (!shots.has(sha)) {
          const file = "expression-" + (shots.size+1) + ".png";
          await snap(file); shots.set(sha,file);
        }
        lastDisplayed = {segmentId:view.segment,assetId:pose};
      } else if (thisSegment.homeAssetId) {
        const home = thisSegment.homeAssetId;
        await until("HOME_FALLBACK", async () => {
          const v = await evaluate(currentView);
          return v.segment === thisSegment.segmentId && v.src?.endsWith("/" + home) && v.visible;
        });
        lastDisplayed = {segmentId:view.segment,assetId:home};
      }
      if (!view.advance) break;
      await evaluate("document.querySelector('.dialogue-advance-primary').click()");
      await until("NEXT_SEGMENT", async () => (await evaluate(currentView)).segment !== view.segment);
    }
    const events = stream.events.slice(start).filter(e => e.executionId === completed.executionId);
    assert.ok(events.some(e=>e.type==="message_delta"));
    if (roundSegments.some(s=>s.spriteAssetId)) assert.ok(events.some(e=>e.type==="segment_annotations"));
    const received = calls.slice(wireStart).filter(c=>c.purpose==="chat" && c.http===200);
    assert.ok(received.length, "MODEL_RECEIPT_REQUIRED");
    if (!rounds.length) {
      assert.ok(usage.items.some(i => i.status === "included" && i.entryId === "east-bookshop"), "WORLD_USAGE_REQUIRED");
      assert.ok(received.some(c=>c.world.includes("东门旧书店")), "WORLD_WIRE_REQUIRED");
    }
    rounds.push({input,userMessageId:accepted.messageId,replyMessageId:reply.messageId,reply:reply.content,executionId:completed.executionId,events:[...new Set(events.map(e=>e.type))],
      delivered:usage.items,provider:received,annotation,segments:roundSegments.length,painted:samples.length-frameStart});
    if (rounds.length >= 3 && shots.size >= 2) break;
  }
  await cdp("Page.reload");
  await until("RELOADED_DOCK", () => evaluate("!!document.querySelector('.ui-page-dock')"));
  if (!await evaluate("!!document.querySelector('.dialogue-page')")) {
    await evaluate("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('对话')).click()");
  }
  assert.ok(lastDisplayed);
  await until("HISTORY_RELOAD", async () => (await evaluate(currentView)).segment === lastDisplayed.segmentId);
  await until("IMAGE_RELOAD", async () => { const v=await evaluate(currentView); return v.src?.endsWith("/"+lastDisplayed.assetId) && v.visible; });
  await snap("after-reload.png");
  assert.ok(shots.size >= 2, "TWO_DISTINCT_VISIBLE_IMAGES_REQUIRED");
  assert.deepEqual(errors, []);
}
try {
  await run();
  console.log(JSON.stringify({output:out,rounds:rounds.length,sprites:shots.size}));
} catch (error) {
  failure = String(error);
  if (socket?.readyState === 1) {
    lastScreen = await evaluate("document.body.innerText.slice(-1600)").catch(()=>"");
    await snap("failure.png").catch(()=>{});
  }
  console.error(String(error), out);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out,"display.json"),JSON.stringify({passed:!process.exitCode,rounds,samples,images:Object.fromEntries(shots),errors,failure,lastScreen},null,2));
  if(socket?.readyState===1) {socket.send(JSON.stringify({id:++seq,method:"Browser.close"}));socket.close();}
  await delay(300);
  if(proc?.exitCode===null) proc.kill();
  if(stream) await stream.close();
  ledger?.close();
  if(app) await app.close();
  delete process.env.NOWADAYS_LIVE_ROLE_KEY;
}
