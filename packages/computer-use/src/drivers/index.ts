import type { InputDriver } from "../driver.js";
import { LinuxInputDriver } from "./linux.js";
import { MacInputDriver } from "./mac.js";
import { WindowsInputDriver } from "./windows.js";

export { BaseInputDriver } from "./base.js";
export { LinuxInputDriver } from "./linux.js";
export { MacInputDriver, parseSystemProfilerDisplays } from "./mac.js";
export { WindowsInputDriver } from "./windows.js";

/** Returns the input driver matching the current (or given) platform. */
export function createPlatformDriver(platform: NodeJS.Platform = process.platform): InputDriver {
  switch (platform) {
    case "darwin":
      return new MacInputDriver();
    case "win32":
      return new WindowsInputDriver();
    case "linux":
      return new LinuxInputDriver();
    default:
      throw new Error(`no input driver for platform "${platform}"`);
  }
}
