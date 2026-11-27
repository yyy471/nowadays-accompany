// 从 backend/ 运行 Node 24 --import tsx ../apps/desktop/tests/media-live-check.mjs [sample|cosyvoice|indextts] [sample|comfy]。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp, listen } from "../../../backend/src/bootstrap/app.ts";
import { parseBackendConfig } from "../../../backend/src/bootstrap/config.ts";
import { httpClient, delay } from "../../../backend/scripts/eval/role-world-http-transport.mjs";
import { resolveElectronExecutable } from "../helpers/electron-executable.cjs";
import { backendDir, desktopDir, repoRoot as root, testResultsDir } from "../helpers/paths.cjs";
import { defaultComfyWorkflow } from "../../../backend/src/scene/comfyui-workflow.ts";

const [voiceMode = "sample", imageMode = "sample"] = process.argv.slice(2);
assert.ok(["sample", "cosyvoice", "indextts"].includes(voiceMode) && ["sample", "comfy"].includes(imageMode));
const output = path.join(testResultsDir, "desktop-media");
fs.mkdirSync(output, { recursive: true });
const out = fs.mkdtempSync(path.join(output, voiceMode + "-" + imageMode + "-"));
const report = { voiceMode, imageMode, textModel: "deterministic", checks: {}, errors: [] };
const save = () => fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2));
const signal = (name, result) => { report.checks[name] = result; save(); };
let backend, proc, ws, tts, seq = 0, log = "";
const waiting = new Map();
const speech1 = "你听，雨点已经落在窗台上了。", speech2 = "等雨小一点，我们再一起出门。";
async function until(name, test, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await delay(100);
  }
  throw Error("TIMEOUT_" + name);
}
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function click(selector, text) {
  const coords = await until("CLICK_" + (text ?? selector), () => ev(`(()=>{
    const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>!el.disabled && !el.closest('[inert]') && el.textContent.includes(${JSON.stringify(text ?? "")}));
    if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();
    if(!r.width || !r.height)return null;
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return hit && e.contains(hit) ? {x,y} : null;
  })()`));
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, ...coords, button: "left", ...(type === "mousePressed" ? { buttons: 1 } : {}), clickCount: 1 });
}
function diagnostic() {
  const state = window.__mediaCheck = { plays: [], speechRequests: [], waves: {}, blocked: [] };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    const item = { url: this.src, events: [], muted: this.muted, volume: this.volume };
    state.plays.push(item);
    for (const type of ["playing", "ended", "pause", "error"]) {
      this.addEventListener(type, () => item.events.push({ type, time: this.currentTime, duration: Number.isFinite(this.duration) ? this.duration : null }));
    }
    return play.apply(this, args);
  };
  document.addEventListener("securitypolicyviolation", event => state.blocked.push(event.violatedDirective));
  const fetchOriginal = window.fetch;
  window.fetch = function (url, ...args) {
    if (String(url).endsWith("/speech")) state.speechRequests.push(String(url));
    return fetchOriginal.call(this, url, ...args);
  };
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = create(blob);
    if (blob.type.startsWith("audio/")) void (async () => {
      try {
        const ctx = new OfflineAudioContext(1, 1, 48000);
        const wave = await ctx.decodeAudioData(await blob.arrayBuffer());
        const ch = wave.getChannelData(0);
        let sum = 0, peak = 0;
        for (const sample of ch) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
        state.waves[url] = { peak, rms: Math.sqrt(sum / ch.length), duration: wave.duration, channels: wave.numberOfChannels, bytes: blob.size };
      } catch (error) { state.waves[url] = { error: String(error) }; }
    })();
    return url;
  };
}
async function startSampleVoice() {
  const rate = 16000, samples = rate * 3, b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(3600 * Math.sin(i * 2 * Math.PI * 220 / rate)), 44 + i * 2);
  tts = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ protocol: "nowadays-tts-v1", service: "sample", model: "fixed-tone", ready: true,
        capabilities: { referenceModes: [], presetVoices: true, languages: ["zh"], speed: null } }));
    }
    if (req.url === "/voices") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ voices: [{ id: "sample", label: "样本音" }] }));
    if (req.url !== "/tts" || req.method !== "POST") return res.writeHead(404).end();
    for await (const _ of req) { /* 读完正式客户端发送的表单。 */ }
    res.writeHead(200, { "Content-Type": "audio/wav" }).end(b);
  });
  return "http://127.0.0.1:" + await listen(tts, 0, "127.0.0.1");
}
const model = { async *stream(req) {
  let reply = speech1 + "\n（她伸手接了一滴雨。）\n" + speech2;
  if (req.system.includes("segmentId") && req.system.includes("spriteAssetId")) {
    const input = JSON.parse(req.messages.at(-1).content);
    reply = JSON.stringify({ segments: input.segments.map((s, i) => ({ segmentId: s.segmentId,
      spriteAssetId: input.sprites[i % input.sprites.length].spriteAssetId, voiceEmotion: s.kind === "speech" ? "轻声聊天" : null })) });
  } else if (req.system.includes("过场图规划器")) {
    const input = JSON.parse(req.messages.at(-1).content);
    reply = JSON.stringify({ description: "窗边的旧木桌上放着一只蓝色玻璃杯，窗外是雨中的山坡。", draw: true,
      layerMode: input.requestedLayerMode ?? "background", startSegmentId: input.segments[0].segmentId, endSegmentId: input.segments.at(-1).segmentId });
  }
  yield { type: "text_delta", text: reply }; yield { type: "completed", stopReason: "stop" };
} };

async function main() {
  const ttsUrl = voiceMode === "sample" ? await startSampleVoice() : "http://127.0.0.1:9890";
  const cfg = parseBackendConfig(["--app-root", path.join(out, "app"), "--port", "0"]);
  backend = createBackendApp(cfg, { disablePresetAssistant: true, disableMemoryRuntime: true, modelPortFactory: () => model, sceneImageGenerationTimeoutMs: 480000 });
  const api = httpClient(await listen(backend.server, 0, "127.0.0.1"));
  const post = async (method, route, body) => (await api.request(method, route, body)).body;
  const role = await post("POST", "/v1/roles", { displayName: "雨声", definition: { text: "习惯听雨的角色" } });
  const rr = "/v1/roles/" + role.roleId, route = rr + "/windows/" + role.defaultWindowId;
  const attachment = path.join(backendDir, "assets/presets/xiacheng/outfits/default");
  const asset = file => new Blob([fs.readFileSync(path.join(attachment, file + ".png"))], { type: "image/png" });
  const outfitForm = new FormData(); outfitForm.append("name", "测试常服"); outfitForm.append("home", asset("home"), "home.png");
  for (const name of ["happy", "worried"]) outfitForm.append("sprites", asset("sprites/" + name), name + ".png");
  const outfit = await post("POST", rr + "/appearance/outfits", outfitForm);
  const before = await api.get(rr + "/state");
  await post("PUT", rr + "/state", { state: { ...before.state, outfitId: outfit.outfitId }, expectedVersion: before.version ?? before.stateVersion });
  await post("POST", rr + "/windows", { kind: "custom", source: "nowadays" });
  const resource = await post("POST", "/v1/resources", { kind: "model", name: "画面与分段样本", config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" } });
  await post("PUT", rr + "/bindings", { bindings: [{ capability: "chat_model", resourceId: resource.resourceId, modelName: "sample", enabled: true }] });
  const health = await (await fetch(ttsUrl + "/health")).json();
  const choices = (await (await fetch(ttsUrl + "/voices")).json()).voices;
  const preset = choices.find(v => voiceMode === "sample" || v.id.startsWith(voiceMode === "indextts" ? "index:" : "cosy:"));
  assert.ok(health.ready && preset);
  const { referenceModes, presetVoices, languages, speed } = health.capabilities;
  await post("PUT", rr + "/voice", { protocol: "nowadays-tts-v1", baseUrl: ttsUrl, language: "zh",
    capabilities: { referenceModes, presetVoices, languages, speed }, voiceSource: { kind: "preset", voiceId: preset.id },
    ...(voiceMode === "sample" ? {} : { ttsEngine: voiceMode }) });
  if (imageMode === "comfy") {
    const { service } = await post("POST", "/v1/image-services", { name: "本机 ComfyUI", config: { protocol: "comfyui", baseUrl: "http://127.0.0.1:8188" } });
    const workflow = defaultComfyWorkflow();
    workflow["12"] = { class_type: "LoadImage", inputs: { image: "anchor.png" } };
    workflow["13"] = { class_type: "ImageScale", inputs: { image: ["12", 0], upscale_method: "bicubic", width: 512, height: 512, crop: "center" } };
    workflow["14"] = { class_type: "VAEEncode", inputs: { pixels: ["13", 0], vae: ["3", 0] } };
    workflow["9"].inputs.latent_image = ["14", 0]; workflow["9"].inputs.denoise = 0.65;
    await post("PUT", rr + "/scene-image", { serviceId: service.serviceId, modelType: "img2img", modelPath: "moss_image_sft_int8_convrot.safetensors",
      autoGenerateEnabled: true, autoCooldownMinutes: 0,
      width: 512, height: 512, steps: 4, basePrompt: "雨天的手绘插画", workflow, outputNodeId: "11" });
    const ref = new FormData(); ref.append("image", asset("sprites/happy"), "character.png");
    await post("PUT", rr + "/scene-image/outfits/" + outfit.outfitId + "/reference", ref);
  }
  await post("POST", rr + "/activity/resume");
  const env = { ...process.env, NOWADAYS_SKIP_ROLE_PICKER: "1", NOWADAYS_BACKEND_URL: api.origin, NOWADAYS_APP_ROOT: cfg.appRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ["--no-sandbox", "--remote-debugging-port=0", "--user-data-dir=" + path.join(out, "profile"),
    desktopDir], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", b => { log = (log + b).slice(-18000); }); proc.stdout.resume();
  const debug = await until("ELECTRON", () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1]);
  const tab = await until("DESK", async () => (await (await fetch("http://127.0.0.1:" + debug + "/json/list")).json()).find(t => t.url.startsWith("desk://bundle/")));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data), job = waiting.get(msg.id);
    if (job) { waiting.delete(msg.id); msg.error ? job.reject(Error(msg.error.message)) : job.resolve(msg.result); }
  };
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "(" + diagnostic.toString() + ")();" });
  await ev("localStorage.setItem('nowadays-dialogue-voice','1')");
  await cdp("Page.reload", { ignoreCache: true });
  const openChat = async () => {
    await until("PAGE", () => ev("!!document.querySelector('.ui-page-dock')"));
    await click(".ui-dock-item", "对话");
    await until("CONNECTED", () => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open'"));
  };
  await openChat();
  await click("#dialogue-draft"); await cdp("Input.insertText", { text: "我们什么时候出门？" }); await click(".dialogue-send");
  const page = await until("THREE_ANNOTATED", async () => {
    const p = await api.get(route + "/messages");
    return p.segments?.length === 3 && p.segments.every(s => s.spriteAssetId) ? p : null;
  });
  const segments = page.segments.sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(segments.map(s => s.kind), ["speech", "narration", "speech"]);
  const activeSprite = async segment => until("SPRITE_" + segment.ordinal, () => ev(`(()=>{
    const i=document.querySelector('.dialogue-character img.active');
    return i?.currentSrc.includes(${JSON.stringify(segment.spriteAssetId)}) && i.complete && i.naturalWidth>0 &&
      getComputedStyle(i).opacity==='1' && {src:i.getAttribute('src'),width:i.naturalWidth,height:i.naturalHeight};
  })()`));
  const sprite = await activeSprite(segments[0]);
  const media = () => ev("window.__mediaCheck");
  const waitPlay = (index, type) => until("AUDIO_" + index + "_" + type, async () => {
    const st = await media(), play = st.plays[index];
    return play?.events.some(e => e.type === type) && { ...play, wave: st.waves[play.url] };
  }, 160000);
  const first = await waitPlay(0, "playing");
  await click(".dialogue-advance-primary");
  const secondSprite = await activeSprite(segments[1]);
  const ended = await waitPlay(0, "ended");
  assert.ok(ended.wave.rms > 0.0001 && ended.wave.peak > 0.01 && !first.muted && first.volume > 0);
  assert.ok(ended.events.find(e => e.type === "ended").time >= ended.wave.duration - 0.1);
  assert.equal((await media()).plays.length, 1);
  signal("automaticAndNarration", { first, ended, sprites: [sprite, secondSprite] });
  await click(".dialogue-advance-primary"); await activeSprite(segments[2]);
  const second = await waitPlay(1, "ended"); assert.ok(second.wave.rms > 0.0001);
  const narration = await ev("document.querySelector('.dialogue-direction')?.parentElement.querySelector('.dialogue-speaker')!==null");
  assert.equal(narration, false);
  assert.ok((await media()).speechRequests.every(url => !url.includes(segments[1].segmentId)));
  await click(".dialogue-speaker"); const manual = await waitPlay(2, "ended");
  assert.equal(manual.url, ended.url); signal("manual", manual);
  await click(".dialogue-speaker"); await waitPlay(3, "playing");
  await click(".dialogue-window-switch .ui-menu-trigger"); await click(".dialogue-window-switch [role=menuitemradio]", "页面窗口");
  const paused = await waitPlay(3, "pause"); assert.ok(!paused.events.some(e => e.type === "ended"));
  signal("windowChange", paused);
  await click(".dialogue-window-switch .ui-menu-trigger"); await click(".dialogue-window-switch [role=menuitemradio]", "主对话");
  await until("RESTORED_SPEECH", () => ev("!!document.querySelector('.dialogue-speaker')"));
  assert.ok((await media()).speechRequests.every(url => url.includes("/windows/" + role.defaultWindowId + "/")), "切窗口时不能向新窗口预取旧句段");
  const scenes = [];
  const showScene = async (mode, label) => {
    const trigger = imageMode === "comfy" && mode === "background" ? "auto" : "manual";
    if (trigger === "manual") {
      await click(".dialogue-round-tools button", "生成过场图");
      await click(".dialogue-scene-options button", mode === "background" ? "只换背景" : "人物与背景");
    }
    const ready = await until("SCENE_" + mode, async () => {
      const p = await api.get(route + "/messages");
      const scene = p.sceneImages.find(s => s.layerMode === mode && s.trigger === trigger);
      if (scene?.status === "failed" || scene?.status === "skipped") throw Error("GENERATION_" + (scene.errorCode ?? scene.status) + "_" + (scene.errorSummary ?? ""));
      return scene?.status === "succeeded" ? scene : false;
    }, imageMode === "comfy" ? 480000 : 45000);
    await click(".dialogue-round-tools button", label);
    const view = await sceneView(mode);
    await cdp("Page.captureScreenshot", { format: "png" }).then(({ data }) => fs.writeFileSync(path.join(out, mode + ".png"), Buffer.from(data, "base64")));
    await click(".dialogue-scene-dismiss");
    assert.ok(view.character, "背景和角色应保持各自的底层素材");
    assert.ok(view.src.includes(ready.result.assetId), "画面应使用此条生成记录的真实资产");
    if (mode === "full_scene") assert.ok(view.overlayAboveCharacter);
    scenes.push({ mode, trigger, id: ready.taskId, asset: ready.result, view });
    signal("scenes", scenes);
  };
  async function sceneView(mode) {
    return until("SCENE_PIXELS_" + mode, () => ev(`(()=>{
      const stage=document.querySelector('.dialogue-stage[data-scene="${mode}"]');
      const i=stage?.querySelector('${mode === "background" ? ".dialogue-background img.active" : ".dialogue-scene-full img"}');
      const character=stage?.querySelector('.dialogue-character img.active');
      return i?.complete && i.naturalWidth>0 && i.currentSrc.includes('/scene-images/') &&
        {src:i.getAttribute('src'),width:i.naturalWidth,height:i.naturalHeight,character:character?.getAttribute('src')??null,
         overlayAboveCharacter:!!stage.querySelector('.dialogue-scene-full') &&
           Number(getComputedStyle(stage.querySelector('.dialogue-scene-full')).zIndex)>Number(getComputedStyle(stage.querySelector('.dialogue-character')).zIndex)};
    })()`));
  }
  await showScene("background", "查看背景图"); await showScene("full_scene", "查看人物场景图");
  await cdp("Page.reload", { ignoreCache: true }); await openChat();
  const refreshed = [];
  for (const s of scenes) {
    await click(".dialogue-round-tools button", s.mode === "background" ? "查看背景图" : "查看人物场景图");
    const view = await sceneView(s.mode); assert.equal(view.src, s.view.src); refreshed.push(view);
    await click(".dialogue-scene-dismiss");
  }
  const restoredSprite = await activeSprite(segments[2]);
  signal("reload", { scenes: refreshed, sprite: restoredSprite });
  report.passed = true;
}
try { await main(); } catch (err) {
  report.errors.push(err.message);
  if (ws?.readyState === 1) {
    report.atFailure = await ev("({text:document.body.innerText.slice(-1400),media:window.__mediaCheck})").catch(() => null);
  }
  process.exitCode = 1;
} finally {
  save(); console.log(path.join(out, "result.json"), report.errors.join(" | "));
  if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: ++seq, method: "Browser.close" })); ws.close(); }
  await delay(300); if (proc?.exitCode === null) proc.kill();
  if (backend) await backend.close(); tts?.closeAllConnections(); tts?.close();
}
