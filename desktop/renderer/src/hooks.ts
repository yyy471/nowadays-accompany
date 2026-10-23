import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface QuerySnapshot<T = unknown> {
  data?: T;
  error?: string;
  loading: boolean;
}

interface QueryEntry {
  path: string;
  snapshot: QuerySnapshot;
  listeners: Map<(snapshot: QuerySnapshot) => void, number>;
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
  refreshAfter?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const IDLE_TTL_MS = 30_000;
const queries = new Map<string, QueryEntry>();

function queryEntry(path: string): QueryEntry {
  let entry = queries.get(path);
  if (!entry) {
    entry = { path, snapshot: { loading: true }, listeners: new Map() };
    queries.set(path, entry);
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  return entry;
}

function notify(entry: QueryEntry): void {
  for (const listener of entry.listeners.keys()) listener(entry.snapshot);
}

function load(entry: QueryEntry): Promise<void> {
  if (entry.inFlight) return entry.inFlight;
  const task = api<unknown>(entry.path)
    .then((data) => {
      entry.snapshot = { data, loading: false };
    })
    .catch((error: unknown) => {
      entry.snapshot = { ...entry.snapshot, error: errorMessage(error), loading: false };
    })
    .finally(() => {
      entry.inFlight = undefined;
      notify(entry);
    });
  entry.inFlight = task;
  return task;
}

function refresh(entry: QueryEntry): Promise<void> {
  if (!entry.inFlight) return load(entry);
  if (!entry.refreshAfter) {
    entry.refreshAfter = entry.inFlight.then(() => {
      entry.refreshAfter = undefined;
      return load(entry);
    });
  }
  return entry.refreshAfter;
}

function schedule(entry: QueryEntry): void {
  if (entry.timer) {
    clearInterval(entry.timer);
    entry.timer = undefined;
  }
  const intervals = [...entry.listeners.values()].filter((value) => value > 0);
  if (!intervals.length) return;
  entry.timer = setInterval(() => {
    if (!document.hidden) void load(entry);
  }, Math.min(...intervals));
}

function subscribe(
  path: string,
  intervalMs: number,
  listener: (snapshot: QuerySnapshot) => void
): () => void {
  const entry = queryEntry(path);
  entry.listeners.set(listener, intervalMs);
  listener(entry.snapshot);
  if (!entry.inFlight && (entry.snapshot.data === undefined || entry.snapshot.error)) void load(entry);
  schedule(entry);
  return () => {
    entry.listeners.delete(listener);
    schedule(entry);
    if (entry.listeners.size > 0) return;
    entry.idleTimer = setTimeout(() => {
      if (entry.listeners.size > 0) return;
      if (entry.timer) clearInterval(entry.timer);
      queries.delete(path);
    }, IDLE_TTL_MS);
  };
}

export function usePoll<T>(
  path: string | null,
  intervalMs = 0
): { data?: T; error?: string; loading: boolean; refresh: () => Promise<void> } {
  const [state, setState] = useState<{ path: string | null; snapshot: QuerySnapshot<T> }>({
    path,
    snapshot: { loading: Boolean(path) }
  });
  const pathRef = useRef(path);

  useEffect(() => {
    pathRef.current = path;
    if (!path) {
      setState({ path, snapshot: { loading: false } });
      return;
    }
    const listener = (snapshot: QuerySnapshot): void => {
      setState({ path, snapshot: snapshot as QuerySnapshot<T> });
    };
    return subscribe(path, intervalMs, listener);
  }, [path, intervalMs]);

  const refreshNow = useCallback(async () => {
    if (!pathRef.current) return;
    await refresh(queryEntry(pathRef.current));
  }, []);

  const snapshot = state.path === path ? state.snapshot : { loading: Boolean(path) };
  return { data: snapshot.data, error: snapshot.error, loading: snapshot.loading, refresh: refreshNow };
}
