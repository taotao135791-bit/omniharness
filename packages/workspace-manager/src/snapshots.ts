import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { SnapshotError } from "./errors.js";
import { IgnoreMatcher } from "./ignore.js";
import { realpathLoose } from "./paths.js";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const ALWAYS_SKIPPED = new Set(["node_modules", ".git"]);

export interface SnapshotOptions {
  label?: string;
  /** Files larger than this are recorded but their content is not stored. */
  maxFileSizeBytes?: number;
}

export interface SnapshotInfo {
  id: string;
  dir: string;
  label: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  /** Files whose content was not stored (over the size cap). */
  skippedFiles: string[];
}

interface ManifestEntry {
  /** Index into Manifest.roots. */
  root: number;
  /** POSIX path relative to the root. */
  path: string;
  size: number;
  mode: number;
  sha256?: string;
  skipped?: boolean;
}

interface Manifest {
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  roots: string[];
  files: ManifestEntry[];
}

interface WalkedFile {
  root: number;
  rel: string;
  abs: string;
  size: number;
  mode: number;
}

async function hashFile(abs: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(abs);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolvePromise());
    stream.on("error", rejectPromise);
  });
  return hash.digest("hex");
}

/**
 * Recursively collects regular files under each workspace root. Skips
 * symlinks, `node_modules`/`.git`, and anything matched by the root's
 * `.gitignore` / `.omniharnessignore`.
 */
export async function walkWorkspaceFiles(workspace: Workspace): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];

  const walk = async (
    rootIndex: number,
    absDir: string,
    relDir: string,
    matcher: IgnoreMatcher,
  ): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED.has(entry.name)) continue;
        if (matcher.isIgnored(rel, true)) continue;
        await walk(rootIndex, abs, rel, matcher);
      } else if (entry.isFile()) {
        if (matcher.isIgnored(rel, false)) continue;
        const info = await stat(abs);
        out.push({ root: rootIndex, rel, abs, size: info.size, mode: info.mode });
      }
    }
  };

  for (let i = 0; i < workspace.roots.length; i++) {
    const root = workspace.roots[i]!;
    await walk(i, root, "", await IgnoreMatcher.fromRoot(root));
  }
  return out;
}

function snapshotDir(dataDir: string, id: string): string {
  return path.join(dataDir, "snapshots", id);
}

/**
 * Captures the workspace's current file set. File content is copied
 * content-addressed under `<dataDir>/snapshots/<id>/blobs/<sha256>` (a copy,
 * never a hardlink, so in-place writers cannot corrupt the blob store),
 * plus a manifest describing the exact file set.
 */
export async function createSnapshot(
  workspace: Workspace,
  dataDir: string,
  opts?: SnapshotOptions,
): Promise<SnapshotInfo> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = snapshotDir(dataDir, id);
  const blobsDir = path.join(dir, "blobs");
  await mkdir(blobsDir, { recursive: true });

  const maxSize = opts?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const files = await walkWorkspaceFiles(workspace);
  const entries: ManifestEntry[] = [];
  const skippedFiles: string[] = [];
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.size;
    if (file.size > maxSize) {
      entries.push({ root: file.root, path: file.rel, size: file.size, mode: file.mode, skipped: true });
      skippedFiles.push(file.rel);
      continue;
    }
    const sha256 = await hashFile(file.abs);
    const blob = path.join(blobsDir, sha256);
    try {
      await stat(blob);
    } catch {
      // Copy (not hardlink): writers that truncate in place would otherwise
      // corrupt the blob through the shared inode.
      await copyFile(file.abs, blob);
    }
    entries.push({ root: file.root, path: file.rel, size: file.size, mode: file.mode, sha256 });
  }

  const createdAt = nowIso();
  const manifest: Manifest = {
    version: 1,
    id,
    label: opts?.label ?? "",
    createdAt,
    roots: workspace.roots,
    files: entries,
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return {
    id,
    dir,
    label: manifest.label,
    createdAt,
    fileCount: entries.length,
    totalBytes,
    skippedFiles,
  };
}

async function readManifest(dataDir: string, id: string): Promise<Manifest> {
  const raw = await readFile(path.join(snapshotDir(dataDir, id), "manifest.json"), "utf8");
  return JSON.parse(raw) as Manifest;
}

/**
 * Restores the exact file set captured by a snapshot: files added after the
 * snapshot are deleted, modified files are overwritten from the blob store,
 * missing files are recreated, and directories left empty are pruned.
 */
export async function restoreSnapshot(
  workspace: Workspace,
  dataDir: string,
  id: string,
): Promise<{ restored: number; deleted: number; skipped: string[] }> {
  const dir = snapshotDir(dataDir, id);
  const blobsDir = path.join(dir, "blobs");
  const manifest = await readManifest(dataDir, id);

  const wanted = new Map<string, ManifestEntry>();
  for (const entry of manifest.files) {
    const root = manifest.roots[entry.root];
    if (root !== undefined) wanted.set(`${entry.root}:${entry.path}`, entry);
  }

  // 1. Delete files that did not exist at snapshot time.
  const current = await walkWorkspaceFiles(workspace);
  let deleted = 0;
  for (const file of current) {
    if (!wanted.has(`${file.root}:${file.rel}`)) {
      await rm(file.abs, { force: true });
      deleted++;
    }
  }

  // 2. Restore files that are missing or whose content differs.
  let restored = 0;
  const skipped: string[] = [];
  for (const entry of manifest.files) {
    if (entry.skipped || !entry.sha256) {
      skipped.push(entry.path);
      continue;
    }
    const root = workspace.roots[entry.root] ?? (await realpathLoose(manifest.roots[entry.root]!));
    const abs = path.join(root, ...entry.path.split("/"));
    let needsRestore = true;
    try {
      const info = await stat(abs);
      needsRestore = info.size !== entry.size || (await hashFile(abs)) !== entry.sha256;
    } catch {
      needsRestore = true;
    }
    if (!needsRestore) continue;
    await mkdir(path.dirname(abs), { recursive: true });
    await rm(abs, { force: true });
    const blob = path.join(blobsDir, entry.sha256);
    try {
      await copyFile(blob, abs);
    } catch (error) {
      throw new SnapshotError(
        `Blob ${entry.sha256} for ${entry.path} missing from snapshot ${id}: ${String(error)}`,
      );
    }
    restored++;
  }

  // 3. Prune directories left empty (deepest first).
  const dirs: string[] = [];
  const collectDirs = async (absDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !ALWAYS_SKIPPED.has(entry.name)) {
        const child = path.join(absDir, entry.name);
        await collectDirs(child);
        dirs.push(child);
      }
    }
  };
  for (const root of workspace.roots) {
    await collectDirs(root);
  }
  for (const d of dirs) {
    // rmdir fails on non-empty directories, which is exactly what we want.
    await rmdir(d).catch(() => undefined);
  }

  return { restored, deleted, skipped };
}
