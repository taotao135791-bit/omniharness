import type { ViewName } from "../core/types.js";
import { truncate } from "../vm/layout.js";

const HINTS: Record<ViewName, { full: string; compact: string }> = {
  sessions: {
    full: "enter open · n new · r rename · t tags · x archive · ]/[ page · ^n new · ^p palette",
    compact: "enter open · n new · x archive · ^p",
  },
  chat: {
    full: "enter send (steer while running) · shift+enter newline · esc interrupt/back · ^o tools · ^b branch · ^m model · ^p palette · /help",
    compact: "enter send · esc · ^p · /help",
  },
  diff: {
    full: "enter expand · a accept · d reject · A accept all · D reject all · r reload",
    compact: "a accept · d reject · r reload",
  },
  models: {
    full: "p set primary · b role bindings · t test provider · r reload",
    compact: "p primary · b bindings · t test",
  },
  approvals: {
    full: "a approve · s session · w workspace · y always · d deny · r reload",
    compact: "a approve · d deny",
  },
  memory: {
    full: "/ search · a approve · d reject · x delete · r reload",
    compact: "a approve · d reject · x del",
  },
  skills: {
    full: "space enable/disable · a approve · d reject proposal · r reload",
    compact: "space toggle · a/d proposal",
  },
  automations: {
    full: "space enable/disable · enter run now · r reload",
    compact: "space toggle · enter run",
  },
  logs: {
    full: "r run diagnostics",
    compact: "r diagnostics",
  },
  settings: {
    full: "enter/space cycle or edit · r reload",
    compact: "enter edit",
  },
};

/** Status bar layout (plain text; the shell paints the background). */
export function renderStatusBar(view: ViewName, flash: string | null, width: number): string[] {
  const hints = HINTS[view];
  const text = flash ?? (width < 80 ? hints.compact : hints.full);
  return [truncate(` ${text}`, width)];
}
