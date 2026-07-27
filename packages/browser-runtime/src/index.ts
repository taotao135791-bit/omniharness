export {
  computeAcceptKey,
  encodeFrame,
  MAX_PAYLOAD_BYTES,
  OPCODES,
  WebSocketConnection,
  WsFrameParser,
  WS_GUID,
} from "./cdp/websocket.js";
export type { WebSocketConnectOptions, WsCloseInfo, WsFrame, WsOpcode } from "./cdp/websocket.js";

export { CdpClient, CdpProtocolError } from "./cdp/client.js";
export type { CdpError, CdpEventHandler } from "./cdp/client.js";

export { findBrowserBinary, launchBrowser } from "./cdp/launch.js";
export type { LaunchedBrowser, LaunchOptions } from "./cdp/launch.js";

export { BrowserRuntime, PolicyDeniedError, UploadDeniedError } from "./runtime.js";
export type { BrowserRuntimeOptions } from "./runtime.js";

export { sanitizeObservation } from "./sanitize.js";
export type { SanitizeResult } from "./sanitize.js";

export { allowlistGate, policyEngineGate } from "./policy.js";

export type {
  BrowserMode,
  BrowserObservation,
  BrowserPage,
  ConsoleRecord,
  NetworkRecord,
  PolicyGate,
} from "./types.js";
