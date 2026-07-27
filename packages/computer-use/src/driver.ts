import type { DisplayInfo, LogicalPoint, MouseButton, ScreenFrame, WindowInfo } from "./types.js";

export interface DriverAvailability {
  available: boolean;
  /** Tools that were probed and not found. */
  missingTools: string[];
  /** Human-readable install / setup guidance when unavailable. */
  guidance: string | null;
}

/**
 * OS-level actuator, deliberately separated from the model side: drivers know
 * how to move pixels and press keys, nothing about goals or screenshots
 * semantics.
 *
 * All pointer coordinates in this interface are normalized logical points
 * ([0,1] x [0,1]) against the primary display; each driver converts to
 * physical pixels / OS points using that display's scaleFactor.
 */
export interface InputDriver {
  readonly platform: string;

  /** Probes whether the underlying platform tools exist and are usable. */
  checkAvailability(): Promise<DriverAvailability>;

  moveTo(point: LogicalPoint): Promise<void>;
  click(point: LogicalPoint, button?: MouseButton): Promise<void>;
  doubleClick(point: LogicalPoint, button?: MouseButton): Promise<void>;
  drag(from: LogicalPoint, to: LogicalPoint, button?: MouseButton): Promise<void>;
  scroll(point: LogicalPoint, deltaX: number, deltaY: number): Promise<void>;
  typeText(text: string): Promise<void>;
  keyPress(key: string, modifiers?: string[]): Promise<void>;
  /** keys like ["cmd", "s"] — last entry is the key, rest are modifiers. */
  shortcut(keys: string[]): Promise<void>;
  launchApp(app: string, args?: string[]): Promise<void>;
  activeWindow(): Promise<WindowInfo | null>;
  screenshot(): Promise<ScreenFrame>;
  listDisplays(): Promise<DisplayInfo[]>;

  /**
   * Optional: bring a window/app to the foreground by name or title
   * substring. Returns false when the platform driver cannot do it.
   */
  activateWindow?(target: string): Promise<boolean>;
}
