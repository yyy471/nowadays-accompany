"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, net, protocol } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveBackendLayout, resolveNodeExecutable } = require("./backend-paths.cjs");
const { extensionHandler, allowSlotNavigation } = require("./extension-protocol.cjs");

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
let backendChild = null;
let backendBaseUrl = process.env.NOWADAYS_BACKEND_URL || "";
const hostToken = backendBaseUrl ? process.env.NOWADAYS_HOST_TOKEN : require("node:crypto").randomBytes(32).toString("hex");
const hostHeaders = hostToken ? { "X-Nowadays-Host-Token": hostToken } : {};
let backendReadyPromise = null;

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

async function ensureBackendRunning() {
  if (backendReadyPromise) {
    return backendReadyPromise;
  }
  backendReadyPromise = (async () => {
    if (backendBaseUrl) {
      const response = await fetch(`${backendBaseUrl}/v1/health`, { headers: hostHeaders, redirect: "error" });
      if (!response.ok || (await response.json()).status !== "ok") {
        throw new Error("配置的后端不可用");
      }
      return backendBaseUrl;
    }

    const layout = backendLayout();
    const backendRoot = layout.backendRoot;
    // 打包态写到用户数据目录，避免落在 Program Files 类只读安装位导致后端写失败；
    // 仓库态仍用后端的本地目录，脚本可用 NOWADAYS_APP_ROOT 覆盖。
    const appRoot = process.env.NOWADAYS_APP_ROOT
      || (app.isPackaged ? join(app.getPath("userData"), "data") : resolve(backendRoot, ".nowadays-desktop"));
    const nodeBin = resolveNode24Executable(layout);
    const mainScript = layout.entry;

    await new Promise((resolveStart, rejectStart) => {
      const child = spawn(
        nodeBin,
        [
          "--import",
          "tsx",
          mainScript,
          "--app-root",
          appRoot,
          "--preset-assets-dir",
          layout.presetAssetsDir,
          "--port",
          "0"
        ],
        {
          cwd: backendRoot,
          env: { ...process.env, NOWADAYS_HOST_TOKEN: hostToken, NOWADAYS_PI_MCP_ROOT: layout.piMcpRoot, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        }
      );
      backendChild = child;
      let stdoutBuf = "";
      let stderrBuf = "";
      const timer = setTimeout(() => {
        rejectStart(new Error(`Backend start timeout: ${stderrBuf}`));
      }, 18000);

      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });

      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("{")) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.event === "listening" && evt.port) {
              clearTimeout(timer);
              backendBaseUrl = `http://${evt.host || "127.0.0.1"}:${evt.port}`;
              resolveStart();
              return;
            }
          } catch {
            // ignore non-json lines
          }
        }
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        rejectStart(err);
      });

      child.once("exit", (code) => {
        if (!backendBaseUrl) {
          clearTimeout(timer);
          rejectStart(new Error(`Backend exited early (${code}): ${stderrBuf}`));
        }
      });
    });

    return backendBaseUrl;
  })();

  return backendReadyPromise;
}

function stopManagedBackend() {
  if (backendChild && backendChild.exitCode === null) {
    try {
      backendChild.kill("SIGTERM");
    } catch {
      // ignore
    }
    backendChild = null;
  }

}

function revealDesk() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function startDesk() {
  try {
    await ensureBackendRunning();
  } catch (err) {
    console.error("[desktop] Failed to start managed backend:", err);
  }

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

    // 2. 同源代理 /v1/* 请求至真实本地后端
    if (pathname.startsWith("/v1/")) {
      // 扩展文件只通过 nd-ext 加载，避免同一份代码也能从桌面来源取得。
      if (/^\/v1\/extensions\/[^/]+\/ui\//.test(pathname)) return new Response(null, { status: 404 });
      if (!backendBaseUrl) {
        return new Response(
          JSON.stringify({ error: { code: "BACKEND_OFFLINE", message: "本地后端尚未就绪" } }),
          { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
      const targetUrl = `${backendBaseUrl}${pathname}${search}`;
      const init = {
        method: request.method,
        headers: new Headers(request.headers),
        redirect: "manual"
      };
      // 同源资产（图片、音频）没有自定义头；仅桌面协议代理向固定后端补签。
      if (hostToken && request.method === "GET" && !pathname.startsWith("/v1/internal/")) init.headers.set("X-Nowadays-Host-Token", hostToken);
      if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
        init.body = await request.arrayBuffer();
      }
      return net.fetch(targetUrl, init);
    }

    // 3. 静态资源服务
    if (request.method !== "GET" || !assets.test(pathname)) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(join(rendererRoot, pathname.slice(1))).href);
  });

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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, "settings-preload.cjs") }
  });
  ipcMain.on("desk:host-headers", event => {
    event.returnValue = event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === home ? hostHeaders : {};
  });
  // EventSource 无自定义头 API。限定后端地址与主框架，不向扩展子帧签发。
  if (hostToken && backendBaseUrl) window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [new URL(backendBaseUrl).protocol + "//" + new URL(backendBaseUrl).hostname + "/*"] },
    (details, callback) => {
      if (details.method === "GET" && details.url.startsWith(backendBaseUrl + "/v1/") && details.frame === window.webContents.mainFrame &&
          details.frame.url === home) Object.assign(details.requestHeaders, hostHeaders);
      callback({ requestHeaders: details.requestHeaders });
    });
  ipcMain.handle("settings:choose-skill-directory", async (event) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== home) {
      throw new Error("SETTINGS_DIRECTORY_PICKER_DENIED");
    }
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  window.webContents.session.protocol.handle("nd-ext", extensionHandler(backendBaseUrl, (url, init) => net.fetch(url, { ...init, headers: hostHeaders })));
  window.webContents.on("will-frame-navigate", event => {
    if (!event.isMainFrame && !allowSlotNavigation(event, window.webContents.mainFrame)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning", message: "配置有改动未保存。要放弃修改并离开吗？",
      buttons: ["继续编辑", "放弃修改"], defaultId: 0, cancelId: 0, noLink: true
    });
    if (choice === 1) event.preventDefault();
    else quitting = false;
  });
  window.once("ready-to-show", revealDesk);
  let checkingTrayHide = false;
  window.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      if (checkingTrayHide) return;
      checkingTrayHide = true;
      void window.webContents.executeJavaScript('window.dispatchEvent(new Event("nowadays:before-tray-hide", {cancelable:true}))')
        .then(async canHide => {
          if (window.isDestroyed() || quitting) return;
          if (!canHide) {
            const { response } = await dialog.showMessageBox(window, {
              type: "warning", message: "配置有改动未保存。要保留草稿并隐藏窗口吗？",
              buttons: ["继续编辑", "隐藏窗口"], defaultId: 0, cancelId: 0, noLink: true
            });
            if (response !== 1) return;
          }
          if (!window.isDestroyed()) window.hide();
        })
        .catch(() => { if (!window.isDestroyed() && !quitting) window.hide(); })
        .finally(() => { checkingTrayHide = false; });
    }
  });
  tray = new Tray(icon);
  tray.setToolTip("Nowadays · 光影书房");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开光影书房", click: revealDesk },
      { label: "退出 Nowadays", click: () => app.quit() }
    ])
  );
  tray.on("double-click", revealDesk);
  void window.loadURL(home);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealDesk);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", stopManagedBackend);
  app.on("window-all-closed", () => {
    app.quit();
  });
  void app.whenReady().then(startDesk);
}
