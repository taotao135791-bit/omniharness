import { contextBridge, ipcRenderer } from "electron";

/**
 * The only surface the renderer gets. contextIsolation is on; this bridge is
 * the entire GUI↔main API. It exposes typed daemon RPC + event subscription
 * and nothing else.
 */
const api = {
  /** Invoke a daemon command. */
  call: (name: string, params: unknown): Promise<unknown> =>
    ipcRenderer.invoke("rpc:call", name, params),

  /** Subscribe to the daemon event stream. Returns an unsubscribe function. */
  onEvent: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: unknown): void => handler(event);
    ipcRenderer.on("daemon:event", listener);
    return () => ipcRenderer.removeListener("daemon:event", listener);
  },

  /** Subscribe to daemon connection state changes. */
  onState: (handler: (state: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: string): void => handler(state);
    ipcRenderer.on("daemon:state", listener);
    return () => ipcRenderer.removeListener("daemon:state", listener);
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("window:toggleMaximize"),
  },
};

export type OmniBridge = typeof api;

contextBridge.exposeInMainWorld("omni", api);
