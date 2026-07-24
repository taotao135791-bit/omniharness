/**
 * Dev entry: builds main+preload and launches Electron against them.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..", "..");

const electronBin = process.platform === "win32"
  ? path.join(appDir, "node_modules", ".bin", "electron.cmd")
  : path.join(appDir, "node_modules", ".bin", "electron");

const child = spawn(electronBin, [appDir], {
  stdio: "inherit",
  env: { ...process.env },
});
child.on("exit", (code) => process.exit(code ?? 0));
