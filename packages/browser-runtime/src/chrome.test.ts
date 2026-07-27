import { describe, expect, it } from "vitest";
import { findBrowserBinary } from "./cdp/launch.js";
import { BrowserRuntime } from "./runtime.js";

/**
 * Real-Chrome smoke test, gated on binary detection: skipped entirely when
 * no Chromium-based browser is installed on this machine.
 */
const binary = await findBrowserBinary();
const describeChrome = binary === null ? describe.skip : describe;

describeChrome("BrowserRuntime with real Chrome", () => {
  it("launches, navigates, evaluates and screenshots", async () => {
    const runtime = await BrowserRuntime.launch({
      mode: "hybrid",
      launch: { headless: true, ...(binary !== null ? { executablePath: binary } : {}) },
    });
    try {
      expect(runtime.profileDir).not.toBeNull();
      const page = await runtime.openPage("about:blank");
      await runtime.navigate(page, "about:blank");
      const value = await runtime.evaluate<number>(page, "40 + 2");
      expect(value).toBe(42);
      const observation = await runtime.observe(page);
      expect(observation.mode).toBe("hybrid");
      expect(observation.screenshotPngBase64).not.toBeNull();
      await runtime.closePage(page);
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
