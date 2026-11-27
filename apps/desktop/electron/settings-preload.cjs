"use strict";

const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame && location.href === "desk://bundle/index.html") {
  let listener;
  ipcRenderer.on("desk:intent-request", (_event, request) => {
    if (listener) listener(request);
    else ipcRenderer.send("desk:intent-reply", request.id, true); // 封面阶段尚无编辑器。
  });
  contextBridge.exposeInMainWorld("nowadaysDesk", {
    hostHeaders: ipcRenderer.sendSync("desk:host-headers"),
    coverPainted: color => ipcRenderer.send("desk:cover", color),
    boot: () => ipcRenderer.invoke("desk:boot"),
    onIntent: callback => {
      listener = callback;
      const cancel = (_event, id) => callback({ id, action: "cancel" });
      ipcRenderer.on("desk:intent-cancel", cancel);
      return () => {
        if (listener === callback) listener = undefined;
        ipcRenderer.removeListener("desk:intent-cancel", cancel);
      };
    },
    waiting: id => ipcRenderer.send("desk:intent-waiting", id),
    reply: (id, accepted) => ipcRenderer.send("desk:intent-reply", id, accepted),
    chooseSkillDirectory: () => ipcRenderer.invoke("settings:choose-skill-directory")
  });
}
