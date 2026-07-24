import { resolve, sep } from "node:path";
import type { PluginManifest, PluginTrustLevel } from "@omniharness/shared-types";

export interface TrustAssessment {
  level: PluginTrustLevel;
  warnings: string[];
}

/**
 * Structural placeholder for a real signature: `<algorithm>:<payload>`,
 * e.g. `ed25519:base64...`. This checks structure only — cryptographic
 * verification is intentionally out of scope for the SDK and happens
 * host-side against a trust store.
 */
const SIGNATURE_PATTERN = /^[a-z0-9-]+:[A-Za-z0-9+/=_-]{16,}$/i;

/**
 * Classify a plugin's trust level:
 * - `bundled`: ships inside the product's plugins/bundled directory;
 * - `signed`: carries a structurally valid signature;
 * - `unsigned`: everything else (a warning is produced).
 */
export function classifyTrust(dir: string, manifest: PluginManifest): TrustAssessment {
  const warnings: string[] = [];
  const segments = resolve(dir).split(sep);
  const bundledIdx = segments.lastIndexOf("bundled");
  if (bundledIdx > 0 && segments[bundledIdx - 1] === "plugins") {
    return { level: "bundled", warnings };
  }
  if (manifest.signature !== undefined) {
    if (SIGNATURE_PATTERN.test(manifest.signature)) {
      return { level: "signed", warnings };
    }
    warnings.push(
      `Plugin "${manifest.id}" carries a malformed signature; treating it as unsigned.`,
    );
  } else {
    warnings.push(`Plugin "${manifest.id}" is unsigned; review its permissions before enabling.`);
  }
  return { level: "unsigned", warnings };
}
