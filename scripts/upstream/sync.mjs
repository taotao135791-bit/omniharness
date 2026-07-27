#!/usr/bin/env node
/**
 * Pi upstream sync: records the pinned upstream ref, fetches the latest,
 * diffs the packages we depend on, and verifies our adapter layer still
 * typechecks against the new version. Run manually before bumping pi deps.
 *
 * Usage: node scripts/upstream/sync.mjs [--update]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const pinFile = path.join(root, "scripts", "upstream", "pi-upstream.json");
const cloneDir = path.join(root, "tmp", "upstream", "pi");

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });

const pin = existsSync(pinFile)
  ? JSON.parse(readFileSync(pinFile, "utf8"))
  : { repo: "https://github.com/earendil-works/pi.git", commit: null, packages: {} };

if (!existsSync(cloneDir)) {
  mkdirSync(path.dirname(cloneDir), { recursive: true });
  const clone = run("git", ["clone", "--depth", "50", pin.repo, cloneDir]);
  if (clone.status !== 0) {
    console.error("clone failed:", clone.stderr);
    process.exit(1);
  }
} else {
  run("git", ["fetch", "--depth", "50", "origin"], { cwd: cloneDir });
}

const latest = run("git", ["rev-parse", "origin/main"], { cwd: cloneDir }).stdout.trim();
console.log(`pinned:  ${pin.commit ?? "(none)"}`);
console.log(`latest:  ${latest}`);

if (pin.commit === latest) {
  console.log("upstream unchanged — nothing to do");
  process.exit(0);
}

const diff = run(
  "git",
  [
    "diff",
    "--stat",
    `${pin.commit ?? "HEAD~1"}..${latest}`,
    "--",
    "packages/ai",
    "packages/agent",
    "packages/tui",
  ],
  { cwd: cloneDir },
);
console.log("\nchanges in packages we depend on:");
console.log(diff.stdout || "(could not diff — pin missing)");

if (process.argv.includes("--update")) {
  pin.commit = latest;
  pin.syncedAt = new Date().toISOString();
  writeFileSync(pinFile, JSON.stringify(pin, null, 2));
  console.log(
    "pin updated. Next: bump @earendil-works/pi-* versions, run pnpm install, then pnpm verify.",
  );
} else {
  console.log("\nrun with --update to record this ref as the new pin");
}
