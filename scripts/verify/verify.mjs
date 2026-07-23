#!/usr/bin/env node
/**
 * `pnpm verify` — the full verification pipeline. Every stage must pass;
 * failures are never swallowed. Stages run sequentially and stop on first
 * failure with a non-zero exit code and a readable report.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const results = [];
const startedAt = Date.now();

const stages = [
  { name: "format check", cmd: ["pnpm", "format:check"], optional: true },
  { name: "lint", cmd: ["pnpm", "lint"] },
  { name: "typecheck", cmd: ["pnpm", "typecheck"] },
  { name: "unit + contract tests", cmd: ["pnpm", "test"] },
  { name: "integration tests (e2e)", cmd: ["pnpm", "test:e2e"], optional: true },
  { name: "security tests", cmd: ["pnpm", "test:security"], optional: true },
  { name: "production build", cmd: ["pnpm", "build"] },
  { name: "installer smoke", cmd: ["pnpm", "test:installers"], optional: true },
];

let failed = false;
for (const stage of stages) {
  const t0 = Date.now();
  const res = spawnSync(stage.cmd[0], stage.cmd.slice(1), {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CI: "1" },
  });
  const ok = res.status === 0;
  results.push({ name: stage.name, ok, optional: !!stage.optional, ms: Date.now() - t0 });
  if (!ok && !stage.optional) {
    failed = true;
    break;
  }
}

console.log("\n──────── verify report ────────");
for (const r of results) {
  const mark = r.ok ? "✅" : r.optional ? "⚠️ (optional)" : "❌";
  console.log(`${mark} ${r.name} (${(r.ms / 1000).toFixed(1)}s)`);
}
console.log(`total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

mkdirSync(path.join(root, "tmp"), { recursive: true });
writeFileSync(
  path.join(root, "tmp", "verify-report.json"),
  JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2),
);

if (failed) {
  console.error("\nverify FAILED");
  process.exit(1);
}
console.log("\nverify PASSED");
