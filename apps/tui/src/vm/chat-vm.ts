import type { ApprovalRequest, DomainEvent, Message } from "@omniharness/agent-protocol";
import { fmtCost, fmtTokens, summarizeArgs, truncate, wrapPlain } from "./layout.js";

export type ToolStatus = "running" | "done" | "failed" | "denied";

export type ChatBlock =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      messageId: string;
      text: string;
      reasoning: string;
      streaming: boolean;
    }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      argsJson: string;
      output: string;
      status: ToolStatus;
      durationMs: number | null;
      error: string | null;
      expanded: boolean;
    }
  | {
      kind: "approval";
      id: string;
      approval: ApprovalRequest;
    }
  | { kind: "system"; id: string; text: string }
  | {
      kind: "compaction";
      id: string;
      beforeTokens: number | null;
      afterTokens: number | null;
      done: boolean;
    };

export interface RunState {
  runId: string;
  modelId: string;
  compacting: boolean;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  runs: number;
}

let blockCounter = 0;
function nextId(prefix: string): string {
  blockCounter += 1;
  return `${prefix}-${blockCounter}`;
}

/**
 * Chat transcript view-model. Pure state machine: history in, domain events
 * in, plain-text layout out. The view layer adds markdown rendering and color
 * on top of `blocks`.
 */
export class ChatViewModel {
  blocks: ChatBlock[] = [];
  sessionId: string | null = null;
  sessionTitle = "";
  activeRun: RunState | null = null;
  /** Follow-up messages queued while a run is active. */
  queuedFollowUps = 0;
  usage: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
  /** Default collapse state for new tool blocks (from tui.collapseToolCalls). */
  collapseToolCalls = true;
  /** Show reasoning blocks (from settings later; on by default). */
  showReasoning = true;

  private assistantByMessageId = new Map<string, Extract<ChatBlock, { kind: "assistant" }>>();
  private toolByCallId = new Map<string, Extract<ChatBlock, { kind: "tool" }>>();

  reset(sessionId: string, title: string): void {
    this.blocks = [];
    this.sessionId = sessionId;
    this.sessionTitle = title;
    this.activeRun = null;
    this.queuedFollowUps = 0;
    this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
    this.assistantByMessageId.clear();
    this.toolByCallId.clear();
  }

  /** Load persisted history from session.messages. */
  loadHistory(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n");
        if (text) this.blocks.push({ kind: "user", id: msg.id, text });
      } else if (msg.role === "assistant") {
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n");
        const reasoning = msg.parts
          .filter((p) => p.type === "reasoning")
          .map((p) => p.text ?? "")
          .join("\n");
        if (text || reasoning) {
          this.blocks.push({
            kind: "assistant",
            id: msg.id,
            messageId: msg.id,
            text,
            reasoning,
            streaming: false,
          });
        }
        for (const part of msg.parts) {
          if (part.type === "tool_call" && part.toolCallId) {
            this.blocks.push({
              kind: "tool",
              id: `${msg.id}-${part.toolCallId}`,
              toolCallId: part.toolCallId,
              toolName: part.toolName ?? "tool",
              argsJson: part.argumentsJson ?? "",
              output: "",
              status: "done",
              durationMs: null,
              error: null,
              expanded: false,
            });
          }
        }
      }
    }
  }

  /** Echo a submitted user message locally (daemon does not re-broadcast it). */
  addUserMessage(text: string): void {
    this.blocks.push({ kind: "user", id: nextId("u"), text });
  }

  addSystemMessage(text: string): void {
    this.blocks.push({ kind: "system", id: nextId("s"), text });
  }

  /** Apply a domain event. Returns true if the transcript changed. */
  applyEvent(ev: DomainEvent): boolean {
    switch (ev.type) {
      case "message.started": {
        if (!this.forThisSession(ev.sessionId) || ev.role !== "assistant") return false;
        const block: Extract<ChatBlock, { kind: "assistant" }> = {
          kind: "assistant",
          id: nextId("a"),
          messageId: ev.messageId,
          text: "",
          reasoning: "",
          streaming: true,
        };
        this.assistantByMessageId.set(ev.messageId, block);
        this.blocks.push(block);
        return true;
      }
      case "message.delta": {
        if (!this.forThisSession(ev.sessionId)) return false;
        const block = this.assistantByMessageId.get(ev.messageId);
        if (!block) return false;
        if (ev.channel === "reasoning") block.reasoning += ev.delta;
        else block.text += ev.delta;
        return true;
      }
      case "message.completed": {
        if (!this.forThisSession(ev.sessionId)) return false;
        const block = this.assistantByMessageId.get(ev.messageId);
        if (!block) return false;
        block.streaming = false;
        return true;
      }
      case "tool.call.started": {
        if (!this.forThisSession(ev.sessionId)) return false;
        const block: Extract<ChatBlock, { kind: "tool" }> = {
          kind: "tool",
          id: nextId("t"),
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          argsJson: ev.argumentsJson,
          output: "",
          status: "running",
          durationMs: null,
          error: null,
          expanded: !this.collapseToolCalls,
        };
        this.toolByCallId.set(ev.toolCallId, block);
        this.blocks.push(block);
        return true;
      }
      case "tool.call.output": {
        if (!this.forThisSession(ev.sessionId)) return false;
        const block = this.toolByCallId.get(ev.toolCallId);
        if (!block) return false;
        block.output += ev.chunk;
        return true;
      }
      case "tool.call.completed": {
        if (!this.forThisSession(ev.sessionId)) return false;
        const block = this.toolByCallId.get(ev.toolCallId);
        if (!block) return false;
        block.status = "done";
        block.durationMs = ev.durationMs;
        if (!block.output) block.output = ev.resultJson;
        return true;
      }
      case "tool.call.failed": {
        if (!this.forThisSession(ev.sessionId)) return false;
        const block = this.toolByCallId.get(ev.toolCallId);
        if (!block) return false;
        block.status = "failed";
        block.error = ev.error;
        return true;
      }
      case "tool.call.denied": {
        if (!this.forThisSession(ev.sessionId)) return false;
        const block = this.toolByCallId.get(ev.toolCallId);
        if (!block) return false;
        block.status = "denied";
        block.error = ev.reason;
        return true;
      }
      case "approval.requested": {
        this.blocks.push({ kind: "approval", id: nextId("ap"), approval: ev.approval });
        return true;
      }
      case "run.started": {
        if (!this.forThisSession(ev.sessionId)) return false;
        this.activeRun = { runId: ev.runId, modelId: ev.modelId, compacting: false };
        return true;
      }
      case "run.completed": {
        if (!this.forThisSession(ev.sessionId)) return false;
        if (this.activeRun?.runId === ev.runId) this.activeRun = null;
        this.usage.inputTokens += ev.usage.inputTokens;
        this.usage.outputTokens += ev.usage.outputTokens;
        this.usage.costUsd += ev.usage.costUsd ?? 0;
        this.usage.runs += 1;
        return true;
      }
      case "run.failed": {
        if (!this.forThisSession(ev.sessionId)) return false;
        if (this.activeRun?.runId === ev.runId) this.activeRun = null;
        this.addSystemMessage(`run failed: ${ev.error}`);
        return true;
      }
      case "run.compacting": {
        if (!this.forThisSession(ev.sessionId)) return false;
        if (this.activeRun?.runId === ev.runId) this.activeRun.compacting = true;
        this.blocks.push({
          kind: "compaction",
          id: nextId("c"),
          beforeTokens: ev.beforeTokens,
          afterTokens: null,
          done: false,
        });
        return true;
      }
      case "run.compacted": {
        if (!this.forThisSession(ev.sessionId)) return false;
        if (this.activeRun?.runId === ev.runId) this.activeRun.compacting = false;
        const last = [...this.blocks].reverse().find((b) => b.kind === "compaction" && !b.done);
        if (last && last.kind === "compaction") {
          last.afterTokens = ev.afterTokens;
          last.done = true;
        } else {
          this.blocks.push({
            kind: "compaction",
            id: nextId("c"),
            beforeTokens: null,
            afterTokens: ev.afterTokens,
            done: true,
          });
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Update an approval block after approval.resolved. */
  resolveApprovalBlock(approvalId: string, status: ApprovalRequest["status"]): void {
    for (const b of this.blocks) {
      if (b.kind === "approval" && b.approval.id === approvalId) {
        b.approval = { ...b.approval, status };
      }
    }
  }

  /** Toggle a tool block's expanded state. Returns the block or undefined. */
  toggleTool(toolCallId: string): Extract<ChatBlock, { kind: "tool" }> | undefined {
    const block = this.toolByCallId.get(toolCallId);
    if (!block) return undefined;
    block.expanded = !block.expanded;
    return block;
  }

  toolBlocks(): Array<Extract<ChatBlock, { kind: "tool" }>> {
    return this.blocks.filter((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool");
  }

  setAllToolsExpanded(expanded: boolean): void {
    for (const b of this.toolBlocks()) b.expanded = expanded;
  }

  /** Usage line shown after a run completes / in the header meter. */
  usageSummary(): string {
    const u = this.usage;
    return `↑${fmtTokens(u.inputTokens)} ↓${fmtTokens(u.outputTokens)} ${fmtCost(u.costUsd)}`;
  }

  /** Plain-text layout of the transcript (no ANSI). Views restyle per kind. */
  renderLines(width: number): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) {
      lines.push(...this.renderBlock(block, width));
    }
    return lines;
  }

  private renderBlock(block: ChatBlock, width: number): string[] {
    const inner = Math.max(10, width - 4);
    switch (block.kind) {
      case "user":
        return wrapPlain(block.text, inner).map((l, i) => (i === 0 ? `❯ ${l}` : `  ${l}`));
      case "assistant": {
        const out: string[] = [];
        if (block.reasoning && this.showReasoning) {
          out.push(...wrapPlain(block.reasoning, inner).map((l) => `  ~ ${l}`));
        }
        out.push(...wrapPlain(block.text || (block.streaming ? "…" : ""), inner));
        return out;
      }
      case "tool": {
        const icon =
          block.status === "running"
            ? "◌"
            : block.status === "done"
              ? "✓"
              : block.status === "denied"
                ? "⊘"
                : "✗";
        const dur = block.durationMs !== null ? ` ${block.durationMs}ms` : "";
        const head = truncate(
          `${icon} ${block.toolName}(${summarizeArgs(block.argsJson, 40)})${dur}${block.expanded ? "" : " [+]"}`,
          width,
        );
        if (!block.expanded) return [head];
        const out = [head];
        const body = block.error ? `error: ${block.error}` : block.output;
        for (const l of wrapPlain(body, inner).slice(0, 200)) out.push(`  │ ${l}`);
        return out;
      }
      case "approval": {
        const a = block.approval;
        const head = truncate(`⚠ approval [${a.risk}] ${a.summary}`, width);
        if (a.status === "pending") {
          return [
            head,
            truncate("  [a]pprove once  [s]ession  [w]orkspace  alwa[y]s  [d]eny", width),
          ];
        }
        return [truncate(`${head}  → ${a.status}`, width)];
      }
      case "compaction": {
        if (!block.done) {
          return [
            truncate(
              `⟳ compacting context (${block.beforeTokens !== null ? fmtTokens(block.beforeTokens) : "?"} tokens)…`,
              width,
            ),
          ];
        }
        return [
          truncate(
            `✓ context compacted ${block.beforeTokens !== null ? fmtTokens(block.beforeTokens) : "?"} → ${block.afterTokens !== null ? fmtTokens(block.afterTokens) : "?"}`,
            width,
          ),
        ];
      }
      case "system":
        return wrapPlain(block.text, inner).map((l) => `— ${l}`);
    }
  }

  private forThisSession(sessionId: string): boolean {
    return this.sessionId !== null && this.sessionId === sessionId;
  }
}
