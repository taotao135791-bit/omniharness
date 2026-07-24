import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrand } from "@omniharness/config-schema";
import { DaemonConnection } from "./daemon-connection.js";
import { registerIpc } from "./ipc.js";
import { createTray } from "./tray.js";
import { registerGlobalHotkey } from "./hotkey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single instance: the daemon is shared; the window is not.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main().catch((err) => {
    console.error("fatal:", err);
    app.exit(1);
  });
}

let mainWindow: BrowserWindow | null = null;

async function main(): Promise<void> {
  const brand = loadBrand();
  await app.whenReady();

  const daemon = new DaemonConnection();
  daemon.start(); // discovers or spawns the daemon, reconnects on loss

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  mainWindow = createMainWindow(brand.product.displayName);
  registerIpc(daemon, () => mainWindow);
  createTray(brand, () => mainWindow);
  registerGlobalHotkey(() => mainWindow);

  // Forward daemon events to the renderer.
  daemon.onEvent((event) => {
    mainWindow?.webContents.send("daemon:event", event);
  });
  daemon.onStateChange((state) => {
    mainWindow?.webContents.send("daemon:state", state);
  });

  app.on("window-all-closed", () => {
    // Tray keeps the app alive (per gui.minimizeToTray); explicit quit via tray.
    if (process.platform === "darwin") return;
  });

  app.on("before-quit", () => {
    daemon.dispose();
  });
}

function createMainWindow(title: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title,
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // External links open in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  const rendererPath = path.join(__dirname, "../../renderer/index.html");
  const devServer = process.env.OMNIHARNESS_RENDERER_URL;
  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(rendererPath);

  return win;
}
