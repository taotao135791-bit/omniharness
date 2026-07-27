import { describe, expect, it } from "vitest";
import {
  assertLogicalPoint,
  geometryMatches,
  isLogicalPoint,
  logicalToOsPoints,
  logicalToPhysical,
  physicalToLogical,
} from "./coordinates.js";

describe("coordinate normalization", () => {
  const display = { width: 5120, height: 2880, scaleFactor: 2 };

  it("maps logical [0,1] to physical pixels", () => {
    expect(logicalToPhysical({ x: 0.5, y: 0.5 }, display)).toEqual({ x: 2560, y: 1440 });
    expect(logicalToPhysical({ x: 0, y: 0 }, display)).toEqual({ x: 0, y: 0 });
  });

  it("clamps the upper edge into display bounds", () => {
    expect(logicalToPhysical({ x: 1, y: 1 }, display)).toEqual({ x: 5119, y: 2879 });
  });

  it("maps logical to OS points via scaleFactor", () => {
    expect(logicalToOsPoints({ x: 0.5, y: 0.5 }, display)).toEqual({ x: 1280, y: 720 });
  });

  it("round-trips physical <-> logical", () => {
    const logical = physicalToLogical({ x: 2560, y: 1440 }, display);
    expect(logical.x).toBeCloseTo(0.5);
    expect(logical.y).toBeCloseTo(0.5);
  });

  it("rejects out-of-range logical points", () => {
    expect(() => assertLogicalPoint({ x: -0.1, y: 0.5 })).toThrow(RangeError);
    expect(() => assertLogicalPoint({ x: 0.5, y: 1.1 })).toThrow(RangeError);
    expect(() => assertLogicalPoint({ x: Number.NaN, y: 0 })).toThrow(RangeError);
    expect(isLogicalPoint({ x: 0.25, y: 0.75 })).toBe(true);
    expect(isLogicalPoint({ x: 2, y: 0 })).toBe(false);
  });

  it("rejects zero-size displays", () => {
    expect(() => physicalToLogical({ x: 0, y: 0 }, { width: 0, height: 100 })).toThrow(RangeError);
  });

  it("detects geometry drift between capture and execution", () => {
    const a = { width: 5120, height: 2880, scaleFactor: 2 };
    expect(geometryMatches(a, { ...a })).toBe(true);
    expect(geometryMatches(a, { ...a, width: 2560 })).toBe(false);
    expect(geometryMatches(a, { ...a, scaleFactor: 1 })).toBe(false);
  });
});
