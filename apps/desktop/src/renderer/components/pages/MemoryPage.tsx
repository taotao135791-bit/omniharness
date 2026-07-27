import React, { useState } from "react";
import type { AppStore } from "../../store.js";
import { useQuery } from "../../hooks.js";
import type { MemoryEntry, MemorySearchResult } from "@omniharness/agent-protocol";

function MemoryRow({
  store,
  entry,
  score,
  onChanged,
}: {
  store: AppStore;
  entry: MemoryEntry;
  score?: number;
  onChanged: () => void;
}): React.JSX.Element {
  const pending = !entry.approvedByUser;
  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    onChanged();
  };
  return (
    <div className={`memory-row ${pending ? "pending" : ""}`}>
      <div className="memory-main">
        <div>
          {pending && <span className="badge risk-medium">proposal</span>}{" "}
          <span className="badge">{entry.kind}</span>{" "}
          <span className="muted">{entry.createdBy}</span>{" "}
          {score !== undefined && <span className="muted">score {score.toFixed(2)}</span>}
        </div>
        <div className="memory-content">{entry.content}</div>
        <div className="muted memory-summary">{entry.summary}</div>
      </div>
      <div className="memory-actions">
        {pending && (
          <>
            <button
              className="mini approve"
              aria-label="Approve memory"
              onClick={() =>
                void act(() => store.rpc.call("memory.approve", { memoryId: entry.id }))
              }
            >
              Approve
            </button>
            <button
              className="mini deny"
              aria-label="Reject memory"
              onClick={() =>
                void act(() => store.rpc.call("memory.reject", { memoryId: entry.id }))
              }
            >
              Reject
            </button>
          </>
        )}
        <button
          className="mini"
          aria-label="Delete memory"
          onClick={() => void act(() => store.rpc.call("memory.delete", { memoryId: entry.id }))}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export function MemoryPage({ store }: { store: AppStore }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");

  const list = useQuery(
    store,
    () => store.rpc.call("memory.list", { approvedOnly: false, limit: 100 }),
    [],
    true,
  );
  const results = useQuery(
    store,
    () =>
      submitted
        ? store.rpc.call("memory.search", { text: submitted, includePending: true, limit: 50 })
        : Promise.resolve({ results: [] as MemorySearchResult[] }),
    [submitted],
  );

  const refreshAll = () => {
    list.refresh();
    results.refresh();
  };

  const searching = submitted.length > 0;

  return (
    <section className="page" aria-label="Memory">
      <h1>Memory</h1>
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <input
          aria-label="Search memory"
          placeholder="Search memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="primary" disabled={!query.trim()}>
          Search
        </button>
        {searching && (
          <button
            type="button"
            onClick={() => {
              setSubmitted("");
              setQuery("");
            }}
          >
            Clear
          </button>
        )}
      </form>

      {searching ? (
        <>
          <h2 className="page-h2">Results for “{submitted}”</h2>
          {(results.data?.results ?? []).map((r) => (
            <MemoryRow
              key={r.entry.id}
              store={store}
              entry={r.entry}
              score={r.score}
              onChanged={refreshAll}
            />
          ))}
          {results.data && results.data.results.length === 0 && (
            <div className="hint">No matching memories.</div>
          )}
        </>
      ) : (
        <>
          <h2 className="page-h2">All memories ({list.data?.total ?? 0})</h2>
          {(list.data?.memories ?? []).map((m) => (
            <MemoryRow key={m.id} store={store} entry={m} onChanged={refreshAll} />
          ))}
          {list.data && list.data.memories.length === 0 && (
            <div className="hint">No memories stored yet.</div>
          )}
        </>
      )}
    </section>
  );
}
