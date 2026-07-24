import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniClient } from "@omniharness/client-sdk";
import type { DomainEvent } from "@omniharness/agent-protocol";

export type DaemonState = "starting" | "connected" | "disconnected" | "error";

interface DaemonRuntimeInfo {
  port: number;
  host: string;
  authToken: string;
  pid: number;
  version: string;
}

/**
 * Owns the GUI's connection to the local daemon: discovers the runtime file,
 * spawns the daemon when absent, reconnects with backoff, fans out events.
 */
export class DaemonConnection {
  private client: OmniClient | null = null;
  private spawned: ChildProcess | null = null;
  private eventHandlers = new Set<(e: DomainEvent) => void>();
  private stateHandlers = new Set<(s: DaemonState) => void>();
  private state: DaemonState = "disconnected";
  private disposed = false;

  onEvent(h: (e: DomainEvent) => void): void {
    this.eventHandlers.add(h);
  }

  onStateChange(h: (s: DaemonState) => void): void {
    this.stateHandlers.add(h);
  }

  private setState(s: DaemonState): void {
    this.state = s;
    for (const h of this.stateHandlers) h(s);
  }

  private dataDir(): string {
    return process.env.OMNIHARNESS_DATA_DIR ?? path.join(os.homedir(), ".omniharness");
  }

  private readRuntimeInfo(): DaemonRuntimeInfo | null {
    const file = `${this.dataDir()}/daemon.json`;
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as DaemonRuntimeInfo;
    } catch {
      return null;
    }
  }

  start(): void {
    this.setState("starting");
    void this.connectWithRetry();
  }

  private async connectWithRetry(): Promise<void> {
    let attempts = 0;
    while (!this.disposed) {
      const info = this.readRuntimeInfo();
      if (!info) {
        if (attempts === 0) this.spawnDaemon();
        attempts += 1;
        await sleep(750);
        continue;
      }
      try {
        const client = new OmniClient({
          url: `ws://${info.host}:${info.port}`,
          authToken: info.authToken,
          client: { kind: "gui", name: "omniharness-desktop", version: "0.1.0" },
          autoReconnect: true,
        });
        client.onEvent((e) => {
          for (const h of this.eventHandlers) h(e);
        });
        client.onConnectionChange((s) => {
          this.setState(s === "connected" ? "connected" : "disconnected");
        });
        await client.connect();
        this.client = client;
        this.setState("connected");
        return;
      } catch {
        attempts += 1;
        await sleep(Math.min(5000, 500 * attempts));
      }
    }
  }

  private spawnDaemon(): void {
    const bin = process.env.OMNIHARNESS_DAEMON_BIN;
    if (!bin || !existsSync(bin)) return; // dev: user runs pnpm dev:daemon
    this.spawned = spawn(bin, [], { detached: true, stdio: "ignore" });
    this.spawned.unref();
  }

  /** Typed RPC proxy used by the IPC layer. */
  async call(name: string, params: unknown): Promise<unknown> {
    if (!this.client) throw new Error("daemon not connected");
    return this.client.call(name as never, params as never);
  }

  dispose(): void {
    this.disposed = true;
    void this.client?.close();
    // Never kill the daemon: other clients may be attached.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
