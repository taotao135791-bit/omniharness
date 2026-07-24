import type { DisplayInfo, LogicalPoint, PhysicalPoint, ScreenFrame } from "./types.js";

/** Validates that a point is finite and inside the normalized [0,1] square. */
export function assertLogicalPoint(point: LogicalPoint): void {
  for (const axis of ["x", "y"] as const) {
    const value = point[axis];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(
        `logical point ${axis} must be a finite number in [0, 1], got ${String(value)}`,
      );
    }
  }
}

export function isLogicalPoint(point: LogicalPoint): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Maps a normalized logical point to physical pixels of the given frame /
 * display. The result is clamped into the display bounds so an out-of-range
 * input can never target outside the screen.
 */
export function logicalToPhysical(
  point: LogicalPoint,
  target: Pick<ScreenFrame, "width" | "height">,
): PhysicalPoint {
  assertLogicalPoint(point);
  return {
    x: clamp(Math.round(point.x * target.width), 0, Math.max(0, target.width - 1)),
    y: clamp(Math.round(point.y * target.height), 0, Math.max(0, target.height - 1)),
  };
}

/** Inverse of {@link logicalToPhysical}. */
export function physicalToLogical(
  point: PhysicalPoint,
  target: Pick<ScreenFrame, "width" | "height">,
): LogicalPoint {
  if (target.width <= 0 || target.height <= 0) {
    throw new RangeError("display dimensions must be positive");
  }
  return {
    x: clamp(point.x / target.width, 0, 1),
    y: clamp(point.y / target.height, 0, 1),
  };
}

/**
 * Maps a logical point to OS "points" (what macOS CGEvent and most windowing
 * APIs address): physical pixels divided by the display scale factor.
 */
export function logicalToOsPoints(
  point: LogicalPoint,
  display: Pick<DisplayInfo, "width" | "height" | "scaleFactor">,
): PhysicalPoint {
  const physical = logicalToPhysical(point, display);
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1;
  return { x: physical.x / scale, y: physical.y / scale };
}

/**
 * Guards against frame/geometry drift between capture and execution: the
 * proposer's coordinates were computed against a specific frame, so the
 * geometry used at execution time must match it within a tolerance.
 */
export function geometryMatches(
  a: Pick<ScreenFrame, "width" | "height" | "scaleFactor">,
  b: Pick<ScreenFrame, "width" | "height" | "scaleFactor">,
): boolean {
  return (
    a.width === b.width && a.height === b.height && Math.abs(a.scaleFactor - b.scaleFactor) < 1e-6
  );
}
