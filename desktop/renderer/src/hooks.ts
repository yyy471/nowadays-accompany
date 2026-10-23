import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function usePoll<T>(
  path: string | null,
  intervalMs = 0
): { data?: T; error?: string; loading: boolean; refresh: () => Promise<void> } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    setLoading(true);
  }, [path]);

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      const next = await api<T>(path);
      if (!mounted.current) return;
      setData(next);
      setError(undefined);
    } catch (error) {
      if (!mounted.current) return;
      setError(errorMessage(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    if (!intervalMs) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}
