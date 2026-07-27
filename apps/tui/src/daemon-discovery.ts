import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadBrand } from "@omniharness/config-schema";

export interface DaemonRuntimeInfo {
  port: number;
  host: string;
  authToken: string;
  pid: number;
  version: string;
  startedAt: string;
}

/** Resolve the product data directory (~/.<dataDirName> by default). */
export function dataDir(): string {
  const override = process.env.OMNIHARNESS_DATA_DIR;
  if (override) return override;
  const brand = loadBrand();
  return path.join(os.homedir(), `.${brand.identifiers.dataDirName}`);
}

/** Read the daemon's runtime file written at startup (mode 0600). */
export function readDaemonInfo(dir: string = dataDir()): DaemonRuntimeInfo | null {
  const file = path.join(dir, "daemon.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonRuntimeInfo;
  } catch {
    return null;
  }
}

export function daemonUrl(info: DaemonRuntimeInfo): string {
  return `ws://${info.host}:${info.port}`;
}
