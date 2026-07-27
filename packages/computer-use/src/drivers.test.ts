import { describe, expect, it } from "vitest";
import { createPlatformDriver } from "./drivers/index.js";
import { MacInputDriver, parseSystemProfilerDisplays } from "./drivers/mac.js";

const SAMPLE_PROFILER_OUTPUT = `
Graphics/Displays:

    Apple M3 Pro:

      Chipset Model: Apple M3 Pro
      Type: GPU
      Bus: Built-In
      Total Number of Cores: 18
      Vendor: Apple (0x106b)
      Metal Support: Metal 3
      Displays:
        Color LCD:
          Display Type: Built-in Liquid Retina XDR Display
          Resolution: 3024 x 1964 Retina
          Main Display: Yes
          Mirror: Off
          Online: Yes
          Automatically Adjust Brightness: Yes
          Connection Type: Internal
        LG ULTRAWIDE:
          Resolution: 2560 x 1080 (UWFHD - Ultra Wide Full HD)
          UI Looks like: 2560 x 1080 @ 60.00Hz
          Mirror: Off
          Online: Yes
          Rotation: Supported
`;

describe("parseSystemProfilerDisplays", () => {
  it("parses retina and non-retina displays with scale factors", () => {
    const displays = parseSystemProfilerDisplays(SAMPLE_PROFILER_OUTPUT);
    expect(displays).toHaveLength(2);

    const builtin = displays[0];
    expect(builtin?.name).toBe("Color LCD");
    expect(builtin?.width).toBe(3024);
    expect(builtin?.height).toBe(1964);
    expect(builtin?.scaleFactor).toBe(2);
    expect(builtin?.primary).toBe(true);

    const external = displays[1];
    expect(external?.name).toBe("LG ULTRAWIDE");
    expect(external?.width).toBe(2560);
    expect(external?.height).toBe(1080);
    expect(external?.scaleFactor).toBe(1);
    expect(external?.primary).toBe(false);
  });

  it("derives scaleFactor from UI Looks like when present", () => {
    const output = `
      Displays:
        External:
          Resolution: 5120 x 2880 Retina
          UI Looks like: 2560 x 1440 @ 60.00Hz
          Main Display: Yes
`;
    const displays = parseSystemProfilerDisplays(output);
    expect(displays[0]?.scaleFactor).toBe(2);
  });

  it("returns an empty list for empty output", () => {
    expect(parseSystemProfilerDisplays("")).toEqual([]);
  });
});

describe("platform driver availability", () => {
  it("creates a driver for the current platform and reports availability", async () => {
    const driver = createPlatformDriver();
    const availability = await driver.checkAvailability();
    expect(typeof availability.available).toBe("boolean");
    if (!availability.available) {
      expect(availability.guidance).not.toBeNull();
    }
  });

  it("mac driver reports unavailable off-darwin", async () => {
    if (process.platform === "darwin") {
      return;
    }
    const availability = await new MacInputDriver().checkAvailability();
    expect(availability.available).toBe(false);
  });
});
