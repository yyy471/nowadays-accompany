"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveBackendLayout, resolveNodeExecutable } = require("./backend-paths.cjs");
const { createBackendLog, summarizeBackendFailure } = require("./backend-log.cjs");
const { resolveManagedMasterKey } = require("./master-key.cjs");
const { extensionHandler, allowSlotNavigation } = require("./extension-protocol.cjs");
const { createWindowIntent } = require("./window-intent.cjs");

const home = "desk://bundle/index.html";
const icon = join(__dirname, "..", "assets", "window.png");
const assets = /^\/(?:index\.html|assets\/[a-z0-9-_]+\.(?:js|css|webp|svg|woff|png|ico))$/i;
const rendererRoot = join(__dirname, "..", "renderer", "dist");

protocol.registerSchemesAsPrivileged([
  { scheme: "nd-ext", privileges: { standard: true, secure: true } },
  {
    scheme: "desk",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let window;
let tray;
let quitting = false;
let allowQuit = false;
let windowIntents;
let quitPromise = null;
let backendChild = null;
let canOpenBackendLogs = false;
const configuredBackend = process.env.NOWADAYS_BACKEND_URL?.replace(/\/$/, "");
let backendBaseUrl = "";
const hostToken = configuredBackend ? process.env.NOWADAYS_HOST_TOKEN : require("node:crypto").randomBytes(32).toString("hex");
const hostHeaders = hostToken ? { "X-Nowadays-Host-Token": hostToken } : {};
let backendReadyPromise = null;

const backendLogDirectory = () => join(app.getPath("userData"), "logs");

// 开发仓库与打包产物的后端、预置素材与 Node 运行时位置统一由布局解析给出（310 §3.2）。
function backendLayout() {
  return resolveBackendLayout({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    dirname: __dirname,
    env: process.env
  });
}

function resolveNode24Executable(layout) {
  return resolveNodeExecutable({ layout, env: process.env, exists: fs.existsSync });
}

async function startManagedBackend() {
  if (quitting) throw new Error("桌面正在退出。");
  if (backendChild) throw new Error("上一轮本地服务仍未退出。");
  const layout = backendLayout();
  const backendRoot = layout.backendRoot;
  // 打包态写到用户数据目录，避免落在 Program Files 类只读安装位导致后端写失败；
  // 仓库态仍用后端的本地目录，脚本可用 NOWADAYS_APP_ROOT 覆盖。
  const appRoot = process.env.NOWADAYS_APP_ROOT
    || (app.isPackaged ? join(app.getPath("userData"), "data") : resolve(backendRoot, ".nowadays-desktop"));
  const nodeBin = resolveNode24Executable(layout);
  const mainScript = layout.entry;

  // 托管主密钥：优先 DPAPI 密文复用/迁移/生成；失败时安全中止并交由上层提示。
  let masterKey;
  try {
    masterKey = resolveManagedMasterKey({ appRoot, safeStorage });
  } catch (error) {
    console.error("backend_master_key_error", error instanceof Error ? error.message : String(error));
    throw new Error("无法准备本机服务的主密钥。");
  }

  const { promise: started, resolve: resolveStart, reject: rejectStart } = Promise.withResolvers();
  let managed;
  const log = createBackendLog({
    logDirectory: backendLogDirectory(),
    hostToken,
    extraSecrets: masterKey.masterKeyBase64 ? [masterKey.masterKeyBase64] : [],
    onStdoutLine(line) {
      if (!managed || managed.closed || managed.stopPromise || quitting) return;
      try {
        const evt = JSON.parse(line);
        if (evt.event === "listening" && evt.port) {
          clearTimeout(managed.startTimer);
          resolveStart({ base: `http://${evt.host || "127.0.0.1"}:${evt.port}`, managed });
        }
      } catch {
        // 非就绪协议日志仅落盘。
      }
    }
  });
  canOpenBackendLogs = log.canOpenLogs;
  log.lifecycle("backend_master_key mode=" + masterKey.mode);
  let child;
  try {
    child = spawn(
      nodeBin,
      [
        ...layout.nodeArgs,
        mainScript,
        "--app-root",
        appRoot,
        "--preset-assets-dir",
        layout.presetAssetsDir,
        "--port",
        "0",
        "--watch-stdin"
      ],
      {
        cwd: backendRoot,
        env: {
          ...process.env,
          NOWADAYS_HOST_TOKEN: hostToken,
          ...(masterKey.masterKeyBase64 ? { NOWADAYS_MASTER_KEY: masterKey.masterKeyBase64 } : {}),
          NOWADAYS_PI_MCP_ROOT: layout.piMcpRoot,
          NO_COLOR: "1"
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
  } catch (error) {
    log.lifecycle(error.message);
    log.close();
    throw new Error(summarizeBackendFailure({ error, stderrTail: log.stderrTail }));
  }
  managed = backendChild = {
    child, log, stopPromise: null, forceKill: null, closed: false,
    bootAbort: new AbortController(),
    cancelStart: () => rejectStart(new Error("本地服务已结束启动。"))
  };
  log.lifecycle(`backend_spawn pid=${child.pid ?? "unknown"}`);
  child.stdin.on("error", error => log.lifecycle(`backend_stdin_error ${error.message}`));
  child.stdout.on("data", chunk => log.stdout(chunk));
  child.stderr.on("data", chunk => log.stderr(chunk));
  child.once("error", error => {
    managed.spawnError = error;
    log.lifecycle(`backend_spawn_error ${error.message}`);
  });
  managed.startTimer = setTimeout(() => rejectStart(new Error("等待本地服务启动超时。")), 18000);
  managed.drained = new Promise(resolveClose => {
    child.once("close", (code, signal) => {
      managed.closed = true;
      clearTimeout(managed.startTimer);
      resolveClose({ code, signal });
    });
  }).then(async ({ code, signal }) => {
    if (managed.forceKill) await managed.forceKill;
    log.lifecycle(`backend_close pid=${child.pid ?? "unknown"} code=${code} signal=${signal}`);
    log.close();
    if (backendChild === managed) {
      backendChild = null;
      backendBaseUrl = "";
    }
    const failure = new Error(summarizeBackendFailure({ code, signal, error: managed.spawnError, stderrTail: log.stderrTail }));
    if (code !== 0 || signal) managed.abnormalExit = failure;
    rejectStart(failure);
    return failure;
  });
  return started;
}

async function waitForDrain(managed, timeout) {
  let timer;
  try {
    return await Promise.race([
      managed.drained.then(() => true),
      new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), timeout); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function forceWindowsBackendTree(managed) {
  const { child, log } = managed;
  log.lifecycle(`backend_shutdown_timeout pid=${child.pid} taskkill /T /F after 5000ms`);
  return new Promise(resolveKill => {
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { timeout: 2000, windowsHide: true, encoding: "buffer" }, (error, _stdout, stderr) => {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        const detail = new TextDecoder(locale.startsWith("zh-CN") ? "gbk" : "utf-8")
          .decode(stderr).trim().replace(/[\r\n]+/g, " ");
        log.lifecycle(error ?
          `backend_taskkill_failed pid=${child.pid} code=${error.code ?? "unknown"} signal=${error.signal ?? "none"} ${detail}` :
          `backend_taskkill_complete pid=${child.pid}`);
        resolveKill();
      });
  });
}

function stopManagedBackend() {
  const managed = backendChild;
  if (!managed) return Promise.resolve();
  const { child, log } = managed;
  managed.stopPromise ??= (async () => {
    managed.bootAbort.abort();
    if (quitting) managed.cancelStart();
    if (!managed.closed && !child.stdin.destroyed && !child.stdin.writableEnded) {
      log.lifecycle(`backend_shutdown_request pid=${child.pid ?? "unknown"} source=stdin`);
      child.stdin.end();
    }
    if (await waitForDrain(managed, 5000)) return;
    if (backendChild === managed && !managed.closed && child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        managed.forceKill = forceWindowsBackendTree(managed);
        await managed.forceKill;
      } else {
        log.lifecycle(`backend_shutdown_timeout pid=${child.pid} SIGTERM after 5000ms`);
        child.kill("SIGTERM");
      }
    }
    if (await waitForDrain(managed, 2000)) return;
    log.lifecycle(`backend_shutdown_drain_timeout pid=${child.pid ?? "unknown"}`);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    log.close();
  })();
  return managed.stopPromise;
}

function revealDesk() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function trusted(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === home;
}

const backendHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const backendHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function proxyBackendRequest(targetUrl, request, headers, body) {
  return new Promise((resolveResponse, rejectResponse) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;
    const reqHeaders = {};
    for (const [name, value] of headers.entries()) {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "connection" || lower === "content-length") continue;
      reqHeaders[name] = value;
    }
    if (body) reqHeaders["content-length"] = String(body.byteLength);
    let settled = false;
    const upstreamReq = transport.request(parsed, {
      method: request.method,
      headers: reqHeaders,
      agent: parsed.protocol === "https:" ? backendHttpsAgent : backendHttpAgent
    }, (upstreamRes) => {
      const responseHeaders = new Headers();
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        const name = upstreamRes.rawHeaders[i];
        const value = upstreamRes.rawHeaders[i + 1];
        if (!name) continue;
        const lower = name.toLowerCase();
        if (lower === "transfer-encoding" || lower === "connection" || lower === "keep-alive") continue;
        responseHeaders.append(name, value ?? "");
      }
      const status = upstreamRes.statusCode ?? 502;
      if (request.method === "HEAD" || status === 204 || status === 304) {
        upstreamRes.resume();
        settled = true;
        resolveResponse(new Response(null, { status, headers: responseHeaders }));
        return;
      }
      let closed = false;
      const stream = new ReadableStream({
        start(controller) {
          upstreamRes.on("data", (chunk) => {
            if (closed) return;
            try { controller.enqueue(chunk); }
            catch { closed = true; upstreamReq.destroy(); }
          });
          upstreamRes.on("end", () => {
            if (closed) return;
            closed = true;
            try { controller.close(); } catch { /* 已关闭 */ }
          });
          upstreamRes.on("aborted", () => {
            if (closed) return;
            closed = true;
            try { controller.close(); } catch { /* 已关闭 */ }
          });
          upstreamRes.on("error", (err) => {
            if (closed) return;
            closed = true;
            try { controller.error(err); } catch { /* 已关闭 */ }
          });
        },
        cancel() {
          closed = true;
          upstreamReq.destroy();
        }
      });
      settled = true;
      resolveResponse(new Response(stream, { status, headers: responseHeaders }));
    });
    const onAbort = () => upstreamReq.destroy();
    if (request.signal) {
      if (request.signal.aborted) { upstreamReq.destroy(); return; }
      request.signal.addEventListener("abort", onAbort, { once: true });
      upstreamReq.once("close", () => request.signal.removeEventListener("abort", onAbort));
    }
    upstreamReq.on("error", (err) => {
      if (!settled) { settled = true; rejectResponse(err); }
    });
    if (body) upstreamReq.end(Buffer.from(body));
    else upstreamReq.end();
  });
}

function startDesk() {
  protocol.handle("desk", async (request) => {
    const { hostname, pathname, search } = new URL(request.url);
    if (hostname !== "bundle") {
      return new Response(null, { status: 404 });
    }

    // 1. 暴露当前连接的本地后端地址与状态
    if (pathname === "/api-config.json") {
      return new Response(
        JSON.stringify({
          backendBaseUrl,
          connected: Boolean(backendBaseUrl),
          // 自动化脚本用它跳过冷启动选角页，直接进入工作区。
          skipRolePicker: process.env.NOWADAYS_SKIP_ROLE_PICKER === "1"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      );
    }

    // 2. 同源代理 /v1/* 请求（含 HTTP 与 SSE）至真实本地后端；使用独立 Node 连接池避免 Chromium 单源 6 连接阻塞。
    if (pathname.startsWith("/v1/")) {
      // 扩展文件只通过 nd-ext 加载，避免同一份代码也能从桌面来源取得。
      if (/^\/v1\/extensions\/[^/]+\/ui\//.test(pathname)) return new Response(null, { status: 404 });
      const offline = () => Response.json(
        { error: { code: "BACKEND_OFFLINE", message: "本地服务暂时连不上" } }, { status: 503 }
      );
      if (!backendBaseUrl) return offline();
      const targetUrl = `${backendBaseUrl}${pathname}${search}`;
      const headers = new Headers(request.headers);
      // 主进程代理向固定后端补签：所有方法统一签发，渲染层不再持有宿主令牌。
      if (hostToken && !pathname.startsWith("/v1/internal/")) headers.set("X-Nowadays-Host-Token", hostToken);
      const body = request.method !== "GET" && request.method !== "HEAD" && request.body
        ? await request.arrayBuffer()
        : null;
      try {
        return await proxyBackendRequest(targetUrl, request, headers, body);
      } catch {
        return offline();
      }
    }

    // 3. 静态资源服务
    if (request.method !== "GET" || !assets.test(pathname)) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(join(rendererRoot, pathname.slice(1))).href);
  });

  let coverShown = false;
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1440,
    height: 840,
    minWidth: 720,
    minHeight: 540,
    useContentSize: true,
    title: "Nowadays · 光影书房",
    icon,
    show: false,
    backgroundColor: "#1b1e2b",
    titleBarStyle: "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, "settings-preload.cjs"),
      additionalArguments: [app.isPackaged ? "--nowadays-packaged=1" : "--nowadays-packaged=0"] }
  });
  async function prepareBackend() {
    const { base, managed } = configuredBackend ? { base: configuredBackend } : await startManagedBackend();
    const timeout = AbortSignal.timeout(18000);
    const signal = managed ? AbortSignal.any([timeout, managed.bootAbort.signal]) : timeout;
    const check = async () => {
      const response = await fetch(base + "/v1/health", { headers: hostHeaders, redirect: "error", signal });
      if (!response.ok || (await response.json()).status !== "ok") throw new Error("本地服务健康检查未通过。");
    };
    try {
      if (managed) await Promise.race([check(), managed.drained.then(failure => { throw failure; })]);
      else await check();
    } catch (error) {
      if (managed && (managed.closed || managed.child.exitCode !== null || managed.child.signalCode !== null)) {
        throw await managed.drained;
      }
      if (managed && error.message === "fetch failed") {
        await stopManagedBackend();
        if (!managed.forceKill && managed.abnormalExit) throw managed.abnormalExit;
      }
      throw error;
    }
    if (quitting || (!configuredBackend && (!managed || backendChild !== managed || managed.closed || managed.stopPromise))) {
      throw new Error("本地服务已结束启动。");
    }
    // HTTP 与 SSE 全部经 desk://bundle/v1/* 由主进程补签宿主令牌，渲染层不再直连后端。
    window.webContents.session.protocol.handle("nd-ext", extensionHandler(base, (url, init) => net.fetch(url, { ...init, headers: hostHeaders })));
    backendBaseUrl = base;
    return { ok: true, skipRolePicker: process.env.NOWADAYS_SKIP_ROLE_PICKER === "1", isPackaged: app.isPackaged };
  }
  ipcMain.handle("desk:boot", event => {
    if (!trusted(event)) throw new Error("DESK_BOOT_DENIED");
    backendReadyPromise ??= prepareBackend().catch(async error => {
      await stopManagedBackend();
      backendReadyPromise = null;
      const reason = error.message === "fetch failed" ? "无法连接本地服务。" :
        error.name === "TimeoutError" ? "等待本地服务响应超时。" : error.message;
      return { ok: false, reason, canOpenLogs: !configuredBackend && canOpenBackendLogs };
    });
    return backendReadyPromise;
  });
  ipcMain.handle("desk:open-backend-logs", async (event, ...args) => {
    if (!trusted(event) || args.length) throw new Error("DESK_BACKEND_LOGS_DENIED");
    if (configuredBackend || !canOpenBackendLogs) return { ok: false, message: "本地服务日志目录不可用。" };
    try {
      const result = await shell.openPath(backendLogDirectory());
      if (!result) return { ok: true };
    } catch {
      // 不将系统路径或本机错误带回界面。
    }
    return { ok: false, message: "无法打开本地服务日志目录。" };
  });
  ipcMain.on("desk:window-theme", (event, preset, color) => {
    if (!trusted(event) || !["daylight", "nightwave"].includes(preset) || typeof color !== "string" || !/^#[a-f0-9]{6}$/i.test(color)) return;
    nativeTheme.themeSource = preset === "nightwave" ? "dark" : "light";
    if (process.platform === "win32") window.setAccentColor(color);
    window.setBackgroundColor(color);
    if (!coverShown) { coverShown = true; revealDesk(); }
  });
  ipcMain.handle("settings:choose-skill-directory", async (event) => {
    if (!trusted(event)) {
      throw new Error("SETTINGS_DIRECTORY_PICKER_DENIED");
    }
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  window.webContents.on("will-frame-navigate", event => {
    if (!event.isMainFrame && !allowSlotNavigation(event, window.webContents.mainFrame)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-prevent-unload", (event) => {
    if (windowIntents.pending) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning", message: "配置有改动未保存。要放弃修改并离开吗？",
      buttons: ["继续编辑", "放弃修改"], defaultId: 0, cancelId: 0, noLink: true
    });
    if (choice === 1) event.preventDefault();
  });
  const intents = windowIntents = createWindowIntent({
    send(channel, data) {
      if (!window.isDestroyed() && !window.webContents.isCrashed()) window.webContents.send("desk:intent-" + channel, data);
    },
    reveal: revealDesk,
    async fallback(action) {
      const { response } = await dialog.showMessageBox(window, {
        type: "warning", message: "书房窗口暂时没有响应。",
        detail: action === "quit" ? "退出将放弃尚未保存的修改。" : "可以保留当前窗口并隐藏到托盘。",
        buttons: ["取消", action === "quit" ? "放弃修改并退出" : "保留草稿并隐藏"], defaultId: 0, cancelId: 0, noLink: true
      });
      return response === 1;
    },
    commit(action) {
      if (action === "hide") { window.hide(); return; }
      quitting = true;
      // 已确认的退出直接销毁唯一主窗，挂死的渲染器也不会再次进入 beforeunload。
      window.destroy(); // window-all-closed 统一调用 app.quit()。
    }
  });
  ipcMain.on("desk:intent-waiting", (event, id) => { if (trusted(event)) intents.waiting(id); });
  ipcMain.on("desk:intent-reply", (event, id, accepted) => { if (trusted(event)) intents.reply(id, accepted); });
  window.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    intents.request("hide");
  });
  tray = new Tray(icon);
  tray.setToolTip("Nowadays · 光影书房");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开光影书房", click: revealDesk },
      { label: "退出 Nowadays", click: () => intents.request("quit") }
    ])
  );
  tray.on("double-click", revealDesk);
  void window.loadURL(home);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealDesk);
  app.on("before-quit", event => {
    if (allowQuit) return;
    if (!quitting && window && !window.isDestroyed()) {
      event.preventDefault();
      windowIntents.request("quit");
      return;
    }
    quitting = true;
    if (configuredBackend) {
      allowQuit = true;
      return;
    }
    event.preventDefault();
    quitPromise ??= (async () => {
      try {
        await stopManagedBackend();
      } finally {
        allowQuit = true;
        app.quit();
      }
    })();
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
  void app.whenReady().then(startDesk);
}
