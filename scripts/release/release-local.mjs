#!/usr/bin/env node
/**
 * Local release: build everything, produce CLI/daemon bundle tarballs and
 * (when possible) desktop installers via electron-builder.
 * Usage: node scripts/release/release-local.mjs [--desktop]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const outDir = path.join(root, "release");
mkdirSync(outDir, { recursive: true });

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status})`);
};

console.log("── build all packages");
run("pnpm", ["build"]);

console.log("── assemble cli+daemon bundle");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const bundleDir = path.join(outDir, `omniharness-${version}`);
mkdirSync(bundleDir, { recursive: true });

// Single-file CJS binaries via esbuild (workspace + npm deps inlined).
const esbuild = path.join(root, "apps", "desktop", "node_modules", ".bin", "esbuild");
for (const [entry, dest] of [
  ["apps/cli/src/main.ts", "bin/omni"],
  ["apps/daemon/src/main.ts", "bin/omniharnessd"],
]) {
  mkdirSync(path.dirname(path.join(bundleDir, dest)), { recursive: true });
  run(esbuild, [
    path.join(root, entry),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${path.join(bundleDir, dest)}`,
  ]);
  // Executable bit for *nix installs.
  try {
    (await import("node:fs")).chmodSync(path.join(bundleDir, dest), 0o755);
  } catch { /* windows */ }
}
copyFileSync(path.join(root, "brand.config.json"), path.join(bundleDir, "brand.config.json"));
copyFileSync(path.join(root, "LICENSE"), path.join(bundleDir, "LICENSE"));
copyFileSync(path.join(root, "NOTICE"), path.join(bundleDir, "NOTICE"));

// Install shim scripts.
writeFileSync(
  path.join(bundleDir, "install.sh"),
  `#!/bin/sh
# OmniHarness installer (unsigned test build)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREFIX="$1"
if [ -z "$PREFIX" ]; then
  echo "usage: sh install.sh <prefix>   (e.g. sh install.sh ~/.local)"
  exit 1
fi
mkdir -p "$PREFIX/bin" "$PREFIX/lib"
rm -rf "$PREFIX/lib/omniharness"
cp -R "$SCRIPT_DIR" "$PREFIX/lib/omniharness"
for tool in omni omniharnessd; do
  cat > "$PREFIX/bin/$tool" <<SH
#!/bin/sh
exec node "$PREFIX/lib/omniharness/bin/$tool" "\\$@"
SH
  chmod +x "$PREFIX/bin/$tool"
done
echo "OmniHarness installed to $PREFIX"
echo "Add to PATH: export PATH=\"$PREFIX/bin:\\$PATH\""
`,
);
console.log(`bundle: ${bundleDir}`);

console.log("── tarball");
run("tar", ["-czf", `${bundleDir}.tar.gz`, "-C", outDir, path.basename(bundleDir)]);
console.log(`tarball: ${bundleDir}.tar.gz`);

if (process.argv.includes("--desktop")) {
  console.log("── desktop installers (electron-builder)");
  run("pnpm", ["--filter", "@omniharness/desktop", "build"]);
  run("pnpm", ["--filter", "@omniharness/desktop", "dist"]);
}

console.log("── sha256");
run("shasum", ["-a", "256", `${bundleDir}.tar.gz`]);
console.log("release:local done");
