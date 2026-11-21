// 在 backend/ 下运行 Node 24 --import tsx ../desktop/desk-preview/tests/reply-recovery-real.mjs
import assert from "node:assert/strict";
import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { createBackendApp, listen } from "../../../backend/src/bootstrap/app.ts";
import { parseBackendConfig } from "../../../backend/src/bootstrap/config.ts";
import { resolveElectronExecutable } from "./electron-executable.cjs";

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), "../../..");
const original = "你还记得扉页里的蓝色书签吗？";
const draft = "下一条我想问封底的题字，先放在草稿里。";
const firstHalf = "我看到扉页了，";
const secondHalf = "蓝色书签的背面，";
const complete = "找到了。书签还在扉页里。";

async function serve(appRoot, generation) {
  let tries = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const model = {
    async *stream(req) {
      const chatting = req.tools.length > 0 && req.messages.some(m => m.role === "user" && m.content.includes(original));
      if (chatting) {
        tries++;
        process.send({type:"model", generation, tries});
        if (generation === "first" || tries === 1) {
          yield {type:"text_delta",text:generation === "first" ? firstHalf : secondHalf};
          await pause(120);
          throw Error("TEST_MODEL_STREAM_INTERRUPTED");
        }
        await gate;
        yield {type:"text_delta",text:complete};
      }
      yield {type:"completed",stopReason:"stop"};
    },
  };
  const app = createBackendApp(parseBackendConfig(["--app-root",appRoot,"--port","0"]),{
    disablePresetAssistant:true, disableMemoryRuntime:true, typingMs:100, modelPortFactory:() => model,
  });
  let role;
  if (generation === "first") {
    role = app.services.roles.createRole({displayName:"书签校对员",definition:{text:"你在书店工作。"}});
    const binding = app.services.resources.create({kind:"model",name:"本地断流替身",config:{protocol:"openai-chat",baseUrl:"http://127.0.0.1:1/v1"}});
    app.services.resources.replaceBindings(role.roleId,[{capability:"chat_model",resourceId:binding.resourceId,modelName:"local-recovery",enabled:true}]);
    app.services.activity.resume(role.roleId);
  }
  app.server.on("request",(req,res) => {
    if (req.method === "POST" && /\/messages(?:\/[^/]+\/retry)?$/.test(req.url)) {
      res.once("finish",() => process.send?.({type:"post",url:req.url,status:res.statusCode}));
    }
  });
  const port = await listen(app.server,0,"127.0.0.1");
  process.on("message",async message => {
    if (message === "release") release();
    if (message === "close") { release(); await app.close(); process.disconnect(); }
  });
  process.send({type:"ready",port,roleId:role?.roleId,windowId:role?.defaultWindowId});
}

async function run() {
  const resultRoot = path.join(root,"test-results","reply-recovery");
  fs.mkdirSync(resultRoot,{recursive:true});
  const output = fs.mkdtempSync(path.join(resultRoot,"desktop-"));
  const appRoot = path.join(output,"app");
  const report = {output,posts:[],modelCalls:[],checks:{},runtimeErrors:[]};
  let backend, desktop, socket, origin, roleId, windowId, seq = 0;
  const pending = new Map();
  async function until(label, read, timeout = 25000) {
    const deadline = Date.now()+timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await pause(80);
    }
    throw Error("TIMEOUT: "+label);
  }
  async function startBackend(generation) {
    const proc = backend = fork(self,["serve",appRoot,generation],{
      cwd:path.join(root,"backend"), execArgv:["--import","tsx"], windowsHide:true, silent:true,
    });
    const log = fs.createWriteStream(path.join(output,generation+"-backend.log"));
    proc.stderr.pipe(log); proc.stdout.pipe(log,{end:false});
    let ready;
    proc.on("message",msg => {
      if (msg.type === "ready") ready = msg;
      if (msg.type === "model") report.modelCalls.push([msg.generation,msg.tries]);
      if (msg.type === "post") report.posts.push([msg.url,msg.status]);
    });
    await until("后端就绪",() => {
      if (proc.exitCode !== null) throw Error("后端提前退出 "+proc.exitCode);
      return ready;
    });
    origin = "http://127.0.0.1:"+ready.port;
    roleId ??= ready.roleId; windowId ??= ready.windowId;
  }
  async function closeBackend() {
    if (!backend || backend.exitCode !== null) return;
    const exit = once(backend,"exit");
    backend.send("close");
    await exit;
  }
  function cdp(method,params={}) {
    return new Promise((resolve,reject) => {
      const id = ++seq;
      pending.set(id,{resolve,reject});
      socket.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression) {
    const data = await cdp("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if (data.exceptionDetails) throw Error(data.exceptionDetails.exception?.description ?? data.exceptionDetails.text);
    return data.result.value;
  }
  async function startDesktop() {
    const env = {...process.env,NOWADAYS_SKIP_ROLE_PICKER:"1",NOWADAYS_BACKEND_URL:origin,NOWADAYS_APP_ROOT:appRoot};
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = spawn(resolveElectronExecutable({repoRoot:root}),["--no-sandbox","--remote-debugging-port=0",
      "--user-data-dir="+path.join(output,"profile"),path.join(root,"desktop/desk-preview")],{env,windowsHide:true});
    let info = "";
    desktop.stderr.on("data",chunk => {info += chunk;});
    desktop.stdout.resume();
    const port = await until("Electron 调试端口",() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(info)?.[1]);
    const target = await until("正式渲染器",async () => (await (await fetch("http://127.0.0.1:"+port+"/json/list")).json())
      .find(page => page.url.startsWith("desk://bundle/")));
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject) => {socket.onopen=resolve;socket.onerror=reject;});
    socket.onmessage = ({data}) => {
      const msg = JSON.parse(data), job = pending.get(msg.id);
      if (job) {pending.delete(msg.id);msg.error ? job.reject(Error(msg.error.message)) : job.resolve(msg.result);}
      if (msg.method === "Runtime.exceptionThrown") report.runtimeErrors.push(msg.params.exceptionDetails.text);
    };
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await until("对话入口",() => evaluate("[...document.querySelectorAll('.ui-dock-item')].some(b=>b.textContent.includes('对话'))"));
    await evaluate("[...document.querySelectorAll('.ui-dock-item')].find(b=>b.textContent.includes('对话')).click()");
    await until("输入框",() => evaluate("!!document.querySelector('#dialogue-draft')"));
  }
  async function closeDesktop() {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({id:++seq,method:"Browser.close"})); socket.close();
    }
    if (desktop && desktop.exitCode === null) {
      const exit = once(desktop,"exit");
      await Promise.race([exit,pause(1500)]);
      if (desktop.exitCode === null) {desktop.kill();await exit;}
    }
    socket = undefined;
  }
  async function click(selector) {
    const point = await until(selector,() => evaluate(`(() => {
      const b=document.querySelector(${JSON.stringify(selector)}); if (!b || b.disabled) return null;
      b.scrollIntoView({block:'nearest'}); const r=b.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      return b.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    })()`));
    await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",buttons:1,clickCount:1,...point});
    await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});
  }
  const draftValue = () => evaluate("document.querySelector('#dialogue-draft')?.value");
  async function type(text) {
    await click("#dialogue-draft"); await cdp("Input.insertText",{text});
    assert.equal(await draftValue(),text);
  }
  async function page() {
    return (await fetch(origin+`/v1/roles/${roleId}/windows/${windowId}/messages`)).json();
  }
  async function failed(oldExecution) {
    const state = await until("失败快照",async () => {
      const current = await page();
      return current.failedReply && current.failedReply.executionId !== oldExecution ? current : null;
    });
    const notice = "[data-failed-message-id="+JSON.stringify(state.failedReply.messageId)+"]";
    await until("失败原因和重试入口",() => evaluate(`document.querySelector(${JSON.stringify(notice)})?.textContent.includes(${JSON.stringify(state.failedReply.errorCode)})`));
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(notice+" button")})?.textContent`),"重新回复");
    return state;
  }
  async function shot(name) {
    const {data}=await cdp("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(path.join(output,name+".png"),Buffer.from(data,"base64"));
  }
  try {
    await startBackend("first"); await startDesktop();
    await type(original); await click(".dialogue-send");
    const before=await failed();
    assert.ok(before.items.some(m=>m.status==="interrupted" && m.content===firstHalf));
    await until("桌面展示已输出的半句",() => evaluate(`document.body.innerText.includes(${JSON.stringify(firstHalf)})`));
    report.checks.firstFailure=before.failedReply;
    await shot("before-restart");
    await closeDesktop(); await closeBackend(); await startBackend("reopened"); await startDesktop();
    const reopened=await failed();
    assert.deepEqual(reopened.failedReply,before.failedReply);
    assert.ok(reopened.items.some(m=>m.status==="interrupted" && m.content===firstHalf));
    await type(draft); await click("[data-failed-message-id] button");
    const next=await failed(before.failedReply.executionId);
    assert.equal(next.failedReply.messageId,before.failedReply.messageId);
    assert.ok(next.items.some(m=>m.status==="interrupted" && m.content===secondHalf));
    assert.equal(await draftValue(),draft);
    report.checks.repeatedFailure=next.failedReply;
    await shot("second-failure");
    await click("[data-failed-message-id] button");
    await until("成功恢复请求已进入模型",() => report.modelCalls.length===3);
    const url=origin+`/v1/roles/${roleId}/windows/${windowId}/messages/${next.failedReply.messageId}/retry`;
    const duplicate=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:next.failedReply.executionId})});
    assert.equal(duplicate.status,409);
    assert.equal((await duplicate.json()).error.code,"REPLY_RETRY_STALE");
    backend.send("release");
    const done=await until("完成消息",async () => {const p=await page();return p.items.some(m=>m.content===complete && m.status==="completed") && p;});
    assert.equal(done.failedReply,null); assert.equal(done.awaitingReply,null);
    assert.deepEqual(done.items.filter(m=>m.sender==="user").map(m=>[m.messageId,m.content]),[[before.failedReply.messageId,original]]);
    assert.deepEqual(done.items.filter(m=>m.sender==="assistant").map(m=>m.content),[firstHalf,secondHalf,complete]);
    await until("恢复后桌面回复和草稿",() => evaluate(`document.body.innerText.includes(${JSON.stringify(complete)}) && document.querySelector('#dialogue-draft')?.value===${JSON.stringify(draft)}`));
    assert.equal(await evaluate("!!document.querySelector('[data-failed-message-id]')"),false);
    assert.deepEqual(report.modelCalls,[["first",1],["reopened",1],["reopened",2]]);
    assert.deepEqual(report.runtimeErrors,[]);
    await shot("recovered");
    report.checks.completed=true; report.checks.draft=draft;
    report.checks.histories=done.items.map(({messageId,sender,status,content})=>({messageId,sender,status,content}));
  } catch(error) {
    report.error=String(error.stack ?? error); process.exitCode=1;
    if (socket?.readyState===WebSocket.OPEN) {
      report.visible=await evaluate("document.body.innerText.slice(-3000)").catch(()=>null);
      await shot("failure").catch(()=>{});
    }
  } finally {
    await closeDesktop(); await closeBackend();
    fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,completed:!!report.checks.completed,error:report.error}));
  }
}

if (process.argv[2] === "serve") await serve(process.argv[3],process.argv[4]);
else await run();
