import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimateContextTokens,
  estimateTokens,
  serializeConversation,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { CompactionSettings } from "@earendil-works/pi-agent-core";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { ModelRouter } from "@omniharness/model-gateway";
import { textMessage } from "@omniharness/model-gateway";

export interface CompactionHooks {
  onCompacting(beforeTokens: number): void;
  onCompacted(afterTokens: number): void;
}

export interface CompactionTransform {
  /** Pi `transformContext` hook: compacts the outgoing context when over threshold. */
  transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
  /**
   * If a compaction happened during the run, returns the compacted transcript
   * to store back into the agent's state (call once the run ends with the
   * final message list). Returns undefined when nothing was compacted.
   */
  applyToTranscript(fullTranscript: AgentMessage[]): AgentMessage[] | undefined;
}

const SUMMARY_PREFIX = "[Summary of earlier conversation]";

/** Mirrors pi-agent-core's summarization system prompt (not re-exported at the package root). */
const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user " +
  "and an AI assistant, then produce a structured summary following the exact format specified.\n\n" +
  "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY " +
  "output the structured summary.";

/**
 * Threshold compaction built from pi-agent-core's estimation/serialization
 * helpers, with the summarization itself routed through OUR ModelRouter
 * ("summarizer" role) instead of a Pi provider.
 *
 * Pi's full compaction pipeline (prepareCompaction/compact) operates on
 * harness session-tree entries; OmniHarness persistence lives in the daemon
 * via session-store, so the adapter uses the lighter in-context form: a
 * summary user message replaces the oldest messages once estimated context
 * tokens exceed `contextWindow - reserveTokens`.
 */
export function createCompactionTransform(options: {
  router: ModelRouter;
  contextWindow: number;
  settings: CompactionSettings;
  hooks: CompactionHooks;
}): CompactionTransform {
  const { router, contextWindow, settings, hooks } = options;
  let memo: { source: AgentMessage[]; cutIndex: number; summary: UserMessage } | undefined;

  function compactedView(
    messages: AgentMessage[],
    cutIndex: number,
    summary: UserMessage,
  ): AgentMessage[] {
    return [summary, ...messages.slice(cutIndex)];
  }

  async function summarize(messages: AgentMessage[], signal?: AbortSignal): Promise<string> {
    const conversation = serializeConversation(messages as Message[]);
    const prompt =
      "Summarize the following conversation between a user and an AI assistant. " +
      "Preserve: the user's goals, decisions made, file paths touched, tool outcomes, " +
      "and any open tasks or pending questions. Be concise but complete.\n\n" +
      conversation;
    let text = "";
    for await (const chunk of router.complete("summarizer", {
      messages: [textMessage("system", SUMMARIZATION_SYSTEM_PROMPT), textMessage("user", prompt)],
      ...(signal !== undefined ? { signal } : {}),
    })) {
      if (chunk.type === "text_delta" && chunk.text !== undefined) text += chunk.text;
      if (chunk.type === "error") throw new Error(chunk.error ?? "summarizer failed");
    }
    if (text.trim() === "") throw new Error("summarizer returned an empty summary");
    return text;
  }

  return {
    async transformContext(messages, signal) {
      if (!settings.enabled) return messages;
      if (memo !== undefined && memo.source === messages) {
        return compactedView(messages, memo.cutIndex, memo.summary);
      }
      const estimate = estimateContextTokens(messages);
      if (!shouldCompact(estimate.tokens, contextWindow, settings)) return messages;

      // Walk back from the newest message, keeping ~keepRecentTokens.
      let keptTokens = 0;
      let cutIndex = messages.length;
      while (cutIndex > 0) {
        const message = messages[cutIndex - 1];
        if (message === undefined) break;
        const tokens = estimateTokens(message);
        if (keptTokens + tokens > settings.keepRecentTokens && cutIndex < messages.length) break;
        keptTokens += tokens;
        cutIndex -= 1;
      }
      // Never cut into a tool-call group: a toolResult without its assistant
      // toolCall would confuse providers.
      while (cutIndex < messages.length && messages[cutIndex]?.role === "toolResult") {
        cutIndex += 1;
      }
      if (cutIndex <= 0 || cutIndex >= messages.length) return messages;

      hooks.onCompacting(estimate.tokens);
      let summaryText: string;
      try {
        summaryText = await summarize(messages.slice(0, cutIndex), signal);
      } catch {
        // Compaction is best-effort; an unavailable summarizer must not break the run.
        return messages;
      }
      const summary: UserMessage = {
        role: "user",
        content: `${SUMMARY_PREFIX}\n${summaryText}`,
        timestamp: Date.now(),
      };
      memo = { source: messages, cutIndex, summary };
      const view = compactedView(messages, cutIndex, summary);
      hooks.onCompacted(estimateContextTokens(view).tokens);
      return view;
    },

    applyToTranscript(fullTranscript) {
      if (memo === undefined) return undefined;
      return compactedView(fullTranscript, memo.cutIndex, memo.summary);
    },
  };
}
