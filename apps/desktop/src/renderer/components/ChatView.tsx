import React, { useEffect, useRef, useState } from "react";
import type { AppStore } from "../store.js";
import { useAppState, useQuery } from "../hooks.js";
import { formatCost, formatTokens, type ToolCallState } from "../vm/chat.js";
import { RunTimeline } from "./RunTimeline.js";
import type { ModelRole } from "@omniharness/shared-types";

type RoleBindings = { bindings: Partial<Record<ModelRole, string>> };

function ToolCallBlock({ call }: { call: ToolCallState }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  let args = call.argumentsJson;
  try {
    args = JSON.stringify(JSON.parse(call.argumentsJson), null, 2);
  } catch {
    /* keep raw */
  }
  return (
    <div className={`tool-call ${call.status}`}>
      <button
        className="tool-call-head"
        aria-expanded={open}
        aria-label={`Tool call ${call.name}, ${call.status}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`chev ${open ? "open" : ""}`}>▸</span>
        <span className="tool-name">{call.name}</span>
        <span className={`badge status-${call.status}`}>{call.status}</span>
        {call.durationMs !== null && <span className="muted">{call.durationMs}ms</span>}
      </button>
      {open && (
        <div className="tool-call-body">
          {args && (
            <>
              <div className="tool-label">arguments</div>
              <pre>{args}</pre>
            </>
          )}
          {call.output && (
            <>
              <div className="tool-label">output</div>
              <pre>{call.output}</pre>
            </>
          )}
          {call.resultJson && (
            <>
              <div className="tool-label">result</div>
              <pre>{call.resultJson}</pre>
            </>
          )}
          {call.error && <div className="error-text">{call.error}</div>}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  store,
  approval,
}: {
  store: AppStore;
  approval: {
    id: string;
    capability: string;
    risk: string;
    summary: string;
    detail: Record<string, string>;
  };
}): React.JSX.Element {
  const [remember, setRemember] = useState("");
  return (
    <div className="approval" role="alert">
      <div className="approval-info">
        <div>
          <span className={`badge risk-${approval.risk}`}>{approval.risk}</span>{" "}
          <strong>{approval.capability}</strong>
        </div>
        <div className="approval-summary">{approval.summary}</div>
        {Object.keys(approval.detail).length > 0 && (
          <pre className="approval-detail">{JSON.stringify(approval.detail, null, 2)}</pre>
        )}
        <label className="remember-row">
          remember:
          <select
            aria-label="Remember scope"
            value={remember}
            onChange={(e) => setRemember(e.target.value)}
          >
            <option value="">just this once</option>
            <option value="session">for this session</option>
            <option value="workspace">for this workspace</option>
            <option value="always">always</option>
          </select>
        </label>
      </div>
      <div className="approval-actions">
        <button
          className="approve"
          onClick={() => void store.resolveApproval(approval.id, "approve", remember || undefined)}
        >
          Approve
        </button>
        <button className="deny" onClick={() => void store.resolveApproval(approval.id, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function ChatView({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const models = useQuery(store, () => store.rpc.call("model.list", {}), [], true);
  const bindings = useQuery(
    store,
    () =>
      s.activeSessionId
        ? store.rpc.call("model.getRoleBindings", { sessionId: s.activeSessionId })
        : Promise.resolve<RoleBindings>({ bindings: {} }),
    [s.activeSessionId],
    true,
  );

  const running = s.chat.activeRunId !== null;
  const currentModel = bindings.data?.bindings.primary ?? "";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [s.chat.messages.length, s.chat.toolCalls.length]);

  const submit = (mode: "send" | "steer" | "enqueue") => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (mode === "send") void store.send(text);
    else if (mode === "steer") void store.steer(text);
    else void store.enqueueFollowUp(text);
  };

  return (
    <section className="chat" aria-label="Chat">
      <div className="chat-header">
        <select
          aria-label="Session model"
          className="model-select"
          value={currentModel}
          onChange={(e) => {
            if (e.target.value) void store.setSessionModel(e.target.value);
          }}
          disabled={!s.activeSessionId}
        >
          <option value="">default model</option>
          {(models.data?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        <span className="meter" aria-label="Token and cost meter">
          ↑{formatTokens(s.chat.totals.inputTokens)} ↓{formatTokens(s.chat.totals.outputTokens)}{" "}
          {formatCost(s.chat.totals)}
        </span>
        {s.chat.compacting && (
          <span className="badge compacting" role="status">
            compacting context…
          </span>
        )}
        {s.chat.compactionNote && !s.chat.compacting && (
          <span className="badge compacted" role="status">
            {s.chat.compactionNote}
          </span>
        )}
      </div>

      <div className="chat-body">
        <div className="messages" aria-live="polite">
          {s.approvals
            .filter((a) => a.status === "pending")
            .map((a) => (
              <ApprovalCard key={a.id} store={store} approval={a} />
            ))}
          {s.chat.messages.length === 0 && (
            <div className="empty">
              {s.activeSessionId
                ? "No messages yet — say something."
                : "Select a session, or create one with the + button in the sidebar."}
            </div>
          )}
          {s.chat.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.reasoning && (
                <details className="reasoning">
                  <summary>reasoning</summary>
                  {m.reasoning}
                </details>
              )}
              {m.text}
              {m.streaming ? " ▍" : ""}
            </div>
          ))}
          {s.chat.toolCalls.map((t) => (
            <ToolCallBlock key={t.id} call={t} />
          ))}
          {s.chat.lastError && <div className="msg error">Error: {s.chat.lastError}</div>}
          <div ref={bottomRef} />
        </div>
        <RunTimeline store={store} />
      </div>

      <div className="composer">
        <textarea
          aria-label={running ? "Steer the running agent" : "Message the agent"}
          placeholder={
            !s.activeSessionId
              ? "Select a session first"
              : running
                ? "Steer the agent… (Enter to steer)"
                : "Message the agent… (Enter to send, Shift+Enter for newline)"
          }
          value={input}
          disabled={!s.activeSessionId}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(running ? "steer" : "send");
            }
          }}
        />
        <div className="composer-actions">
          {running ? (
            <>
              <button
                className="primary"
                disabled={!input.trim()}
                onClick={() => submit("steer")}
                aria-label="Steer run"
              >
                Steer
              </button>
              <button
                disabled={!input.trim()}
                onClick={() => submit("enqueue")}
                aria-label="Enqueue follow-up"
              >
                Enqueue
              </button>
              <button
                className="danger"
                onClick={() => void store.interrupt()}
                aria-label="Interrupt run"
              >
                ■ Interrupt
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={!s.activeSessionId || !input.trim()}
              onClick={() => submit("send")}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
