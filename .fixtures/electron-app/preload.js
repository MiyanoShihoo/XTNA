const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xtnaDemo", {
  readConfig: (key) => ipcRenderer.invoke("config:read", key),
  sendTelemetry: (payload) => ipcRenderer.send("telemetry:send", payload),
});
