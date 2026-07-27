import type { ConnectionState } from "../core/types.js";
import { truncate } from "../vm/layout.js";

export interface HeaderState {
  brand: string;
  connection: ConnectionState;
  daemonVersion: string | null;
  sessionTitle: string | null;
  modelLabel: string | null;
  usageLabel: string | null;
  pendingApprovals: number;
  view: string;
}

/**
 * Header layout (plain text; the shell paints the background).
 * Full form: brand · conn · session · model · usage · approvals
 * Compact form (< 80 cols): brand · conn · model · approvals
 */
export function renderHeader(s: HeaderState, width: number): string[] {
  const conn =
    s.connection === "connected" ? "●" : s.connection === "replaying" ? "◌" : "✗";
  const approvals = s.pendingApprovals > 0 ? `⚠${s.pendingApprovals}` : "";
  if (width < 80) {
    const parts = [s.brand, conn];
    if (s.modelLabel) parts.push(s.modelLabel);
    if (approvals) parts.push(approvals);
    return [truncate(parts.join(" "), width)];
  }
  const parts = [`${s.brand} ${s.daemonVersion ?? ""}`.trim(), conn];
  if (s.sessionTitle) parts.push(truncate(s.sessionTitle, 30));
  if (s.modelLabel) parts.push(s.modelLabel);
  if (s.usageLabel) parts.push(s.usageLabel);
  if (approvals) parts.push(approvals);
  parts.push(`[${s.view}]`);
  return [truncate(parts.join("  ·  "), width)];
}
