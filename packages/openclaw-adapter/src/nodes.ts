/**
 * Node bridge — paired OpenClaw nodes (phones/desktops) and command invocation.
 *
 * Nodes are WS clients of the OpenClaw gateway with role "node"; the gateway
 * pushes work as `node.invoke.request` EVENT frames and nodes answer with
 * `node.invoke.result` REQ frames (upstream src/infra/node-commands.ts,
 * packages/gateway-protocol/src/schema/nodes.ts). This bridge keeps the node
 * registry, enforces the dangerous-command arming policy, and correlates
 * invoke results. Transport is injected; no sockets here.
 */

import { randomUUID } from "node:crypto";
import { noopAudit, stamp } from "./audit.js";
import type { AuditSink } from "./audit.js";
import type { EventFrame, GatewayFrame } from "./frames.js";

export interface PairedNode {
  nodeId: string;
  name: string;
  platform: string;
  capabilities: string[];
  pairedAt: string;
}

/** Upstream DEFAULT_DANGEROUS_NODE_COMMANDS (src/gateway/node-command-policy.ts:104). */
export const DEFAULT_DANGEROUS_NODE_COMMANDS: readonly string[] = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "computer.act",
  "sms.send",
  "mobile.ui.observe",
  "mobile.ui.act",
  "health.summary",
];

export function isDangerousNodeCommand(command: string): boolean {
  return DEFAULT_DANGEROUS_NODE_COMMANDS.includes(command);
}

/** Capability prefix of a command: "camera.snap" → "camera". */
export function commandCapability(command: string): string {
  const dot = command.indexOf(".");
  return dot === -1 ? command : command.slice(0, dot);
}

export class NodeRegistry {
  private readonly nodes = new Map<string, PairedNode>();

  constructor(private readonly audit: AuditSink = noopAudit) {}

  pair(node: PairedNode): void {
    this.nodes.set(node.nodeId, node);
    this.audit(
      stamp({
        kind: "node.paired",
        nodeId: node.nodeId,
        name: node.name,
        platform: node.platform,
        capabilities: node.capabilities,
      }),
    );
  }

  revoke(nodeId: string): boolean {
    const removed = this.nodes.delete(nodeId);
    if (removed) this.audit(stamp({ kind: "node.revoked", nodeId }));
    return removed;
  }

  get(nodeId: string): PairedNode | undefined {
    return this.nodes.get(nodeId);
  }

  isPaired(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  list(): PairedNode[] {
    return [...this.nodes.values()];
  }
}

// ── invocation ──────────────────────────────────────────────────────────────

/** Downlink payload of the node.invoke.request event frame. */
export interface NodeInvokeRequestPayload {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
}

/** Uplink payload of node.invoke.result. */
export interface NodeInvokeResultPayload {
  id: string;
  nodeId: string;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
}

export interface NodeInvokeResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** Transport seam: how invoke request frames reach the gateway/node. */
export interface NodeTransport {
  sendEvent(frame: EventFrame): void;
}

export class NodeInvokeError extends Error {
  constructor(
    message: string,
    public readonly code: "not_paired" | "capability_missing" | "not_armed" | "timeout" | "invoke_failed",
  ) {
    super(message);
    this.name = "NodeInvokeError";
  }
}

interface PendingInvoke {
  nodeId: string;
  command: string;
  resolve: (result: NodeInvokeResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NodeBridge {
  private readonly audit: AuditSink;
  private readonly armed: ReadonlySet<string>;
  private readonly pending = new Map<string, PendingInvoke>();

  constructor(
    private readonly registry: NodeRegistry,
    private readonly transport: NodeTransport,
    deps: {
      /**
       * Dangerous commands explicitly armed (upstream
       * `gateway.nodes.commands.allow`). Dangerous commands NOT in this set
       * are refused, exactly like OpenClaw strips them from the runtime
       * allowlist until armed.
       */
      armedCommands?: readonly string[];
      audit?: AuditSink;
    } = {},
  ) {
    this.audit = deps.audit ?? noopAudit;
    this.armed = new Set(deps.armedCommands ?? []);
  }

  /**
   * Invoke a command on a paired node. Resolves when the node's
   * node.invoke.result arrives (fed in via handleGatewayFrame).
   */
  invoke(
    nodeId: string,
    command: string,
    params?: Record<string, unknown>,
    opts: { timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<NodeInvokeResult> {
    const node = this.registry.get(nodeId);
    const invokeId = randomUUID();
    const auditInvoke = (allowed: boolean, reason?: string): void => {
      this.audit(
        stamp({
          kind: "node.invoke",
          nodeId,
          command,
          invokeId,
          allowed,
          ...(reason ? { reason } : {}),
        }),
      );
    };

    if (!node) {
      auditInvoke(false, "not_paired");
      return Promise.reject(new NodeInvokeError(`node ${nodeId} is not paired`, "not_paired"));
    }
    const capability = commandCapability(command);
    if (!node.capabilities.includes(capability)) {
      auditInvoke(false, "capability_missing");
      return Promise.reject(
        new NodeInvokeError(`node ${nodeId} does not declare capability "${capability}"`, "capability_missing"),
      );
    }
    if (isDangerousNodeCommand(command) && !this.armed.has(command)) {
      auditInvoke(false, "not_armed");
      return Promise.reject(
        new NodeInvokeError(
          `dangerous node command "${command}" is not armed (gateway.nodes.commands.allow)`,
          "not_armed",
        ),
      );
    }
    auditInvoke(true);

    const timeoutMs = opts.timeoutMs ?? 60_000;
    const payload: NodeInvokeRequestPayload = { id: invokeId, nodeId, command };
    if (params !== undefined) payload.paramsJSON = JSON.stringify(params);
    payload.timeoutMs = timeoutMs;
    if (opts.idempotencyKey) payload.idempotencyKey = opts.idempotencyKey;

    return new Promise<NodeInvokeResult>((resolve, reject) => {
      const graceMs = Math.min(1000, Math.max(50, Math.floor(timeoutMs * 0.1)));
      const timer = setTimeout(() => {
        this.pending.delete(invokeId);
        reject(new NodeInvokeError(`invoke ${invokeId} timed out`, "timeout"));
      }, timeoutMs + graceMs);
      this.pending.set(invokeId, { nodeId, command, resolve, reject, timer });
      const frame: EventFrame = { type: "event", event: "node.invoke.request", payload };
      try {
        this.transport.sendEvent(frame);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(invokeId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Feed an inbound gateway frame; resolves matching pending invokes. */
  handleGatewayFrame(frame: GatewayFrame): void {
    if (frame.type !== "req" || frame.method !== "node.invoke.result") return;
    const p = frame.params;
    if (typeof p !== "object" || p === null) return;
    const result = p as Record<string, unknown>;
    const id = result["id"];
    if (typeof id !== "string") return;
    const pendingInvoke = this.pending.get(id);
    if (!pendingInvoke) return;
    clearTimeout(pendingInvoke.timer);
    this.pending.delete(id);
    const ok = result["ok"] === true;
    if (ok) {
      const out: NodeInvokeResult = { ok: true };
      if ("payload" in result) out.payload = result["payload"];
      else if (typeof result["payloadJSON"] === "string") {
        try {
          out.payload = JSON.parse(result["payloadJSON"]);
        } catch {
          out.payload = result["payloadJSON"];
        }
      }
      pendingInvoke.resolve(out);
    } else {
      const err = result["error"];
      const message =
        typeof err === "object" && err !== null && typeof (err as Record<string, unknown>)["message"] === "string"
          ? ((err as Record<string, unknown>)["message"] as string)
          : "node invoke failed";
      pendingInvoke.resolve({ ok: false, error: message });
    }
  }

  /** Number of in-flight invocations (for tests/diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
