import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { DaemonConnection } from "./daemon-connection.js";

/**
 * Minimal IPC surface. The renderer can:
 *  1. invoke any daemon command ("rpc:call") — validated against the command catalog
 *  2. subscribe to daemon events (pushed via "daemon:event")
 *  3. read daemon connection state
 * No filesystem, no shell, no node access crosses this bridge.
 */
export function registerIpc(
  daemon: DaemonConnection,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("rpc:call", async (_event: IpcMainInvokeEvent, name: string, params: unknown) => {
    if (typeof name !== "string" || !/^[a-z]+\.[a-zA-Z]+$/.test(name)) {
      throw new Error(`invalid command name: ${String(name)}`);
    }
    return daemon.call(name, params);
  });

  ipcMain.handle("daemon:state", () => {
    return { state: (daemon as unknown as { state?: string }).state ?? "unknown" };
  });

  // Renderer-initiated window controls (kept explicit, not generic).
  ipcMain.handle("window:minimize", () => getWindow()?.minimize());
  ipcMain.handle("window:toggleMaximize", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
}
