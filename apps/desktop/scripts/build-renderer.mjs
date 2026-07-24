#!/usr/bin/env node
/**
 * Builds the React renderer with esbuild (no dev server needed for production).
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, copyFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const outDir = path.join(appDir, "renderer");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(appDir, "src", "renderer", "index.tsx")],
  bundle: true,
  outfile: path.join(outDir, "bundle.js"),
  platform: "browser",
  format: "esm",
  sourcemap: true,
  jsx: "automatic",
  target: "chrome120",
  logLevel: "info",
});

copyFileSync(path.join(appDir, "src", "renderer", "index.html"), path.join(outDir, "index.html"));
console.log("renderer built →", outDir);
