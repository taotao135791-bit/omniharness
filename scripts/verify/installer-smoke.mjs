#!/usr/bin/env node
/**
 * Installer smoke test: verifies built artifacts exist and are launchable where
 * possible. Without signed installers this checks the packaged app directory
 * structure and the CLI bundle. Real OS-package smoke runs in CI per platform.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const releaseDir = path.join(root, "apps", "desktop", "release");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// 1. CLI/daemon bundles are built
check("daemon bundle built", existsSync(path.join(root, "apps", "daemon", "dist", "main.js")));
check("cli bundle built", existsSync(path.join(root, "apps", "cli", "dist", "main.js")));

// 2. CLI responds
const cliMain = path.join(root, "apps", "cli", "dist", "main.js");
if (existsSync(cliMain)) {
  const res = spawnSync("node", [cliMain, "--version"], { encoding: "utf8", timeout: 15000 });
  check("cli --version runs", res.status === 0, (res.stdout || res.stderr).trim().slice(0, 80));
}

// 3. Desktop packages, if produced
if (existsSync(releaseDir)) {
  const artifacts = readdirSync(releaseDir).filter((f) => /\.(dmg|zip|exe|msi|AppImage|deb|tar\.gz)$/.test(f));
  check("desktop installer artifacts exist", artifacts.length > 0, artifacts.join(", ") || "none");
} else {
  console.log("⚠️  desktop release dir absent — installers not built in this environment");
}

process.exit(failures > 0 ? 1 : 0);
