import {
  Editor,
  Markdown,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AppController } from "../core/app-controller.js";
import type { ChatBlock } from "../vm/chat-vm.js";
import { bold, dim, editorTheme, fg, italic, mdTheme } from "../theme.js";
import { truncate, wrapPlain, summarizeArgs } from "../vm/layout.js";

const MAX_MD_CACHE = 200;

/**
 * The chat view: streaming transcript (markdown assistant blocks, tool-call
 * blocks, inline approval prompts) + multiline editor. State lives in
 * ChatViewModel; this component only renders it and routes keys.
 */
export class ChatView implements Component, Focusable {
  private _focused = false;
  private readonly editor: Editor;
  private readonly mdCache = new Map<string, Markdown>();

  constructor(
    tui: TUI,
    private readonly controller: AppController,
  ) {
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (text) => {
      if (text) this.editor.addToHistory(text);
      void this.controller.submitChat(text);
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  invalidate(): void {
    this.editor.invalidate();
    for (const md of this.mdCache.values()) md.invalidate();
  }

  render(width: number): string[] {
    const vm = this.controller.chat;
    const lines: string[] = [];
    if (vm.sessionTitle) {
      lines.push(dim(truncate(`  ${vm.sessionTitle}`, width)));
    }
    if (vm.blocks.length === 0) {
      lines.push(dim("  empty session — type below to start"));
    }
    for (const block of vm.blocks) {
      lines.push(...this.renderBlock(block, width));
      lines.push("");
    }
    const run = vm.activeRun;
    if (run) {
      lines.push(
        fg.cyan(
          truncate(
            `  ◌ running (${run.modelId})${run.compacting ? " — compacting…" : ""} — esc to interrupt, enter to steer`,
            width,
          ),
        ),
      );
    }
    if (vm.queuedFollowUps > 0) {
      lines.push(dim(`  ${vm.queuedFollowUps} follow-up(s) queued`));
    }
    const approval = this.controller.pendingApproval;
    if (approval) {
      lines.push("");
      lines.push(bold(fg.yellow(truncate(`  ⚠ APPROVAL REQUIRED [${approval.risk}] ${approval.capability}`, width))));
      lines.push(...wrapPlain(approval.summary, Math.max(10, width - 4)).map((l) => fg.yellow(`  ${l}`)));
      lines.push(
        dim("  [a]pprove once  [s]ession  [w]orkspace  alwa[y]s  [d]eny"),
      );
    }
    lines.push(...this.editor.render(width));
    return lines;
  }

  private renderBlock(block: ChatBlock, width: number): string[] {
    const inner = Math.max(10, width - 4);
    switch (block.kind) {
      case "user":
        return wrapPlain(block.text, inner).map((l, i) =>
          i === 0 ? bold(fg.green(`❯ ${l}`)) : fg.green(`  ${l}`),
        );
      case "assistant": {
        const out: string[] = [];
        if (block.reasoning) {
          out.push(...wrapPlain(block.reasoning, inner).map((l) => italic(dim(`  ~ ${l}`))));
        }
        let md = this.mdCache.get(block.id);
        if (!md) {
          if (this.mdCache.size >= MAX_MD_CACHE) {
            const oldest = this.mdCache.keys().next().value;
            if (oldest !== undefined) this.mdCache.delete(oldest);
          }
          md = new Markdown("", 0, 0, mdTheme);
          this.mdCache.set(block.id, md);
        }
        md.setText(block.text || (block.streaming ? "…" : ""));
        out.push(...md.render(width));
        return out;
      }
      case "tool": {
        const icon =
          block.status === "running"
            ? fg.cyan("◌")
            : block.status === "done"
              ? fg.green("✓")
              : block.status === "denied"
                ? fg.yellow("⊘")
                : fg.red("✗");
        const dur = block.durationMs !== null ? dim(` ${block.durationMs}ms`) : "";
        const head = `${icon} ${bold(block.toolName)}${dim(`(${summarizeArgs(block.argsJson, 40)})`)}${dur}${block.expanded ? "" : dim(" [+]")}`;
        if (!block.expanded) return [truncate(head, width)];
        const out = [truncate(head, width)];
        const body = block.error ? `error: ${block.error}` : block.output;
        for (const l of wrapPlain(body, inner).slice(0, 200)) {
          out.push(dim(`  │ ${l}`));
        }
        return out;
      }
      case "approval": {
        const a = block.approval;
        const head = truncate(`⚠ approval [${a.risk}] ${a.summary}`, width);
        if (a.status === "pending") return [fg.yellow(head)];
        return [dim(`${head}  → ${a.status}`)];
      }
      case "compaction": {
        if (!block.done) {
          return [fg.magenta(truncate(`⟳ compacting context (${block.beforeTokens ?? "?"} tokens)…`, width))];
        }
        return [
          fg.magenta(
            truncate(`✓ context compacted ${block.beforeTokens ?? "?"} → ${block.afterTokens ?? "?"}`, width),
          ),
        ];
      }
      case "system":
        return wrapPlain(block.text, inner).map((l) => dim(`— ${l}`));
    }
  }

  handleInput(data: string): void {
    const c = this.controller;
    // An inline approval prompt captures the keyboard until resolved.
    const approval = c.pendingApproval;
    if (approval) {
      if (data === "a") void c.resolveApproval(approval.id, "approve", "once");
      else if (data === "s") void c.resolveApproval(approval.id, "approve", "session");
      else if (data === "w") void c.resolveApproval(approval.id, "approve", "workspace");
      else if (data === "y") void c.resolveApproval(approval.id, "approve", "always");
      else if (data === "d") void c.resolveApproval(approval.id, "deny", "once");
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      const tools = c.chat.toolBlocks();
      const last = tools[tools.length - 1];
      if (last) c.chat.toggleTool(last.toolCallId);
      return;
    }
    if (matchesKey(data, "ctrl+shift+o")) {
      const tools = c.chat.toolBlocks();
      const anyCollapsed = tools.some((t) => !t.expanded);
      c.chat.setAllToolsExpanded(anyCollapsed);
      return;
    }
    this.editor.handleInput(data);
  }
}
