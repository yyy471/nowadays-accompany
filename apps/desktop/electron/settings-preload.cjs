"use strict";

const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame && location.href === "desk://bundle/index.html") contextBridge.exposeInMainWorld("nowadaysDesk", {
  hostHeaders: ipcRenderer.sendSync("desk:host-headers"),
  chooseSkillDirectory: () => ipcRenderer.invoke("settings:choose-skill-directory"),
});
