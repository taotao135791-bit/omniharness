import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { validatePluginManifest } from "@omniharness/config-schema";
import type { PluginManifest, PluginPermissions } from "@omniharness/shared-types";
import { IntegrityMismatchError, ManifestLoadError, ManifestValidationError } from "./errors.js";

export interface LoadedManifest {
  manifest: PluginManifest;
  /** Absolute path of the directory the manifest was loaded from. */
  dir: string;
  /** Absolute path of the plugin entry file. */
  entryPath: string;
  /** Computed SHA-256 (hex) of the entry file. */
  integrityHash: string;
}

function normalizePermissions(raw: PluginPermissions): PluginPermissions {
  return {
    capabilities: raw.capabilities ?? [],
    tools: raw.tools ?? [],
    uiExtensions: raw.uiExtensions ?? [],
    registersProviders: raw.registersProviders ?? false,
    secrets: raw.secrets ?? [],
    networkDomains: raw.networkDomains ?? [],
  };
}

function computeEntryHash(entryPath: string): string {
  return createHash("sha256").update(readFileSync(entryPath)).digest("hex");
}

/** Strip an optional `sha256:` algorithm prefix from a declared hash. */
function normalizeDeclaredHash(declared: string): string {
  const lowered = declared.trim().toLowerCase();
  return lowered.startsWith("sha256:") ? lowered.slice("sha256:".length) : lowered;
}

/**
 * Load and validate a plugin's manifest.json:
 * 1. read + parse the file,
 * 2. validate against the manifest schema (config-schema),
 * 3. resolve the entry file (confined to the plugin directory) and compute
 *    its SHA-256 integrity hash,
 * 4. when the manifest declares an integrityHash, compare it against the
 *    computed one and fail on mismatch.
 */
export function loadManifest(dir: string): LoadedManifest {
  const absDir = resolve(dir);
  const manifestPath = resolve(absDir, "manifest.json");

  let rawText: string;
  try {
    rawText = readFileSync(manifestPath, "utf8");
  } catch {
    throw new ManifestLoadError(`Cannot read plugin manifest at "${manifestPath}"`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new ManifestLoadError(
      `Plugin manifest at "${manifestPath}" is not valid JSON: ${(cause as Error).message}`,
    );
  }

  const issues = validatePluginManifest(parsed);
  if (issues.length > 0) {
    throw new ManifestValidationError(absDir, issues);
  }

  const validated = parsed as PluginManifest;
  const manifest: PluginManifest = {
    ...validated,
    permissions: normalizePermissions(validated.permissions),
  };

  const entryPath = resolve(absDir, manifest.entry);
  if (entryPath !== absDir && !entryPath.startsWith(absDir + sep)) {
    throw new ManifestLoadError(
      `Plugin entry "${manifest.entry}" escapes the plugin directory "${absDir}"`,
    );
  }

  let integrityHash: string;
  try {
    integrityHash = computeEntryHash(entryPath);
  } catch {
    throw new ManifestLoadError(`Cannot read plugin entry file at "${entryPath}"`);
  }

  if (manifest.integrityHash !== undefined) {
    const expected = normalizeDeclaredHash(manifest.integrityHash);
    if (expected !== integrityHash) {
      throw new IntegrityMismatchError(manifest.id, expected, integrityHash);
    }
  }

  return { manifest, dir: absDir, entryPath, integrityHash };
}
