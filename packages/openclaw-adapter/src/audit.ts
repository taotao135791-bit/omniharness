import type { IsoTimestamp } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";

/**
 * Audit trail for the OpenClaw adapter. Every inbound message, authorization
 * decision and approval relay is appended to an injected sink. The sink is
 * owned by the host (typically backed by the daemon's event log); the adapter
 * never decides where audit records go.
 */
export type AuditEvent =
  | {
      kind: "inbound.received";
      at: IsoTimestamp;
      channel: string;
      accountId: string;
      senderId: string;
      chatType: string;
      bodyBytes: number;
    }
  | {
      kind: "authz.decision";
      at: IsoTimestamp;
      channel: string;
      accountId: string;
      senderId: string;
      allowed: boolean;
      reason: string;
      sessionKey?: string;
    }
  | {
      kind: "rate_limited";
      at: IsoTimestamp;
      channel: string;
      accountId: string;
      senderId: string;
    }
  | {
      kind: "media_rejected";
      at: IsoTimestamp;
      channel: string;
      accountId: string;
      senderId: string;
      mediaType: string;
      sizeBytes: number;
      maxBytes: number;
    }
  | {
      kind: "session.mapped";
      at: IsoTimestamp;
      sessionKey: string;
      sessionId: string;
      profileId: string;
    }
  | {
      kind: "turn.started";
      at: IsoTimestamp;
      sessionKey: string;
      sessionId: string;
      runId: string;
    }
  | {
      kind: "turn.finished";
      at: IsoTimestamp;
      sessionKey: string;
      sessionId: string;
      runId: string;
      status: string;
    }
  | {
      kind: "approval.requested";
      at: IsoTimestamp;
      approvalId: string;
      sessionId: string;
      capability: string;
      channel?: string;
    }
  | {
      kind: "approval.relayed";
      at: IsoTimestamp;
      approvalId: string;
      decision: "approve" | "deny" | "timeout";
      senderId?: string;
      channel?: string;
    }
  | {
      kind: "node.paired";
      at: IsoTimestamp;
      nodeId: string;
      name: string;
      platform: string;
      capabilities: string[];
    }
  | {
      kind: "node.revoked";
      at: IsoTimestamp;
      nodeId: string;
    }
  | {
      kind: "node.invoke";
      at: IsoTimestamp;
      nodeId: string;
      command: string;
      invokeId: string;
      allowed: boolean;
      reason?: string;
    };

export type AuditSink = (event: AuditEvent) => void;

/** Default sink: drops records. Hosts should inject a real one. */
export const noopAudit: AuditSink = () => {};

/** Test/dev helper: collect records in memory. */
export function collectingAudit(events: AuditEvent[] = []): { sink: AuditSink; events: AuditEvent[] } {
  return { sink: (e) => events.push(e), events };
}

export function stamp(event: Omit<AuditEvent, "at"> & { at?: IsoTimestamp }): AuditEvent {
  return { ...event, at: event.at ?? nowIso() } as AuditEvent;
}
