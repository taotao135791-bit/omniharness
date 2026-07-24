import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBrand } from "@omniharness/config-schema";

export interface DaemonPaths {
  dataDir: string;
  dbFile: string;
  runtimeFile: string;
  logFile: string;
  artifactsDir: string;
  snapshotsDir: string;
}

/** Resolve and create the product data directory layout. */
export function resolvePaths(dataDirOverride?: string): DaemonPaths {
  const brand = loadBrand();
  const dataDir =
    dataDirOverride ??
    process.env.OMNIHARNESS_DATA_DIR ??
    path.join(os.homedir(), `.${brand.identifiers.dataDirName}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const paths: DaemonPaths = {
    dataDir,
    dbFile: path.join(dataDir, "omniharness.db"),
    runtimeFile: path.join(dataDir, "daemon.json"),
    logFile: path.join(dataDir, "daemon.log"),
    artifactsDir: path.join(dataDir, "artifacts"),
    snapshotsDir: path.join(dataDir, "snapshots"),
  };
  fs.mkdirSync(paths.artifactsDir, { recursive: true });
  fs.mkdirSync(paths.snapshotsDir, { recursive: true });
  return paths;
}

export interface RuntimeInfo {
  port: number;
  host: string;
  authToken: string;
  pid: number;
  version: string;
  startedAt: string;
}

/** Generate or load the per-install auth token (0600 file). */
export function loadOrCreateAuthToken(dataDir: string): string {
  const tokenFile = path.join(dataDir, ".auth-token");
  try {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* create below */
  }
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

export function writeRuntimeInfo(file: string, info: RuntimeInfo): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeRuntimeInfo(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}
