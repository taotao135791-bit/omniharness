import { logicalToOsPoints, logicalToPhysical } from "../coordinates.js";
import type { InputDriver } from "../driver.js";
import type { DisplayInfo, LogicalPoint, PhysicalPoint } from "../types.js";

/**
 * Shared geometry plumbing for concrete drivers: caches the primary display
 * and converts normalized logical points to the coordinate space the OS API
 * expects.
 */
export abstract class BaseInputDriver implements InputDriver {
  abstract readonly platform: string;
  private cachedPrimary: DisplayInfo | null = null;

  abstract checkAvailability(): ReturnType<InputDriver["checkAvailability"]>;
  abstract listDisplays(): Promise<DisplayInfo[]>;
  abstract moveTo(point: LogicalPoint): Promise<void>;
  abstract click(point: LogicalPoint, button?: import("../types.js").MouseButton): Promise<void>;
  abstract doubleClick(
    point: LogicalPoint,
    button?: import("../types.js").MouseButton,
  ): Promise<void>;
  abstract drag(
    from: LogicalPoint,
    to: LogicalPoint,
    button?: import("../types.js").MouseButton,
  ): Promise<void>;
  abstract scroll(point: LogicalPoint, deltaX: number, deltaY: number): Promise<void>;
  abstract typeText(text: string): Promise<void>;
  abstract keyPress(key: string, modifiers?: string[]): Promise<void>;
  abstract shortcut(keys: string[]): Promise<void>;
  abstract launchApp(app: string, args?: string[]): Promise<void>;
  abstract activeWindow(): Promise<import("../types.js").WindowInfo | null>;
  abstract screenshot(): Promise<import("../types.js").ScreenFrame>;

  /** Primary display, resolved lazily and cached. */
  async primaryDisplay(): Promise<DisplayInfo> {
    if (this.cachedPrimary !== null) {
      return this.cachedPrimary;
    }
    const displays = await this.listDisplays();
    const primary = displays.find((d) => d.primary) ?? displays[0];
    if (primary === undefined) {
      throw new Error("no displays reported by the platform driver");
    }
    this.cachedPrimary = primary;
    return primary;
  }

  /** Re-resolve display geometry (e.g. after a monitor change). */
  refreshDisplays(): void {
    this.cachedPrimary = null;
  }

  /** Logical [0,1] -> physical pixels of the primary display. */
  protected async toPhysical(point: LogicalPoint): Promise<PhysicalPoint> {
    return logicalToPhysical(point, await this.primaryDisplay());
  }

  /** Logical [0,1] -> OS points (physical px / scaleFactor). */
  protected async toOsPoints(point: LogicalPoint): Promise<PhysicalPoint> {
    return logicalToOsPoints(point, await this.primaryDisplay());
  }
}
