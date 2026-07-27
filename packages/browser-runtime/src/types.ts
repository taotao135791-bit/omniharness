import type { IsoTimestamp } from "@omniharness/shared-types";

/**
 * Observation modes. The caller MUST declare the mode up front and every
 * observation records which mode produced it, so a human always knows
 * whether the model is seeing pixels, DOM, or both.
 */
export type BrowserMode = "visual" | "dom" | "hybrid";

/** Domain allow/deny gate consulted before every navigation. */
export interface PolicyGate {
  check(domain: string): Promise<boolean>;
}

export interface BrowserPage {
  targetId: string;
  sessionId: string;
  url: string;
}

export interface ConsoleRecord {
  type: string;
  text: string;
  url: string | null;
  at: IsoTimestamp;
}

export interface NetworkRecord {
  kind: "request" | "response" | "loading_finished" | "loading_failed";
  url: string;
  method: string | null;
  status: number | null;
  at: IsoTimestamp;
}

/**
 * What the model is allowed to see, per observation. Fields not produced by
 * the declared mode are null — a visual observation never contains DOM text
 * and a dom observation never contains a screenshot.
 */
export interface BrowserObservation {
  mode: BrowserMode;
  url: string;
  title: string | null;
  screenshotPngBase64: string | null;
  /** Page text, passed through sanitizeObservation. */
  domText: string | null;
  /** Raw DOMSnapshot.captureSnapshot payload (opaque CDP result). */
  domSnapshot: unknown;
  /** Raw Accessibility.getFullAXTree payload (opaque CDP result). */
  axTree: unknown;
  /** True when untrusted-content sanitization removed/flagged something. */
  sanitizeFlagged: boolean;
  capturedAt: IsoTimestamp;
}
