"use strict";

const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("nowadaysDesk", {
  chooseSkillDirectory: () => ipcRenderer.invoke("settings:choose-skill-directory"),
});
