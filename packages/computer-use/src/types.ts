import type { IsoTimestamp } from "@omniharness/shared-types";

/**
 * A single captured screen frame.
 *
 * `width`/`height` are PHYSICAL pixels of the capture; `scaleFactor` maps
 * physical pixels to logical "points" (points = px / scaleFactor), which is
 * what macOS window-server coordinates are expressed in.
 */
export interface ScreenFrame {
  width: number;
  height: number;
  scaleFactor: number;
  pngBase64: string;
  capturedAt: IsoTimestamp;
  displayId: string;
}

/** Normalized logical coordinate: x and y in the closed range [0, 1]. */
export interface LogicalPoint {
  x: number;
  y: number;
}

/** Physical pixel coordinate on a specific display. */
export interface PhysicalPoint {
  x: number;
  y: number;
}

export type MouseButton = "left" | "right" | "middle";

export interface DisplayInfo {
  displayId: string;
  name: string;
  /** Physical pixel size. */
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

export interface WindowInfo {
  appName: string;
  title: string | null;
}

/**
 * Actions the model may propose. All coordinates are normalized logical
 * points ([0,1] x [0,1]) relative to the frame the action was proposed
 * against; the driver converts to physical pixels / points per display.
 *
 * `hint` is free-text intent ("click the Delete button", "type into the
 * password field") used ONLY for sensitive-action classification and audit;
 * it is never required for execution.
 */
export type ComputerAction =
  | { kind: "mouse_move"; point: LogicalPoint; hint?: string }
  | { kind: "click"; point: LogicalPoint; button?: MouseButton; hint?: string }
  | { kind: "double_click"; point: LogicalPoint; button?: MouseButton; hint?: string }
  | {
      kind: "drag";
      from: LogicalPoint;
      to: LogicalPoint;
      button?: MouseButton;
      hint?: string;
    }
  | {
      kind: "scroll";
      point: LogicalPoint;
      /** Scroll deltas in "notch" units; positive deltaY scrolls down. */
      deltaX: number;
      deltaY: number;
      hint?: string;
    }
  | { kind: "type"; text: string; hint?: string }
  | { kind: "key_press"; key: string; modifiers?: string[]; hint?: string }
  /** e.g. ["cmd", "s"] or ["ctrl", "shift", "p"] — last entry is the key. */
  | { kind: "shortcut"; keys: string[]; hint?: string }
  | { kind: "launch_app"; app: string; args?: string[]; hint?: string }
  | { kind: "switch_window"; target: string; hint?: string }
  | { kind: "wait"; ms: number; hint?: string }
  | { kind: "screenshot"; hint?: string }
  /** Types local file paths into an open file dialog. Always approval-gated. */
  | { kind: "choose_file"; paths: string[]; hint?: string }
  /**
   * Types a secret WITHOUT the model ever seeing its value. `secretRef` is an
   * opaque reference resolved by the session's SecretResolver at execution
   * time; the resolved value goes straight to the input driver.
   */
  | { kind: "secure_fill"; secretRef: string; point?: LogicalPoint; hint?: string };

export type ComputerActionKind = ComputerAction["kind"];

/** A UI element detected by a vision inspector, bounds in logical coords. */
export interface ObservedElement {
  id: string;
  role: string | null;
  label: string | null;
  bounds: { x: number; y: number; width: number; height: number };
}

/** What the model sees: a frame plus whatever the inspector extracted. */
export interface Observation {
  frame: ScreenFrame;
  description: string | null;
  elements: ObservedElement[];
}

export interface ActionResult {
  /** The action as recorded in the trace (secrets redacted). */
  action: ComputerAction;
  ok: boolean;
  error: string | null;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp;
}

export interface VerificationResult {
  verified: boolean;
  reason: string;
}

export type ApprovalOutcome = "not_required" | "approved" | "denied";

/** One recorded step of a session loop, in execution order. */
export interface TraceEntry {
  step: number;
  action: ComputerAction;
  sensitiveKinds: string[];
  approval: ApprovalOutcome;
  result: ActionResult | null;
  verification: VerificationResult | null;
  at: IsoTimestamp;
}

/**
 * Everything the proposer is allowed to see. Secret VALUES never appear here
 * — only the list of reference names usable with `secure_fill`.
 */
export interface ComputerContext {
  goal: string;
  step: number;
  observation: Observation;
  trace: readonly TraceEntry[];
  /** Opaque secret reference names available for `secure_fill` actions. */
  secretRefs: readonly string[];
}
