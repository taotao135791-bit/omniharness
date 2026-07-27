export type {
  ActionResult,
  ApprovalOutcome,
  ComputerAction,
  ComputerActionKind,
  ComputerContext,
  DisplayInfo,
  LogicalPoint,
  MouseButton,
  Observation,
  ObservedElement,
  PhysicalPoint,
  ScreenFrame,
  TraceEntry,
  VerificationResult,
  WindowInfo,
} from "./types.js";

export {
  assertLogicalPoint,
  geometryMatches,
  isLogicalPoint,
  logicalToOsPoints,
  logicalToPhysical,
  physicalToLogical,
} from "./coordinates.js";

export type { DriverAvailability, InputDriver } from "./driver.js";
export {
  BaseInputDriver,
  createPlatformDriver,
  LinuxInputDriver,
  MacInputDriver,
  parseSystemProfilerDisplays,
  WindowsInputDriver,
} from "./drivers/index.js";

export { findTool, runFile } from "./exec.js";
export type { ExecOptions, ExecResult } from "./exec.js";

export { classifyAction } from "./sensitive.js";
export type { SensitiveAssessment, SensitiveKind } from "./sensitive.js";

export { assertNoSecretLeak, MapSecretResolver } from "./secure-fill.js";
export type { SecretResolver } from "./secure-fill.js";

export { ComputerUseSession } from "./session.js";
export type {
  ApprovalGate,
  ApprovalRequestInfo,
  ComputerUseSessionOptions,
  SessionEndReason,
  SessionSummary,
  VisionProposer,
} from "./session.js";

export { ComposedComputerUseProvider } from "./provider.js";
export type { ComposedProviderOptions, ComputerUseProvider } from "./provider.js";
