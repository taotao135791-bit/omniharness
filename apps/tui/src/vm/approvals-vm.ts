import type { ApprovalRequest } from "@omniharness/agent-protocol";
import { fmtTime, truncate } from "./layout.js";
import { SelectableList } from "./selectable-list.js";

/** Pending approvals queue view-model. */
export class ApprovalsViewModel {
  approvals: ApprovalRequest[] = [];
  loading = false;
  error: string | null = null;
  readonly list = new SelectableList();

  setApprovals(approvals: ApprovalRequest[]): void {
    this.approvals = approvals;
    this.loading = false;
    this.error = null;
    this.list.setRows(
      approvals.map((a) => ({
        id: a.id,
        label: `[${a.risk}] ${a.summary}`,
        detail: `${a.capability}  ${fmtTime(a.createdAt)}`,
      })),
    );
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  /** Insert or update from an approval.requested event. */
  upsert(approval: ApprovalRequest): void {
    const idx = this.approvals.findIndex((a) => a.id === approval.id);
    if (idx === -1) this.approvals.push(approval);
    else this.approvals[idx] = approval;
    this.setApprovals([...this.approvals]);
  }

  removeResolved(approvalId: string): void {
    this.setApprovals(this.approvals.filter((a) => a.id !== approvalId));
  }

  selected(): ApprovalRequest | undefined {
    const row = this.list.selectedRow();
    return row ? this.approvals.find((a) => a.id === row.id) : undefined;
  }

  renderLines(width: number, maxVisible: number): string[] {
    if (this.loading) return ["  loading approvals…"];
    if (this.error) return [truncate(`  error: ${this.error}`, width)];
    if (this.approvals.length === 0) return ["  no pending approvals"];
    return this.list.renderLines(width, maxVisible);
  }
}
