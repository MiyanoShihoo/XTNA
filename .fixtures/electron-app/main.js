const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  win.loadFile("index.html");
  return win;
}

ipcMain.handle("config:read", async (_event, key) => ({ key, value: "demo" }));
ipcMain.on("telemetry:send", (_event, payload) => {
  console.log("telemetry", JSON.stringify(payload));
});

app.whenReady().then(createWindow);
