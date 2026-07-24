import React, { useCallback, useEffect, useRef, useState } from "react";

interface SessionRow {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  streaming?: boolean;
}

interface ApprovalRow {
  id: string;
  capability: string;
  risk: string;
  summary: string;
  status: string;
}

type DaemonEvent = {
  type: string;
  sessionId?: string;
  messageId?: string;
  delta?: string;
  channel?: string;
  approval?: ApprovalRow;
  approvalId?: string;
  status?: string;
};

export function App(): React.JSX.Element {
  const [daemonState, setDaemonState] = useState("starting");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const r = (await window.omni.call("session.list", { limit: 100 })) as { sessions: SessionRow[] };
      setSessions(r.sessions);
    } catch {
      /* daemon not ready yet */
    }
  }, []);

  const refreshApprovals = useCallback(async () => {
    try {
      const r = (await window.omni.call("approval.list", { status: "pending", limit: 20 })) as {
        approvals: ApprovalRow[];
      };
      setApprovals(r.approvals);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const offState = window.omni.onState((s) => {
      setDaemonState(s);
      if (s === "connected") {
        void refreshSessions();
        void refreshApprovals();
      }
    });
    const offEvents = window.omni.onEvent((raw) => {
      const e = raw as DaemonEvent;
      if (e.type === "message.delta" && e.sessionId && e.messageId && e.channel === "text") {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === e.messageId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx]!, text: next[idx]!.text + (e.delta ?? "") };
            return next;
          }
          return [...prev, { id: e.messageId!, role: "assistant", text: e.delta ?? "", streaming: true }];
        });
      }
      if (e.type === "message.completed" && e.messageId) {
        setMessages((prev) => prev.map((m) => (m.id === e.messageId ? { ...m, streaming: false } : m)));
      }
      if (e.type === "run.completed" || e.type === "run.failed") setRunning(false);
      if (e.type === "approval.requested" && e.approval) {
        setApprovals((prev) => [...prev, e.approval!]);
      }
      if (e.type === "approval.resolved" && e.approvalId) {
        setApprovals((prev) => prev.filter((a) => a.id !== e.approvalId));
      }
      if (e.type === "session.created" || e.type === "session.updated") void refreshSessions();
    });
    return () => {
      offState();
      offEvents();
    };
  }, [refreshSessions, refreshApprovals]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeSession) return;
    setInput("");
    setRunning(true);
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", text }]);
    try {
      await window.omni.call("run.start", { sessionId: activeSession, input: text });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "assistant", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      setRunning(false);
    }
  }, [input, activeSession]);

  const resolveApproval = useCallback(async (id: string, decision: "approve" | "deny") => {
    await window.omni.call("approval.resolve", { approvalId: id, decision });
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Sessions</h2>
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeSession ? "active" : ""}`}
            onClick={() => {
              setActiveSession(s.id);
              setMessages([]);
              void window.omni
                .call("session.messages", { sessionId: s.id, limit: 100 })
                .then((r) => {
                  const msgs = (r as { messages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }> }).messages;
                  setMessages(
                    msgs.map((m) => ({
                      id: m.id,
                      role: m.role === "user" ? "user" : m.role === "tool" ? "tool" : "assistant",
                      text: m.parts.map((p) => p.text ?? "").join(""),
                    })),
                  );
                })
                .catch(() => undefined);
            }}
          >
            {s.title || s.id}
          </div>
        ))}
        {sessions.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12 }}>No sessions yet</div>}
      </aside>
      <main className="main">
        <div className="statusbar">
          <span>
            <span className={`dot ${daemonState === "connected" ? "connected" : "disconnected"}`} />
            daemon: {daemonState}
          </span>
          {activeSession && <span>session: {activeSession}</span>}
        </div>
        <div className="messages">
          {approvals
            .filter((a) => a.status === "pending")
            .map((a) => (
              <div key={a.id} className="approval">
                <span style={{ flex: 1 }}>
                  <strong>{a.capability}</strong> ({a.risk}) — {a.summary}
                </span>
                <button className="approve" onClick={() => void resolveApproval(a.id, "approve")}>
                  Approve
                </button>
                <button className="deny" onClick={() => void resolveApproval(a.id, "deny")}>
                  Deny
                </button>
              </div>
            ))}
          {messages.length === 0 && (
            <div className="empty">
              {activeSession ? "No messages yet — say something." : "Select a session or create one via the CLI/TUI."}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.text}
              {m.streaming ? " ▍" : ""}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="composer">
          <textarea
            value={input}
            placeholder={activeSession ? "Message the agent… (Enter to send, Shift+Enter for newline)" : "Select a session first"}
            disabled={!activeSession || running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button disabled={!activeSession || running || !input.trim()} onClick={() => void send()}>
            {running ? "Running…" : "Send"}
          </button>
        </div>
      </main>
    </div>
  );
}
