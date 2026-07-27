import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppState, AppStore } from "./store.js";
import { errMsg } from "./store.js";

/** Subscribe a component to the whole store snapshot. */
export function useAppState(store: AppStore): AppState {
  return useSyncExternalStore(store.subscribe, () => store.snapshot);
}

export interface QueryResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Data-fetching hook for pages: runs an async RPC-backed loader on mount and
 * whenever `deps` change. `listenRevision` re-runs on store dataRevision bumps.
 */
export function useQuery<T>(
  store: AppStore,
  loader: () => Promise<T>,
  deps: readonly unknown[],
  listenRevision = false,
): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const revision = useAppState(store).dataRevision;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loaderRef
      .current()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(errMsg(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tick, ...(listenRevision ? [revision] : []), ...deps]);

  return { data, error, loading, refresh };
}
