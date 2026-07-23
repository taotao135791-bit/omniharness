import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Centralized branding. Every user-visible name, identifier and piece of copy
 * flows from brand.config.json at the repo root. A rename touches one file.
 */

export interface BrandConfig {
  product: {
    codeName: string;
    displayName: string;
    tagline: string;
    vendor: string;
    website: string;
    supportUrl: string;
    license: string;
  };
  identifiers: {
    bundleId: string;
    appId: string;
    cliBin: string;
    daemonServiceName: string;
    dataDirName: string;
    configFileName: string;
    registryNamespace: string;
  };
  paths: { iconSvg: string; iconPng: string; iconIco: string; iconIcns: string };
  channels: Record<string, { name: string; autoUpdate: boolean }>;
  copy: { welcome: string; onboardingTitle: string; shortDescription: string };
}

let cached: BrandConfig | null = null;

/** Load brand.config.json, searching upwards from cwd. */
export function loadBrand(fromDir: string = process.cwd()): BrandConfig {
  if (cached) return cached;
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "brand.config.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      cached = JSON.parse(raw) as BrandConfig;
      return cached;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error("brand.config.json not found (searched upwards from " + fromDir + ")");
      dir = parent;
    }
  }
}

/** For tests: inject a brand config directly. */
export function __setBrandForTests(brand: BrandConfig | null): void {
  cached = brand;
}
