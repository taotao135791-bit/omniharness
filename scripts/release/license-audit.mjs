#!/usr/bin/env node
/**
 * License audit: walks installed production dependencies and reports their
 * licenses. Fails on copyleft licenses not on the allowlist.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const ALLOWLIST = new Set([
  "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD",
  "CC0-1.0", "Unlicense", "Python-2.0", "Zlib",
]);

const seen = new Map();
const violations = [];

function scan(dir) {
  const pkgFile = path.join(dir, "package.json");
  if (!existsSync(pkgFile)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    if (pkg.name && !seen.has(pkg.name)) {
      const license = typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? "UNKNOWN");
      seen.set(pkg.name, { version: pkg.version ?? "?", license });
      const normalized = license.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/i);
      for (const lic of normalized) {
        if (!ALLOWLIST.has(lic) && lic !== "UNKNOWN") {
          violations.push(`${pkg.name}@${pkg.version}: ${license}`);
        }
      }
    }
  } catch { /* skip malformed */ }
}

function walk(dir) {
  if (!existsSync(dir)) return;
  scan(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules") {
      for (const sub of readdirSync(full, { withFileTypes: true })) {
        if (sub.name.startsWith(".")) continue;
        if (sub.name.startsWith("@")) {
          for (const scoped of readdirSync(path.join(full, sub.name))) {
            walk(path.join(full, sub.name, scoped));
          }
        } else {
          walk(path.join(full, sub.name));
        }
      }
    } else {
      walk(full);
    }
  }
}

walk(path.join(root, "node_modules"));

console.log(`audited ${seen.size} packages`);
const licenses = {};
for (const { license } of seen.values()) licenses[license] = (licenses[license] ?? 0) + 1;
console.log("license distribution:", JSON.stringify(licenses, null, 2));
if (violations.length > 0) {
  console.error("\nCOPYLEFT/UNKNOWN violations:");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("license audit passed");
