"use strict";

const { app, BrowserWindow, Menu, Tray, net, protocol } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const home = "desk://bundle/index.html";
const icon = join(__dirname, "assets", "window.png");
const assets = /^\/(?:index\.html|(?:app|environment|window-effects)\.js|style\.css|assets\/(?:anchors\.js|[a-z-]+\.(?:webp|svg)))$/;
protocol.registerSchemesAsPrivileged([
  { scheme: "desk", privileges: { standard: true, secure: true } }
]);

let window;
let tray;
let quitting = false;

function revealDesk() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function startDesk() {
  protocol.handle("desk", request => {
    const { hostname, pathname } = new URL(request.url);
    if (request.method !== "GET" || hostname !== "bundle" || !assets.test(pathname)) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(join(__dirname, pathname.slice(1))).href);
  });
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1440, height: 810, minWidth: 704, minHeight: 396, useContentSize: true,
    title: "Nowadays", icon, show: false, backgroundColor: "#312c32",
    titleBarStyle: "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.setAspectRatio(16 / 9);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.once("ready-to-show", revealDesk);
  window.on("close", event => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  tray = new Tray(icon);
  tray.setToolTip("Nowadays · 书桌");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开书桌", click: revealDesk },
    { label: "退出 Nowadays", click: () => app.quit() }
  ]));
  tray.on("double-click", revealDesk);
  void window.loadURL(home);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealDesk);
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => { app.quit(); });
  void app.whenReady().then(startDesk);
}
