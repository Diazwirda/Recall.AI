const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cliff", {
  onStatusChanged: (cb) => ipcRenderer.on("status:changed", (_e, payload) => cb(payload)),
  onVideoReady: (cb) => ipcRenderer.on("audioUrl:ready", (_e, payload) => cb(payload)),
  onTranscriptReady: (cb) => ipcRenderer.on("transcript:ready", (_e, payload) => cb(payload)),
  onSummaryReady: (cb) => ipcRenderer.on("summary:ready", (_e, payload) => cb(payload)),
});
