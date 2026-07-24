#!/usr/bin/env node
/**
 * First-run environment check + workspace setup (`pnpm setup` calls install+build;
 * this script validates the toolchain before that).
 */
import { spawnSync } from "node:child_process";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const nodeMajor = Number(process.versions.node.split(".")[0]);
check("Node.js >= 22.12", nodeMajor >= 22, process.version);

const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
check("pnpm available", pnpm.status === 0, pnpm.stdout?.trim());

const git = spawnSync("git", ["--version"], { encoding: "utf8" });
check("git available", git.status === 0, git.stdout?.trim());

// node:sqlite presence (needed by session-store)
try {
  await import("node:sqlite");
  check("node:sqlite available", true);
} catch {
  check("node:sqlite available", false, "requires Node 22.5+ (24 recommended)");
}

if (failures > 0) {
  console.error("\nsetup prerequisites missing");
  process.exit(1);
}
console.log("\nenvironment ok — run: pnpm install && pnpm build");
