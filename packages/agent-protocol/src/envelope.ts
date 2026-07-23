import type { CommandName, CommandParams } from "./commands.js";
import type { DomainEvent } from "./events.js";

/** Client → daemon handshake. */
export interface HelloMessage {
  type: "hello";
  protocolVersion: { major: number; minor: number };
  client: { kind: "tui" | "gui" | "cli" | "sdk" | "channel"; name: string; version: string };
  /** Bearer token from the daemon's local auth file. */
  authToken: string;
  /** Last event seq the client has seen; daemon replays everything after it. */
  lastEventSeq?: number;
}

export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: { major: number; minor: number };
  daemonVersion: string;
  latestSeq: number;
  /** True when events between lastEventSeq and latestSeq were replayed. */
  replayed: boolean;
}

export interface CommandMessage<N extends CommandName = CommandName> {
  type: "command";
  id: string;
  name: N;
  params: CommandParams<N>;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retriable?: boolean };
}

export interface EventMessage {
  type: "event";
  event: DomainEvent;
}

export type ServerMessage = WelcomeMessage | ResponseMessage | EventMessage;
export type ClientMessage = HelloMessage | CommandMessage;

export function encodeMessage(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decodeMessage(data: string): ServerMessage | ClientMessage {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new Error("Invalid protocol message: missing type");
  }
  return parsed as ServerMessage | ClientMessage;
}

/** Standard error codes used across the RPC boundary. */
export const ErrorCodes = {
  UNAUTHORIZED: "unauthorized",
  NOT_FOUND: "not_found",
  INVALID_PARAMS: "invalid_params",
  POLICY_DENIED: "policy_denied",
  APPROVAL_REQUIRED: "approval_required",
  BUDGET_EXCEEDED: "budget_exceeded",
  PROVIDER_ERROR: "provider_error",
  RATE_LIMITED: "rate_limited",
  CONFLICT: "conflict",
  INTERNAL: "internal",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
